import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { formatDuration, spotifyFetch, type SpotifyGrantProps, type SpotifyWorkerEnv } from './spotify';

type SpotifyHandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export type ToolResult = {
	content: Array<{ type: 'text'; text: string }>;
	isError?: boolean;
};

export type SpotifyTool = {
	name: string;
	description: string;
	schema: Record<string, z.ZodTypeAny>;
	readOnly?: boolean;
	handler: (args: any, extra: SpotifyHandlerExtra) => Promise<ToolResult>;
};

export type ToolContext = {
	env: SpotifyWorkerEnv;
	grant: SpotifyGrantProps;
};

type Query = Record<string, string | number | boolean | undefined>;
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

const API_BASE = 'https://api.spotify.com/v1';
const URI_TYPES = ['track', 'album', 'artist', 'playlist', 'show', 'episode', 'audiobook', 'chapter', 'user'] as const;
type UriType = (typeof URI_TYPES)[number];
const SEARCH_TYPES = ['track', 'album', 'artist', 'playlist', 'show', 'episode', 'audiobook'] as const;
type SearchType = (typeof SEARCH_TYPES)[number];

export class SpotifyApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function describeSpotifyError(status: number, body: string, path: string, retryAfter: string | null): string {
	let detail = body;
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string; reason?: string } | string; error_description?: string };
		if (typeof parsed.error === 'object' && parsed.error) {
			detail = [parsed.error.message, parsed.error.reason].filter(Boolean).join(' / ');
		} else if (typeof parsed.error === 'string') {
			detail = [parsed.error, parsed.error_description].filter(Boolean).join(': ');
		}
	} catch {
		// non-JSON body
	}

	const isPlayer = path.startsWith('/me/player');
	if (status === 404 && isPlayer) {
		return 'No active Spotify device was found. Open Spotify on a device (or call getAvailableDevices + transferPlayback), or pass a deviceId.';
	}
	if (status === 401) {
		return `Spotify rejected the access token (${detail || 'unauthorized'}). Reconnect this MCP integration to re-authorize Spotify.`;
	}
	if (status === 403) {
		if (/scope/i.test(detail)) {
			return `Spotify says the granted scopes are insufficient (${detail}). Reconnect this MCP integration so the new scopes are granted.`;
		}
		if (isPlayer) {
			return `Spotify refused the player command (${detail || 'forbidden'}). Playback control requires Spotify Premium and a device that allows remote control.`;
		}
		return `Spotify returned 403 Forbidden: ${detail || 'forbidden'}. (Development-mode apps can only read the items of playlists you own or collaborate on.)`;
	}
	if (status === 429) {
		return `Spotify rate limit hit (${detail || 'too many requests'}).${retryAfter ? ` Retry after ${retryAfter}s.` : ''}`;
	}
	return `Spotify returned ${status}: ${detail || 'request failed'}`;
}

