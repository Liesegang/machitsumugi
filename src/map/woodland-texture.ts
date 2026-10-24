import type { Point } from '../domain/types'

export const WOODLAND_TEXTURE_MIN_SCALE = .8
function noise(x: number, y: number) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
  return n - Math.floor(n)
}
/** World-anchored crowns shared by canvas/PNG and SVG. Contour clipping, rather
 * than a crown's centre test, preserves shorelines and holes in both renderers. */
export function* woodlandCrowns(regions: { polygon: Point[] }[], sparse: boolean) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const region of regions) for (const p of region.polygon) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
  if (!Number.isFinite(minX)) return
  const spacing = sparse ? 85 : 45
  for (let x = Math.floor(minX / spacing) * spacing; x < maxX; x += spacing) for (let y = Math.floor(minY / spacing) * spacing; y < maxY; y += spacing) {
    const value = noise(x, y)
    yield { x: x + noise(x + 5, y) * spacing, y: y + noise(x, y + 7) * spacing, radius: sparse ? 4 + value * 5 : 6 + value * 7, opacity: (sparse ? .04 : .05) + value * .035, dark: value <= .5 }
  }
}
