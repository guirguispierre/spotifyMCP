import type { MaxInt } from '@spotify/web-api-ts-sdk';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
	createSpotifyApiForGrant,
	formatDuration,
	spotifyFetch,
	type SpotifyGrantProps,
	type SpotifyTokenRecord,
	type SpotifyWorkerEnv,
} from './spotify';

type SpotifyHandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

type ToolResult = {
	content: Array<{
		type: 'text';
		text: string;
		isError?: boolean;
	}>;
};

type SpotifyTool<Args = any> = {
	name: string;
	description: string;
	schema: Record<string, z.ZodTypeAny>;
	handler: (args: any, extra: SpotifyHandlerExtra) => Promise<ToolResult> | ToolResult;
};

type ToolContext = {
	env: SpotifyWorkerEnv;
	grant: SpotifyGrantProps;
};

type SpotifyArtist = {
	id: string;
	name: string;
};

type SpotifyAlbum = {
	id: string;
	name: string;
	artists: SpotifyArtist[];
};

type SpotifyTrack = {
	id: string;
	name: string;
	type: string;
	duration_ms: number;
	artists: SpotifyArtist[];
	album: SpotifyAlbum;
};

function isTrack(item: unknown): item is SpotifyTrack {
	return Boolean(
		item &&
			typeof item === 'object' &&
			'album' in item &&
			'artists' in item &&
			'type' in item &&
			(item as { type?: string }).type === 'track',
	);
}

async function withSpotify<T>(
	context: ToolContext,
	action: (spotifyApi: Awaited<ReturnType<typeof createSpotifyApiForGrant>>['api'], record: SpotifyTokenRecord) => Promise<T>,
): Promise<T> {
	const { api, record } = await createSpotifyApiForGrant(context.env, context.grant);
	return action(api, record);
}

