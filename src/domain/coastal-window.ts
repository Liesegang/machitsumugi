import type { Point } from './types'

interface CoastalWindowInput {
  width: number; height: number; extent: number; margin: number; mirrored: boolean
  preferredBearing?: number
  landform?: 'peninsula' | 'bay' | 'ria'
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
    const seaBearing = Math.hypot(seaX, seaY) > .1 ? Math.atan2(seaY, seaX) : Math.PI / 2
    const facing = seaBearing - Math.PI / 2
    // At a regional corner the locally coast-facing frame can be pushed far
    // inland by the support margin. Survey other bearings before accepting an
    // inland window; the actual coastline and terrain remain unchanged.
    const bearings = [facing, facing - .18, facing + .18, ...Array.from({ length: 16 }, (_, i) => i * Math.PI / 8)]
    for (const angle of bearings) for (const fraction of [.56, .70, .82]) {
      const c = Math.cos(angle), s = Math.sin(angle)
      // Place the coast toward its actual seaward side of this bearing. A
      // fixed x=.5/y>.5 anchor forced the sea to the bottom of every map.
      const normal = seaBearing - angle, offsetFraction = fraction - .5
      const localAnchor = { x: width * (.5 + mirror * Math.cos(normal) * offsetFraction), y: height * (.5 + Math.sin(normal) * offsetFraction) }
      const offset = (p: Point) => ({ x: c * mirror * (p.x - localAnchor.x) - s * (p.y - localAnchor.y), y: s * mirror * (p.x - localAnchor.x) + c * (p.y - localAnchor.y) })
      const corners = [{ x: -margin, y: -margin }, { x: width + margin, y: -margin }, { x: -margin, y: height + margin }, { x: width + margin, y: height + margin }].map(offset)
      const minX = 100 - Math.min(...corners.map(p => p.x)), maxX = extent - 100 - Math.max(...corners.map(p => p.x)), minY = 100 - Math.min(...corners.map(p => p.y)), maxY = extent - 100 - Math.max(...corners.map(p => p.y))
      if (minX > maxX || minY > maxY) continue
      const worldAnchor = { x: clamp(site.point.x, minX, maxX), y: clamp(site.point.y, minY, maxY) }
      let sea = 0, usable = 0, wrappingRows = 0, wrappingColumns = 0
      const columnPrevious = new Uint8Array(16), columnTransitions = new Uint8Array(16)
      let rowTransitions = 0, rowPrevious = false
      for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) {
        const p = offset({ x: width * (x + .5) / 16, y: height * (y + .5) / 12 }), q = { x: worldAnchor.x + p.x, y: worldAnchor.y + p.y }
        const wet = input.seaAt(q)
        if (wet) sea++
        else if (input.usableAt(q)) usable++
        if (input.landform) {
          if (!x) rowTransitions = 0
          else if (wet !== rowPrevious) rowTransitions++
          if (y && Number(wet) !== columnPrevious[x]) columnTransitions[x]++
          columnPrevious[x] = Number(wet); rowPrevious = wet
          if (x === 15 && rowTransitions >= 2) wrappingRows++
          if (y === 11 && columnTransitions[x]! >= 2) wrappingColumns++
        }
      }
      const seaFraction = sea / 192, usableFraction = usable / 192
      // Balanced framing is a map-selection preference, not a target supplied
      // to the erosion or sea-level calculation. Keep useful land and real sea.
      const targetSea = input.landform === 'peninsula' ? .45 : input.landform === 'ria' ? .4 : input.landform === 'bay' ? .36 : .3
      const wrapping = input.landform ? Math.max(wrappingRows / 12, wrappingColumns / 16) * (input.landform === 'peninsula' ? .45 : .75) : 0
      const bearingCost = input.preferredBearing === undefined ? 0 : (1 - Math.cos(angle - input.preferredBearing)) * .08
      const cost = site.score * .1 + Math.abs(seaFraction - targetSea) * 3 + Math.max(0, .12 - seaFraction) * 35 + Math.max(0, seaFraction - .65) * 20 - usableFraction - wrapping + bearingCost + Math.hypot(worldAnchor.x - site.point.x, worldAnchor.y - site.point.y) / 800
      if (cost < bestCost) { bestCost = cost; best = { index: site.index, worldAnchor, localAnchor, angle, seaFraction, usableFraction } }
    }
  }
  return best
}
