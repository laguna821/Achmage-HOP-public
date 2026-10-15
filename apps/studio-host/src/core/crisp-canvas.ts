/**
 * Keeps rendered page canvases on the device pixel grid.
 *
 * rhwp sizes a page canvas by the logical page box (page width × zoom) while its backing store is
 * rounded to whole device pixels. At 150% Windows scaling the bitmap is then ~0.5 px larger than its
 * box, so WebView2 resamples the finished page once more. One-pixel strokes spread into their
 * neighbours (measured at 90% zoom: +22% inked pixels, grey ratio 0.648 → 0.813) — the "slightly
 * blurred when zoomed out" look that Hancom Office's on-screen output does not show.
 *
 * Measured in WebView2: a canvas box of exactly backing ÷ DPR CSS pixels is painted 1:1 at any
 * fractional layout offset (paint snaps it to whole device pixels), while any fractional
 * translation in `transform` resamples it again. So the box takes that size (rhwp writes but never
 * reads it; the difference is < 1 device px and the content keeps its logical scale), the
 * fractional part of rhwp's own `translateX(-50%)` centring is cancelled with the independent
 * `translate` property, and the canvas is sampled nearest. Canvases that are really scaled (zoom
 * preview animation, clamped surfaces) keep the browser's smooth filtering.
 */

/** Largest box/backing mismatch still treated as "the same pixels" (rounding, not scaling). */
export const PIXEL_GRID_TOLERANCE = 0.01;

export interface Matrix2D { a: number; b: number; c: number; d: number; e: number; f: number }

export interface CanvasLike {
  width: number;
  height: number;
  style: { width: string; height: string; translate: string; imageRendering: string };
  /** Layout box size in CSS px, before transforms. */
  layoutSize(): { width: number; height: number };
  /** Computed `transform` as a 2D matrix in CSS px (identity for none), or null for 3D. */
  transform(): Matrix2D | null;
}

/** True when `box` shows `backing` at (nearly) one backing pixel per device pixel. */
export function nearlyOneToOne(
  box: { width: number; height: number },
  backing: { width: number; height: number },
  dpr: number,
): boolean {
  if (!(box.width > 0 && box.height > 0 && backing.width > 0 && backing.height > 0 && dpr > 0)) return false;
  return Math.abs(backing.width / (box.width * dpr) - 1) <= PIXEL_GRID_TOLERANCE
    && Math.abs(backing.height / (box.height * dpr) - 1) <= PIXEL_GRID_TOLERANCE;
}

/** CSS offset that moves a CSS coordinate onto the nearest whole device pixel. */
export function deviceGridOffset(cssCoordinate: number, dpr: number): number {
  const device = cssCoordinate * dpr;
  return (Math.round(device) - device) / dpr;
}

const EPSILON = 1e-6;
const pureTranslation = (m: Matrix2D | null): m is Matrix2D =>
  !!m && Math.abs(m.a - 1) < EPSILON && Math.abs(m.d - 1) < EPSILON && Math.abs(m.b) < EPSILON && Math.abs(m.c) < EPSILON;

/** Snaps the given canvases in batched read/write passes. Returns how many were snapped. */
export function snapCanvasesToDeviceGrid(canvases: readonly CanvasLike[], dpr: number): number {
  for (const canvas of canvases) {
    canvas.style.translate = '';
    canvas.style.imageRendering = '';
  }
  const surfaces = canvases.filter(canvas => nearlyOneToOne(canvas.layoutSize(), canvas, dpr));
  for (const canvas of surfaces) {
    canvas.style.width = `${canvas.width / dpr}px`;
    canvas.style.height = `${canvas.height / dpr}px`;
  }
  const transforms = surfaces.map(canvas => canvas.transform());
  let snapped = 0;
  surfaces.forEach((canvas, index) => {
    const m = transforms[index];
    if (!pureTranslation(m)) return; // zoom preview scale: leave it smooth
    const dx = deviceGridOffset(m.e, dpr), dy = deviceGridOffset(m.f, dpr);
    if (Math.abs(dx) > EPSILON || Math.abs(dy) > EPSILON) canvas.style.translate = `${dx}px ${dy}px`;
    canvas.style.imageRendering = 'pixelated';
    snapped += 1;
  });
  return snapped;
}

/** Parses a computed `transform` value. */
export function parseComputedTransform(value: string): Matrix2D | null {
  if (!value || value === 'none') return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const match = /^matrix\(([^)]+)\)$/.exec(value.trim());
  if (!match) return null;
  const [a, b, c, d, e, f] = match[1].split(',').map(Number);
  return [a, b, c, d, e, f].every(Number.isFinite) ? { a, b, c, d, e, f } : null;
}

function domCanvas(canvas: HTMLCanvasElement, view: Window): CanvasLike {
  return {
    get width() { return canvas.width; },
    get height() { return canvas.height; },
    style: canvas.style,
    layoutSize() {
      const style = view.getComputedStyle(canvas);
      return { width: Number.parseFloat(style.width), height: Number.parseFloat(style.height) };
    },
    transform: () => parseComputedTransform(view.getComputedStyle(canvas).transform),
  };
}

/** Re-snaps every canvas under `root` whenever rhwp re-renders, moves or replaces one. Returns a disposer. */
export function installCrispCanvases(root: HTMLElement): () => void {
  const view = root.ownerDocument.defaultView;
  if (!view) return () => {};
  const snap = () => {
    const canvases = [...root.querySelectorAll('canvas')].map(canvas => domCanvas(canvas, view));
    if (canvases.length > 0) snapCanvasesToDeviceGrid(canvases, view.devicePixelRatio || 1);
    observer.takeRecords();
  };
  const touchesCanvas = (nodes: NodeList) => [...nodes].some(node => node instanceof view.HTMLCanvasElement);
  const observer = new MutationObserver(records => {
    if (records.some(record => record.type === 'childList'
      ? touchesCanvas(record.addedNodes) || touchesCanvas(record.removedNodes)
      : record.target instanceof view.HTMLCanvasElement)) snap();
  });
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'width', 'height'] });
  snap();
  return () => observer.disconnect();
}