function toErrorResult(prefix: string, error: unknown): ToolResult {
	return {
		content: [
			{
				type: 'text',
				text: `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
				isError: true,
			},
		],
	};
}

function buildReadTools(context: ToolContext): SpotifyTool<any>[] {
	const searchSpotify: SpotifyTool<{
		query: string;
		type: 'track' | 'album' | 'artist' | 'playlist';
		limit?: number;
	}> = {
		name: 'searchSpotify',
		description: 'Search for tracks, albums, artists, or playlists on Spotify.',
		schema: {
			query: z.string().describe('The search query to run on Spotify.'),
			type: z
				.enum(['track', 'album', 'artist', 'playlist'])
				.describe('The Spotify item type to search for.'),
			limit: z.number().min(1).max(50).optional().describe('Maximum number of results to return.'),
		},
		handler: async ({ query, type, limit = 10 }) => {
			try {
				const results = await withSpotify(context, (spotifyApi) =>
					spotifyApi.search(query, [type], undefined, limit as MaxInt<50>),
				);

				let formattedResults = '';
				if (type === 'track' && results.tracks) {
					formattedResults = results.tracks.items
						.map((track: any, index: number) => {
							const artists = track.artists.map((artist: any) => artist.name).join(', ');
							return `${index + 1}. "${track.name}" by ${artists} (${formatDuration(track.duration_ms)}) - ID: ${track.id}`;
						})
						.join('\n');
				} else if (type === 'album' && results.albums) {
					formattedResults = results.albums.items
						.map((album: any, index: number) => {
							const artists = album.artists.map((artist: any) => artist.name).join(', ');
							return `${index + 1}. "${album.name}" by ${artists} - ID: ${album.id}`;
						})
						.join('\n');
				} else if (type === 'artist' && results.artists) {
					formattedResults = results.artists.items
						.map((artist: any, index: number) => `${index + 1}. ${artist.name} - ID: ${artist.id}`)
						.join('\n');
				} else if (type === 'playlist' && results.playlists) {
					formattedResults = results.playlists.items
						.map((playlist: any, index: number) => {
							const owner = playlist?.owner?.display_name ?? playlist?.owner?.id ?? 'Unknown';
							return `${index + 1}. "${playlist?.name ?? 'Unknown Playlist'}" by ${owner} - ID: ${playlist?.id ?? 'Unknown'}`;
						})
						.join('\n');
				}

				return {
					content: [
						{
							type: 'text',
							text:
								formattedResults.length > 0
									? `# Search results for "${query}" (${type})\n\n${formattedResults}`
									: `No ${type} results found for "${query}".`,
						},
					],
				};
			} catch (error) {
				return toErrorResult('Error searching Spotify', error);
			}
		},
	};

	const getNowPlaying: SpotifyTool<Record<string, never>> = {
		name: 'getNowPlaying',
		description: 'Get the currently playing Spotify track, device, and playback state.',
		schema: {},
		handler: async () => {
			try {
				const playback = await withSpotify(context, (spotifyApi) => spotifyApi.player.getPlaybackState());

				if (!playback?.item || !isTrack(playback.item)) {
					return {
						content: [{ type: 'text', text: 'Nothing is currently playing on Spotify.' }],
					};
				}

				const artists = playback.item.artists.map((artist) => artist.name).join(', ');
				const deviceName = playback.device ? `${playback.device.name} (${playback.device.type})` : 'Unknown device';
				const volume =
					playback.device?.volume_percent === null || playback.device?.volume_percent === undefined
						? 'N/A'
						: `${playback.device.volume_percent}%`;

				return {
					content: [
						{
							type: 'text',
							text:
								`# ${playback.is_playing ? 'Now playing' : 'Playback paused'}\n\n` +
								`**Track**: "${playback.item.name}"\n` +
								`**Artist**: ${artists}\n` +
								`**Album**: ${playback.item.album.name}\n` +
								`**Progress**: ${formatDuration(playback.progress_ms ?? 0)} / ${formatDuration(playback.item.duration_ms)}\n` +
								`**Device**: ${deviceName}\n` +
								`**Volume**: ${volume}\n` +
								`**Shuffle**: ${playback.shuffle_state ? 'On' : 'Off'}\n` +
								`**Repeat**: ${playback.repeat_state ?? 'off'}`,
						},
					],
				};
			} catch (error) {
				return toErrorResult('Error getting current playback', error);
			}
		},
	};

	const getMyPlaylists: SpotifyTool<{
		limit: z.ZodOptional<z.ZodNumber>;
		offset: z.ZodOptional<z.ZodNumber>;
	}> = {
		name: 'getMyPlaylists',
		description: "List the authenticated user's Spotify playlists.",
		schema: {
			limit: z.number().min(1).max(50).optional().describe('Maximum number of playlists to return.'),
			offset: z.number().min(0).optional().describe('Zero-based pagination offset.'),
		},
		handler: async ({ limit = 20, offset = 0 }) => {
			try {
				const playlists = await withSpotify(context, (spotifyApi) =>
					spotifyApi.currentUser.playlists.playlists(limit as MaxInt<50>, offset),
				);

				if (playlists.items.length === 0) {
					return {
						content: [{ type: 'text', text: 'This Spotify account has no playlists.' }],
					};
				}

				return {
					content: [
						{
							type: 'text',
							text:
								`# Spotify playlists (${offset + 1}-${offset + playlists.items.length} of ${playlists.total})\n\n` +
								playlists.items
									.map((playlist, index) => {
										const trackCount = playlist.tracks?.total ?? 0;
										return `${offset + index + 1}. "${playlist.name}" (${trackCount} tracks) - ID: ${playlist.id}`;
									})
									.join('\n'),
						},
					],
				};
			} catch (error) {
				return toErrorResult('Error getting playlists', error);
			}
		},
	};

	const getPlaylistTracks: SpotifyTool<{
		playlistId: z.ZodString;
		limit: z.ZodOptional<z.ZodNumber>;
		offset: z.ZodOptional<z.ZodNumber>;
	}> = {
		name: 'getPlaylistTracks',
		description: 'List tracks from a Spotify playlist.',
		schema: {
			playlistId: z.string().describe('The Spotify playlist ID.'),
			limit: z.number().min(1).max(50).optional().describe('Maximum number of tracks to return.'),
			offset: z.number().min(0).optional().describe('Zero-based pagination offset.'),
		},
		handler: async ({ playlistId, limit = 50, offset = 0 }) => {
			try {
				const playlistTracks = await withSpotify(context, (spotifyApi) =>
					spotifyApi.playlists.getPlaylistItems(
						playlistId,
						undefined,
						undefined,
						limit as MaxInt<50>,
						offset,
					),
				);

				if ((playlistTracks.items?.length ?? 0) === 0) {
					return { content: [{ type: 'text', text: 'This playlist does not contain any tracks.' }] };
				}

				const formattedTracks = playlistTracks.items
					.map((item, index) => {
						const track = item.track;
						if (!track || !isTrack(track)) {
							return `${offset + index + 1}. Unknown item`;
						}

						const artists = track.artists.map((artist) => artist.name).join(', ');
						return `${offset + index + 1}. "${track.name}" by ${artists} (${formatDuration(track.duration_ms)}) - ID: ${track.id}`;
					})
					.join('\n');

				return {
					content: [
						{
							type: 'text',
							text: `# Playlist tracks (${offset + 1}-${offset + playlistTracks.items.length} of ${playlistTracks.total})\n\n${formattedTracks}`,
						},
					],
				};
			} catch (error) {
				return toErrorResult('Error getting playlist tracks', error);
			}
		},
	};

	const getRecentlyPlayed: SpotifyTool<{
		limit: z.ZodOptional<z.ZodNumber>;
	}> = {
		name: 'getRecentlyPlayed',
		description: 'List recently played Spotify tracks.',
		schema: {
			limit: z.number().min(1).max(50).optional().describe('Maximum number of tracks to return.'),
		},
		handler: async ({ limit = 20 }) => {
			try {
				const history = await withSpotify(context, (spotifyApi) =>
					spotifyApi.player.getRecentlyPlayedTracks(limit as MaxInt<50>),
				);

				if (history.items.length === 0) {
					return { content: [{ type: 'text', text: 'Spotify has no recently played tracks for this user.' }] };
				}

				return {
					content: [
						{
							type: 'text',
							text:
								'# Recently played tracks\n\n' +
								history.items
									.map((item, index) => {
										if (!item.track || !isTrack(item.track)) {
											return `${index + 1}. Unknown item`;
										}

										const artists = item.track.artists.map((artist) => artist.name).join(', ');
										const playedAt = item.played_at ? new Date(item.played_at).toLocaleString() : 'Unknown time';
										return `${index + 1}. "${item.track.name}" by ${artists} (${formatDuration(item.track.duration_ms)}) - Played at: ${playedAt}`;
									})
									.join('\n'),
						},
					],
				};
			} catch (error) {
				return toErrorResult('Error getting recently played tracks', error);
			}
		},
	};

	const getUsersSavedTracks: SpotifyTool<{
		limit: z.ZodOptional<z.ZodNumber>;
		offset: z.ZodOptional<z.ZodNumber>;
	}> = {
		name: 'getUsersSavedTracks',
		description: 'List tracks from the user’s Spotify Liked Songs.',
		schema: {
			limit: z.number().min(1).max(50).optional().describe('Maximum number of tracks to return.'),
			offset: z.number().min(0).optional().describe('Zero-based pagination offset.'),
		},
		handler: async ({ limit = 50, offset = 0 }) => {
			try {
				const savedTracks = await withSpotify(context, (spotifyApi) =>
					spotifyApi.currentUser.tracks.savedTracks(limit as MaxInt<50>, offset),
				);

				if (savedTracks.items.length === 0) {
					return { content: [{ type: 'text', text: 'No saved tracks were found in Liked Songs.' }] };
				}

				return {
					content: [
						{
							type: 'text',
							text:
								`# Liked Songs (${offset + 1}-${offset + savedTracks.items.length} of ${savedTracks.total})\n\n` +
								savedTracks.items
									.map((item, index) => {
										if (!item.track || !isTrack(item.track)) {
											return `${offset + index + 1}. Unknown item`;
										}

										const artists = item.track.artists.map((artist) => artist.name).join(', ');
										return `${offset + index + 1}. "${item.track.name}" by ${artists} (${formatDuration(item.track.duration_ms)}) - Added: ${new Date(item.added_at).toLocaleDateString()}`;
									})
									.join('\n'),
						},
					],
				};
			} catch (error) {
				return toErrorResult('Error getting saved tracks', error);
			}
		},
	};

	const removeUsersSavedTracks: SpotifyTool<{
		trackIds: z.ZodArray<z.ZodString>;
	}> = {
		name: 'removeUsersSavedTracks',
		description: 'Remove one or more tracks from the user’s Spotify Liked Songs.',
		schema: {
			trackIds: z.array(z.string()).min(1).max(40).describe('Array of Spotify track IDs to remove.'),
		},
		handler: async ({ trackIds }) => {
			try {
					const uris = trackIds.map((id: string) => `spotify:track:${id}`).join(',');
				const response = await spotifyFetch(
					context.env,
					context.grant,
					`https://api.spotify.com/v1/me/library?uris=${encodeURIComponent(uris)}`,
					{ method: 'DELETE' },
				);

				if (!response.ok) {
					throw new Error(`Spotify returned ${response.status}: ${await response.text()}`);
				}

				return {
					content: [
						{
							type: 'text',
							text: `Removed ${trackIds.length} track${trackIds.length === 1 ? '' : 's'} from Liked Songs.`,
						},
					],
				};
			} catch (error) {
				return toErrorResult('Error removing saved tracks', error);
			}
		},
	};

	const getQueue: SpotifyTool<{
		limit: z.ZodOptional<z.ZodNumber>;
	}> = {
		name: 'getQueue',
		description: 'Get the current Spotify queue and now-playing track.',
		schema: {
			limit: z.number().min(1).max(50).optional().describe('Maximum number of queued tracks to show.'),
		},
		handler: async ({ limit = 10 }) => {
			try {
				const queue = await withSpotify(context, (spotifyApi) => spotifyApi.player.getUsersQueue());
				const current = (queue as { currently_playing?: any }).currently_playing;
				const upcoming = ((queue as { queue?: any[] }).queue ?? []).slice(0, limit);

				const currentText = current
					? `Currently Playing: "${current.name ?? 'Unknown'}" by ${
							Array.isArray(current.artists)
								? current.artists.map((artist: { name: string }) => artist.name).join(', ')
								: 'Unknown'
						}`
					: 'Nothing is currently playing.';

				const upcomingText =
					upcoming.length === 0
						? 'No upcoming items in the queue.'
						: upcoming
								.map((track, index) => {
									const artists = Array.isArray(track.artists)
										? track.artists.map((artist: { name: string }) => artist.name).join(', ')
										: 'Unknown';
									return `${index + 1}. "${track.name ?? 'Unknown'}" by ${artists}`;
								})
								.join('\n');

				return {
					content: [{ type: 'text', text: `# Spotify queue\n\n${currentText}\n\n${upcomingText}` }],
				};
			} catch (error) {
				return toErrorResult('Error getting the queue', error);
			}
		},
	};

	const getAvailableDevices: SpotifyTool<Record<string, never>> = {
		name: 'getAvailableDevices',
		description: 'List Spotify Connect devices available to this user.',
		schema: {},
		handler: async () => {
			try {
				const devices = await withSpotify(context, (spotifyApi) => spotifyApi.player.getAvailableDevices());

				if (!devices.devices || devices.devices.length === 0) {
					return { content: [{ type: 'text', text: 'No Spotify devices are available right now.' }] };
				}

				return {
					content: [
						{
							type: 'text',
							text:
								'# Available Spotify devices\n\n' +
								devices.devices
									.map((device, index) => {
										const volume = device.volume_percent === null ? 'N/A' : `${device.volume_percent}%`;
										return `${index + 1}. ${device.name} (${device.type})\n   Active: ${device.is_active ? 'yes' : 'no'} | Volume: ${volume} | ID: ${device.id}`;
									})
									.join('\n\n'),
						},
					],
				};
			} catch (error) {
				return toErrorResult('Error getting available devices', error);
			}
		},
	};

	return [
		searchSpotify,
		getNowPlaying,
		getMyPlaylists,
		getPlaylistTracks,
		getRecentlyPlayed,
		getUsersSavedTracks,
		removeUsersSavedTracks,
		getQueue,
		getAvailableDevices,
	];
}

