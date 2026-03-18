import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';
import { makeSpotifyUserKey } from '../src/spotify';

describe('Spotify MCP worker', () => {
	describe('request for /', () => {
		it('renders the landing page (unit style)', async () => {
			const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain('Spotify MCP');
		});

		it('renders the landing page (integration style)', async () => {
			const request = new Request('http://example.com/');
			const response = await SELF.fetch(request);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain('/mcp');
		});
	});

	describe('request for missing route', () => {
		it('returns a 404 page', async () => {
			const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/not-found');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(404);
			expect(await response.text()).toContain('No route matched');
		});
	});

	describe('spotify grant ids', () => {
		it('scopes the key by browser identity and avoids provider delimiters', () => {
			expect(makeSpotifyUserKey('agent_user_a', '31zznoz2gyjciggr5ak5s76hio3m')).toBe(
				'agent_user_a__spotify_31zznoz2gyjciggr5ak5s76hio3m',
			);
			expect(makeSpotifyUserKey('agent_user_a', '31zznoz2gyjciggr5ak5s76hio3m')).not.toContain(':');
			expect(makeSpotifyUserKey('agent_user_a', '31zznoz2gyjciggr5ak5s76hio3m')).not.toBe(
				makeSpotifyUserKey('agent_user_b', '31zznoz2gyjciggr5ak5s76hio3m'),
			);
		});
	});
});
