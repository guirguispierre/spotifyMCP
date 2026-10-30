import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveSpotifyTokens, type SpotifyWorkerEnv } from '../src/spotify';
import { getSpotifyTools, parseSpotifyRef } from '../src/tools';

const testEnv = {
	...env,
	APP_ENCRYPTION_SECRET: 'test-secret',
	SPOTIFY_CLIENT_ID: 'cid',
	SPOTIFY_CLIENT_SECRET: 'csecret',
} as unknown as SpotifyWorkerEnv;
const grant = { spotifyUserKey: 'agent_test__spotify_user' };

type Call = { method: string; url: URL; body?: string; auth?: string | null };
let calls: Call[] = [];
let responder: (call: Call) => Response;

function tools() {
	return Object.fromEntries(getSpotifyTools({ env: testEnv, grant }).map((t) => [t.name, t]));
}

async function run(name: string, args: Record<string, unknown> = {}) {
	const result = await tools()[name].handler(args, {} as never);
	return { text: result.content[0].text, isError: result.isError ?? false };
}

beforeEach(async () => {
	calls = [];
	responder = () => new Response(null, { status: 204 });
	await saveSpotifyTokens(testEnv, grant.spotifyUserKey, {
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		expiresAt: Date.now() + 3_600_000,
		scope: [],
		tokenType: 'Bearer',
		userId: 'user',
	});
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const call: Call = {
			method: request.method,
			url: new URL(request.url),
			body: init?.body ? String(init.body) : undefined,
			auth: request.headers.get('authorization'),
		};
		calls.push(call);
		return responder(call);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

describe('parseSpotifyRef', () => {
	it('accepts URIs, URLs, and bare IDs', () => {
		expect(parseSpotifyRef('spotify:album:abc123').uri).toBe('spotify:album:abc123');
		expect(parseSpotifyRef('https://open.spotify.com/intl-de/track/4iV5W9uYEdYUVa79Axb7Rh?si=x').uri).toBe(
			'spotify:track:4iV5W9uYEdYUVa79Axb7Rh',
		);
		expect(parseSpotifyRef('4iV5W9uYEdYUVa79Axb7Rh', 'track').uri).toBe('spotify:track:4iV5W9uYEdYUVa79Axb7Rh');
		expect(() => parseSpotifyRef('not an id!', 'track')).toThrow();
	});
});

describe('spotify tools', () => {
	it('registers a broad, uniquely named tool set', () => {
		const list = getSpotifyTools({ env: testEnv, grant });
		const names = list.map((t) => t.name);
		expect(new Set(names).size).toBe(names.length);
		for (const required of ['addToQueue', 'getQueue', 'playSearch', 'transferPlayback', 'seekToPosition', 'getTopItems', 'saveToLibrary', 'spotifyApiRequest']) {
			expect(names).toContain(required);
		}
		expect(list.length).toBeGreaterThanOrEqual(50);
	});

	it('queues multiple items in order with the bearer token', async () => {
		const res = await run('addToQueue', { uris: ['spotify:track:aaa', 'https://open.spotify.com/episode/bbb'], deviceId: 'dev1' });
		expect(res.isError).toBe(false);
		expect(calls.map((c) => [c.method, c.url.pathname, c.url.searchParams.get('uri'), c.url.searchParams.get('device_id')])).toEqual([
			['POST', '/v1/me/player/queue', 'spotify:track:aaa', 'dev1'],
			['POST', '/v1/me/player/queue', 'spotify:episode:bbb', 'dev1'],
		]);
		expect(calls[0].auth).toBe('Bearer access-1');
	});

	it('queues the top search result for a query', async () => {
		responder = (call) =>
			call.url.pathname === '/v1/search'
				? json({ tracks: { items: [{ type: 'track', uri: 'spotify:track:top', name: 'Top', artists: [] }] } })
				: new Response(null, { status: 204 });
		const res = await run('addToQueue', { query: 'some song' });
		expect(res.text).toContain('spotify:track:top');
		expect(calls[0].url.searchParams.get('type')).toBe('track');
		expect(calls[1].url.searchParams.get('uri')).toBe('spotify:track:top');
	});

	it('plays an album as a context and tracks as uris', async () => {
		await run('playMusic', { uri: 'spotify:album:alb' });
		expect(JSON.parse(calls[0].body!)).toEqual({ context_uri: 'spotify:album:alb' });
		await run('playMusic', { type: 'track', id: 'trk' });
		expect(JSON.parse(calls[1].body!)).toEqual({ uris: ['spotify:track:trk'] });
	});

	it('uses the generic library endpoints', async () => {
		await run('saveToLibrary', { items: ['abc', 'spotify:album:def'] });
		expect(calls[0].method).toBe('PUT');
		expect(calls[0].url.pathname).toBe('/v1/me/library');
		expect(calls[0].url.searchParams.get('uris')).toBe('spotify:track:abc,spotify:album:def');

		responder = () => json([true, false]);
		const res = await run('checkUsersSavedAlbums', { albumIds: ['a1', 'a2'] });
		expect(calls[1].url.pathname).toBe('/v1/me/library/contains');
		expect(res.text).toContain('spotify:album:a1: Saved');
		expect(res.text).toContain('spotify:album:a2: Not saved');
	});

	it('uses /items playlist endpoints', async () => {
		responder = () => json({ snapshot_id: 's1' }, 201);
		await run('addTracksToPlaylist', { playlistId: 'https://open.spotify.com/playlist/pl1', trackIds: ['t1'], position: 0 });
		expect(calls[0].url.pathname).toBe('/v1/playlists/pl1/items');
		expect(JSON.parse(calls[0].body!)).toEqual({ uris: ['spotify:track:t1'], position: 0 });

		responder = () => json({ snapshot_id: 's2' });
		await run('removeTracksFromPlaylist', { playlistId: 'pl1', trackIds: ['t1'] });
		expect(calls[1].method).toBe('DELETE');
		expect(JSON.parse(calls[1].body!)).toEqual({ items: [{ uri: 'spotify:track:t1' }] });
	});

	it('maps player 404s to a no-active-device hint', async () => {
		responder = () => json({ error: { status: 404, message: 'Player command failed: No active device found' } }, 404);
		const res = await run('pausePlayback');
		expect(res.isError).toBe(true);
		expect(res.text).toContain('No active Spotify device');
	});

	it('refreshes the token once on a 401 and retries', async () => {
		responder = (call) => {
			if (call.url.hostname === 'accounts.spotify.com') return json({ access_token: 'access-2', expires_in: 3600, token_type: 'Bearer' });
			return call.auth === 'Bearer access-1' ? json({ error: { status: 401, message: 'expired' } }, 401) : new Response(null, { status: 204 });
		};
		const res = await run('skipToNext');
		expect(res.isError).toBe(false);
		expect(calls.map((c) => c.auth ?? c.url.hostname)).toEqual(['Bearer access-1', expect.stringContaining('Basic'), 'Bearer access-2']);
	});

	it('restricts the raw API escape hatch to Web API paths', async () => {
		const bad = await run('spotifyApiRequest', { method: 'GET', path: 'https://evil.example/x' });
		expect(bad.isError).toBe(true);
		expect(calls).toHaveLength(0);
		responder = () => json({ ok: 1 });
		const good = await run('spotifyApiRequest', { method: 'GET', path: '/me/top/artists', query: { limit: 5 } });
		expect(good.text).toContain('"ok": 1');
		expect(calls[0].url.searchParams.get('limit')).toBe('5');
	});
});