function buildPlayTools(context: ToolContext): SpotifyTool<any>[] {
	const playMusic: SpotifyTool<{
		uri?: string;
		type?: 'track' | 'album' | 'artist' | 'playlist';
		id?: string;
		deviceId?: string;
	}> = {
		name: 'playMusic',
		description: 'Start playing a Spotify track, album, artist, or playlist.',
		schema: {
			uri: z.string().optional().describe('The full Spotify URI to play.'),
			type: z.enum(['track', 'album', 'artist', 'playlist']).optional().describe('The Spotify item type.'),
			id: z.string().optional().describe('The Spotify item ID.'),
			deviceId: z.string().optional().describe('Optional Spotify device ID to target.'),
		},
		handler: async ({ uri, type, id, deviceId }) => {
			if (!(uri || (type && id))) {
				return {
					content: [{ type: 'text', text: 'Provide either a Spotify URI or both type and id.', isError: true }],
				};
			}

			const spotifyUri = uri ?? `spotify:${type}:${id}`;
			try {
				await withSpotify(context, async (spotifyApi) => {
					const device = deviceId ?? '';
					if (type === 'track' || spotifyUri.startsWith('spotify:track:')) {
						await spotifyApi.player.startResumePlayback(device, undefined, [spotifyUri]);
						return;
					}
					await spotifyApi.player.startResumePlayback(device, spotifyUri);
				});

				return { content: [{ type: 'text', text: `Started playback for ${spotifyUri}.` }] };
			} catch (error) {
				return toErrorResult('Error starting playback', error);
			}
		},
	};

	const pausePlayback: SpotifyTool<{ deviceId: z.ZodOptional<z.ZodString> }> = {
		name: 'pausePlayback',
		description: 'Pause playback on the user’s Spotify device.',
		schema: {
			deviceId: z.string().optional().describe('Optional Spotify device ID to target.'),
		},
		handler: async ({ deviceId }) => {
			try {
				await withSpotify(context, (spotifyApi) => spotifyApi.player.pausePlayback(deviceId ?? ''));
				return { content: [{ type: 'text', text: 'Playback paused.' }] };
			} catch (error) {
				return toErrorResult('Error pausing playback', error);
			}
		},
	};

	const resumePlayback: SpotifyTool<{ deviceId: z.ZodOptional<z.ZodString> }> = {
		name: 'resumePlayback',
		description: 'Resume Spotify playback.',
		schema: {
			deviceId: z.string().optional().describe('Optional Spotify device ID to target.'),
		},
		handler: async ({ deviceId }) => {
			try {
				await withSpotify(context, (spotifyApi) => spotifyApi.player.startResumePlayback(deviceId ?? ''));
				return { content: [{ type: 'text', text: 'Playback resumed.' }] };
			} catch (error) {
				return toErrorResult('Error resuming playback', error);
			}
		},
	};

	const skipToNext: SpotifyTool<{ deviceId: z.ZodOptional<z.ZodString> }> = {
		name: 'skipToNext',
		description: 'Skip to the next item in the Spotify queue.',
		schema: {
			deviceId: z.string().optional().describe('Optional Spotify device ID to target.'),
		},
		handler: async ({ deviceId }) => {
			try {
				await withSpotify(context, (spotifyApi) => spotifyApi.player.skipToNext(deviceId ?? ''));
				return { content: [{ type: 'text', text: 'Skipped to the next track.' }] };
			} catch (error) {
				return toErrorResult('Error skipping to the next track', error);
			}
		},
	};

	const skipToPrevious: SpotifyTool<{ deviceId: z.ZodOptional<z.ZodString> }> = {
		name: 'skipToPrevious',
		description: 'Skip to the previous item in the Spotify queue.',
		schema: {
			deviceId: z.string().optional().describe('Optional Spotify device ID to target.'),
		},
		handler: async ({ deviceId }) => {
			try {
				await withSpotify(context, (spotifyApi) => spotifyApi.player.skipToPrevious(deviceId ?? ''));
				return { content: [{ type: 'text', text: 'Skipped to the previous track.' }] };
			} catch (error) {
				return toErrorResult('Error skipping to the previous track', error);
			}
		},
	};

	const createPlaylist: SpotifyTool<{
		name: z.ZodString;
		description: z.ZodOptional<z.ZodString>;
		public: z.ZodOptional<z.ZodBoolean>;
	}> = {
		name: 'createPlaylist',
		description: 'Create a Spotify playlist for the authenticated user.',
		schema: {
			name: z.string().describe('The new playlist name.'),
			description: z.string().optional().describe('Optional playlist description.'),
			public: z.boolean().optional().describe('Whether the playlist should be public.'),
		},
		handler: async ({ name, description, public: isPublic = false }) => {
			try {
				const playlist = await withSpotify(context, async (spotifyApi) => {
					const me = await spotifyApi.currentUser.profile();
					return spotifyApi.playlists.createPlaylist(me.id, {
						name,
						description,
						public: isPublic,
					});
				});

				return {
					content: [
						{
							type: 'text',
							text: `Created playlist "${name}".\nPlaylist ID: ${playlist.id}\nURL: ${playlist.external_urls.spotify}`,
						},
					],
				};
			} catch (error) {
				return toErrorResult('Error creating playlist', error);
			}
		},
	};

	const addTracksToPlaylist: SpotifyTool<{
		playlistId: z.ZodString;
		trackIds: z.ZodArray<z.ZodString>;
		position: z.ZodOptional<z.ZodNumber>;
	}> = {
		name: 'addTracksToPlaylist',
		description: 'Add Spotify tracks to a playlist.',
		schema: {
			playlistId: z.string().describe('The Spotify playlist ID.'),
			trackIds: z.array(z.string()).min(1).describe('Array of Spotify track IDs to add.'),
			position: z.number().min(0).optional().describe('Optional insert position in the playlist.'),
		},
		handler: async ({ playlistId, trackIds, position }) => {
			try {
				await withSpotify(context, (spotifyApi) =>
					spotifyApi.playlists.addItemsToPlaylist(
						playlistId,
							trackIds.map((id: string) => `spotify:track:${id}`),
						position,
					),
				);

				return {
					content: [{ type: 'text', text: `Added ${trackIds.length} track(s) to playlist ${playlistId}.` }],
				};
			} catch (error) {
				return toErrorResult('Error adding tracks to playlist', error);
			}
		},
	};

	const addToQueue: SpotifyTool<{
		uri?: string;
		type?: 'track' | 'album' | 'artist' | 'playlist';
		id?: string;
		deviceId?: string;
	}> = {
		name: 'addToQueue',
		description: 'Add a Spotify item to the user’s current queue.',
		schema: {
			uri: z.string().optional().describe('The full Spotify URI to queue.'),
			type: z.enum(['track', 'album', 'artist', 'playlist']).optional().describe('The Spotify item type.'),
			id: z.string().optional().describe('The Spotify item ID.'),
			deviceId: z.string().optional().describe('Optional Spotify device ID to target.'),
		},
		handler: async ({ uri, type, id, deviceId }) => {
			const spotifyUri = uri ?? (type && id ? `spotify:${type}:${id}` : undefined);
			if (!spotifyUri) {
				return {
					content: [{ type: 'text', text: 'Provide either a Spotify URI or both type and id.', isError: true }],
				};
			}

			try {
				await withSpotify(context, (spotifyApi) =>
					spotifyApi.player.addItemToPlaybackQueue(spotifyUri, deviceId ?? ''),
				);
				return { content: [{ type: 'text', text: `Added ${spotifyUri} to the queue.` }] };
			} catch (error) {
				return toErrorResult('Error adding to queue', error);
			}
		},
	};

	const setVolume: SpotifyTool<{
		volumePercent: z.ZodNumber;
		deviceId: z.ZodOptional<z.ZodString>;
	}> = {
		name: 'setVolume',
		description: 'Set playback volume on a Spotify device.',
		schema: {
			volumePercent: z.number().min(0).max(100).describe('The target volume percentage from 0 to 100.'),
			deviceId: z.string().optional().describe('Optional Spotify device ID to target.'),
		},
		handler: async ({ volumePercent, deviceId }) => {
			try {
				await withSpotify(context, (spotifyApi) =>
					spotifyApi.player.setPlaybackVolume(Math.round(volumePercent), deviceId ?? ''),
				);
				return { content: [{ type: 'text', text: `Volume set to ${Math.round(volumePercent)}%.` }] };
			} catch (error) {
				return toErrorResult('Error setting volume', error);
			}
		},
	};

	const adjustVolume: SpotifyTool<{
		adjustment: z.ZodNumber;
		deviceId: z.ZodOptional<z.ZodString>;
	}> = {
		name: 'adjustVolume',
		description: 'Adjust playback volume up or down relative to the current value.',
		schema: {
			adjustment: z.number().min(-100).max(100).describe('Relative volume adjustment from -100 to 100.'),
			deviceId: z.string().optional().describe('Optional Spotify device ID to target.'),
		},
		handler: async ({ adjustment, deviceId }) => {
			try {
				const playback = await withSpotify(context, (spotifyApi) => spotifyApi.player.getPlaybackState());
				if (!playback?.device || playback.device.volume_percent === null) {
					return { content: [{ type: 'text', text: 'No active Spotify device with a readable volume was found.' }] };
				}

				const newVolume = Math.min(100, Math.max(0, playback.device.volume_percent + adjustment));
				await withSpotify(context, (spotifyApi) =>
					spotifyApi.player.setPlaybackVolume(Math.round(newVolume), deviceId ?? ''),
				);

				return {
					content: [
						{
							type: 'text',
							text: `Volume changed from ${playback.device.volume_percent}% to ${Math.round(newVolume)}%.`,
						},
					],
				};
			} catch (error) {
				return toErrorResult('Error adjusting volume', error);
			}
		},
	};

	return [
		playMusic,
		pausePlayback,
		resumePlayback,
		skipToNext,
		skipToPrevious,
		createPlaylist,
		addTracksToPlaylist,
		addToQueue,
		setVolume,
		adjustVolume,
	];
}

