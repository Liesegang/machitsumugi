import { describe, expect, it } from 'vitest';
import type { Point } from './types';
import { overlapsRegion } from './test-support/map-geometry';

const rectangle = (x: number, y: number, width: number, height: number): Point[] => [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
];
const moat = { polygon: rectangle(0, 0, 100, 100), holes: [rectangle(30, 30, 40, 40)] };

describe('independent saved-map geometry checks', () => {
  it('keeps the dry bailey and its touching boundary outside the moat', () => {
    expect(overlapsRegion(rectangle(40, 40, 20, 20), moat)).toBe(false);
    expect(overlapsRegion(rectangle(30, 30, 40, 40), moat)).toBe(false);
    expect(overlapsRegion(rectangle(30, 40, 20, 20), moat)).toBe(false);
  });

  it('detects a footprint crossing from the bailey into water', () => {
    expect(overlapsRegion(rectangle(65, 40, 10, 10), moat)).toBe(true);
    expect(overlapsRegion(rectangle(20, 40, 60, 10), moat)).toBe(true);
  });

  it('detects enclosing or coincident solid regions without strict edge crossings', () => {
    expect(overlapsRegion(rectangle(-10, -10, 120, 120), moat)).toBe(true);
    expect(overlapsRegion(rectangle(0, 0, 100, 100), { polygon: rectangle(0, 0, 100, 100) })).toBe(true);
  });

  it('allows land outside the water region and boundary-only contact', () => {
    expect(overlapsRegion(rectangle(110, 40, 10, 10), moat)).toBe(false);
    expect(overlapsRegion(rectangle(100, 40, 10, 10), moat)).toBe(false);
  });
});
