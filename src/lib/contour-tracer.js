// @ts-nocheck
/**
 * ContourTracer — Pure JS bitmap-to-profile extraction
 * 
 * Pipeline: Image → Canvas → Binary threshold → Moore contour tracing → 
 *           RDP simplification → Normalization → [{x, y}, ...] profile
 *
 * Usage:
 *   const tracer = new ContourTracer();
 *   const profiles = await tracer.fromImage(imgElementOrURL, { threshold: 128, simplifyEpsilon: 1.5 });
 *   // profiles[0].points = [{x, y}, ...] — normalized to unit scale, largest contour first
 */

export class ContourTracer {

  // ─── Public API ───────────────────────────────────────────────

  /**
   * Extract profile contours from an image (URL, HTMLImageElement, or HTMLCanvasElement).
   * @param {string|HTMLImageElement|HTMLCanvasElement} source 
   * @param {Object} opts
   * @param {number} opts.threshold      - Grayscale threshold (0-255), default 128
   * @param {number} opts.simplifyEpsilon - RDP simplification tolerance in pixels, default 1.5
   * @param {number} opts.minPoints      - Skip contours with fewer points, default 10
   * @param {number} opts.maxContours    - Max contours to return (sorted by area), default 5
   * @param {boolean} opts.normalize     - Normalize to unit scale, default true
   * @param {boolean} opts.invert        - Invert: treat white as foreground, default false
   * @param {number} opts.maxSize        - Max image dimension for processing, default 512
   * @returns {Promise<Array<{points: Array<{x:number,y:number}>, area: number, closed: boolean}>>}
   */
  async fromImage(source, opts = {}) {
    const {
      threshold = 128,
      simplifyEpsilon = 1.5,
      minPoints = 10,
      maxContours = 5,
      normalize = true,
      invert = false,
      maxSize = 512
    } = opts;

    // Step 1: Load image onto canvas
    const canvas = await this._loadToCanvas(source, maxSize);
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Step 2: Convert to binary bitmap
    const binary = this._threshold(imageData, threshold, invert);

    // Step 3: Trace all contours (Moore neighborhood)
    const rawContours = this._traceAllContours(binary, canvas.width, canvas.height);

    // Step 4: Process each contour
    let results = rawContours
      .filter(c => c.length >= minPoints)
      .map(contour => {
        // Simplify
        const simplified = this._rdpSimplify(contour, simplifyEpsilon);
        // Compute area (signed, for sorting)
        const area = Math.abs(this._polygonArea(simplified));
        return { points: simplified, area, closed: true };
      })
      .sort((a, b) => b.area - a.area)
      .slice(0, maxContours);

    // Step 5: Normalize
    if (normalize) {
      results = results.map(r => ({
        ...r,
        points: this._normalizePoints(r.points)
      }));
    }

    return results;
  }

