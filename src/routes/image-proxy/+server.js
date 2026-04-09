// @ts-nocheck
import { error } from '@sveltejs/kit';

/** @type {import('./$types').RequestHandler} */
export async function GET({ url, fetch }) {
	const imageUrl = url.searchParams.get('url');

	if (!imageUrl) {
		throw error(400, 'Missing url parameter');
	}

	try {
		const response = await fetch(imageUrl);
		if (!response.ok) {
			throw error(response.status, 'Failed to fetch image');
		}

		const buffer = await response.arrayBuffer();
		const contentType = response.headers.get('content-type') || 'image/png';

		return new Response(buffer, {
			headers: {
				'Content-Type': contentType,
				'Cache-Control': 'public, max-age=3600'
			}
		});
	} catch (err) {
		console.error('[Image Proxy] Error:', err);
		throw error(502, `Proxy error: ${err?.message || String(err)}`);
	}
}