function buildAlbumTools(context: ToolContext): SpotifyTool<any>[] {
	const getAlbums: SpotifyTool<{
		albumIds: string | string[];
	}> = {
		name: 'getAlbums',
		description: 'Fetch one or more Spotify albums by ID.',
		schema: {
			albumIds: z.union([z.string(), z.array(z.string()).max(20)]).describe('One album ID or up to 20 album IDs.'),
		},
		handler: async ({ albumIds }) => {
			const ids = Array.isArray(albumIds) ? albumIds : [albumIds];
			try {
				const list = await withSpotify(context, async (spotifyApi) =>
					ids.length === 1 ? [await spotifyApi.albums.get(ids[0])] : await spotifyApi.albums.get(ids),
				);
				return {
					content: [
						{
							type: 'text',
							text:
								'# Albums\n\n' +
								list
									.map((album, index) => {
										const artists = album.artists.map((artist) => artist.name).join(', ');
										return `${index + 1}. "${album.name}" by ${artists} (${album.release_date}) - ${album.total_tracks} tracks - ID: ${album.id}`;
									})
									.join('\n'),
						},
					],
				};
			} catch (error) {
				return toErrorResult('Error getting albums', error);
			}
		},
	};

	const getAlbumTracks: SpotifyTool<{
		albumId: z.ZodString;
		limit: z.ZodOptional<z.ZodNumber>;
		offset: z.ZodOptional<z.ZodNumber>;
	}> = {
		name: 'getAlbumTracks',
		description: 'List tracks from a Spotify album.',
		schema: {
			albumId: z.string().describe('The Spotify album ID.'),
			limit: z.number().min(1).max(50).optional().describe('Maximum number of tracks to return.'),
			offset: z.number().min(0).optional().describe('Zero-based pagination offset.'),
		},
		handler: async ({ albumId, limit = 20, offset = 0 }) => {
			try {
				const tracks = await withSpotify(context, (spotifyApi) =>
					spotifyApi.albums.tracks(albumId, undefined, limit as MaxInt<50>, offset),
				);

				return {
					content: [
						{
							type: 'text',
							text:
								`# Album tracks (${offset + 1}-${offset + tracks.items.length} of ${tracks.total})\n\n` +
								tracks.items
									.map((track, index) => {
										const artists = track.artists.map((artist) => artist.name).join(', ');
										return `${offset + index + 1}. "${track.name}" by ${artists} (${formatDuration(track.duration_ms)}) - ID: ${track.id}`;
									})
									.join('\n'),
						},
					],
				};
			} catch (error) {
				return toErrorResult('Error getting album tracks', error);
			}
		},
	};

	const saveOrRemoveAlbumForUser: SpotifyTool<{
		albumIds: string[];
		action: 'save' | 'remove';
	}> = {
		name: 'saveOrRemoveAlbumForUser',
		description: 'Save or remove albums from the user’s Spotify library.',
		schema: {
			albumIds: z.array(z.string()).min(1).max(20).describe('Array of Spotify album IDs.'),
			action: z.enum(['save', 'remove']).describe('Whether to save or remove the albums.'),
		},
		handler: async ({ albumIds, action }) => {
			try {
				await withSpotify(context, (spotifyApi) =>
					action === 'save'
						? spotifyApi.currentUser.albums.saveAlbums(albumIds)
						: spotifyApi.currentUser.albums.removeSavedAlbums(albumIds),
				);

				return {
					content: [
						{
							type: 'text',
							text: `${action === 'save' ? 'Saved' : 'Removed'} ${albumIds.length} album(s) ${action === 'save' ? 'to' : 'from'} the user library.`,
						},
					],
				};
			} catch (error) {
				return toErrorResult(`Error trying to ${action} albums`, error);
			}
		},
	};

	const checkUsersSavedAlbums: SpotifyTool<{
		albumIds: z.ZodArray<z.ZodString>;
	}> = {
		name: 'checkUsersSavedAlbums',
		description: 'Check whether specific albums are saved in the user’s Spotify library.',
		schema: {
			albumIds: z.array(z.string()).min(1).max(20).describe('Array of Spotify album IDs to inspect.'),
		},
		handler: async ({ albumIds }) => {
			try {
				const saved = await withSpotify(context, (spotifyApi) =>
					spotifyApi.currentUser.albums.hasSavedAlbums(albumIds),
				);

				return {
					content: [
						{
							type: 'text',
							text:
								'# Album save status\n\n' +
									albumIds.map((albumId: string, index: number) => `${index + 1}. ${albumId}: ${saved[index] ? 'Saved' : 'Not saved'}`).join('\n'),
						},
					],
				};
			} catch (error) {
				return toErrorResult('Error checking saved albums', error);
			}
		},
	};

	return [getAlbums, getAlbumTracks, saveOrRemoveAlbumForUser, checkUsersSavedAlbums];
}

