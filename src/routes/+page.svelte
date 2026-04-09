<svelte:options runes={false} />
<script lang="ts">
	// @ts-nocheck
	import * as THREE from 'three';
	import Canvas3D from '$lib/components/Canvas3D.svelte';
	import { ContourTracer } from '$lib/contour-tracer.js';

	type TraceResult = {
		points: Array<{ x: number; y: number }>;
		area: number;
		closed: boolean;
	};

	const tracer = new ContourTracer();

	let prompt = 'modern two floor family house plan';
	let isLoading = false;
	let errorMessage = '';

	let floor1Url = '';
	let floor2Url = '';
	let floor1SourceUrl = '';
	let floor2SourceUrl = '';

	let wallContoursFloor1: TraceResult[] = [];
	let windowContoursFloor1: TraceResult[] = [];
	let doorContoursFloor1: TraceResult[] = [];
	let wallContoursFloor2: TraceResult[] = [];
	let windowContoursFloor2: TraceResult[] = [];
	let doorContoursFloor2: TraceResult[] = [];

	let renderObject: THREE.Group | null = null;

	async function generate() {
		if (!prompt.trim()) {
			errorMessage = 'Please enter a prompt for the house plan.';
			return;
		}

		isLoading = true;
		errorMessage = '';
		resetResults();

		try {
			const floor1Prompt =
				`Architectural top-down floor plan, ${prompt}. ` +
				'Flat 2D scheme only, pure white background, black walls, green windows, red doors. ' +
				'No text labels, no shadows, no furniture, no dimensions, no perspective.';

			const first = await requestImage(floor1Prompt);
			floor1SourceUrl = first;
			floor1Url = toProxyUrl(first);

			const floor2Prompt =
				'Second floor plan variation based on the reference image. Keep exactly same visual language: black walls, green windows, red doors, white background, flat schematic top-down.';
			const second = await requestImage(floor2Prompt, floor1SourceUrl);
			floor2SourceUrl = second;
			floor2Url = toProxyUrl(second);

			({
				walls: wallContoursFloor1,
				windows: windowContoursFloor1,
				doors: doorContoursFloor1
			} = await extractByClass(floor1Url));

			({
				walls: wallContoursFloor2,
				windows: windowContoursFloor2,
				doors: doorContoursFloor2
			} = await extractByClass(floor2Url));

			renderObject = build3DFromContours();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			isLoading = false;
		}
	}

	function resetResults() {
		floor1Url = '';
		floor2Url = '';
		floor1SourceUrl = '';
		floor2SourceUrl = '';
		wallContoursFloor1 = [];
		windowContoursFloor1 = [];
		doorContoursFloor1 = [];
		wallContoursFloor2 = [];
		windowContoursFloor2 = [];
		doorContoursFloor2 = [];
		renderObject = null;
	}

	async function requestImage(imagePrompt: string, referenceImage?: string): Promise<string> {
		const response = await fetch('/images', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: imagePrompt, imageUrl: referenceImage })
		});

		if (!response.ok) {
			const message = await response.text();
			throw new Error(`Image generation failed: ${message}`);
		}

		const data = await response.json();
		const url = data?.data?.[0]?.url;
		if (!url) {
			throw new Error('The image API did not return an image URL.');
		}

		return url;
	}

	function toProxyUrl(url: string) {
		if (!url) return '';
		if (url.startsWith('/image-proxy?url=')) return url;
		if (url.startsWith('data:')) return url;
		return `/image-proxy?url=${encodeURIComponent(url)}`;
	}

	async function extractByClass(src: string) {
		const image = await loadImage(src);
		const wallsCanvas = createMaskCanvas(image, (r, g, b) => r < 70 && g < 70 && b < 70);
		const windowsCanvas = createMaskCanvas(
			image,
			(r, g, b) => g > 120 && r < 120 && b < 120
		);
		const doorsCanvas = createMaskCanvas(image, (r, g, b) => r > 130 && g < 110 && b < 110);

		const commonOpts = {
			threshold: 200,
			simplifyEpsilon: 1.2,
			minPoints: 8,
			maxContours: 250,
			normalize: false,
			invert: false,
			maxSize: 1024
		};

		const walls = (await tracer.fromImage(wallsCanvas, commonOpts)) as TraceResult[];
		const windows = (await tracer.fromImage(windowsCanvas, commonOpts)) as TraceResult[];
		const doors = (await tracer.fromImage(doorsCanvas, commonOpts)) as TraceResult[];

		return { walls, windows, doors };
	}

	async function loadImage(src: string) {
		const safeSrc = src.startsWith('http') ? toProxyUrl(src) : src;
		const response = await fetch(safeSrc);
		if (!response.ok) {
			throw new Error(`Could not fetch generated image for contour extraction (${response.status}).`);
		}
		const blob = await response.blob();
		const objectUrl = URL.createObjectURL(blob);

		return new Promise<HTMLImageElement>((resolve, reject) => {
			const image = new Image();
			image.onload = () => {
				URL.revokeObjectURL(objectUrl);
				resolve(image);
			};
			image.onerror = () => {
				URL.revokeObjectURL(objectUrl);
				reject(new Error('Could not load generated image for contour extraction.'));
			};
			image.src = objectUrl;
		});
	}

	function createMaskCanvas(
		image: HTMLImageElement,
		matcher: (r: number, g: number, b: number) => boolean
	) {
		const canvas = document.createElement('canvas');
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const context = canvas.getContext('2d');
		if (!context) {
			throw new Error('Could not create canvas context for contour extraction.');
		}
		context.drawImage(image, 0, 0);
		const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
		const { data } = imageData;
		for (let i = 0; i < data.length; i += 4) {
			const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
			const isMatch = matcher(r, g, b);
			const value = isMatch ? 0 : 255;
			data[i] = value;
			data[i + 1] = value;
			data[i + 2] = value;
			data[i + 3] = 255;
		}
		context.putImageData(imageData, 0, 0);
		return canvas;
	}

	function build3DFromContours() {
		const group = new THREE.Group();
		group.rotation.x = -Math.PI / 2;
		group.position.y = 0;

		const pxToWorld = 0.02;
		const floorHeight = 3;

		addFloor(group, wallContoursFloor1, 0, 2.8, '#111111', pxToWorld);
		addFloor(group, windowContoursFloor1, 0.9, 1.5, '#16a34a', pxToWorld);
		addFloor(group, doorContoursFloor1, 0, 2.2, '#dc2626', pxToWorld);

		addFloor(group, wallContoursFloor2, floorHeight, 2.8, '#1f2937', pxToWorld);
		addFloor(group, windowContoursFloor2, floorHeight + 0.9, 1.5, '#22c55e', pxToWorld);
		addFloor(group, doorContoursFloor2, floorHeight, 2.2, '#ef4444', pxToWorld);

		const slabMaterial = new THREE.MeshStandardMaterial({ color: '#e5e7eb', metalness: 0.05, roughness: 0.9 });
		const slab = new THREE.Mesh(new THREE.BoxGeometry(24, 0.15, 24), slabMaterial);
		slab.position.set(0, -0.1, 0);
		group.add(slab);

		return group;
	}

	function addFloor(
		group: THREE.Group,
		contours: TraceResult[],
		yOffset: number,
		height: number,
		color: string,
		scale: number
	) {
		const material = new THREE.MeshStandardMaterial({
			color,
			metalness: 0.08,
			roughness: 0.85
		});

		for (const contour of contours) {
			if (!contour.points || contour.points.length < 3) continue;
			const shape = toShape(contour.points, scale);
			if (!shape) continue;

			const geometry = new THREE.ExtrudeGeometry(shape, {
				depth: height,
				bevelEnabled: false,
				curveSegments: 2
			});
			const mesh = new THREE.Mesh(geometry, material);
			mesh.position.y = yOffset;
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			group.add(mesh);
		}
	}

	function toShape(points: Array<{ x: number; y: number }>, scale: number) {
		const deduped = removeNearDuplicates(points);
		if (deduped.length < 3) return null;
		const centerX = deduped.reduce((sum, p) => sum + p.x, 0) / deduped.length;
		const centerY = deduped.reduce((sum, p) => sum + p.y, 0) / deduped.length;

		const shape = new THREE.Shape();
		shape.moveTo((deduped[0].x - centerX) * scale, (deduped[0].y - centerY) * scale);
		for (let i = 1; i < deduped.length; i++) {
			shape.lineTo((deduped[i].x - centerX) * scale, (deduped[i].y - centerY) * scale);
		}
		shape.closePath();
		return shape;
	}

	function removeNearDuplicates(points: Array<{ x: number; y: number }>) {
		const minDistanceSq = 2.2;
		const filtered: Array<{ x: number; y: number }> = [];
		for (const point of points) {
			const previous = filtered[filtered.length - 1];
			if (!previous) {
				filtered.push(point);
				continue;
			}
			const dx = point.x - previous.x;
			const dy = point.y - previous.y;
			if (dx * dx + dy * dy >= minDistanceSq) {
				filtered.push(point);
			}
		}
		return filtered;
	}
