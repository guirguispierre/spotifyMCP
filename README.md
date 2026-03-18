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

- Spotify search across tracks, albums, artists, and playlists
- Playback inspection, queue inspection, and device inspection
- Playback control: play, pause, resume, skip, queue, and volume
- Playlist reads and writes
- Album save/remove checks
- Per-user Spotify OAuth with encrypted token storage in Workers KV

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