  /**
   * Extract a single open profile (e.g. chair side silhouette).
   * Takes the largest contour, splits it at the topmost and bottommost points,
   * and returns the longer half as an open curve.
   * @param {string|HTMLImageElement|HTMLCanvasElement} source
   * @param {Object} opts - Same as fromImage, plus:
   * @param {string} opts.side - 'left' or 'right' half of the contour, default 'left'
   * @returns {Promise<{points: Array<{x:number,y:number}>, closed: boolean}>}
   */
  async extractProfile(source, opts = {}) {
    const { side = 'left', ...restOpts } = opts;
    const contours = await this.fromImage(source, { ...restOpts, normalize: false, maxContours: 1 });
    if (contours.length === 0) return { points: [], closed: false };

    const pts = contours[0].points;

    // Find topmost and bottommost points
    let topIdx = 0, botIdx = 0;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].y < pts[topIdx].y) topIdx = i;
      if (pts[i].y > pts[botIdx].y) botIdx = i;
    }

    // Split contour into two halves at top/bottom
    const half1 = [];
    const half2 = [];
    let idx = topIdx;
    let onFirst = true;
    for (let count = 0; count <= pts.length; count++) {
      const pt = pts[idx % pts.length];
      if (onFirst) {
        half1.push(pt);
        if (idx % pts.length === botIdx) onFirst = false;
      } else {
        half2.push(pt);
      }
      idx++;
    }

    // Determine left/right by average x
    const avgX1 = half1.reduce((s, p) => s + p.x, 0) / half1.length;
    const avgX2 = half2.reduce((s, p) => s + p.x, 0) / half2.length;

    let profile;
    if (side === 'left') {
      profile = avgX1 < avgX2 ? half1 : half2;
    } else {
      profile = avgX1 > avgX2 ? half1 : half2;
    }

    // Ensure top-to-bottom ordering (ascending y)
    if (profile.length > 1 && profile[0].y > profile[profile.length - 1].y) {
      profile.reverse();
    }

    const normalized = opts.normalize !== false ? this._normalizePoints(profile) : profile;
    return { points: normalized, closed: false };
  }

  // ─── Image Loading ────────────────────────────────────────────

  async _loadToCanvas(source, maxSize) {
    let img;

    if (typeof source === 'string') {
      // URL — load as Image
      img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.crossOrigin = 'anonymous';
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = source;
      });
    } else if (source instanceof HTMLCanvasElement) {
      // Already a canvas
      return source;
    } else if (source instanceof HTMLImageElement) {
      img = source;
      if (!img.complete) {
        await new Promise(resolve => { img.onload = resolve; });
      }
    } else {
      throw new Error('ContourTracer: source must be a URL string, HTMLImageElement, or HTMLCanvasElement');
    }

    // Scale down if needed
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    if (Math.max(w, h) > maxSize) {
      const scale = maxSize / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas;
  }

  // ─── Thresholding ─────────────────────────────────────────────

  /**
   * Convert RGBA ImageData to a 1D binary array (1 = foreground, 0 = background).
   * Foreground = dark pixels (below threshold) unless inverted.
   */
  _threshold(imageData, threshold, invert) {
    const { data, width, height } = imageData;
    const binary = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      const a = data[i * 4 + 3];
      // Grayscale luminance
      const gray = (r * 0.299 + g * 0.587 + b * 0.114);
      // Treat transparent pixels as background
      const isForeground = a > 128 && (invert ? gray >= threshold : gray < threshold);
      binary[i] = isForeground ? 1 : 0;
    }
    return binary;
  }

  // ─── Moore Neighborhood Contour Tracing ───────────────────────

  /**
   * Trace all outer contours from a binary image using Moore neighborhood tracing.
   * Returns array of contours, each a list of {x, y} pixel coordinates.
   */
  _traceAllContours(binary, width, height) {
    const visited = new Uint8Array(width * height); // marks boundary pixels already assigned
    const contours = [];

    // Scan left-to-right, top-to-bottom for contour start points
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (binary[idx] === 1 && visited[idx] === 0) {
          // Check if this is an outer boundary pixel (has a background neighbor or is at edge)
          if (this._isBorderPixel(binary, width, height, x, y)) {
            const contour = this._traceMoore(binary, visited, width, height, x, y);
            if (contour.length >= 4) {
              contours.push(contour);
            }
          }
        }
      }
    }

    return contours;
  }

  _isBorderPixel(binary, width, height, x, y) {
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) return true;
    // Check 4-connected neighbors
    const idx = y * width + x;
    if (binary[idx - 1] === 0) return true;       // left
    if (binary[idx + 1] === 0) return true;       // right
    if (binary[idx - width] === 0) return true;   // up
    if (binary[idx + width] === 0) return true;   // down
    return false;
  }

  /**
   * Moore neighborhood contour tracing starting from (startX, startY).
   * Walks clockwise around the boundary of the foreground region.
   */
  _traceMoore(binary, visited, width, height, startX, startY) {
    // 8-connected neighbor offsets (clockwise from top-left)
    //   7 0 1
    //   6 . 2
    //   5 4 3
    const dx = [0, 1, 1, 1, 0, -1, -1, -1];
    const dy = [-1, -1, 0, 1, 1, 1, 0, -1];

    const contour = [];
    const maxSteps = width * height * 2; // safety limit

    // Start pixel
    let cx = startX, cy = startY;
    // Entry direction: we came from the left (direction 6), so start checking from direction 7
    let backtrack = 6;

    let steps = 0;
    do {
      contour.push({ x: cx, y: cy });
      visited[cy * width + cx] = 1;

      // Search clockwise from (backtrack + 1) % 8
      let found = false;
      let startDir = (backtrack + 1) % 8;

      for (let i = 0; i < 8; i++) {
        const dir = (startDir + i) % 8;
        const nx = cx + dx[dir];
        const ny = cy + dy[dir];

        if (nx >= 0 && nx < width && ny >= 0 && ny < height && binary[ny * width + nx] === 1) {
          // Move to this neighbor
          backtrack = (dir + 4) % 8; // reverse direction
          cx = nx;
          cy = ny;
          found = true;
          break;
        }
      }

      if (!found) break; // isolated pixel
      steps++;
    } while ((cx !== startX || cy !== startY) && steps < maxSteps);

    return contour;
  }

  // ─── Ramer-Douglas-Peucker Simplification ─────────────────────

  _rdpSimplify(points, epsilon) {
    if (points.length <= 2) return points;

    // Find the point with the max distance from line(start, end)
    let maxDist = 0;
    let maxIdx = 0;
    const start = points[0];
    const end = points[points.length - 1];

    for (let i = 1; i < points.length - 1; i++) {
      const d = this._pointLineDistance(points[i], start, end);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }

    if (maxDist > epsilon) {
      const left = this._rdpSimplify(points.slice(0, maxIdx + 1), epsilon);
      const right = this._rdpSimplify(points.slice(maxIdx), epsilon);
      return left.slice(0, -1).concat(right);
    } else {
      return [start, end];
    }
  }

  _pointLineDistance(point, lineStart, lineEnd) {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
      const ex = point.x - lineStart.x;
      const ey = point.y - lineStart.y;
      return Math.sqrt(ex * ex + ey * ey);
    }
    const t = Math.max(0, Math.min(1, ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lenSq));
    const projX = lineStart.x + t * dx;
    const projY = lineStart.y + t * dy;
    const ex = point.x - projX;
    const ey = point.y - projY;
    return Math.sqrt(ex * ex + ey * ey);
  }

  // ─── Polygon Area (Shoelace formula) ──────────────────────────

  _polygonArea(points) {
    let area = 0;
    const n = points.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += points[i].x * points[j].y;
      area -= points[j].x * points[i].y;
    }
    return area / 2;
  }

  // ─── Normalization ────────────────────────────────────────────

  /**
   * Normalize points to fit within a unit bounding box centered at origin.
   * Preserves aspect ratio. Y is flipped so +Y = up (image Y is down).
   */
  _normalizePoints(points) {
    if (points.length === 0) return points;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const w = maxX - minX || 1;
    const h = maxY - minY || 1;
    const scale = 1 / Math.max(w, h);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    return points.map(p => ({
      x: Math.round(((p.x - cx) * scale) * 10000) / 10000,
      y: Math.round((-(p.y - cy) * scale) * 10000) / 10000  // flip Y
    }));
  }

  // ─── Skeleton / Centerline Extraction ──────────────────────────

  /**
   * Extract centerline curves from an image using Zhang-Suen thinning.
   * Returns polylines representing the center spines of strokes/shapes.
   * Best for images with thick lines/stripes (like your chevron pattern).
   *
   * @param {string|HTMLImageElement|HTMLCanvasElement} source
   * @param {Object} opts
   * @param {number} opts.threshold       - Grayscale threshold, default 128
   * @param {number} opts.simplifyEpsilon - RDP simplification tolerance, default 2.0
   * @param {number} opts.minLength       - Skip skeletons shorter than this (pixels), default 20
   * @param {number} opts.maxCurves       - Max curves to return (sorted by length), default 20
   * @param {boolean} opts.normalize      - Normalize to unit scale, default true
   * @param {boolean} opts.invert         - Invert foreground/background, default false
   * @param {number} opts.maxSize         - Max image dimension, default 512
   * @returns {Promise<Array<{points: Array<{x:number,y:number}>, length: number, closed: boolean}>>}
   */
  async extractSkeleton(source, opts = {}) {
    const {
      threshold = 128,
      simplifyEpsilon = 2.0,
      minLength = 20,
      maxCurves = 20,
      normalize = true,
      invert = false,
      maxSize = 512
    } = opts;

    // Step 1: Load and threshold
    const canvas = await this._loadToCanvas(source, maxSize);
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const binary = this._threshold(imageData, threshold, invert);
    const w = canvas.width, h = canvas.height;

    // Step 2: Zhang-Suen thinning → 1-pixel-wide skeleton
    const skeleton = this._zhangSuenThin(binary, w, h);

    // Step 3: Trace polylines from skeleton pixels
    const rawCurves = this._traceSkeletonPolylines(skeleton, w, h);

    // Step 4: Simplify, measure, filter, sort
    let results = rawCurves
      .map(curve => {
        const simplified = this._rdpSimplify(curve, simplifyEpsilon);
        const len = this._polylineLength(simplified);
        return { points: simplified, length: len, closed: false };
      })
      .filter(c => c.length >= minLength && c.points.length >= 2)
      .sort((a, b) => b.length - a.length);

    // Step 5: Deduplicate — remove curves that are near-identical
    results = this._deduplicateCurves(results);
    results = results.slice(0, maxCurves);

    // Step 6: Normalize
    if (normalize) {
      results = results.map(r => ({
        ...r,
        points: this._normalizePoints(r.points)
      }));
    }

    return results;
  }

  // ─── Zhang-Suen Thinning ──────────────────────────────────────

  /**
   * Zhang-Suen binary image thinning algorithm.
   * Iteratively removes boundary pixels until only 1-pixel-wide skeletons remain.
   * Returns a new binary array (1 = skeleton pixel).
   */
  _zhangSuenThin(binary, w, h) {
    // Work on a copy
    const img = new Uint8Array(binary);
    let changed = true;

    while (changed) {
      changed = false;

      // Sub-iteration 1
      const toRemove1 = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (img[y * w + x] === 0) continue;
          const [P2, P3, P4, P5, P6, P7, P8, P9] = this._zhangNeighbors(img, w, x, y);
          const B = P2 + P3 + P4 + P5 + P6 + P7 + P8 + P9;
          if (B < 2 || B > 6) continue;
          const A = this._zhangTransitions(P2, P3, P4, P5, P6, P7, P8, P9);
          if (A !== 1) continue;
          if (P2 * P4 * P6 !== 0) continue;
          if (P4 * P6 * P8 !== 0) continue;
          toRemove1.push(y * w + x);
        }
      }
      for (const idx of toRemove1) { img[idx] = 0; changed = true; }

      // Sub-iteration 2
      const toRemove2 = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (img[y * w + x] === 0) continue;
          const [P2, P3, P4, P5, P6, P7, P8, P9] = this._zhangNeighbors(img, w, x, y);
          const B = P2 + P3 + P4 + P5 + P6 + P7 + P8 + P9;
          if (B < 2 || B > 6) continue;
          const A = this._zhangTransitions(P2, P3, P4, P5, P6, P7, P8, P9);
          if (A !== 1) continue;
          if (P2 * P4 * P8 !== 0) continue;
          if (P2 * P6 * P8 !== 0) continue;
          toRemove2.push(y * w + x);
        }
      }
      for (const idx of toRemove2) { img[idx] = 0; changed = true; }
    }

    return img;
  }

  /**
   * Get 8-connected neighbors in Zhang-Suen order:
   * P9 P2 P3
   * P8  .  P4
   * P7 P6 P5
   */
  _zhangNeighbors(img, w, x, y) {
    return [
      img[(y - 1) * w + x],       // P2
      img[(y - 1) * w + x + 1],   // P3
      img[y * w + x + 1],         // P4
      img[(y + 1) * w + x + 1],   // P5
      img[(y + 1) * w + x],       // P6
      img[(y + 1) * w + x - 1],   // P7
      img[y * w + x - 1],         // P8
      img[(y - 1) * w + x - 1]    // P9
    ];
  }

  /**
   * Count 0→1 transitions in the ordered sequence P2,P3,...,P9,P2
   */
  _zhangTransitions(P2, P3, P4, P5, P6, P7, P8, P9) {
    const seq = [P2, P3, P4, P5, P6, P7, P8, P9, P2];
    let count = 0;
    for (let i = 0; i < 8; i++) {
      if (seq[i] === 0 && seq[i + 1] === 1) count++;
    }
    return count;
  }

  // ─── Skeleton Polyline Tracing ────────────────────────────────

  /**
   * Trace connected polylines from a 1-pixel-wide skeleton image.
   * Finds endpoints and junctions, then walks along skeleton paths.
   */
  _traceSkeletonPolylines(skeleton, w, h) {
    const visited = new Uint8Array(w * h);
    const curves = [];

    // Classify pixels: count neighbors
    const neighborCount = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (skeleton[y * w + x] === 0) continue;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (skeleton[(y + dy) * w + (x + dx)] === 1) count++;
          }
        }
        neighborCount[y * w + x] = count;
      }
    }

    // Find endpoints (1 neighbor) and junctions (3+ neighbors) as start points
    const startPoints = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        if (skeleton[idx] === 1 && (neighborCount[idx] === 1 || neighborCount[idx] >= 3)) {
          startPoints.push({ x, y });
        }
      }
    }

    // Trace from each endpoint
    for (const start of startPoints) {
      const startIdx = start.y * w + start.x;
      if (visited[startIdx] && neighborCount[startIdx] === 1) continue;

      // Find unvisited neighbors to trace into
      const neighbors = this._getSkeletonNeighbors(skeleton, w, h, start.x, start.y);
      for (const nb of neighbors) {
        if (visited[nb.y * w + nb.x] && neighborCount[nb.y * w + nb.x] !== 1) continue;

        const curve = [{ x: start.x, y: start.y }];
        let cx = nb.x, cy = nb.y;
        visited[startIdx] = 1;

        while (true) {
          const cidx = cy * w + cx;
          if (visited[cidx] && neighborCount[cidx] < 3) break;

          curve.push({ x: cx, y: cy });
          visited[cidx] = 1;

          // If we hit a junction or endpoint, stop
          if (neighborCount[cidx] >= 3 || neighborCount[cidx] === 1) break;

          // Find next unvisited neighbor
          const nextNbs = this._getSkeletonNeighbors(skeleton, w, h, cx, cy);
          let next = null;
          for (const n of nextNbs) {
            const nidx = n.y * w + n.x;
            if (!visited[nidx] || neighborCount[nidx] >= 3) {
              if (!visited[nidx]) { next = n; break; }
            }
          }
          if (!next) break;
          cx = next.x;
          cy = next.y;
        }

        if (curve.length >= 2) {
          curves.push(curve);
        }
      }
    }

    // Also trace any remaining unvisited skeleton loops (no endpoints)
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        if (skeleton[idx] === 1 && !visited[idx]) {
          const curve = [];
          let cx = x, cy = y;
          while (true) {
            const cidx = cy * w + cx;
            if (visited[cidx]) break;
            curve.push({ x: cx, y: cy });
            visited[cidx] = 1;
            const nbs = this._getSkeletonNeighbors(skeleton, w, h, cx, cy);
            let next = null;
            for (const n of nbs) {
              if (!visited[n.y * w + n.x]) { next = n; break; }
            }
            if (!next) break;
            cx = next.x;
            cy = next.y;
          }
          if (curve.length >= 2) {
            curves.push(curve);
          }
        }
      }
    }

    return curves;
  }

  _getSkeletonNeighbors(skeleton, w, h, x, y) {
    const nbs = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && skeleton[ny * w + nx] === 1) {
          nbs.push({ x: nx, y: ny });
        }
      }
    }
    return nbs;
  }

  /**
   * Remove near-duplicate curves by comparing start/end points and midpoints.
   * Two curves are considered duplicates if their endpoints and midpoints are
   * within a distance threshold (as fraction of image diagonal).
   */
  _deduplicateCurves(curves, distThreshold = 8) {
    const unique = [];

    const fingerprint = (curve) => {
      const pts = curve.points;
      const start = pts[0];
      const end = pts[pts.length - 1];
      const mid = pts[Math.floor(pts.length / 2)];
      return { start, end, mid };
    };

    const dist = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);

    const isSimilar = (fp1, fp2) => {
      // Check both forward and reversed matching
      const fwd = dist(fp1.start, fp2.start) + dist(fp1.end, fp2.end) + dist(fp1.mid, fp2.mid);
      const rev = dist(fp1.start, fp2.end) + dist(fp1.end, fp2.start) + dist(fp1.mid, fp2.mid);
      return Math.min(fwd, rev) < distThreshold * 3;
    };

    for (const curve of curves) {
      const fp = fingerprint(curve);
      let isDup = false;
      for (const existing of unique) {
        if (isSimilar(fp, fingerprint(existing))) {
          isDup = true;
          break;
        }
      }
      if (!isDup) unique.push(curve);
    }

    return unique;
  }

  _polylineLength(points) {
    let len = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      len += Math.sqrt(dx * dx + dy * dy);
    }
    return len;
  }

  // ─── Utility: Resample to uniform spacing ─────────────────────

  /**
   * Resample a polyline to N evenly-spaced points.
   * Useful for creating smooth profiles for EXTRUDE.
   */
  static resample(points, count = 32) {
    if (points.length < 2 || count < 2) return points;

    // Compute cumulative arc lengths
    const lengths = [0];
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      lengths.push(lengths[i - 1] + Math.sqrt(dx * dx + dy * dy));
    }
    const totalLength = lengths[lengths.length - 1];
    if (totalLength === 0) return points;

    const result = [];
    for (let i = 0; i < count; i++) {
      const targetLen = (i / (count - 1)) * totalLength;
      // Find segment
      let seg = 0;
      while (seg < lengths.length - 2 && lengths[seg + 1] < targetLen) seg++;
      const segLen = lengths[seg + 1] - lengths[seg];
      const t = segLen > 0 ? (targetLen - lengths[seg]) / segLen : 0;
      result.push({
        x: Math.round((points[seg].x + t * (points[seg + 1].x - points[seg].x)) * 10000) / 10000,
        y: Math.round((points[seg].y + t * (points[seg + 1].y - points[seg].y)) * 10000) / 10000
      });
    }
    return result;
  }

  // ─── Utility: Preview contour on canvas ───────────────────────

  /**
   * Draw extracted contours onto a canvas for debugging/preview.
   */
  static drawContours(canvas, contours, opts = {}) {
    const { lineWidth = 2, colors = ['#ff0000', '#00cc00', '#0066ff', '#ff9900', '#cc00ff'] } = opts;
    const ctx = canvas.getContext('2d');
    contours.forEach((contour, ci) => {
      const pts = contour.points || contour;
      if (pts.length < 2) return;
      ctx.beginPath();
      ctx.strokeStyle = colors[ci % colors.length];
      ctx.lineWidth = lineWidth;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      if (contour.closed !== false) ctx.closePath();
      ctx.stroke();
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════

if (typeof window !== 'undefined') {
  window.ContourTracer = ContourTracer;
}



export default ContourTracer;
