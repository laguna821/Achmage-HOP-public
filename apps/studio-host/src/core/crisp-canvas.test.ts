import { describe, expect, it } from 'vitest';
import { deviceGridOffset, nearlyOneToOne, parseComputedTransform, snapCanvasesToDeviceGrid, type CanvasLike, type Matrix2D } from './crisp-canvas';

/** A page canvas whose computed transform follows rhwp's `translateX(-50%)` centring or a preview scale. */
function fakeCanvas(logical: { width: number; height: number }, backing: { width: number; height: number }, mode: 'left' | 'centred' | 'preview') {
  const style = { width: `${logical.width}px`, height: `${logical.height}px`, translate: '', imageRendering: '' };
  const size = () => ({ width: Number.parseFloat(style.width), height: Number.parseFloat(style.height) });
  const canvas: CanvasLike = {
    ...backing, style,
    layoutSize: size,
    transform(): Matrix2D {
      if (mode === 'preview') return { a: 0.9, b: 0, c: 0, d: 0.9, e: -size().width / 2, f: 0 };
      return { a: 1, b: 0, c: 0, d: 1, e: mode === 'centred' ? -size().width / 2 : 0, f: 0 };
    },
  };
  return canvas;
}

describe('device pixel grid snapping', () => {
  it('treats rounding of the backing store as 1:1 but not real scaling', () => {
    expect(nearlyOneToOne({ width: 714.3229, height: 1010.25 }, { width: 1072, height: 1516 }, 1.5)).toBe(true);
    expect(nearlyOneToOne({ width: 600, height: 848 }, { width: 1072, height: 1516 }, 1.5)).toBe(false);
    expect(nearlyOneToOne({ width: 0, height: 0 }, { width: 1072, height: 1516 }, 1.5)).toBe(false);
    expect(Math.abs(deviceGridOffset(-397, 1.5))).toBeCloseTo(1 / 3, 6);
    expect(deviceGridOffset(-357.333333, 1.5)).toBeCloseTo(0, 5);
    expect(parseComputedTransform('none')).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(parseComputedTransform('matrix(1, 0, 0, 1, -397, 0)')).toMatchObject({ e: -397 });
    expect(parseComputedTransform('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)')).toBeNull();
  });

  it('gives the 90% page at 150% scaling a box of exactly its backing pixels, sampled nearest', () => {
    const page = fakeCanvas({ width: 714.3229, height: 1010.25 }, { width: 1072, height: 1516 }, 'left');
    expect(snapCanvasesToDeviceGrid([page], 1.5)).toBe(1);
    expect(Number.parseFloat(page.style.width) * 1.5).toBeCloseTo(1072, 9);
    expect(Number.parseFloat(page.style.height) * 1.5).toBeCloseTo(1516, 9);
    expect(page.style).toMatchObject({ translate: '', imageRendering: 'pixelated' });
    snapCanvasesToDeviceGrid([page], 1.5);
    expect(page.style.width).toBe(`${1072 / 1.5}px`);
  });

  it('cancels the half device pixel that centring leaves on an odd-width page', () => {
    const page = fakeCanvas({ width: 793.7, height: 1122.5 }, { width: 1191, height: 1684 }, 'centred');
    expect(snapCanvasesToDeviceGrid([page], 1.5)).toBe(1);
    const shift = Number.parseFloat(page.style.translate);
    const residual = ((page.transform()!.e + shift) * 1.5) % 1;
    expect(Math.min(Math.abs(residual), 1 - Math.abs(residual))).toBeLessThan(1e-6);
    const even = fakeCanvas({ width: 714.3229, height: 1010.25 }, { width: 1072, height: 1516 }, 'centred');
    snapCanvasesToDeviceGrid([even], 1.5);
    expect(even.style.translate).toBe('');
  });

  it('leaves a zoom-previewed or clamped surface smoothly filtered', () => {
    const preview = fakeCanvas({ width: 714.3229, height: 1010.25 }, { width: 1072, height: 1516 }, 'preview');
    Object.assign(preview.style, { translate: '0.1px 0px', imageRendering: 'pixelated' });
    expect(snapCanvasesToDeviceGrid([preview], 1.5)).toBe(0);
    expect(preview.style).toMatchObject({ translate: '', imageRendering: '' });
    const clamped = fakeCanvas({ width: 3175, height: 4490 }, { width: 4096, height: 5793 }, 'left');
    expect(snapCanvasesToDeviceGrid([clamped], 1.5)).toBe(0);
    expect(clamped.style.width).toBe('3175px');
  });
});
