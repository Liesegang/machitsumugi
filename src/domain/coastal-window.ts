import type { Point } from './types'

interface CoastalWindowInput {
  width: number; height: number; extent: number; margin: number; mirrored: boolean
  candidates: { index: number; point: Point; score: number }[]
  seaAt(p: Point): boolean
  usableAt(p: Point): boolean
}
export interface CoastalWindow { index: number; worldAnchor: Point; localAnchor: Point; angle: number; seaFraction: number; usableFraction: number }
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

/** Choose a camera window on an existing shoreline, never sculpt a new coast.
 * The previous coast-first/then-clamp sequence could move the selected mouth
 * kilometres inland. Survey the complete supported frame before selecting it. */
export function coastalWindow(input: CoastalWindowInput): CoastalWindow | null {
  const { width, height, margin, extent } = input, mirror = input.mirrored ? -1 : 1
  const shortlist: CoastalWindowInput['candidates'] = []
  for (const site of [...input.candidates].sort((a, b) => a.score - b.score)) {
    if (shortlist.every(other => Math.hypot(other.point.x - site.point.x, other.point.y - site.point.y) >= 500)) shortlist.push(site)
    if (shortlist.length >= 60) break
  }
  let best: CoastalWindow | null = null, bestCost = Infinity
  for (const site of shortlist) {
    let seaX = 0, seaY = 0
    for (const radius of [300, 700]) for (let j = 0; j < 16; j++) {
      const angle = j * Math.PI / 8, p = { x: site.point.x + Math.cos(angle) * radius, y: site.point.y + Math.sin(angle) * radius }
      if (input.seaAt(p)) { seaX += Math.cos(angle); seaY += Math.sin(angle) }
    }
    const facing = Math.hypot(seaX, seaY) > .1 ? Math.atan2(seaY, seaX) - Math.PI / 2 : 0
    // At a regional corner the locally coast-facing frame can be pushed far
    // inland by the support margin. Survey other bearings before accepting an
    // inland window; the actual coastline and terrain remain unchanged.
    const bearings = [facing, facing - .18, facing + .18, ...Array.from({ length: 16 }, (_, i) => i * Math.PI / 8)]
    for (const angle of bearings) for (const fraction of [.56, .70, .82]) {
      const localAnchor = { x: width * .5, y: height * fraction }, c = Math.cos(angle), s = Math.sin(angle)
      const offset = (p: Point) => ({ x: c * mirror * (p.x - localAnchor.x) - s * (p.y - localAnchor.y), y: s * mirror * (p.x - localAnchor.x) + c * (p.y - localAnchor.y) })
      const corners = [{ x: -margin, y: -margin }, { x: width + margin, y: -margin }, { x: -margin, y: height + margin }, { x: width + margin, y: height + margin }].map(offset)
      const minX = 100 - Math.min(...corners.map(p => p.x)), maxX = extent - 100 - Math.max(...corners.map(p => p.x)), minY = 100 - Math.min(...corners.map(p => p.y)), maxY = extent - 100 - Math.max(...corners.map(p => p.y))
      if (minX > maxX || minY > maxY) continue
      const worldAnchor = { x: clamp(site.point.x, minX, maxX), y: clamp(site.point.y, minY, maxY) }
      let sea = 0, usable = 0
      for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) {
        const p = offset({ x: width * (x + .5) / 16, y: height * (y + .5) / 12 }), q = { x: worldAnchor.x + p.x, y: worldAnchor.y + p.y }
        if (input.seaAt(q)) sea++
        else if (input.usableAt(q)) usable++
      }
      const seaFraction = sea / 192, usableFraction = usable / 192
      // Balanced framing is a map-selection preference, not a target supplied
      // to the erosion or sea-level calculation. Keep useful land and real sea.
      const cost = site.score * .1 + Math.abs(seaFraction - .3) * 3 + Math.max(0, .12 - seaFraction) * 35 + Math.max(0, seaFraction - .65) * 20 - usableFraction + Math.hypot(worldAnchor.x - site.point.x, worldAnchor.y - site.point.y) / 800
      if (cost < bestCost) { bestCost = cost; best = { index: site.index, worldAnchor, localAnchor, angle, seaFraction, usableFraction } }
    }
  }
  return best
}
