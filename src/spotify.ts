import { SpotifyApi } from '@spotify/web-api-ts-sdk';

export type SpotifyWorkerEnv = Env & {
	APP_ENCRYPTION_SECRET: string;
	SPOTIFY_CLIENT_ID: string;
	SPOTIFY_CLIENT_SECRET: string;
	SPOTIFY_TOKENS: KVNamespace;
};

export const SPOTIFY_API_SCOPES = [
	'user-read-private',
	'user-read-email',
	'user-read-playback-state',
	'user-modify-playback-state',
	'user-read-currently-playing',
	'playlist-read-private',
	'playlist-modify-private',
	'playlist-modify-public',
	'user-library-read',
	'user-library-modify',
	'user-read-recently-played',
];

export type SpotifyGrantProps = {
	spotifyUserKey: string;
	spotifyDisplayName?: string;
};

export type SpotifyTokenRecord = {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	scope: string[];
	tokenType: string;
	userId: string;
	displayName?: string;
	email?: string;
	country?: string;
	product?: string;
};

type SpotifyTokenResponse = {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	scope?: string;
	token_type: string;
};

const textEncoder = new TextEncoder();
let cachedCryptoKeyPromise: Promise<CryptoKey> | undefined;

function toBase64Url(input: ArrayBuffer | Uint8Array | string): string {
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

function fromBase64Url(input: string): Uint8Array {
	const base64 = input.replaceAll('-', '+').replaceAll('_', '/');
	const padding = (4 - (base64.length % 4)) % 4;
	const padded = `${base64}${'='.repeat(padding)}`;
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function getEncryptionKey(secret: string): Promise<CryptoKey> {
	if (!cachedCryptoKeyPromise) {
		cachedCryptoKeyPromise = crypto.subtle
			.digest('SHA-256', textEncoder.encode(secret))
			.then((hash) =>
				crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']),
			);
	}

	return cachedCryptoKeyPromise;
}

async function encryptJson(secret: string, value: unknown): Promise<string> {
	const key = await getEncryptionKey(secret);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plaintext = textEncoder.encode(JSON.stringify(value));
	const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
	return `${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
}

async function decryptJson<T>(secret: string, value: string): Promise<T> {
	const [ivPart, payloadPart] = value.split('.');
	if (!ivPart || !payloadPart) {
		throw new Error('Encrypted token payload is malformed.');
	}

	const key = await getEncryptionKey(secret);
	const iv = fromBase64Url(ivPart);
	const payload = fromBase64Url(payloadPart);
	const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, payload);
	return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

function getSpotifyBasicAuth(env: SpotifyWorkerEnv): string {
	return `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`;
}

export function formatDuration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000)
		.toString()
		.padStart(2, '0');
	return `${minutes}:${seconds}`;
}

function sanitizeKeyPart(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function makeSpotifyUserKey(browserUserKey: string, spotifyUserId: string): string {
	return `${sanitizeKeyPart(browserUserKey)}__spotify_${sanitizeKeyPart(spotifyUserId)}`;
}

export async function saveSpotifyTokens(
	env: SpotifyWorkerEnv,
	userKey: string,
	record: SpotifyTokenRecord,
): Promise<void> {
	const encrypted = await encryptJson(env.APP_ENCRYPTION_SECRET, record);
	await env.SPOTIFY_TOKENS.put(userKey, encrypted);
}

export async function loadSpotifyTokens(
	env: SpotifyWorkerEnv,
	userKey: string,
): Promise<SpotifyTokenRecord | null> {
	const stored = await env.SPOTIFY_TOKENS.get(userKey);
	if (!stored) {
		return null;
	}

	return decryptJson<SpotifyTokenRecord>(env.APP_ENCRYPTION_SECRET, stored);
}

async function exchangeSpotifyToken(
	env: SpotifyWorkerEnv,
	params: URLSearchParams,
): Promise<SpotifyTokenResponse> {
	const response = await fetch('https://accounts.spotify.com/api/token', {
		method: 'POST',
		headers: {
			Authorization: getSpotifyBasicAuth(env),
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: params.toString(),
	});

	if (!response.ok) {
		throw new Error(`Spotify token exchange failed with status ${response.status}: ${await response.text()}`);
	}

	return (await response.json()) as SpotifyTokenResponse;
}

export async function exchangeSpotifyAuthorizationCode(
	env: SpotifyWorkerEnv,
	code: string,
	redirectUri: string,
): Promise<SpotifyTokenResponse> {
	const params = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri,
	});

	return exchangeSpotifyToken(env, params);
}

export async function refreshSpotifyAuthorization(
	env: SpotifyWorkerEnv,
	record: SpotifyTokenRecord,
): Promise<SpotifyTokenRecord> {
	const params = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: record.refreshToken,
	});
	const refreshed = await exchangeSpotifyToken(env, params);

	return {
		...record,
		accessToken: refreshed.access_token,
		refreshToken: refreshed.refresh_token ?? record.refreshToken,
		expiresAt: Date.now() + refreshed.expires_in * 1000,
		scope: refreshed.scope ? refreshed.scope.split(' ') : record.scope,
		tokenType: refreshed.token_type ?? record.tokenType,
	};
}

export async function getSpotifyProfile(accessToken: string): Promise<{
	id: string;
	display_name?: string;
	email?: string;
	country?: string;
	product?: string;
}> {
	const response = await fetch('https://api.spotify.com/v1/me', {
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	});

	if (!response.ok) {
		throw new Error(`Spotify profile request failed with status ${response.status}: ${await response.text()}`);
	}

	return (await response.json()) as {
		id: string;
		display_name?: string;
		email?: string;
		country?: string;
		product?: string;
	};
}

export async function getActiveSpotifyTokens(
	env: SpotifyWorkerEnv,
	grant: SpotifyGrantProps,
): Promise<SpotifyTokenRecord> {
	const record = await loadSpotifyTokens(env, grant.spotifyUserKey);
	if (!record) {
		throw new Error('No Spotify tokens are stored for this user. Reconnect this MCP integration in your client.');
	}

	if (record.expiresAt <= Date.now() + 60_000) {
		const refreshed = await refreshSpotifyAuthorization(env, record);
		await saveSpotifyTokens(env, grant.spotifyUserKey, refreshed);
		return refreshed;
	}

	return record;
}

export async function createSpotifyApiForGrant(
	env: SpotifyWorkerEnv,
	grant: SpotifyGrantProps,
): Promise<{ api: SpotifyApi; record: SpotifyTokenRecord }> {
	const record = await getActiveSpotifyTokens(env, grant);
	const expiresIn = Math.max(60, Math.floor((record.expiresAt - Date.now()) / 1000));

	return {
		api: SpotifyApi.withAccessToken(env.SPOTIFY_CLIENT_ID, {
			access_token: record.accessToken,
			token_type: record.tokenType,
			expires_in: expiresIn,
			refresh_token: record.refreshToken,
		}),
		record,
	};
}

export async function spotifyFetch(
	env: SpotifyWorkerEnv,
	grant: SpotifyGrantProps,
	input: string,
	init?: RequestInit,
): Promise<Response> {
	const { record } = await createSpotifyApiForGrant(env, grant);

	return fetch(input, {
		...init,
		headers: {
			Authorization: `Bearer ${record.accessToken}`,
			...(init?.headers ?? {}),
		},
	});
}

export function getSpotifyAuthorizeUrl(baseUrl: string, state: string, env: SpotifyWorkerEnv): string {
	const redirectUri = new URL('/spotify/callback', baseUrl).toString();
	const params = new URLSearchParams({
		client_id: env.SPOTIFY_CLIENT_ID,
		response_type: 'code',
		redirect_uri: redirectUri,
		scope: SPOTIFY_API_SCOPES.join(' '),
		state,
		show_dialog: 'true',
	});

	return `https://accounts.spotify.com/authorize?${params.toString()}`;
}
