# Spotify MCP

Remote Spotify MCP server hosted on Cloudflare Workers.

This project exposes Spotify tools over remote MCP at `/mcp` and uses OAuth so each end user connects their own Spotify account. It is intended for any MCP client that supports:

- Remote MCP over HTTP
- OAuth 2.0/2.1 authorization code flow
- OAuth discovery via `/.well-known/oauth-authorization-server`
- Protected resource metadata via `/.well-known/oauth-protected-resource`
- Dynamic client registration or pre-registered OAuth clients

Poke is one supported client, but the server is no longer branded or scoped only to Poke.

## What it supports

~55 tools covering the Spotify Web API as it exists for development-mode apps after the February 2026 changes (generic `/me/library` endpoints, `/playlists/{id}/items`, no batch/browse endpoints). Every tool accepts Spotify IDs, `spotify:` URIs, or `open.spotify.com` URLs.

- **Playback**: `getNowPlaying`, `getAvailableDevices`, `transferPlayback`, `playMusic`, `playSearch`, `pausePlayback`, `resumePlayback`, `skipToNext`, `skipToPrevious`, `seekToPosition`, `setRepeatMode`, `setShuffle`, `setVolume`, `adjustVolume`
- **Queue / history**: `getQueue`, `addToQueue` (URIs, lists, or a search query), `getRecentlyPlayed`, `saveQueueAsPlaylist`
- **Search & catalog**: `searchSpotify` (all 7 types), `getTrack`, `getAlbums`, `getAlbumTracks`, `getArtist`, `getArtistAlbums`, `getShow`, `getShowEpisodes`, `getEpisode`, `getAudiobook`, `getAudiobookChapters`, `getChapter`
- **Library**: `getUsersSavedTracks`, `getSavedAlbums`, `getSavedShows`, `getSavedEpisodes`, `getSavedAudiobooks`, `getFollowedArtists`, `saveToLibrary`, `removeFromLibrary`, `checkLibrary`, `likeCurrentTrack`, `removeUsersSavedTracks`, `saveOrRemoveAlbumForUser`, `checkUsersSavedAlbums`
- **You**: `getMyProfile`, `getTopItems` (top artists/tracks by time range)
- **Playlists**: `getMyPlaylists`, `findMyPlaylist`, `getPlaylist`, `getPlaylistTracks`, `createPlaylist`, `addTracksToPlaylist`, `addCurrentTrackToPlaylist`, `removeTracksFromPlaylist`, `reorderPlaylistItems`, `replacePlaylistItems`, `updatePlaylist`, `getPlaylistCoverImage`, `uploadPlaylistCoverImage`, `createPlaylistFromTopTracks`
- **Escape hatch**: `spotifyApiRequest` — raw call to any `https://api.spotify.com/v1` path with the user's token

Playback control needs Spotify Premium and an active device. Per-user Spotify OAuth with encrypted token storage in Workers KV; tokens auto-refresh (and retry once on a 401).

Existing connections must reconnect once to grant the new scopes (`user-top-read`, `user-follow-read`, `user-follow-modify`, `playlist-read-collaborative`, `ugc-image-upload`, `user-read-playback-position`).

## Architecture

- `src/index.ts`: Cloudflare Worker entrypoint, OAuth flow, and MCP transport
- `src/spotify.ts`: Spotify OAuth, token refresh, encryption, and API helpers
- `src/tools.ts`: MCP tool definitions
- `src/html.ts`: landing page and authorization UI

## Cloudflare setup

This Worker uses:

- `OAUTH_KV` for OAuth provider state and grants
- `SPOTIFY_TOKENS` for encrypted per-user Spotify token storage
- Worker secrets for Spotify credentials and the app encryption secret

Create the KV namespaces and bind them in [wrangler.jsonc](/Users/guirguispierre/Documents/spotifymcp/wrangler.jsonc), then regenerate types:

```sh
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create SPOTIFY_TOKENS
npx wrangler types
```

Set the required secrets:

```sh
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put APP_ENCRYPTION_SECRET
```

Run locally or deploy:

```sh
npx wrangler dev
npx wrangler deploy
```

## Client setup

Configure your MCP client to use:

```text
https://<your-worker-subdomain>.workers.dev/mcp
```

Clients should discover these OAuth endpoints automatically:

- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource`

If your client requires manual OAuth metadata, use the same base URL.

## Devin example

In Devin: **Settings → MCP Marketplace → Add custom MCP** → transport **HTTP**, URL `https://<your-worker-subdomain>.workers.dev/mcp`, authentication **OAuth**. Save, then click **Connect** and log in to Spotify. Dynamic client registration is supported, so no client ID/secret is needed.

## Poke example

If you are using Poke custom integrations, use the same MCP URL:

```text
https://<your-worker-subdomain>.workers.dev/mcp
```

Poke should discover the OAuth metadata endpoints automatically.

## Spotify dashboard setup

Your Spotify app must allow this redirect URI:

```text
https://<your-worker-subdomain>.workers.dev/spotify/callback
```

Without that redirect URI configured in the Spotify Developer Dashboard, Spotify login will fail on callback.
