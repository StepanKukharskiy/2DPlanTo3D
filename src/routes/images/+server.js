// @ts-nocheck
import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import https from 'https';

const TOGETHER_BASE = 'https://api.together.xyz/v1';
const API_KEY = env.API_KEY || env.TOGETHER_API_KEY || '';
const DEFAULT_IMAGE_MODEL = 'google/gemini-3-pro-image';

const MAX_RETRIES = 3;
const TIMEOUT_MS = 60000; // 60 second timeout for image generation

async function fetchWithRetry(url, payload, retries = MAX_RETRIES) {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(payload);
		const urlObj = new URL(url);
		
		const options = {
			hostname: urlObj.hostname,
			path: urlObj.pathname,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${API_KEY}`,
				'Content-Length': Buffer.byteLength(data)
			},
			timeout: TIMEOUT_MS
		};

		const req = https.request(options, (res) => {
			let responseData = '';
			res.on('data', (chunk) => {
				responseData += chunk;
			});
			res.on('end', () => {
				try {
					const parsed = JSON.parse(responseData);
					resolve({
						ok: res.statusCode >= 200 && res.statusCode < 300,
						status: res.statusCode,
						data: parsed
					});
				} catch (e) {
					resolve({
						ok: res.statusCode >= 200 && res.statusCode < 300,
						status: res.statusCode,
						data: responseData
					});
				}
			});
		});

		req.on('timeout', () => {
			req.destroy();
			if (retries > 0) {
				console.log(`[Images API] Request timed out, retrying... (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
				setTimeout(() => fetchWithRetry(url, payload, retries - 1).then(resolve).catch(reject), 2000);
			} else {
				reject(new Error('Request timeout after all retries'));
			}
		});

		req.on('error', (err) => {
			if (retries > 0) {
				console.log(`[Images API] Request failed, retrying... (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
				setTimeout(() => fetchWithRetry(url, payload, retries - 1).then(resolve).catch(reject), 2000);
			} else {
				reject(err);
			}
		});

		req.write(data);
		req.end();
	});
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
	console.log('[Images API] Received request');

	if (!API_KEY) {
		console.error('[Images API] API_KEY not configured');
		throw error(500, 'API_KEY not configured on server');
	}

	try {
		const body = await request.json();
		console.log('[Images API] Request body:', { 
			model: body.model || DEFAULT_IMAGE_MODEL, 
			prompt: body.prompt?.substring(0, 50) + '...', 
			hasImage: !!body.image 
		});

		const model = body.model || DEFAULT_IMAGE_MODEL;
		const prompt = body.prompt || '';
		const image = body.image; // base64 encoded image

		// Build payload based on model type
		const payload = {
			model: model,
			prompt: prompt,
			response_format: 'url'
		};

		// Gemini models require exact width/height dimensions
		if (model.includes('gemini') || model.includes('google/')) {
			payload.width = 1024;
			payload.height = 1024;
		}

		// Add reference_images if image provided
		if (image) {
			// Service expects data URLs with prefix, not raw base64
			const dataUrl = image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;
			payload.reference_images = [dataUrl];
			console.log('[Images API] Sending reference_images, length:', dataUrl.length);
		}

		console.log('[Images API] Payload keys:', Object.keys(payload));
		console.log('[Images API] Sending request to AI service with 60s timeout and retries...');

		const res = await fetchWithRetry(`${TOGETHER_BASE}/images/generations`, payload);

		console.log('[Images API] Response status:', res.status);

		if (!res.ok) {
			console.log('[Images API] Error response:', res.data);
			console.error('[Images API] Request payload:', JSON.stringify(payload, null, 2));
			throw error(res.status, `Images API error: ${res.data}`);
		}

		console.log('[Images API] Success - received data with', res.data.data?.length || 0, 'images');
		return json(res.data);
	} catch (err) {
		console.error('[Images API] Catch error:', err);
		const msg = err?.body?.message || err?.message || String(err);
		console.error('[Images API] Proxy error:', msg);
		throw error(502, `Proxy error: ${msg}`);
	}
}