</script>

<svelte:head>
	<title>2D Plan to 3D House Generator</title>
</svelte:head>

<main>
	<section class="panel">
		<h1>2D Plan → 3D House</h1>
		<p>Enter a prompt and generate a color-coded floor plan pair, contour extraction, and 3D extrusions.</p>
		<div class="form-row">
			<textarea
				bind:value={prompt}
				rows="3"
				placeholder="Example: compact two-storey house with staircase core and balcony"
			></textarea>
			<button on:click={generate} disabled={isLoading} aria-label={isLoading ? 'Generating plan' : 'Generate plan'}>
				{isLoading ? '⏳' : '✨'}
			</button>
		</div>
		{#if errorMessage}
			<p class="error">{errorMessage}</p>
		{/if}
	</section>

	<section class="results-grid">
		<article>
			<h2>First Floor (Generated)</h2>
			{#if floor1Url}
				<img src={floor1Url} alt="Generated first floor plan" />
			{:else}
				<div class="placeholder">No image yet</div>
			{/if}
			<p>Contours: walls {wallContoursFloor1.length}, windows {windowContoursFloor1.length}, doors {doorContoursFloor1.length}</p>
		</article>

		<article>
			<h2>Second Floor (Generated)</h2>
			{#if floor2Url}
				<img src={floor2Url} alt="Generated second floor plan" />
			{:else}
				<div class="placeholder">No image yet</div>
			{/if}
			<p>Contours: walls {wallContoursFloor2.length}, windows {windowContoursFloor2.length}, doors {doorContoursFloor2.length}</p>
		</article>
	</section>

	<section class="viewer">
		<h2>3D Extrusion View (three.js)</h2>
		<div class="canvas-wrap">
			<Canvas3D renderObject={renderObject} showAxes={false} />
		</div>
	</section>
</main>

<style>
	:global(body) {
		margin: 0;
		font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
		background: #f5f7fb;
		color: #111827;
	}

	main {
		max-width: 1200px;
		margin: 0 auto;
		padding: 1rem;
		display: grid;
		gap: 1rem;
	}

	.panel,
	.results-grid article,
	.viewer {
		background: white;
		padding: 1rem;
		border-radius: 12px;
		box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
	}

	h1,
	h2 {
		margin: 0 0 0.5rem;
	}

	.form-row {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.8rem;
		align-items: start;
	}

	textarea {
		width: 100%;
		resize: vertical;
		min-height: 88px;
		padding: 0.6rem;
		font-size: 0.95rem;
		border: 1px solid #cbd5e1;
		border-radius: 10px;
	}

	button {
		padding: 0.7rem 1rem;
		border: none;
		border-radius: 10px;
		background: #2563eb;
		color: white;
		font-weight: 600;
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.error {
		color: #b91c1c;
		margin-top: 0.6rem;
	}

	.results-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	img,
	.placeholder {
		width: 100%;
		height: 320px;
		object-fit: cover;
		border: 1px solid #e2e8f0;
		border-radius: 10px;
	}

	.placeholder {
		display: grid;
		place-items: center;
		background: #f8fafc;
		color: #64748b;
	}

	.viewer .canvas-wrap {
		height: 520px;
	}

	@media (max-width: 960px) {
		.results-grid {
			grid-template-columns: 1fr;
		}

		.form-row {
			grid-template-columns: 1fr;
		}
	}
</style>
