# 2D Plan → 3D House Generator

A SvelteKit application that turns a text prompt into color-coded floor plan images, extracts structural contours, and builds a stacked 3D preview using three.js.

## What this project does

1. Accepts a natural-language prompt for a house plan.
2. Generates a first-floor 2D plan image.
3. Generates a second-floor 2D plan image using the first floor as reference.
4. Extracts contours by semantic class from each image:
   - **Walls** (black)
   - **Windows** (green)
   - **Doors** (red)
5. Extrudes each contour class into 3D meshes.
6. Stacks both floors vertically and renders the result in an interactive three.js viewer.

## Image generation model

This project uses:

- `google/flash-image-2.5`

The model is called by the server endpoint at `src/routes/images/+server.js`.

## Tech stack

- **SvelteKit** (UI + server routes)
- **TypeScript/Svelte** for page orchestration
- **three.js** for 3D geometry and rendering
- **ContourTracer** utility for bitmap contour extraction

## Project structure

- `src/routes/+page.svelte`  
  Main UI: prompt input, generate flow, contour extraction orchestration, and 3D mesh assembly.

- `src/lib/components/Canvas3D.svelte`  
  Reusable three.js canvas component for rendering generated geometry.

- `src/lib/sceneBuilder.js`  
  Shared scene/camera/renderer/lighting/control helpers used by `Canvas3D`.

- `src/lib/contour-tracer.js`  
  Contour extraction logic (Moore tracing + simplification) exported as ESM.

- `src/routes/images/+server.js`  
  Server endpoint that proxies requests to the image model and supports reference images.

- `src/routes/image-proxy/+server.js`  
  Same-origin proxy route for fetching remote image URLs to avoid browser CORS issues.

## Visual encoding expectations

For best contour extraction results, generated floor plans should be strict schematic images:

- White background
- Black walls
- Green windows
- Red doors
- No labels, shadows, perspective, or furniture

## Setup

### 1) Install dependencies

```bash
npm install
```

### 2) Configure environment

Set one of these server-side environment variables:

- `API_KEY`
- `TOGETHER_API_KEY`

### 3) Run development server

```bash
npm run dev
```

## Build and checks

```bash
npm run check
npm run build
```

## Notes and limitations

- Contour quality depends on how cleanly the model adheres to the expected color scheme.
- If model outputs anti-aliased or off-color regions, masks may capture extra noise.
- Browser-based tests may require Playwright browser binaries in your environment.