function buildPlaylistTools(context: ToolContext): SpotifyTool<any>[] {
	const getPlaylist: SpotifyTool<{ playlistId: z.ZodString }> = {
		name: 'getPlaylist',
		description: 'Get details for a Spotify playlist.',
		schema: {
			playlistId: z.string().describe('The Spotify playlist ID.'),
		},
		handler: async ({ playlistId }) => {
			try {
				const playlist = await withSpotify(context, (spotifyApi) => spotifyApi.playlists.getPlaylist(playlistId));
				const owner = playlist.owner?.display_name ?? playlist.owner?.id ?? 'Unknown';
				return {
					content: [
						{
							type: 'text',
							text:
								`# Playlist: "${playlist.name}"\n\n` +
								`**Owner**: ${owner}\n` +
								`**Tracks**: ${playlist.tracks?.total ?? 0}\n` +
								`**Visibility**: ${playlist.public ? 'Public' : 'Private'}\n` +
								`**Description**: ${playlist.description || 'None'}\n` +
								`**ID**: ${playlist.id}\n` +
								`**URL**: ${playlist.external_urls.spotify}`,
						},
					],
				};
			} catch (error) {
				return toErrorResult('Error getting playlist', error);
			}
		},
	};

	const updatePlaylist: SpotifyTool<{
		playlistId: z.ZodString;
		name: z.ZodOptional<z.ZodString>;
		description: z.ZodOptional<z.ZodString>;
		public: z.ZodOptional<z.ZodBoolean>;
		collaborative: z.ZodOptional<z.ZodBoolean>;
	}> = {
		name: 'updatePlaylist',
		description: 'Update name, description, or visibility settings for a Spotify playlist.',
		schema: {
			playlistId: z.string().describe('The Spotify playlist ID.'),
			name: z.string().optional().describe('Updated playlist name.'),
			description: z.string().optional().describe('Updated playlist description.'),
			public: z.boolean().optional().describe('Updated public/private flag.'),
			collaborative: z.boolean().optional().describe('Updated collaborative flag.'),
		},
		handler: async ({ playlistId, name, description, public: isPublic, collaborative }) => {
			if (!name && description === undefined && isPublic === undefined && collaborative === undefined) {
				return {
					content: [{ type: 'text', text: 'Provide at least one field to update.', isError: true }],
				};
			}

			try {
				const body: Record<string, string | boolean> = {};
				if (name) body.name = name;
				if (description !== undefined) body.description = description;
				if (isPublic !== undefined) body.public = isPublic;
				if (collaborative !== undefined) body.collaborative = collaborative;

				await withSpotify(context, (spotifyApi) =>
					spotifyApi.playlists.changePlaylistDetails(playlistId, body),
				);

				return {
					content: [
						{
							type: 'text',
							text: `Updated playlist ${playlistId}. Fields changed: ${Object.keys(body).join(', ')}.`,
						},
					],
				};
			} catch (error) {
				return toErrorResult('Error updating playlist', error);
			}
		},
	};

	const removeTracksFromPlaylist: SpotifyTool<{
		playlistId: z.ZodString;
		trackIds: z.ZodArray<z.ZodString>;
		snapshotId: z.ZodOptional<z.ZodString>;
	}> = {
		name: 'removeTracksFromPlaylist',
		description: 'Remove tracks from a Spotify playlist.',
		schema: {
			playlistId: z.string().describe('The Spotify playlist ID.'),
			trackIds: z.array(z.string()).min(1).max(100).describe('Track IDs to remove from the playlist.'),
			snapshotId: z.string().optional().describe('Optional snapshot ID for a targeted playlist version.'),
		},
		handler: async ({ playlistId, trackIds, snapshotId }) => {
			try {
				await withSpotify(context, (spotifyApi) =>
					spotifyApi.playlists.removeItemsFromPlaylist(playlistId, {
							tracks: trackIds.map((id: string) => ({ uri: `spotify:track:${id}` })),
						...(snapshotId ? { snapshot_id: snapshotId } : {}),
					}),
				);

				return {
					content: [{ type: 'text', text: `Removed ${trackIds.length} track(s) from playlist ${playlistId}.` }],
				};
			} catch (error) {
				return toErrorResult('Error removing tracks from playlist', error);
			}
		},
	};

	const reorderPlaylistItems: SpotifyTool<{
		playlistId: z.ZodString;
		rangeStart: z.ZodNumber;
		insertBefore: z.ZodNumber;
		rangeLength: z.ZodOptional<z.ZodNumber>;
		snapshotId: z.ZodOptional<z.ZodString>;
	}> = {
		name: 'reorderPlaylistItems',
		description: 'Move one or more contiguous tracks within a Spotify playlist.',
		schema: {
			playlistId: z.string().describe('The Spotify playlist ID.'),
			rangeStart: z.number().min(0).describe('Index of the first item to move.'),
			insertBefore: z.number().min(0).describe('Destination index for the moved item(s).'),
			rangeLength: z.number().min(1).optional().describe('Number of consecutive items to move.'),
			snapshotId: z.string().optional().describe('Optional snapshot ID for a targeted playlist version.'),
		},
		handler: async ({ playlistId, rangeStart, insertBefore, rangeLength, snapshotId }) => {
			try {
				await withSpotify(context, (spotifyApi) =>
					spotifyApi.playlists.updatePlaylistItems(playlistId, {
						range_start: rangeStart,
						insert_before: insertBefore,
						...(rangeLength !== undefined ? { range_length: rangeLength } : {}),
						...(snapshotId ? { snapshot_id: snapshotId } : {}),
					}),
				);

				return {
					content: [
						{
							type: 'text',
							text: `Moved ${rangeLength ?? 1} track(s) inside playlist ${playlistId}.`,
						},
					],
				};
			} catch (error) {
				return toErrorResult('Error reordering playlist items', error);
			}
		},
	};

	return [getPlaylist, updatePlaylist, removeTracksFromPlaylist, reorderPlaylistItems];
}

export function getSpotifyTools(context: ToolContext): SpotifyTool<any>[] {
	return [
		...buildReadTools(context),
		...buildPlayTools(context),
		...buildAlbumTools(context),
		...buildPlaylistTools(context),
	];
}