export async function spotifyRequest<T = any>(
	context: ToolContext,
	method: HttpMethod,
	path: string,
	options: { query?: Query; body?: unknown; rawBody?: string; contentType?: string } = {},
): Promise<T | null> {
	const url = new URL(`${API_BASE}${path}`);
	for (const [key, value] of Object.entries(options.query ?? {})) {
		if (value !== undefined && value !== '') {
			url.searchParams.set(key, String(value));
		}
	}

	const headers: Record<string, string> = {};
	let body: string | undefined;
	if (options.rawBody !== undefined) {
		body = options.rawBody;
		headers['content-type'] = options.contentType ?? 'text/plain';
	} else if (options.body !== undefined) {
		body = JSON.stringify(options.body);
		headers['content-type'] = 'application/json';
	} else if (method !== 'GET') {
		headers['content-length'] = '0';
	}

	const response = await spotifyFetch(context.env, context.grant, url.toString(), { method, headers, body });
	const text = await response.text();
	if (!response.ok) {
		throw new SpotifyApiError(
			response.status,
			describeSpotifyError(response.status, text, path, response.headers.get('retry-after')),
		);
	}
	if (!text) {
		return null;
	}
	try {
		return JSON.parse(text) as T;
	} catch {
		return text as unknown as T;
	}
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

function tool(definition: Omit<SpotifyTool, 'handler'> & { run: (args: any) => Promise<string> }): SpotifyTool {
	const { run, ...rest } = definition;
	return {
		...rest,
		handler: async (args) => {
			try {
				return ok(await run(args ?? {}));
			} catch (error) {
				return fail(`${definition.name} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	};
}

// ---------- ID / URI helpers ----------

export function parseSpotifyRef(input: string, defaultType?: UriType): { type: UriType; id: string; uri: string } {
	const value = input.trim();
	const uriMatch = /^spotify:(track|album|artist|playlist|show|episode|audiobook|chapter|user):([^:?\s]+)$/.exec(value);
	if (uriMatch) {
		return { type: uriMatch[1] as UriType, id: uriMatch[2], uri: value };
	}
	const urlMatch = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|album|artist|playlist|show|episode|audiobook|chapter|user)\/([^/?#\s]+)/i.exec(value);
	if (urlMatch) {
		const type = urlMatch[1].toLowerCase() as UriType;
		return { type, id: urlMatch[2], uri: `spotify:${type}:${urlMatch[2]}` };
	}
	if (!defaultType) {
		throw new Error(`"${input}" is not a Spotify URI or open.spotify.com URL; pass a full URI like spotify:track:<id>.`);
	}
	if (!/^[A-Za-z0-9]+$/.test(value)) {
		throw new Error(`"${input}" is not a valid Spotify ID, URI, or URL.`);
	}
	return { type: defaultType, id: value, uri: `spotify:${defaultType}:${value}` };
}

export const toId = (input: string, type: UriType) => parseSpotifyRef(input, type).id;
export const toUri = (input: string, type?: UriType) => parseSpotifyRef(input, type).uri;

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

const idArg = (what: string) => z.string().describe(`${what} — a Spotify ID, spotify: URI, or open.spotify.com URL.`);
const deviceArg = z.string().optional().describe('Optional Spotify device ID to target (see getAvailableDevices). Defaults to the active device.');
const limitArg = (max: number, def: number) =>
	z.number().int().min(1).max(max).optional().describe(`Maximum number of results (1-${max}, default ${def}).`);
const offsetArg = z.number().int().min(0).optional().describe('Zero-based pagination offset.');
const marketArg = z.string().length(2).optional().describe('Optional ISO 3166-1 alpha-2 market code. Defaults to the user\'s country.');

// ---------- formatting ----------

const names = (artists?: Array<{ name: string }>) => (artists ?? []).map((a) => a.name).join(', ') || 'Unknown artist';

export function formatItem(item: any): string {
	if (!item) return 'Unknown item';
	switch (item.type) {
		case 'track':
			return `"${item.name}" by ${names(item.artists)}${item.album?.name ? ` — ${item.album.name}` : ''} (${formatDuration(item.duration_ms ?? 0)}) [${item.uri}]`;
		case 'episode':
			return `Episode "${item.name}"${item.show?.name ? ` — ${item.show.name}` : ''} (${formatDuration(item.duration_ms ?? 0)}) [${item.uri}]`;
		case 'album':
			return `Album "${item.name}" by ${names(item.artists)}${item.release_date ? ` (${item.release_date})` : ''}${item.total_tracks ? `, ${item.total_tracks} tracks` : ''} [${item.uri}]`;
		case 'artist':
			return `Artist ${item.name}${item.genres?.length ? ` (${item.genres.slice(0, 3).join(', ')})` : ''} [${item.uri}]`;
		case 'playlist': {
			const owner = item.owner?.display_name ?? item.owner?.id ?? 'unknown';
			const total = item.items?.total ?? item.tracks?.total;
			return `Playlist "${item.name}" by ${owner}${total !== undefined ? `, ${total} items` : ''} [${item.uri}]`;
		}
		case 'show':
			return `Show "${item.name}"${item.total_episodes ? `, ${item.total_episodes} episodes` : ''} [${item.uri}]`;
		case 'audiobook':
			return `Audiobook "${item.name}" by ${names(item.authors)}${item.total_chapters ? `, ${item.total_chapters} chapters` : ''} [${item.uri}]`;
		case 'chapter':
			return `Chapter "${item.name}" (${formatDuration(item.duration_ms ?? 0)}) [${item.uri}]`;
		case 'user':
			return `User ${item.display_name ?? item.id} [${item.uri}]`;
		default:
			return `${item.name ?? item.id ?? 'item'}${item.uri ? ` [${item.uri}]` : ''}`;
	}
}

function numbered(items: any[], offset = 0, map: (item: any) => string = formatItem): string {
	const lines = items.filter(Boolean).map((item, index) => `${offset + index + 1}. ${map(item)}`);
	return lines.length ? lines.join('\n') : '(none)';
}

function page(title: string, data: { items?: any[]; total?: number; offset?: number; next?: string | null }, map?: (item: any) => string): string {
	const items = data.items ?? [];
	const offset = data.offset ?? 0;
	const range = items.length ? `${offset + 1}-${offset + items.length}` : '0';
	const total = data.total !== undefined ? ` of ${data.total}` : '';
	return `# ${title} (${range}${total})\n\n${numbered(items, offset, map)}${data.next ? '\n\n(more available — increase offset)' : ''}`;
}

function formatPlayback(state: any): string {
	if (!state) return 'Nothing is playing and no active device was found.';
	const lines: string[] = [];
	lines.push(`**Status**: ${state.is_playing ? 'Playing' : 'Paused'}`);
	if (state.item) {
		lines.push(`**Item**: ${formatItem(state.item)}`);
		lines.push(`**Progress**: ${formatDuration(state.progress_ms ?? 0)} / ${formatDuration(state.item.duration_ms ?? 0)}`);
	} else if (state.currently_playing_type) {
		lines.push(`**Item type**: ${state.currently_playing_type}`);
	}
	if (state.device) {
		lines.push(
			`**Device**: ${state.device.name} (${state.device.type}, id ${state.device.id ?? 'n/a'}, volume ${state.device.volume_percent ?? 'n/a'}%)`,
		);
	}
	if (state.shuffle_state !== undefined) lines.push(`**Shuffle**: ${state.shuffle_state ? 'on' : 'off'}${state.smart_shuffle ? ' (smart)' : ''}`);
	if (state.repeat_state) lines.push(`**Repeat**: ${state.repeat_state}`);
	if (state.context?.uri) lines.push(`**Context**: ${state.context.type} ${state.context.uri}`);
	return `# Playback\n\n${lines.join('\n')}`;
}

// ---------- shared operations ----------

async function searchTop(context: ToolContext, query: string, type: SearchType, limit = 1, market?: string): Promise<any[]> {
	const result = await spotifyRequest(context, 'GET', '/search', { query: { q: query, type, limit, market } });
	return (result?.[`${type}s`]?.items ?? []).filter(Boolean);
}

async function getCurrentItem(context: ToolContext): Promise<any> {
	const state = await spotifyRequest(context, 'GET', '/me/player/currently-playing', { query: { additional_types: 'track,episode' } });
	if (!state?.item) {
		throw new Error('Nothing is currently playing.');
	}
	return state.item;
}

async function startPlayback(
	context: ToolContext,
	options: { uris?: string[]; contextUri?: string; offsetPosition?: number; offsetUri?: string; positionMs?: number; deviceId?: string },
): Promise<void> {
	const body: Record<string, unknown> = {};
	if (options.contextUri) body.context_uri = options.contextUri;
	if (options.uris?.length) body.uris = options.uris;
	if (options.offsetUri) body.offset = { uri: options.offsetUri };
	else if (options.offsetPosition !== undefined) body.offset = { position: options.offsetPosition };
	if (options.positionMs !== undefined) body.position_ms = options.positionMs;
	await spotifyRequest(context, 'PUT', '/me/player/play', {
		query: { device_id: options.deviceId?.trim() || undefined },
		body: Object.keys(body).length ? body : undefined,
	});
}

async function libraryRequest(context: ToolContext, method: 'PUT' | 'DELETE', uris: string[]): Promise<void> {
	for (const batch of chunk(uris, 40)) {
		await spotifyRequest(context, method, '/me/library', { query: { uris: batch.join(',') } });
	}
}

async function libraryContains(context: ToolContext, uris: string[]): Promise<boolean[]> {
	const results: boolean[] = [];
	for (const batch of chunk(uris, 40)) {
		const res = await spotifyRequest<boolean[]>(context, 'GET', '/me/library/contains', { query: { uris: batch.join(',') } });
		results.push(...(res ?? []));
	}
	return results;
}

async function addItemsToPlaylist(context: ToolContext, playlistId: string, uris: string[], position?: number): Promise<string | undefined> {
	let snapshot: string | undefined;
	let insertAt = position;
	for (const batch of chunk(uris, 100)) {
		const res = await spotifyRequest(context, 'POST', `/playlists/${playlistId}/items`, {
			body: { uris: batch, ...(insertAt !== undefined ? { position: insertAt } : {}) },
		});
		snapshot = res?.snapshot_id ?? snapshot;
		if (insertAt !== undefined) insertAt += batch.length;
	}
	return snapshot;
}

async function getAll<T = any>(context: ToolContext, path: string, query: Query, max: number, pageSize = 50): Promise<T[]> {
	const out: T[] = [];
	let offset = Number(query.offset ?? 0);
	while (out.length < max) {
		const limit = Math.min(pageSize, max - out.length);
		const res = await spotifyRequest(context, 'GET', path, { query: { ...query, limit, offset } });
		const items: T[] = res?.items ?? [];
		out.push(...items);
		if (!res?.next || items.length === 0) break;
		offset += items.length;
	}
	return out;
}

function playlistEntry(entry: any): string {
	const item = entry?.item ?? entry?.track;
	const added = entry?.added_at ? ` (added ${entry.added_at.slice(0, 10)})` : '';
	return item ? `${formatItem(item)}${added}` : 'Unavailable item';
}

// ---------- tools ----------

function playerTools(context: ToolContext): SpotifyTool[] {
	return [
		tool({
			name: 'getNowPlaying',
			description: 'Get the currently playing track/episode, progress, device, shuffle and repeat state.',
			schema: {},
			readOnly: true,
			run: async () =>
				formatPlayback(await spotifyRequest(context, 'GET', '/me/player', { query: { additional_types: 'track,episode' } })),
		}),
		tool({
			name: 'getAvailableDevices',
			description: 'List Spotify Connect devices the user can play on, with IDs usable as deviceId.',
			schema: {},
			readOnly: true,
			run: async () => {
				const res = await spotifyRequest(context, 'GET', '/me/player/devices');
				const devices: any[] = res?.devices ?? [];
				if (!devices.length) return 'No Spotify devices are available. Open Spotify on a phone, computer, or speaker first.';
				return (
					'# Devices\n\n' +
					numbered(
						devices,
						0,
						(d) =>
							`${d.name} (${d.type})${d.is_active ? ' [ACTIVE]' : ''}${d.is_restricted ? ' [restricted]' : ''} — volume ${d.volume_percent ?? 'n/a'}% — id: ${d.id}`,
					)
				);
			},
		}),
		tool({
			name: 'transferPlayback',
			description: 'Move playback to another device (e.g. from phone to laptop/speaker).',
			schema: {
				deviceId: z.string().describe('Target device ID from getAvailableDevices.'),
				play: z.boolean().optional().describe('true = start playing on the new device; false/omitted = keep the current play/pause state.'),
			},
			run: async ({ deviceId, play }) => {
				await spotifyRequest(context, 'PUT', '/me/player', { body: { device_ids: [deviceId], ...(play !== undefined ? { play } : {}) } });
				return `Transferred playback to device ${deviceId}.`;
			},
		}),
		tool({
			name: 'playMusic',
			description:
				'Start playback. Pass `uris` (tracks/episodes to play in order) OR a context (`uri`/`contextUri` of an album, artist, playlist, show, audiobook). A single track uri plays that track. Omit everything to resume.',
			schema: {
				uri: z.string().optional().describe('A Spotify URI/URL of a track, episode, album, artist, playlist, show or audiobook.'),
				uris: z.array(z.string()).max(100).optional().describe('List of track/episode IDs, URIs, or URLs to play in order.'),
				contextUri: z.string().optional().describe('Album/artist/playlist/show/audiobook URI or URL to play as a context.'),
				type: z.enum(['track', 'album', 'artist', 'playlist', 'show', 'episode', 'audiobook']).optional().describe('Item type when passing a bare `id`.'),
				id: z.string().optional().describe('Bare Spotify ID (requires `type`).'),
				offsetPosition: z.number().int().min(0).optional().describe('Start at this zero-based position within the context.'),
				offsetUri: z.string().optional().describe('Start at this track URI within the context.'),
				positionMs: z.number().int().min(0).optional().describe('Start position within the first item, in milliseconds.'),
				deviceId: deviceArg,
			},
			run: async ({ uri, uris, contextUri, type, id, offsetPosition, offsetUri, positionMs, deviceId }) => {
				const playUris: string[] = (uris ?? []).map((u: string) => toUri(u, 'track'));
				let ctxUri = contextUri ? toUri(contextUri) : undefined;
				const single = uri ? parseSpotifyRef(uri, type) : id && type ? parseSpotifyRef(id, type) : undefined;
				if (single) {
					if (single.type === 'track' || single.type === 'episode') playUris.unshift(single.uri);
					else ctxUri = single.uri;
				}
				await startPlayback(context, {
					uris: playUris.length ? playUris : undefined,
					contextUri: ctxUri,
					offsetPosition,
					offsetUri: offsetUri ? toUri(offsetUri, 'track') : undefined,
					positionMs,
					deviceId,
				});
				if (ctxUri) return `Started playing ${ctxUri}${playUris.length ? ` (ignored track list in favour of context)` : ''}.`;
				if (playUris.length) return `Started playing ${playUris.length} item(s): ${playUris.slice(0, 5).join(', ')}${playUris.length > 5 ? ', …' : ''}`;
				return 'Resumed playback.';
			},
		}),
		tool({
			name: 'playSearch',
			description: 'Search Spotify and immediately play the top result (e.g. "play Blinding Lights", "play the album Blonde", "play my Discover Weekly"-style playlist names).',
			schema: {
				query: z.string().describe('What to search for.'),
				type: z.enum(SEARCH_TYPES).optional().describe('Type of thing to play (default track).'),
				deviceId: deviceArg,
			},
			run: async ({ query, type = 'track', deviceId }) => {
				const [top] = await searchTop(context, query, type);
				if (!top) return `No ${type} found for "${query}".`;
				if (type === 'track' || type === 'episode') await startPlayback(context, { uris: [top.uri], deviceId });
				else await startPlayback(context, { contextUri: top.uri, deviceId });
				return `Now playing ${formatItem(top)}`;
			},
		}),
		tool({
			name: 'pausePlayback',
			description: 'Pause playback.',
			schema: { deviceId: deviceArg },
			run: async ({ deviceId }) => {
				await spotifyRequest(context, 'PUT', '/me/player/pause', { query: { device_id: deviceId } });
				return 'Playback paused.';
			},
		}),
		tool({
			name: 'resumePlayback',
			description: 'Resume playback where it left off.',
			schema: { deviceId: deviceArg },
			run: async ({ deviceId }) => {
				await startPlayback(context, { deviceId });
				return 'Playback resumed.';
			},
		}),
		tool({
			name: 'skipToNext',
			description: 'Skip to the next item in the queue.',
			schema: { deviceId: deviceArg },
			run: async ({ deviceId }) => {
				await spotifyRequest(context, 'POST', '/me/player/next', { query: { device_id: deviceId } });
				return 'Skipped to the next item.';
			},
		}),
		tool({
			name: 'skipToPrevious',
			description: 'Go back to the previous item.',
			schema: { deviceId: deviceArg },
			run: async ({ deviceId }) => {
				await spotifyRequest(context, 'POST', '/me/player/previous', { query: { device_id: deviceId } });
				return 'Went back to the previous item.';
			},
		}),
		tool({
			name: 'seekToPosition',
			description: 'Seek within the current item.',
			schema: {
				positionMs: z.number().int().min(0).optional().describe('Absolute position in milliseconds.'),
				positionSeconds: z.number().min(0).optional().describe('Absolute position in seconds (alternative to positionMs).'),
				relativeSeconds: z.number().optional().describe('Seek forward (+) or back (-) relative to the current position.'),
				deviceId: deviceArg,
			},
			run: async ({ positionMs, positionSeconds, relativeSeconds, deviceId }) => {
				let target = positionMs ?? (positionSeconds !== undefined ? Math.round(positionSeconds * 1000) : undefined);
				if (target === undefined && relativeSeconds !== undefined) {
					const state = await spotifyRequest(context, 'GET', '/me/player');
					if (!state) throw new Error('Nothing is playing.');
					target = Math.max(0, (state.progress_ms ?? 0) + Math.round(relativeSeconds * 1000));
				}
				if (target === undefined) throw new Error('Provide positionMs, positionSeconds, or relativeSeconds.');
				await spotifyRequest(context, 'PUT', '/me/player/seek', { query: { position_ms: target, device_id: deviceId } });
				return `Seeked to ${formatDuration(target)}.`;
			},
		}),
		tool({
			name: 'setRepeatMode',
			description: 'Set repeat mode: "track" (repeat one), "context" (repeat album/playlist), or "off".',
			schema: { state: z.enum(['track', 'context', 'off']), deviceId: deviceArg },
			run: async ({ state, deviceId }) => {
				await spotifyRequest(context, 'PUT', '/me/player/repeat', { query: { state, device_id: deviceId } });
				return `Repeat set to ${state}.`;
			},
		}),
		tool({
			name: 'setShuffle',
			description: 'Turn shuffle on or off.',
			schema: { state: z.boolean().describe('true = shuffle on, false = off.'), deviceId: deviceArg },
			run: async ({ state, deviceId }) => {
				await spotifyRequest(context, 'PUT', '/me/player/shuffle', { query: { state, device_id: deviceId } });
				return `Shuffle ${state ? 'enabled' : 'disabled'}.`;
			},
		}),
		tool({
			name: 'setVolume',
			description: 'Set playback volume (0-100).',
			schema: { volumePercent: z.number().min(0).max(100), deviceId: deviceArg },
			run: async ({ volumePercent, deviceId }) => {
				const volume = Math.round(volumePercent);
				await spotifyRequest(context, 'PUT', '/me/player/volume', { query: { volume_percent: volume, device_id: deviceId } });
				return `Volume set to ${volume}%.`;
			},
		}),
		tool({
			name: 'adjustVolume',
			description: 'Raise or lower the volume relative to the current level.',
			schema: { adjustment: z.number().min(-100).max(100).describe('Relative change, e.g. 10 or -15.'), deviceId: deviceArg },
			run: async ({ adjustment, deviceId }) => {
				const state = await spotifyRequest(context, 'GET', '/me/player');
				const current = state?.device?.volume_percent;
				if (current === undefined || current === null) throw new Error('No active device with a readable volume.');
				const volume = Math.min(100, Math.max(0, Math.round(current + adjustment)));
				await spotifyRequest(context, 'PUT', '/me/player/volume', { query: { volume_percent: volume, device_id: deviceId } });
				return `Volume changed from ${current}% to ${volume}%.`;
			},
		}),
		tool({
			name: 'getQueue',
			description: 'Show what is playing now and what is up next in the queue.',
			schema: { limit: limitArg(50, 20) },
			readOnly: true,
			run: async ({ limit = 20 }) => {
				const res = await spotifyRequest(context, 'GET', '/me/player/queue');
				const queue: any[] = res?.queue ?? [];
				return `# Queue\n\n**Now playing**: ${res?.currently_playing ? formatItem(res.currently_playing) : 'nothing'}\n\n**Up next**:\n${numbered(queue.slice(0, limit))}`;
			},
		}),
		tool({
			name: 'addToQueue',
			description:
				'Add tracks/episodes to the end of the queue. Pass `uri`, a list in `uris`, or a `query` to queue the top search result(s).',
			schema: {
				uri: z.string().optional().describe('Track/episode URI, URL, or ID.'),
				uris: z.array(z.string()).max(50).optional().describe('Several track/episode URIs, URLs, or IDs, queued in order.'),
				type: z.enum(['track', 'episode']).optional().describe('Type for bare IDs (default track).'),
				id: z.string().optional().describe('Bare ID (legacy; prefer uri).'),
				query: z.string().optional().describe('Search query; the top result(s) get queued.'),
				count: z.number().int().min(1).max(10).optional().describe('With `query`: how many top results to queue (default 1).'),
				deviceId: deviceArg,
			},
			run: async ({ uri, uris, type = 'track', id, query, count = 1, deviceId }) => {
				const list: string[] = [];
				if (uri) list.push(toUri(uri, type));
				if (id) list.push(toUri(id, type));
				for (const u of uris ?? []) list.push(toUri(u, type));
				if (query) {
					const found = await searchTop(context, query, type, count);
					if (!found.length) throw new Error(`No ${type} found for "${query}".`);
					list.push(...found.map((item) => item.uri));
				}
				if (!list.length) throw new Error('Provide uri, uris, id, or query.');
				for (const itemUri of list) {
					const ref = parseSpotifyRef(itemUri);
					if (ref.type !== 'track' && ref.type !== 'episode') {
						throw new Error(`Only tracks and episodes can be queued (got ${ref.type}). Use playMusic for albums/playlists.`);
					}
					await spotifyRequest(context, 'POST', '/me/player/queue', { query: { uri: itemUri, device_id: deviceId } });
				}
				return `Queued ${list.length} item(s): ${list.join(', ')}`;
			},
		}),
		tool({
			name: 'getRecentlyPlayed',
			description: 'Get recently played tracks (up to 50).',
			schema: {
				limit: limitArg(50, 20),
				before: z.number().int().optional().describe('Unix ms timestamp; return items played before this.'),
				after: z.number().int().optional().describe('Unix ms timestamp; return items played after this.'),
			},
			readOnly: true,
			run: async ({ limit = 20, before, after }) => {
				const res = await spotifyRequest(context, 'GET', '/me/player/recently-played', { query: { limit, before, after } });
				return `# Recently played\n\n${numbered(res?.items ?? [], 0, (e) => `${formatItem(e.track)} — played ${e.played_at}`)}`;
			},
		}),
	];
}

function searchAndCatalogTools(context: ToolContext): SpotifyTool[] {
	return [
		tool({
			name: 'searchSpotify',
			description: 'Search Spotify for tracks, albums, artists, playlists, shows, episodes, or audiobooks. Supports filters like artist:, album:, year:, genre: in the query.',
			schema: {
				query: z.string().describe('Search query, e.g. "kendrick lamar" or "track:humble artist:kendrick".'),
				type: z.enum(SEARCH_TYPES).optional().describe('Single type to search (default track).'),
				types: z.array(z.enum(SEARCH_TYPES)).optional().describe('Search several types at once (overrides type).'),
				limit: limitArg(10, 10),
				offset: offsetArg,
				market: marketArg,
			},
			readOnly: true,
			run: async ({ query, type = 'track', types, limit = 10, offset, market }) => {
				const selected: SearchType[] = types?.length ? types : [type];
				const res = await spotifyRequest(context, 'GET', '/search', {
					query: { q: query, type: selected.join(','), limit, offset, market },
				});
				const sections = selected.map((t) => {
					const bucket = res?.[`${t}s`];
					return `## ${t}s\n${numbered(bucket?.items ?? [], bucket?.offset ?? 0)}`;
				});
				return `# Search results for "${query}"\n\n${sections.join('\n\n')}`;
			},
		}),
		tool({
			name: 'getTrack',
			description: 'Get details for one or more tracks.',
			schema: { trackIds: z.union([z.string(), z.array(z.string()).max(20)]).describe('Track ID/URI/URL or a list of them.'), market: marketArg },
			readOnly: true,
			run: async ({ trackIds, market }) => {
				const ids: string[] = Array.isArray(trackIds) ? trackIds : [trackIds];
				const tracks = await Promise.all(ids.map((t) => spotifyRequest(context, 'GET', `/tracks/${toId(t, 'track')}`, { query: { market } })));
				return `# Tracks\n\n${numbered(tracks, 0, (t) => `${formatItem(t)} — album "${t.album?.name}" (${t.album?.release_date ?? '?'})${t.explicit ? ' [explicit]' : ''} — ${t.external_urls?.spotify ?? ''}`)}`;
			},
		}),
		tool({
			name: 'getAlbums',
			description: 'Get details for one or more albums.',
			schema: { albumIds: z.union([z.string(), z.array(z.string()).max(20)]).describe('Album ID/URI/URL or a list of them.'), market: marketArg },
			readOnly: true,
			run: async ({ albumIds, market }) => {
				const ids: string[] = Array.isArray(albumIds) ? albumIds : [albumIds];
				const albums = await Promise.all(ids.map((a) => spotifyRequest(context, 'GET', `/albums/${toId(a, 'album')}`, { query: { market } })));
				return `# Albums\n\n${numbered(albums, 0, (a) => `${formatItem(a)} — ${a.album_type ?? 'album'} — ${a.external_urls?.spotify ?? ''}`)}`;
			},
		}),
		tool({
			name: 'getAlbumTracks',
			description: 'List the tracks on an album.',
			schema: { albumId: idArg('Album'), limit: limitArg(50, 50), offset: offsetArg, market: marketArg },
			readOnly: true,
			run: async ({ albumId, limit = 50, offset = 0, market }) => {
				const res = await spotifyRequest(context, 'GET', `/albums/${toId(albumId, 'album')}/tracks`, { query: { limit, offset, market } });
				return page('Album tracks', res ?? {});
			},
		}),
		tool({
			name: 'getArtist',
			description: 'Get an artist profile (name, genres, images).',
			schema: { artistId: idArg('Artist') },
			readOnly: true,
			run: async ({ artistId }) => {
				const a = await spotifyRequest(context, 'GET', `/artists/${toId(artistId, 'artist')}`);
				return `# ${a.name}\n\n**Genres**: ${a.genres?.join(', ') || 'n/a'}\n**URI**: ${a.uri}\n**URL**: ${a.external_urls?.spotify ?? ''}`;
			},
		}),
		tool({
			name: 'getArtistAlbums',
			description: "List an artist's albums, singles, compilations and appearances.",
			schema: {
				artistId: idArg('Artist'),
				includeGroups: z.array(z.enum(['album', 'single', 'appears_on', 'compilation'])).optional().describe('Filter by release group (default album,single).'),
				limit: limitArg(50, 20),
				offset: offsetArg,
				market: marketArg,
			},
			readOnly: true,
			run: async ({ artistId, includeGroups, limit = 20, offset = 0, market }) => {
				const res = await spotifyRequest(context, 'GET', `/artists/${toId(artistId, 'artist')}/albums`, {
					query: { include_groups: (includeGroups ?? ['album', 'single']).join(','), limit, offset, market },
				});
				return page('Artist releases', res ?? {});
			},
		}),
		tool({
			name: 'getShow',
			description: 'Get a podcast show and its latest episodes.',
			schema: { showId: idArg('Show'), market: marketArg },
			readOnly: true,
			run: async ({ showId, market }) => {
				const s = await spotifyRequest(context, 'GET', `/shows/${toId(showId, 'show')}`, { query: { market } });
				return `# ${s.name}\n\n${s.description ?? ''}\n\n**URI**: ${s.uri}\n\n## Latest episodes\n${numbered(s.episodes?.items?.slice(0, 10) ?? [], 0, (e) => `${formatItem({ ...e, type: 'episode' })} — ${e.release_date ?? ''}`)}`;
			},
		}),
		tool({
			name: 'getShowEpisodes',
			description: 'List episodes of a podcast show.',
			schema: { showId: idArg('Show'), limit: limitArg(50, 20), offset: offsetArg, market: marketArg },
			readOnly: true,
			run: async ({ showId, limit = 20, offset = 0, market }) => {
				const res = await spotifyRequest(context, 'GET', `/shows/${toId(showId, 'show')}/episodes`, { query: { limit, offset, market } });
				return page('Episodes', res ?? {}, (e) => `${formatItem({ ...e, type: 'episode' })} — ${e.release_date ?? ''}`);
			},
		}),
		tool({
			name: 'getEpisode',
			description: 'Get a podcast episode, including description and resume point.',
			schema: { episodeId: idArg('Episode'), market: marketArg },
			readOnly: true,
			run: async ({ episodeId, market }) => {
				const e = await spotifyRequest(context, 'GET', `/episodes/${toId(episodeId, 'episode')}`, { query: { market } });
				const resume = e.resume_point ? `\n**Resume point**: ${e.resume_point.fully_played ? 'fully played' : formatDuration(e.resume_point.resume_position_ms ?? 0)}` : '';
				return `# ${formatItem(e)}\n\n**Released**: ${e.release_date ?? '?'}${resume}\n\n${e.description ?? ''}`;
			},
		}),
		tool({
			name: 'getAudiobook',
			description: 'Get an audiobook and its chapters.',
			schema: { audiobookId: idArg('Audiobook'), market: marketArg },
			readOnly: true,
			run: async ({ audiobookId, market }) => {
				const b = await spotifyRequest(context, 'GET', `/audiobooks/${toId(audiobookId, 'audiobook')}`, { query: { market } });
				return `# ${formatItem(b)}\n\n**Narrators**: ${names(b.narrators)}\n\n${b.description ?? ''}\n\n## Chapters\n${numbered(b.chapters?.items ?? [], 0, (c) => formatItem({ ...c, type: 'chapter' }))}`;
			},
		}),
		tool({
			name: 'getAudiobookChapters',
			description: 'List chapters of an audiobook.',
			schema: { audiobookId: idArg('Audiobook'), limit: limitArg(50, 20), offset: offsetArg, market: marketArg },
			readOnly: true,
			run: async ({ audiobookId, limit = 20, offset = 0, market }) => {
				const res = await spotifyRequest(context, 'GET', `/audiobooks/${toId(audiobookId, 'audiobook')}/chapters`, { query: { limit, offset, market } });
				return page('Chapters', res ?? {}, (c) => formatItem({ ...c, type: 'chapter' }));
			},
		}),
		tool({
			name: 'getChapter',
			description: 'Get a single audiobook chapter.',
			schema: { chapterId: idArg('Chapter'), market: marketArg },
			readOnly: true,
			run: async ({ chapterId, market }) => {
				const c = await spotifyRequest(context, 'GET', `/chapters/${toId(chapterId, 'chapter')}`, { query: { market } });
				return `# ${formatItem(c)}\n\n${c.description ?? ''}`;
			},
		}),
	];
}

function libraryTools(context: ToolContext): SpotifyTool[] {
	const savedList = (name: string, description: string, path: string, title: string, pick: (entry: any) => any) =>
		tool({
			name,
			description,
			schema: { limit: limitArg(50, 20), offset: offsetArg },
			readOnly: true,
			run: async ({ limit = 20, offset = 0 }) => {
				const res = await spotifyRequest(context, 'GET', path, { query: { limit, offset } });
				return page(title, res ?? {}, (entry) => `${formatItem(pick(entry))}${entry.added_at ? ` (saved ${entry.added_at.slice(0, 10)})` : ''}`);
			},
		});

	const itemsArg = z
		.array(z.string())
		.min(1)
		.max(200)
		.describe('Spotify URIs or open.spotify.com URLs (tracks, albums, episodes, shows, audiobooks, playlists, users, artists). Bare IDs use `defaultType`.');
	const defaultTypeArg = z.enum(URI_TYPES).optional().describe('Type assumed for bare IDs (default track).');

	return [
		savedList('getUsersSavedTracks', 'List the user\'s Liked Songs.', '/me/tracks', 'Liked Songs', (e) => e.track),
		savedList('getSavedAlbums', 'List albums saved in the user\'s library.', '/me/albums', 'Saved albums', (e) => e.album),
		savedList('getSavedShows', 'List podcasts the user follows.', '/me/shows', 'Saved shows', (e) => e.show),
		savedList('getSavedEpisodes', 'List podcast episodes saved by the user.', '/me/episodes', 'Saved episodes', (e) => e.episode),
		savedList('getSavedAudiobooks', 'List audiobooks saved by the user.', '/me/audiobooks', 'Saved audiobooks', (e) => e),
		tool({
			name: 'getFollowedArtists',
			description: 'List artists the user follows.',
			schema: { limit: limitArg(50, 20), after: z.string().optional().describe('Cursor: last artist ID from the previous page.') },
			readOnly: true,
			run: async ({ limit = 20, after }) => {
				const res = await spotifyRequest(context, 'GET', '/me/following', { query: { type: 'artist', limit, after } });
				const artists = res?.artists ?? {};
				return `# Followed artists (${artists.total ?? '?'} total)\n\n${numbered(artists.items ?? [])}${artists.cursors?.after ? `\n\n(next page: after=${artists.cursors.after})` : ''}`;
			},
		}),
		tool({
			name: 'saveToLibrary',
			description: 'Save/like/follow items: like songs, save albums/episodes/audiobooks, follow shows, playlists, users or artists.',
			schema: { items: itemsArg, defaultType: defaultTypeArg },
			run: async ({ items, defaultType = 'track' }) => {
				const uris = items.map((i: string) => toUri(i, defaultType));
				await libraryRequest(context, 'PUT', uris);
				return `Saved ${uris.length} item(s) to the library: ${uris.join(', ')}`;
			},
		}),
		tool({
			name: 'removeFromLibrary',
			description: 'Remove/unlike/unfollow items from the user\'s library.',
			schema: { items: itemsArg, defaultType: defaultTypeArg },
			run: async ({ items, defaultType = 'track' }) => {
				const uris = items.map((i: string) => toUri(i, defaultType));
				await libraryRequest(context, 'DELETE', uris);
				return `Removed ${uris.length} item(s) from the library: ${uris.join(', ')}`;
			},
		}),
		tool({
			name: 'checkLibrary',
			description: 'Check whether items are saved/liked/followed by the user.',
			schema: { items: itemsArg, defaultType: defaultTypeArg },
			readOnly: true,
			run: async ({ items, defaultType = 'track' }) => {
				const uris: string[] = items.map((i: string) => toUri(i, defaultType));
				const saved = await libraryContains(context, uris);
				return `# Library status\n\n${uris.map((u, i) => `${i + 1}. ${u}: ${saved[i] ? 'saved' : 'not saved'}`).join('\n')}`;
			},
		}),
		tool({
			name: 'likeCurrentTrack',
			description: 'Like (save to Liked Songs) or unlike whatever is playing right now.',
			schema: { action: z.enum(['like', 'unlike']).optional().describe('Default like.') },
			run: async ({ action = 'like' }) => {
				const item = await getCurrentItem(context);
				await libraryRequest(context, action === 'like' ? 'PUT' : 'DELETE', [item.uri]);
				return `${action === 'like' ? 'Liked' : 'Unliked'} ${formatItem(item)}`;
			},
		}),
		tool({
			name: 'removeUsersSavedTracks',
			description: 'Remove tracks from Liked Songs.',
			schema: { trackIds: z.array(z.string()).min(1).max(200).describe('Track IDs, URIs, or URLs.') },
			run: async ({ trackIds }) => {
				await libraryRequest(context, 'DELETE', trackIds.map((t: string) => toUri(t, 'track')));
				return `Removed ${trackIds.length} track(s) from Liked Songs.`;
			},
		}),
		tool({
			name: 'saveOrRemoveAlbumForUser',
			description: 'Save or remove albums from the user\'s library.',
			schema: { albumIds: z.array(z.string()).min(1).max(200), action: z.enum(['save', 'remove']) },
			run: async ({ albumIds, action }) => {
				await libraryRequest(context, action === 'save' ? 'PUT' : 'DELETE', albumIds.map((a: string) => toUri(a, 'album')));
				return `${action === 'save' ? 'Saved' : 'Removed'} ${albumIds.length} album(s).`;
			},
		}),
		tool({
			name: 'checkUsersSavedAlbums',
			description: 'Check whether albums are saved in the user\'s library.',
			schema: { albumIds: z.array(z.string()).min(1).max(200) },
			readOnly: true,
			run: async ({ albumIds }) => {
				const uris: string[] = albumIds.map((a: string) => toUri(a, 'album'));
				const saved = await libraryContains(context, uris);
				return `# Album save status\n\n${uris.map((u, i) => `${i + 1}. ${u}: ${saved[i] ? 'Saved' : 'Not saved'}`).join('\n')}`;
			},
		}),
	];
}

function userTools(context: ToolContext): SpotifyTool[] {
	return [
		tool({
			name: 'getMyProfile',
			description: 'Get the connected Spotify account profile.',
			schema: {},
			readOnly: true,
			run: async () => {
				const me = await spotifyRequest(context, 'GET', '/me');
				return `# ${me.display_name ?? me.id}\n\n**User ID**: ${me.id}\n**URI**: ${me.uri}${me.product ? `\n**Plan**: ${me.product}` : ''}${me.country ? `\n**Country**: ${me.country}` : ''}\n**URL**: ${me.external_urls?.spotify ?? ''}`;
			},
		}),
		tool({
			name: 'getTopItems',
			description: "Get the user's top artists or tracks (their personal 'Wrapped'-style stats).",
			schema: {
				type: z.enum(['artists', 'tracks']),
				timeRange: z.enum(['short_term', 'medium_term', 'long_term']).optional().describe('short_term ≈ 4 weeks, medium_term ≈ 6 months (default), long_term ≈ 1 year.'),
				limit: limitArg(50, 20),
				offset: offsetArg,
			},
			readOnly: true,
			run: async ({ type, timeRange = 'medium_term', limit = 20, offset = 0 }) => {
				const res = await spotifyRequest(context, 'GET', `/me/top/${type}`, { query: { time_range: timeRange, limit, offset } });
				return page(`Top ${type} (${timeRange})`, res ?? {});
			},
		}),
	];
}

function playlistTools(context: ToolContext): SpotifyTool[] {
	return [
		tool({
			name: 'getMyPlaylists',
			description: "List the user's playlists (owned and followed).",
			schema: { limit: limitArg(50, 50), offset: offsetArg },
			readOnly: true,
			run: async ({ limit = 50, offset = 0 }) => {
				const res = await spotifyRequest(context, 'GET', '/me/playlists', { query: { limit, offset } });
				return page('Playlists', res ?? {}, (p) => `${formatItem(p)}${p.collaborative ? ' [collaborative]' : ''} — id: ${p.id}`);
			},
		}),
		tool({
			name: 'findMyPlaylist',
			description: "Find one of the user's own/followed playlists by (partial) name.",
			schema: { name: z.string() },
			readOnly: true,
			run: async ({ name }) => {
				const all = await getAll(context, '/me/playlists', {}, 500);
				const needle = name.toLowerCase();
				const hits = all.filter((p: any) => p?.name?.toLowerCase().includes(needle));
				return hits.length ? `# Matching playlists\n\n${numbered(hits, 0, (p) => `${formatItem(p)} — id: ${p.id}`)}` : `No playlist matching "${name}" among ${all.length} playlists.`;
			},
		}),
		tool({
			name: 'getPlaylist',
			description: 'Get playlist details (name, owner, description, item count).',
			schema: { playlistId: idArg('Playlist') },
			readOnly: true,
			run: async ({ playlistId }) => {
				const p = await spotifyRequest(context, 'GET', `/playlists/${toId(playlistId, 'playlist')}`);
				const total = p.items?.total ?? p.tracks?.total;
				return (
					`# Playlist: "${p.name}"\n\n` +
					`**Owner**: ${p.owner?.display_name ?? p.owner?.id ?? 'Unknown'}\n` +
					`**Items**: ${total ?? 'n/a (not owned by you)'}\n` +
					`**Visibility**: ${p.public ? 'Public' : 'Private'}${p.collaborative ? ', collaborative' : ''}\n` +
					`**Description**: ${p.description || 'None'}\n` +
					`**Snapshot**: ${p.snapshot_id}\n**ID**: ${p.id}\n**URL**: ${p.external_urls?.spotify ?? ''}`
				);
			},
		}),
		tool({
			name: 'getPlaylistTracks',
			description: 'List the items of a playlist (only playlists the user owns or collaborates on).',
			schema: { playlistId: idArg('Playlist'), limit: limitArg(50, 50), offset: offsetArg },
			readOnly: true,
			run: async ({ playlistId, limit = 50, offset = 0 }) => {
				const res = await spotifyRequest(context, 'GET', `/playlists/${toId(playlistId, 'playlist')}/items`, {
					query: { limit, offset, additional_types: 'track,episode' },
				});
				return page('Playlist items', res ?? {}, playlistEntry);
			},
		}),
		tool({
			name: 'createPlaylist',
			description: 'Create a new playlist for the user, optionally pre-filled with tracks.',
			schema: {
				name: z.string(),
				description: z.string().optional(),
				public: z.boolean().optional().describe('Default false (private).'),
				collaborative: z.boolean().optional().describe('Collaborative playlists must be private.'),
				items: z.array(z.string()).optional().describe('Optional track/episode IDs, URIs, or URLs to add.'),
			},
			run: async ({ name, description, public: isPublic = false, collaborative, items }) => {
				const p = await spotifyRequest(context, 'POST', '/me/playlists', {
					body: { name, description, public: collaborative ? false : isPublic, ...(collaborative !== undefined ? { collaborative } : {}) },
				});
				let added = '';
				if (items?.length) {
					await addItemsToPlaylist(context, p.id, items.map((i: string) => toUri(i, 'track')));
					added = ` with ${items.length} item(s)`;
				}
				return `Created playlist "${p.name}"${added}. ID: ${p.id} — ${p.external_urls?.spotify ?? p.uri}`;
			},
		}),
		tool({
			name: 'addTracksToPlaylist',
			description: 'Add tracks or episodes to a playlist.',
			schema: {
				playlistId: idArg('Playlist'),
				trackIds: z.array(z.string()).optional().describe('Track IDs, URIs, or URLs.'),
				uris: z.array(z.string()).optional().describe('Track/episode URIs or URLs (alias of trackIds).'),
				position: z.number().int().min(0).optional().describe('Zero-based insert position; omit to append.'),
			},
			run: async ({ playlistId, trackIds, uris, position }) => {
				const list = [...(trackIds ?? []), ...(uris ?? [])].map((t: string) => toUri(t, 'track'));
				if (!list.length) throw new Error('Provide trackIds or uris.');
				await addItemsToPlaylist(context, toId(playlistId, 'playlist'), list, position);
				return `Added ${list.length} item(s) to playlist ${toId(playlistId, 'playlist')}.`;
			},
		}),
		tool({
			name: 'addCurrentTrackToPlaylist',
			description: 'Add whatever is playing right now to a playlist.',
			schema: { playlistId: idArg('Playlist') },
			run: async ({ playlistId }) => {
				const item = await getCurrentItem(context);
				await addItemsToPlaylist(context, toId(playlistId, 'playlist'), [item.uri]);
				return `Added ${formatItem(item)} to playlist ${toId(playlistId, 'playlist')}.`;
			},
		}),
		tool({
			name: 'removeTracksFromPlaylist',
			description: 'Remove tracks/episodes (all occurrences) from a playlist.',
			schema: {
				playlistId: idArg('Playlist'),
				trackIds: z.array(z.string()).min(1).max(100).describe('Track IDs, URIs, or URLs (episodes need full URIs).'),
				snapshotId: z.string().optional(),
			},
			run: async ({ playlistId, trackIds, snapshotId }) => {
				await spotifyRequest(context, 'DELETE', `/playlists/${toId(playlistId, 'playlist')}/items`, {
					body: { items: trackIds.map((t: string) => ({ uri: toUri(t, 'track') })), ...(snapshotId ? { snapshot_id: snapshotId } : {}) },
				});
				return `Removed ${trackIds.length} item(s) from playlist ${toId(playlistId, 'playlist')}.`;
			},
		}),
		tool({
			name: 'reorderPlaylistItems',
			description: 'Move a contiguous block of items within a playlist.',
			schema: {
				playlistId: idArg('Playlist'),
				rangeStart: z.number().int().min(0).describe('Index of the first item to move.'),
				insertBefore: z.number().int().min(0).describe('Index to move the items before (use the playlist length to move to the end).'),
				rangeLength: z.number().int().min(1).optional().describe('How many consecutive items to move (default 1).'),
				snapshotId: z.string().optional(),
			},
			run: async ({ playlistId, rangeStart, insertBefore, rangeLength, snapshotId }) => {
				await spotifyRequest(context, 'PUT', `/playlists/${toId(playlistId, 'playlist')}/items`, {
					body: {
						range_start: rangeStart,
						insert_before: insertBefore,
						...(rangeLength !== undefined ? { range_length: rangeLength } : {}),
						...(snapshotId ? { snapshot_id: snapshotId } : {}),
					},
				});
				return `Moved ${rangeLength ?? 1} item(s) from position ${rangeStart} to before ${insertBefore}.`;
			},
		}),
		tool({
			name: 'replacePlaylistItems',
			description: 'Replace ALL items of a playlist with the given list (an empty list clears the playlist).',
			schema: { playlistId: idArg('Playlist'), uris: z.array(z.string()).describe('Track/episode IDs, URIs, or URLs; empty array clears.') },
			run: async ({ playlistId, uris }) => {
				const id = toId(playlistId, 'playlist');
				const list: string[] = uris.map((u: string) => toUri(u, 'track'));
				await spotifyRequest(context, 'PUT', `/playlists/${id}/items`, { body: { uris: list.slice(0, 100) } });
				if (list.length > 100) await addItemsToPlaylist(context, id, list.slice(100));
				return list.length ? `Replaced playlist ${id} contents with ${list.length} item(s).` : `Cleared playlist ${id}.`;
			},
		}),
		tool({
			name: 'updatePlaylist',
			description: 'Change a playlist name, description, public flag, or collaborative flag.',
			schema: {
				playlistId: idArg('Playlist'),
				name: z.string().optional(),
				description: z.string().optional(),
				public: z.boolean().optional(),
				collaborative: z.boolean().optional(),
			},
			run: async ({ playlistId, name, description, public: isPublic, collaborative }) => {
				const body: Record<string, unknown> = {};
				if (name) body.name = name;
				if (description !== undefined) body.description = description;
				if (isPublic !== undefined) body.public = isPublic;
				if (collaborative !== undefined) body.collaborative = collaborative;
				if (!Object.keys(body).length) throw new Error('Provide at least one field to update.');
				await spotifyRequest(context, 'PUT', `/playlists/${toId(playlistId, 'playlist')}`, { body });
				return `Updated playlist ${toId(playlistId, 'playlist')}: ${Object.keys(body).join(', ')}.`;
			},
		}),
		tool({
			name: 'getPlaylistCoverImage',
			description: 'Get the cover image URL(s) of a playlist.',
			schema: { playlistId: idArg('Playlist') },
			readOnly: true,
			run: async ({ playlistId }) => {
				const images: any[] = (await spotifyRequest(context, 'GET', `/playlists/${toId(playlistId, 'playlist')}/images`)) ?? [];
				return images.length ? images.map((i) => `${i.url}${i.width ? ` (${i.width}x${i.height})` : ''}`).join('\n') : 'No cover image.';
			},
		}),
		tool({
			name: 'uploadPlaylistCoverImage',
			description: 'Set a custom playlist cover from a public JPEG URL or base64 JPEG (max 256 KB).',
			schema: {
				playlistId: idArg('Playlist'),
				imageUrl: z.string().url().optional().describe('Public URL of a JPEG image.'),
				imageBase64: z.string().optional().describe('Base64-encoded JPEG data (no data: prefix).'),
			},
			run: async ({ playlistId, imageUrl, imageBase64 }) => {
				let data = imageBase64?.replace(/^data:image\/jpeg;base64,/, '').trim();
				if (!data && imageUrl) {
					const res = await fetch(imageUrl);
					if (!res.ok) throw new Error(`Could not download image: HTTP ${res.status}`);
					const bytes = new Uint8Array(await res.arrayBuffer());
					let binary = '';
					for (const byte of bytes) binary += String.fromCharCode(byte);
					data = btoa(binary);
				}
				if (!data) throw new Error('Provide imageUrl or imageBase64.');
				if (data.length > 256 * 1024) throw new Error(`Image is ${Math.round(data.length / 1024)} KB base64; Spotify's limit is 256 KB.`);
				await spotifyRequest(context, 'PUT', `/playlists/${toId(playlistId, 'playlist')}/images`, { rawBody: data, contentType: 'image/jpeg' });
				return `Uploaded a new cover for playlist ${toId(playlistId, 'playlist')}.`;
			},
		}),
		tool({
			name: 'createPlaylistFromTopTracks',
			description: "Create a playlist from the user's top tracks for a time range (e.g. 'my top 50 this month').",
			schema: {
				name: z.string().optional(),
				timeRange: z.enum(['short_term', 'medium_term', 'long_term']).optional().describe('Default short_term (~4 weeks).'),
				limit: z.number().int().min(1).max(100).optional().describe('Number of tracks (default 50).'),
				public: z.boolean().optional(),
			},
			run: async ({ name, timeRange = 'short_term', limit = 50, public: isPublic = false }) => {
				const tracks = await getAll(context, `/me/top/tracks`, { time_range: timeRange }, limit);
				if (!tracks.length) throw new Error('Spotify returned no top tracks for that range.');
				const label = { short_term: 'last 4 weeks', medium_term: 'last 6 months', long_term: 'last year' }[timeRange as string];
				const p = await spotifyRequest(context, 'POST', '/me/playlists', {
					body: { name: name ?? `Top tracks — ${label}`, description: `Top ${tracks.length} tracks (${label}).`, public: isPublic },
				});
				await addItemsToPlaylist(context, p.id, tracks.map((t: any) => t.uri));
				return `Created "${p.name}" with ${tracks.length} tracks. ID: ${p.id} — ${p.external_urls?.spotify ?? p.uri}`;
			},
		}),
		tool({
			name: 'saveQueueAsPlaylist',
			description: 'Snapshot the current track plus the upcoming queue into a new playlist.',
			schema: { name: z.string().optional(), public: z.boolean().optional() },
			run: async ({ name, public: isPublic = false }) => {
				const res = await spotifyRequest(context, 'GET', '/me/player/queue');
				const items = [res?.currently_playing, ...(res?.queue ?? [])].filter((i: any) => i?.uri);
				const uris = [...new Set(items.map((i: any) => i.uri as string))];
				if (!uris.length) throw new Error('The queue is empty.');
				const p = await spotifyRequest(context, 'POST', '/me/playlists', {
					body: { name: name ?? `Queue — ${new Date().toISOString().slice(0, 10)}`, public: isPublic },
				});
				await addItemsToPlaylist(context, p.id, uris);
				return `Created "${p.name}" with ${uris.length} items. ID: ${p.id}`;
			},
		}),
	];
}

const RAW_PATH_PATTERN = /^\/(me|tracks|albums|artists|playlists|shows|episodes|audiobooks|chapters|search|browse|recommendations|audio-features|audio-analysis|users|markets)(\/|$|\?)/;

function rawTools(context: ToolContext): SpotifyTool[] {
	return [
		tool({
			name: 'spotifyApiRequest',
			description:
				'Escape hatch: call any Spotify Web API endpoint (https://api.spotify.com/v1) directly with the user\'s token and get raw JSON. Use when no dedicated tool exists. Path is relative, e.g. "/me/player" or "/artists/{id}/albums".',
			schema: {
				method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
				path: z.string().describe('Path under /v1, starting with "/" (e.g. "/me/top/artists").'),
				query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Query string parameters.'),
				body: z.any().optional().describe('JSON body for POST/PUT/DELETE.'),
			},
			run: async ({ method, path, query, body }) => {
				if (!RAW_PATH_PATTERN.test(path) || path.includes('..') || path.includes('://')) {
					throw new Error('path must be a Spotify Web API path like "/me/player" (relative to https://api.spotify.com/v1).');
				}
				const res = await spotifyRequest(context, method, path, { query, body });
				if (res === null) return `${method} ${path} succeeded (no content).`;
				const text = typeof res === 'string' ? res : JSON.stringify(res, null, 1);
				return text.length > 30_000 ? `${text.slice(0, 30_000)}\n… (truncated, ${text.length} chars total)` : text;
			},
		}),
	];
}

export function getSpotifyTools(context: ToolContext): SpotifyTool[] {
	return [
		...playerTools(context),
		...searchAndCatalogTools(context),
		...libraryTools(context),
		...userTools(context),
		...playlistTools(context),
		...rawTools(context),
	];
}
