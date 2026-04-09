<svelte:options runes={false} />
<script lang="ts">
	// @ts-nocheck
	import { onMount, onDestroy } from 'svelte';
	import * as THREE from 'three';
	import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
	import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
	import {
		createScene,
		createCamera,
		createRenderer,
		setupLighting,
		createDefaultObjects,
		handleResize,
		setupControls
	} from '$lib/sceneBuilder.js';

	export let className = '';
	export let renderObject: any = null;
	export let backgroundColor = '#f0f0f0';
	export let backgroundImageUrl = '';
	export let transparentBackground = false;
	export let showGrid = true;
	export let showAxes = true;
	export let ambientLightIntensity = 1.0;
	export let directionalLightIntensity = 1.5;
	export let showWireframe = false;
	export let enableShadows = false;
	export let fogEnabled = false;
	export let fogNear = 10;
	export let fogFar = 50;
	export let fogColor = '#f8fafc';
	export let cameraFov = 50;
	export let toneMappingExposure = 1;
	export let renderMode: 'standard' | 'outline' | 'overlay' = 'standard';
	export let outlineColor = '#000000';
	export let outlineBackgroundColor = '#ffffff';
	export let outlineThresholdAngle = 25;

	let canvas: HTMLCanvasElement;
	let scene: any;
	let camera: any;
	let renderer: any;
	let animationId: number;
	let lights: any;
	let objects: any;
	let controls: any;
	let mountedRenderObject: any = null;
	let framedRenderObject: any = null;
	let containerWidth = 800;
	let containerHeight = 600;
	let outlineScene: THREE.Scene | null = null;
	let outlineGroup: THREE.Group | null = null;
	let outlineSignature = '';
	let loadedBackgroundImage: HTMLImageElement | null = null;
	let loadedBackgroundImageUrl = '';
	let animationPaused = false; // Pause animation during cleanup
	let lastFrameTime = 0;
	let targetFPS = 60;
	let frameInterval = 1000 / targetFPS;
	let sceneControlsTimeout: any = null;
	const outlineFillMaterial = new THREE.MeshBasicMaterial({
		color: '#ffffff',
		side: THREE.DoubleSide
	});

	type ScreenshotOptions = {
		maxWidth?: number;
		format?: 'image/png' | 'image/jpeg';
		quality?: number;
		maxBytes?: number;
	};

	const estimateDataUrlBytes = (dataUrl: string): number => {
		const base64Payload = dataUrl.split(',')[1] ?? '';
		return Math.floor((base64Payload.length * 3) / 4);
	};

	export function captureScreenshot(options: ScreenshotOptions = {}) {
		if (!renderer || !scene || !camera) return '';
		const { maxWidth, format = 'image/png', quality: requestedQuality = 0.9, maxBytes } = options;
		renderFrame();

		const sourceCanvas = document.createElement('canvas');
		sourceCanvas.width = renderer.domElement.width;
		sourceCanvas.height = renderer.domElement.height;
		const sourceContext = sourceCanvas.getContext('2d');
		if (!sourceContext) return renderer.domElement.toDataURL(format, requestedQuality);

		if (!transparentBackground || !backgroundImageUrl) {
			sourceContext.drawImage(renderer.domElement, 0, 0, sourceCanvas.width, sourceCanvas.height);
		} else {
			if (loadedBackgroundImage && loadedBackgroundImageUrl === backgroundImageUrl) {
				sourceContext.drawImage(
					loadedBackgroundImage,
					0,
					0,
					sourceCanvas.width,
					sourceCanvas.height
				);
			}
			sourceContext.drawImage(renderer.domElement, 0, 0, sourceCanvas.width, sourceCanvas.height);
		}

		const initialScale =
			typeof maxWidth === 'number' && maxWidth > 0 && sourceCanvas.width > maxWidth
				? maxWidth / sourceCanvas.width
				: 1;

		let targetWidth = Math.max(1, Math.round(sourceCanvas.width * initialScale));
		let targetHeight = Math.max(1, Math.round(sourceCanvas.height * initialScale));
		let currentQuality = requestedQuality;

		const encodeScreenshot = () => {
			const encodedCanvas = document.createElement('canvas');
			encodedCanvas.width = targetWidth;
			encodedCanvas.height = targetHeight;
			const encodedContext = encodedCanvas.getContext('2d');
			if (!encodedContext) return sourceCanvas.toDataURL(format, currentQuality);
			encodedContext.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);
			return encodedCanvas.toDataURL(format, currentQuality);
		};

		let screenshotDataUrl = encodeScreenshot();
		if (typeof maxBytes === 'number' && maxBytes > 0 && format === 'image/jpeg') {
			let attempts = 0;
			while (estimateDataUrlBytes(screenshotDataUrl) > maxBytes && attempts < 7) {
				if (currentQuality > 0.5) {
					currentQuality = Math.max(0.5, currentQuality - 0.1);
				} else {
					targetWidth = Math.max(1, Math.round(targetWidth * 0.85));
					targetHeight = Math.max(1, Math.round(targetHeight * 0.85));
				}
				screenshotDataUrl = encodeScreenshot();
				attempts += 1;
			}
		}

		return screenshotDataUrl;
	}

	export async function exportToGLB(): Promise<Blob> {
		return new Promise((resolve, reject) => {
			if (!scene) return reject(new Error('Scene not initialized'));
			const exporter = new GLTFExporter();
			exporter.parse(
				scene,
				(result) => {
					if (result instanceof ArrayBuffer) {
						resolve(new Blob([result], { type: 'application/octet-stream' }));
					} else {
						const json = JSON.stringify(result);
						resolve(new Blob([json], { type: 'application/octet-stream' }));
					}
				},
				(error) => reject(error),
				{ binary: true }
			);
		});
	}

	export async function exportToOBJ(): Promise<Blob> {
		return new Promise((resolve, reject) => {
			if (!scene) return reject(new Error('Scene not initialized'));
			try {
				const exporter = new OBJExporter();
				const result = exporter.parse(scene);
				resolve(new Blob([result], { type: 'text/plain' }));
			} catch (error) {
				reject(error);
			}
		});
	}

	export function downloadGLB() {
		exportToGLB().then((blob) => {
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = 'scene.glb';
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
			URL.revokeObjectURL(url);
		});
	}

	export function downloadOBJ() {
		exportToOBJ().then((blob) => {
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = 'scene.obj';
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
			URL.revokeObjectURL(url);
		});
	}

	function updateLoadedBackgroundImage() {
		if (!backgroundImageUrl) {
			loadedBackgroundImage = null;
			loadedBackgroundImageUrl = '';
			return;
		}

		const img = new Image();
		img.onload = () => {
			loadedBackgroundImage = img;
			loadedBackgroundImageUrl = backgroundImageUrl;
		};
		img.onerror = () => {
			console.warn('[Canvas3D] Failed to load background image:', backgroundImageUrl);
			loadedBackgroundImage = null;
			loadedBackgroundImageUrl = '';
		};
		img.src = backgroundImageUrl;
	}

	function applySceneControlsDebounced() {
		if (sceneControlsTimeout) {
			clearTimeout(sceneControlsTimeout);
		}
		sceneControlsTimeout = setTimeout(() => {
			applySceneControls();
			sceneControlsTimeout = null;
		}, 16); // Debounce to ~60fps
	}

	function applySceneControls() {
		if (!scene || !objects) return;
		scene.background = transparentBackground ? null : new THREE.Color(backgroundColor);
		if (objects?.gridHelper) objects.gridHelper.visible = showGrid;
		if (objects?.axesHelper) objects.axesHelper.visible = showAxes;

		if (lights) {
			if (lights.ambientLight) lights.ambientLight.intensity = ambientLightIntensity;
			if (lights.directionalLight) lights.directionalLight.intensity = directionalLightIntensity;
		}

		// Wireframe - optimize traversal
		scene.traverse((child: any) => {
			if (child.isMesh && child.material) {
				if (Array.isArray(child.material)) {
					child.material.forEach((mat: any) => {
						if (mat) mat.wireframe = showWireframe;
					});
				} else {
					child.material.wireframe = showWireframe;
				}
			}
		});

		// Shadows - batch updates
		if (renderer) {
			renderer.shadowMap.enabled = enableShadows;
			const meshesToUpdate: any[] = [];
			const lightsToUpdate: any[] = [];
			
			scene.traverse((child: any) => {
				if (child.isMesh) {
					meshesToUpdate.push(child);
				}
				if (child.isLight && child.shadow) {
					lightsToUpdate.push(child);
				}
			});
			
			meshesToUpdate.forEach((mesh) => {
				mesh.castShadow = enableShadows;
				mesh.receiveShadow = enableShadows;
			});
			
			lightsToUpdate.forEach((light) => {
				light.castShadow = enableShadows;
			});
		}

		// Fog
		if (fogEnabled) {
			scene.fog = new THREE.Fog(new THREE.Color(fogColor), fogNear, fogFar);
		} else {
			scene.fog = null;
		}

		// Camera FOV
		if (camera) {
			camera.fov = cameraFov;
			camera.updateProjectionMatrix();
		}

		// Tone mapping exposure
		if (renderer) {
			renderer.toneMappingExposure = toneMappingExposure;
			renderer.setClearAlpha(transparentBackground ? 0 : 1);
		}
	}

	function updateRenderObject() {
		if (!scene) return;
		
		// Store reference to old object before cleanup
		const oldRenderObject = mountedRenderObject;
		
		if (oldRenderObject) {
			// Pause animation during cleanup
			animationPaused = true;
			
			// Remove old object from scene immediately (no traversal needed)
			scene.remove(oldRenderObject);
			
			// Clear the reference immediately
			mountedRenderObject = null;
			
			// Resume animation after a short delay to allow cleanup to complete
			setTimeout(() => {
				animationPaused = false;
			}, 50);
		}

		if (renderObject) {
			mountedRenderObject = renderObject;
			scene.add(mountedRenderObject);
			if (objects?.cube) objects.cube.visible = false;
			const bounds = new THREE.Box3().setFromObject(mountedRenderObject);
			if (!bounds.isEmpty() && framedRenderObject !== renderObject) {
				const center = bounds.getCenter(new THREE.Vector3());
				const size = bounds.getSize(new THREE.Vector3());
				const distance = Math.max(size.x, size.y, size.z, 1) * 2.4;
				camera.position.set(center.x + distance, center.y + distance * 0.7, center.z + distance);
				camera.lookAt(center);
				controls?.target.copy(center);
				controls?.update();
				framedRenderObject = renderObject;
			}
		} else if (objects?.cube) {
			objects.cube.visible = true;
			framedRenderObject = null;
		}
		rebuildOutlineGroup();
	}

	function buildOutlineSignature() {
		if (!mountedRenderObject) return '';
		const thresholdAngle = Math.max(0, Number(outlineThresholdAngle) || 25);
		const visibleMeshes: string[] = [];
		mountedRenderObject.updateMatrixWorld(true);
		mountedRenderObject.traverseVisible((child: any) => {
			if (!child?.isMesh || !child.geometry) return;
			visibleMeshes.push(child.uuid);
		});
		return `${outlineColor}|${thresholdAngle}|${visibleMeshes.join('|')}`;
	}

	function rebuildOutlineGroup() {
		if (outlineGroup) {
			outlineGroup.traverse((child: any) => {
				if (child?.geometry?.dispose) child.geometry.dispose();
			});
		}
		if (!mountedRenderObject) {
			outlineGroup = null;
			outlineScene = null;
			outlineSignature = '';
			return;
		}
		const group = new THREE.Group();
		const lineMaterial = new THREE.LineBasicMaterial({ color: outlineColor });
		const thresholdAngle = Math.max(0, Number(outlineThresholdAngle) || 25);
		mountedRenderObject.updateMatrixWorld(true);
		mountedRenderObject.traverseVisible((child: any) => {
			if (!child?.isMesh || !child.geometry) return;
			const edgesGeometry = new THREE.EdgesGeometry(child.geometry, thresholdAngle);
			edgesGeometry.applyMatrix4(child.matrixWorld);
			const edges = new THREE.LineSegments(edgesGeometry, lineMaterial);
			edges.matrixAutoUpdate = false;
			group.add(edges);
		});
		outlineGroup = group;
		outlineScene = new THREE.Scene();
		outlineScene.add(group);
		outlineSignature = buildOutlineSignature();
	}

	function syncOutlineGroup() {
		if (!mountedRenderObject) {
			if (outlineGroup || outlineScene || outlineSignature) rebuildOutlineGroup();
			return;
		}
		const nextSignature = buildOutlineSignature();
		if (nextSignature !== outlineSignature) {
			rebuildOutlineGroup();
		}
	}

	function renderOutlineLayer() {
		syncOutlineGroup();
		if (!renderer || !camera || !outlineScene) return;
		const previousAutoClear = renderer.autoClear;
		renderer.autoClear = false;
		renderer.render(outlineScene, camera);
		renderer.autoClear = previousAutoClear;
	}

	function renderFrame() {
		if (!renderer || !scene || !camera) return;
		if (renderMode === 'standard') {
			renderer.render(scene, camera);
			return;
		}
		if (renderMode === 'overlay') {
			renderer.render(scene, camera);
			renderOutlineLayer();
			return;
		}
		const previousBackground = scene.background;
		const previousOverrideMaterial = scene.overrideMaterial;
		const showBackgroundImageInOutline = Boolean(backgroundImageUrl);
		const previousClearAlpha = renderer.getClearAlpha();
		const previousClearColor = renderer.getClearColor(new THREE.Color()).clone();
		scene.background = showBackgroundImageInOutline
			? null
			: new THREE.Color(outlineBackgroundColor);
		if (showBackgroundImageInOutline) {
			renderer.setClearColor(previousClearColor, 0);
		}
		scene.overrideMaterial = outlineFillMaterial;
		renderer.render(scene, camera);
		scene.overrideMaterial = previousOverrideMaterial;
		renderOutlineLayer();
		scene.background = previousBackground;
		if (showBackgroundImageInOutline) {
			renderer.setClearColor(previousClearColor, previousClearAlpha);
		}
	}

	onMount(() => {
		if (!canvas) return;

		// Initialize water time tracking
		(window as any)._lastWaterTime = performance.now();

		// Set initial dimensions
		containerWidth = canvas.clientWidth;
		containerHeight = canvas.clientHeight;

		// Initialize scene
		scene = createScene();

		// Setup camera
		camera = createCamera(containerWidth, containerHeight);

		// Setup renderer
		renderer = createRenderer(canvas);

		// Setup lighting
		lights = setupLighting(scene);

		// Add default objects
		objects = createDefaultObjects(scene);

		// Setup controls
		controls = setupControls(camera, renderer);
		applySceneControls();
		updateRenderObject();

		// Start animation loop
		animate(performance.now());

		// Handle window resize
		const handleWindowResize = () => {
			handleResize(camera, renderer, canvas);
		};

		window.addEventListener('resize', handleWindowResize);

		// Cleanup on destroy
		return () => {
			window.removeEventListener('resize', handleWindowResize);
		};
	});

	onDestroy(() => {
		if (animationId) {
			cancelAnimationFrame(animationId);
		}
		if (renderer) {
			renderer.dispose();
		}
	});

	function animate(currentTime: number) {
		animationId = requestAnimationFrame(animate);

		// Frame rate limiting
		if (currentTime - lastFrameTime < frameInterval) {
			return;
		}
		lastFrameTime = currentTime;

		// Update controls
		if (controls) {
			controls.update();
		}

		// Rotate the default cube for demonstration
		if (objects?.cube) {
			objects.cube.rotation.x += 0.01;
			objects.cube.rotation.y += 0.01;
		}

		// Update water animations (optimized)
		if (!animationPaused && scene && mountedRenderObject && typeof mountedRenderObject.traverse === 'function') {
			const deltaTime = currentTime - (window as any)._lastWaterTime || 0;
			(window as any)._lastWaterTime = currentTime;
			
			// Skip water updates if too frequent
			if (deltaTime > 16) { // ~60fps throttle
				try {
					// Use a more efficient traversal - only check userData once
					const objectsToUpdate: any[] = [];
					mountedRenderObject.traverse((object: any) => {
						if (object?.userData?.updateWater && object?.userData?.waterAnimation) {
							objectsToUpdate.push(object);
						}
					});
					
					// Update only objects that need water animation
					objectsToUpdate.forEach((object) => {
						try {
							object.userData.updateWater(deltaTime);
							if (object.geometry?.attributes?.position) {
								object.geometry.attributes.position.needsUpdate = true;
							}
						} catch (error) {
							console.warn('[Canvas3D] Water animation error:', error);
							// Disable problematic water animation completely
							object.userData.updateWater = null;
							object.userData.waterAnimation = null;
						}
					});
				} catch (error) {
					console.warn('[Canvas3D] Render object traversal error:', error);
					// Pause animation briefly to prevent continuous errors
					animationPaused = true;
					setTimeout(() => {
						animationPaused = false;
					}, 100);
				}
			}
		}

		renderFrame();
	}

	// Handle prop changes
	$: if (renderer && canvas) {
		const newWidth = canvas.clientWidth;
		const newHeight = canvas.clientHeight;
		if (newWidth !== containerWidth || newHeight !== containerHeight) {
			containerWidth = newWidth;
			containerHeight = newHeight;
			handleResize(camera, renderer, canvas);
		}
	}

	$: if (scene && camera && objects && renderObject !== undefined) {
		updateRenderObject();
	}

	$: if (mountedRenderObject && (outlineColor || outlineThresholdAngle)) {
		rebuildOutlineGroup();
	}

	$: if (backgroundImageUrl !== loadedBackgroundImageUrl) {
		updateLoadedBackgroundImage();
	}

	$: if (
		scene &&
		objects &&
		lights &&
		(backgroundColor ||
			showGrid !== undefined ||
			showAxes !== undefined ||
			ambientLightIntensity ||
			directionalLightIntensity ||
			showWireframe !== undefined ||
			enableShadows !== undefined ||
			fogEnabled !== undefined ||
			fogNear ||
			fogFar ||
			fogColor ||
			cameraFov ||
			toneMappingExposure)
	) {
		applySceneControlsDebounced();
	}
</script>

<div
	class={`canvas-shell ${className}`}
	class:canvas-shell--monochrome-bg={renderMode === 'outline' && !!backgroundImageUrl}
	style:background-image={backgroundImageUrl ? `url(${backgroundImageUrl})` : 'none'}
>
	<canvas bind:this={canvas}></canvas>
</div>

<style>
	.canvas-shell {
		width: 100%;
		height: 100%;
		background-size: cover;
		background-position: center;
		background-repeat: no-repeat;
	}

	.canvas-shell--monochrome-bg {
		filter: grayscale(1) contrast(1.15);
	}

	canvas {
		display: block;
		width: 100%;
		height: 100%;
		pointer-events: auto;
		touch-action: none;
		border-radius: 8px;
		box-shadow:
			0 4px 6px -1px rgba(0, 0, 0, 0.1),
			0 2px 4px -1px rgba(0, 0, 0, 0.06);
	}
</style>
