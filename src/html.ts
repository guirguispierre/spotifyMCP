import type { AuthRequest, ClientInfo } from '@cloudflare/workers-oauth-provider';

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function scopeList(scopes: string[]): string {
	if (scopes.length === 0) {
		return '<li>spotify</li>';
	}

	return scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join('');
}

export function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>${escapeHtml(title)}</title>
		<style>
			:root {
				color-scheme: light;
				--bg: #f3efe6;
				--card: rgba(255, 255, 255, 0.88);
				--ink: #182018;
				--muted: #55625a;
				--line: rgba(24, 32, 24, 0.12);
				--accent: #1db954;
				--accent-2: #15753a;
			}

			* { box-sizing: border-box; }
			body {
				margin: 0;
				min-height: 100vh;
				font-family: "IBM Plex Sans", "Avenir Next", sans-serif;
				color: var(--ink);
				background:
					radial-gradient(circle at top left, rgba(29, 185, 84, 0.18), transparent 35%),
					radial-gradient(circle at bottom right, rgba(22, 117, 58, 0.12), transparent 30%),
					var(--bg);
				display: grid;
				place-items: center;
				padding: 24px;
			}

			main {
				width: min(760px, 100%);
				background: var(--card);
				backdrop-filter: blur(18px);
				border: 1px solid var(--line);
				border-radius: 24px;
				padding: 32px;
				box-shadow: 0 20px 60px rgba(24, 32, 24, 0.08);
			}

			h1, h2 { margin: 0 0 16px; line-height: 1.05; }
			h1 { font-size: clamp(2rem, 5vw, 3.6rem); }
			h2 { font-size: 1.2rem; }
			p, li { color: var(--muted); line-height: 1.6; }
			code {
				font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
				background: rgba(24, 32, 24, 0.06);
				padding: 2px 6px;
				border-radius: 6px;
			}

			.grid {
				display: grid;
				gap: 20px;
			}

			.panel {
				border: 1px solid var(--line);
				border-radius: 18px;
				padding: 18px;
				background: rgba(255, 255, 255, 0.7);
			}

			.button {
				display: inline-flex;
				align-items: center;
				justify-content: center;
				gap: 8px;
				padding: 14px 18px;
				border-radius: 999px;
				border: none;
				background: linear-gradient(135deg, var(--accent), var(--accent-2));
				color: white;
				font-weight: 700;
				font-size: 1rem;
				cursor: pointer;
				text-decoration: none;
			}

			.button.secondary {
				background: transparent;
				color: var(--ink);
				border: 1px solid var(--line);
			}

			form { display: grid; gap: 16px; }
			ul { padding-left: 20px; margin: 0; }
			.badge {
				display: inline-block;
				padding: 6px 10px;
				border-radius: 999px;
				background: rgba(29, 185, 84, 0.12);
				color: var(--accent-2);
				font-size: 0.88rem;
				font-weight: 700;
				margin-bottom: 16px;
			}

			.meta {
				display: flex;
				flex-wrap: wrap;
				gap: 10px;
				font-size: 0.92rem;
				color: var(--muted);
			}
		</style>
	</head>
	<body>
		<main>${body}</main>
	</body>
</html>`;
}

export function homePage(baseUrl: string): string {
	return page(
		'Spotify MCP',
		`
			<div class="badge">Cloudflare-hosted MCP</div>
			<h1>Spotify MCP</h1>
			<p>This Worker exposes a remote MCP server at <code>${escapeHtml(
				`${baseUrl}/mcp`,
			)}</code> and authenticates each user against Spotify with OAuth.</p>
			<div class="grid">
				<section class="panel">
					<h2>What it does</h2>
					<ul>
						<li>Search Spotify tracks, albums, artists, and playlists</li>
						<li>Read queue, devices, liked songs, and playlists</li>
						<li>Control playback, volume, queue, and playlist contents</li>
					</ul>
				</section>
				<section class="panel">
					<h2>Connect from Any Agent</h2>
					<p>Use <code>${escapeHtml(
						`${baseUrl}/mcp`,
					)}</code> as the remote MCP server URL in any client that supports OAuth-backed MCP connections.</p>
					<p>Each user completes their own Spotify login and gets a separate encrypted token record on the Worker.</p>
				</section>
			</div>
		`,
	);
}

export function authorizePage(args: {
	client: ClientInfo | null;
	oauthRequest: AuthRequest;
	signedRequest: string;
	csrfToken: string;
}): string {
	const { client, oauthRequest, signedRequest, csrfToken } = args;
	const clientName = client?.clientName ?? oauthRequest.clientId;

	return page(
		'Authorize Spotify MCP',
		`
			<div class="badge">Authorization required</div>
			<h1>Connect Spotify to ${escapeHtml(clientName)}</h1>
			<p>${escapeHtml(
				clientName,
			)} is requesting access to this Spotify MCP server so it can use Spotify tools on your behalf.</p>
			<div class="grid">
				<section class="panel">
					<h2>Requested MCP scopes</h2>
					<ul>${scopeList(oauthRequest.scope)}</ul>
				</section>
				<section class="panel">
					<h2>What happens next</h2>
					<ul>
						<li>You will be redirected to Spotify to sign in and approve access.</li>
						<li>Your Spotify tokens stay server-side on Cloudflare.</li>
						<li>Your MCP client receives only an OAuth grant for this MCP server.</li>
					</ul>
				</section>
			</div>
			<form method="post" action="/authorize/spotify">
				<input type="hidden" name="request_token" value="${escapeHtml(signedRequest)}" />
				<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}" />
				<button class="button" type="submit">Continue with Spotify</button>
			</form>
		`,
	);
}

export function statusPage(title: string, message: string, details?: string): string {
	return page(
		title,
		`
			<div class="badge">Spotify MCP</div>
			<h1>${escapeHtml(title)}</h1>
			<p>${escapeHtml(message)}</p>
			${details ? `<section class="panel"><p>${escapeHtml(details)}</p></section>` : ''}
			<a class="button secondary" href="/">Back to home</a>
		`,
	);
}
