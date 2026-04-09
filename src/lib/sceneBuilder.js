// @ts-nocheck
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export function createScene() {
	const scene = new THREE.Scene();
	scene.background = new THREE.Color('#f0f0f0');
	return scene;
}

export function createCamera(width, height) {
	const safeHeight = Math.max(height || 1, 1);
	const camera = new THREE.PerspectiveCamera(50, (width || 1) / safeHeight, 0.1, 1000);
	camera.position.set(12, 10, 12);
	camera.lookAt(0, 0, 0);
	return camera;
}

export function createRenderer(canvas) {
	const renderer = new THREE.WebGLRenderer({
		canvas,
		antialias: true,
		alpha: true,
		preserveDrawingBuffer: true
	});
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.setSize(canvas.clientWidth || 800, canvas.clientHeight || 600, false);
	renderer.shadowMap.enabled = false;
	return renderer;
}

export function setupLighting(scene) {
	const ambientLight = new THREE.AmbientLight(0xffffff, 1);
	scene.add(ambientLight);

	const directionalLight = new THREE.DirectionalLight(0xffffff, 1.4);
	directionalLight.position.set(12, 18, 10);
	directionalLight.castShadow = true;
	scene.add(directionalLight);

	return { ambientLight, directionalLight };
}

export function createDefaultObjects(scene) {
	const gridHelper = new THREE.GridHelper(40, 40, 0xb3b3b3, 0xd9d9d9);
	scene.add(gridHelper);

	const axesHelper = new THREE.AxesHelper(4);
	scene.add(axesHelper);

	const cube = new THREE.Mesh(
		new THREE.BoxGeometry(2, 2, 2),
		new THREE.MeshStandardMaterial({ color: '#6b7280' })
	);
	cube.position.y = 1;
	scene.add(cube);

	return { gridHelper, axesHelper, cube };
}

export function setupControls(camera, renderer) {
	const controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.target.set(0, 0, 0);
	controls.update();
	return controls;
}

export function handleResize(camera, renderer, canvas) {
	const width = canvas.clientWidth || 1;
	const height = canvas.clientHeight || 1;
	camera.aspect = width / Math.max(height, 1);
	camera.updateProjectionMatrix();
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.setSize(width, height, false);
}
