import { WorkerEntrypoint } from 'cloudflare:workers';
import OAuthProvider, {
	type AuthRequest,
	type OAuthHelpers,
	type ClientInfo,
} from '@cloudflare/workers-oauth-provider';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import { homePage, authorizePage, statusPage } from './html';
import {
	exchangeSpotifyAuthorizationCode,
	getSpotifyAuthorizeUrl,
	getSpotifyProfile,
	makeSpotifyUserKey,
	saveSpotifyTokens,
	type SpotifyGrantProps,
	type SpotifyTokenRecord,
	type SpotifyWorkerEnv,
} from './spotify';
import { getSpotifyTools } from './tools';

type AppEnv = SpotifyWorkerEnv & {
	OAUTH_PROVIDER: OAuthHelpers;
};

type SignedStatePayload =
	| {
			type: 'oauth-request';
			request: AuthRequest;
			browserUserKey: string;
			issuedAt: number;
	  }
	| {
			type: 'spotify-oauth';
			request: AuthRequest;
			browserUserKey: string;
			issuedAt: number;
	  };

const SUPPORTED_MCP_SCOPES = ['spotify'];
const USER_COOKIE_NAME = '__Host-spotify-mcp-user';
const textEncoder = new TextEncoder();

function escapeHtml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function base64UrlEncode(input: string | Uint8Array | ArrayBuffer): string {
	const bytes =
		typeof input === 'string'
			? textEncoder.encode(input)
			: input instanceof Uint8Array
				? input
				: new Uint8Array(input);

	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlDecode(input: string): Uint8Array {
	const base64 = input.replaceAll('-', '+').replaceAll('_', '/');
	const padding = (4 - (base64.length % 4)) % 4;
	const padded = `${base64}${'='.repeat(padding)}`;
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmac(secret: string, value: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		textEncoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(value));
	return base64UrlEncode(signature);
}

async function signState(env: SpotifyWorkerEnv, payload: SignedStatePayload): Promise<string> {
	const body = base64UrlEncode(JSON.stringify(payload));
	const signature = await hmac(env.APP_ENCRYPTION_SECRET, body);
	return `${body}.${signature}`;
}

async function verifyState(env: SpotifyWorkerEnv, token: string): Promise<SignedStatePayload> {
	const [body, signature] = token.split('.');
	if (!body || !signature) {
		throw new Error('The OAuth state parameter is malformed.');
	}

	const expected = await hmac(env.APP_ENCRYPTION_SECRET, body);
	if (signature !== expected) {
		throw new Error('The OAuth state signature is invalid.');
	}

	const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as SignedStatePayload;
	if (Date.now() - payload.issuedAt > 15 * 60_000) {
		throw new Error('The OAuth state has expired. Start the authorization flow again.');
	}

	return payload;
}

function getBaseUrl(request: Request): string {
	const url = new URL(request.url);
	return `${url.protocol}//${url.host}`;
}

function getGrantScopes(request: AuthRequest): string[] {
	return request.scope.length > 0 ? request.scope : SUPPORTED_MCP_SCOPES;
}

function csrfCookie(value: string): string {
	return serializeCookie('__Host-spotify-mcp-csrf', value, {
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		path: '/',
		maxAge: 600,
	});
}

function browserUserCookie(value: string): string {
	return serializeCookie(USER_COOKIE_NAME, value, {
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		path: '/',
		maxAge: 60 * 60 * 24 * 365,
	});
}

function clearCsrfCookie(): string {
	return serializeCookie('__Host-spotify-mcp-csrf', '', {
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		path: '/',
		maxAge: 0,
	});
}

function getOrCreateBrowserUserKey(request: Request): { browserUserKey: string; setCookie?: string } {
	const cookies = parseCookie(request.headers.get('cookie') ?? '');
	const existing = cookies[USER_COOKIE_NAME];
	if (typeof existing === 'string' && existing.length > 0) {
		return { browserUserKey: existing };
	}

	const browserUserKey = `agent_${crypto.randomUUID()}`;
	return {
		browserUserKey,
		setCookie: browserUserCookie(browserUserKey),
	};
}

function renderErrorPage(title: string, message: string, status = 400): Response {
	return new Response(statusPage(title, message), {
		status,
		headers: {
			'content-type': 'text/html; charset=UTF-8',
		},
	});
}

function createSpotifyTokenRecord(
	tokenResponse: {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
		scope?: string;
		token_type: string;
	},
	profile: Awaited<ReturnType<typeof getSpotifyProfile>>,
): SpotifyTokenRecord {
	if (!tokenResponse.refresh_token) {
		throw new Error('Spotify did not return a refresh token for this user.');
	}

	return {
		accessToken: tokenResponse.access_token,
		refreshToken: tokenResponse.refresh_token,
		expiresAt: Date.now() + tokenResponse.expires_in * 1000,
		scope: tokenResponse.scope ? tokenResponse.scope.split(' ') : [],
		tokenType: tokenResponse.token_type,
		userId: profile.id,
		displayName: profile.display_name,
		email: profile.email,
		country: profile.country,
		product: profile.product,
	};
}

function buildMcpServer(env: SpotifyWorkerEnv, grant: SpotifyGrantProps): McpServer {
	const server = new McpServer({
		name: 'spotify-mcp',
		version: '1.0.0',
	});

	for (const tool of getSpotifyTools({ env, grant })) {
		server.tool(tool.name, tool.description, tool.schema, tool.handler);
	}

	return server;
}

class SpotifyApiHandler extends WorkerEntrypoint<AppEnv> {
	async fetch(request: Request): Promise<Response> {
		const props = (this.ctx.props ?? {}) as SpotifyGrantProps;
		if (!props.spotifyUserKey) {
			return new Response('Missing authenticated Spotify user context.', { status: 401 });
		}

		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		const server = buildMcpServer(this.env, props);
		await server.connect(transport);
		return transport.handleRequest(request);
	}
}

const defaultHandler = {
	async fetch(request: Request, env: AppEnv): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'GET' && url.pathname === '/') {
			return new Response(homePage(getBaseUrl(request)), {
				headers: { 'content-type': 'text/html; charset=UTF-8' },
			});
		}

		if (request.method === 'GET' && url.pathname === '/authorize') {
			try {
				const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
				const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
				const csrfToken = crypto.randomUUID();
				const { browserUserKey, setCookie } = getOrCreateBrowserUserKey(request);
				const signedRequest = await signState(env, {
					type: 'oauth-request',
					request: oauthRequest,
					browserUserKey,
					issuedAt: Date.now(),
				});

				const headers = new Headers({
					'content-type': 'text/html; charset=UTF-8',
				});
				headers.append('set-cookie', csrfCookie(csrfToken));
				if (setCookie) {
					headers.append('set-cookie', setCookie);
				}

				return new Response(
					authorizePage({
						client,
						oauthRequest,
						signedRequest,
						csrfToken,
					}),
					{
						headers,
					},
				);
			} catch (error) {
				return renderErrorPage(
					'Authorization failed',
					error instanceof Error ? error.message : String(error),
				);
			}
		}

		if (request.method === 'POST' && url.pathname === '/authorize/spotify') {
			try {
				const formData = await request.formData();
				const requestToken = formData.get('request_token');
				const submittedCsrf = formData.get('csrf_token');
				const cookieHeader = request.headers.get('cookie') ?? '';
				const cookies = parseCookie(cookieHeader);
				const cookieCsrf = cookies['__Host-spotify-mcp-csrf'];

				if (typeof requestToken !== 'string' || typeof submittedCsrf !== 'string') {
					return renderErrorPage('Authorization failed', 'The authorization request is missing required fields.');
				}

				if (!cookieCsrf || cookieCsrf !== submittedCsrf) {
					return renderErrorPage('Authorization failed', 'The CSRF check failed. Start the flow again.');
				}

				const payload = await verifyState(env, requestToken);
				if (payload.type !== 'oauth-request') {
					return renderErrorPage('Authorization failed', 'Unexpected authorization state.');
				}

				const spotifyState = await signState(env, {
					type: 'spotify-oauth',
					request: payload.request,
					browserUserKey: payload.browserUserKey,
					issuedAt: Date.now(),
				});

				return new Response(null, {
					status: 302,
					headers: {
						location: getSpotifyAuthorizeUrl(getBaseUrl(request), spotifyState, env),
						'set-cookie': clearCsrfCookie(),
					},
				});
			} catch (error) {
				return renderErrorPage(
					'Authorization failed',
					error instanceof Error ? error.message : String(error),
				);
			}
		}

		if (request.method === 'GET' && url.pathname === '/spotify/callback') {
			const error = url.searchParams.get('error');
			if (error) {
				return renderErrorPage('Spotify authorization failed', `Spotify returned: ${error}`);
			}

			const code = url.searchParams.get('code');
			const state = url.searchParams.get('state');
			if (!code || !state) {
				return renderErrorPage('Spotify authorization failed', 'Spotify did not return a code and state pair.');
			}

			try {
				const payload = await verifyState(env, state);
				if (payload.type !== 'spotify-oauth') {
					return renderErrorPage('Spotify authorization failed', 'Unexpected Spotify authorization state.');
				}

				const redirectUri = new URL('/spotify/callback', getBaseUrl(request)).toString();
				const tokenResponse = await exchangeSpotifyAuthorizationCode(env, code, redirectUri);
				const profile = await getSpotifyProfile(tokenResponse.access_token);
				const spotifyUserKey = makeSpotifyUserKey(payload.browserUserKey, profile.id);
				await saveSpotifyTokens(env, spotifyUserKey, createSpotifyTokenRecord(tokenResponse, profile));

				const completion = await env.OAUTH_PROVIDER.completeAuthorization({
					request: payload.request,
					userId: spotifyUserKey,
					metadata: {
						label: profile.display_name ?? profile.id,
						spotifyUserId: profile.id,
					},
					scope: getGrantScopes(payload.request),
					props: {
						spotifyUserKey,
						spotifyDisplayName: profile.display_name ?? profile.id,
					} satisfies SpotifyGrantProps,
				});

				return Response.redirect(completion.redirectTo, 302);
			} catch (callbackError) {
				return renderErrorPage(
					'Spotify authorization failed',
					callbackError instanceof Error ? callbackError.message : String(callbackError),
				);
			}
		}

		return new Response(statusPage('Not found', `No route matched ${escapeHtml(url.pathname)}.`), {
			status: 404,
			headers: {
				'content-type': 'text/html; charset=UTF-8',
			},
		});
	},
};

export default new OAuthProvider<AppEnv>({
	apiRoute: '/mcp',
	apiHandler: SpotifyApiHandler,
	defaultHandler,
	authorizeEndpoint: '/authorize',
	tokenEndpoint: '/token',
	clientRegistrationEndpoint: '/register',
	scopesSupported: SUPPORTED_MCP_SCOPES,
	resourceMetadata: {
		resource_name: 'Spotify MCP',
		scopes_supported: SUPPORTED_MCP_SCOPES,
	},
});
