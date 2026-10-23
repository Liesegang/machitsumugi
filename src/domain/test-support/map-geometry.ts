import type { Point } from '../types';

// These geometric predicates are deliberately independent of the generator's rejection code.
export const bounds = (p: Point[]) => ({ x0: Math.min(...p.map(q => q.x)), x1: Math.max(...p.map(q => q.x)), y0: Math.min(...p.map(q => q.y)), y1: Math.max(...p.map(q => q.y)) });
export function contains(poly: Point[], p: Point) {
  let winding = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
    if (a.y <= p.y && b.y > p.y && side > 0) winding++;
    if (a.y > p.y && b.y <= p.y && side < 0) winding--;
  }
  return winding !== 0;
}
export function segmentCross(a: Point, b: Point, c: Point, d: Point) {
  const orientation = (a: Point, b: Point, c: Point) => (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  return orientation(a, b, c) * orientation(a, b, d) < 0 && orientation(c, d, a) * orientation(c, d, b) < 0;
}
export function pointLineDistance(p: Point, a: Point, b: Point) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(p.x - a.x - vx * t, p.y - a.y - vy * t);
}

// Positive-area overlap with a region, retaining dry holes such as a castle bailey.
// Keep this independent of production polygon clipping and siting predicates.
export function overlapsRegion(polygon: Point[], region: { polygon: Point[]; holes?: Point[][] }) {
  const onBoundary = (ring: Point[], point: Point) => ring.some((a, i) => pointLineDistance(point, a, ring[(i + 1) % ring.length]!) < 1e-8);
  const strictlyWithin = (ring: Point[], point: Point) => contains(ring, point) && !onBoundary(ring, point);
  const inside = (point: Point) => strictlyWithin(region.polygon, point) && !(region.holes ?? []).some(hole => contains(hole, point) || onBoundary(hole, point));
  if (polygon.some(inside) || region.polygon.some(point => strictlyWithin(polygon, point))) return true;
  const rings = [region.polygon, ...(region.holes ?? [])];
  if (polygon.some((a, i) => rings.some(ring => ring.some((b, j) => segmentCross(a, polygon[(i + 1) % polygon.length]!, b, ring[(j + 1) % ring.length]!))))) return true;
  // Coincident edges have no strict crossing. Probe their building-interior side
  // so equal polygons overlap but touching a dry hole's boundary does not.
  return polygon.some((a, i) => {
    const b = polygon[(i + 1) % polygon.length]!, length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!length) return false;
    const epsilon = Math.max(1e-6, length * 1e-8);
    return [-1, 1].some(sign => {
      const point = { x: (a.x + b.x) / 2 - sign * (b.y - a.y) / length * epsilon, y: (a.y + b.y) / 2 + sign * (b.x - a.x) / length * epsilon };
      return strictlyWithin(polygon, point) && inside(point);
    });
  });
}
