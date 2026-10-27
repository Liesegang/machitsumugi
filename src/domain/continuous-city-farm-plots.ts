import type { Point, Road } from './types'
import type { PolygonRegion } from './geometry'
import type { AgriculturalTerrain } from './land-use'
import { agriculturalPlotSuitable, agriculturalUse } from './land-use'
import { boundsOf, distance, distanceToSegment, overlaps, pointInRegion, regionArea, seededRandom, subtractRegions } from './geometry'

export interface ContinuousFarmDistrictInput {
  /** The exact pieces of ONE already road-served district, including holes. */
  regions: readonly PolygonRegion[]
  road: Road
  origin: Point
  seed: string
  terrain: AgriculturalTerrain & { waterAt?(point: Point): boolean }
}

const sum = (parts: readonly PolygonRegion[]) => parts.reduce((n, part) => n + regionArea(part), 0)
const onBoundary = (p: Point, region: PolygonRegion) => [region.polygon, ...region.holes ?? []].some(ring => ring.some((a, i) => distanceToSegment(p, a, ring[(i + 1) % ring.length]!) < 1e-6))
function sharedEdge(a: PolygonRegion, b: PolygonRegion) {
  if (!overlaps(boundsOf(a.polygon), boundsOf(b.polygon))) return false
  for (const ring of [a.polygon, ...a.holes ?? []]) for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!, q = ring[(i + 1) % ring.length]!, length = distance(p, q)
    if (length < .001) continue
    const ux = (q.x - p.x) / length, uy = (q.y - p.y) / length
    for (const other of [b.polygon, ...b.holes ?? []]) for (let j = 0; j < other.length; j++) {
      const c = other[j]!, d = other[(j + 1) % other.length]!
      if (Math.abs((c.x - p.x) * uy - (c.y - p.y) * ux) > 1e-6 || Math.abs((d.x - p.x) * uy - (d.y - p.y) * ux) > 1e-6) continue
      const ca = (c.x - p.x) * ux + (c.y - p.y) * uy, cb = (d.x - p.x) * ux + (d.y - p.y) * uy
      if (Math.min(length, Math.max(ca, cb)) - Math.max(0, Math.min(ca, cb)) > .05) return true
    }
  }
  return false
}

/** Field ownership follows one actual access/contour survey. The remainder is
 * real grassed bunds and field access, not another painted farm rectangle.
 * Natural banks reject whole units; water/woodland boundaries never trim them
 * into curved slivers. Positive-width seams retain access across storage tiles. */
export function subdivideContinuousFarmDistrict(input: ContinuousFarmDistrictInput) {
  const { road, origin, terrain } = input, untouched = () => ({ plots: [] as (PolygonRegion & { landUse: 'paddy' | 'dry-field' })[], bunds: [...input.regions], diagnostics: { plots: 0, servedParts: 0, areaError: 0, bearing: 0 } })
  if (!input.regions.length || road.controlledAccess || road.role === 'expressway' || road.role === 'ramp' || (road.level ?? 0) !== 0 || road.points.length < 2) return untouched()
  const segments = road.points.slice(1).map((b, i) => ({ a: road.points[i]!, b }))
  if (!segments.some(s => distanceToSegment(origin, s.a, s.b) <= road.width / 2 + .05)) return untouched()
  const served = new Set<number>(), pending: number[] = []
  for (const [i, region] of input.regions.entries()) if ([region.polygon, ...region.holes ?? []].some(ring => ring.some(p => segments.some(s => distanceToSegment(p, s.a, s.b) <= road.width / 2 + .05)))) { served.add(i); pending.push(i) }
  for (let i = 0; i < pending.length; i++) for (let j = 0; j < input.regions.length; j++) if (!served.has(j) && sharedEdge(input.regions[pending[i]!]!, input.regions[j]!)) { served.add(j); pending.push(j) }
  const parts = input.regions.filter((_, i) => served.has(i))
  if (!parts.length) return untouched()
  const segment = [...segments].sort((a, b) => distanceToSegment(origin, a.a, a.b) - distanceToSegment(origin, b.a, b.b))[0]!
  let bearing = Math.atan2(segment.b.y - segment.a.y, segment.b.x - segment.a.x)
  const center = boundsOf(parts.flatMap(p => p.polygon)), probe = { x: (center.minX + center.maxX) / 2, y: (center.minY + center.maxY) / 2 }
  const gx = (terrain.elevation({ x: probe.x + 30, y: probe.y }) - terrain.elevation({ x: probe.x - 30, y: probe.y })) / 60
  const gy = (terrain.elevation({ x: probe.x, y: probe.y + 30 }) - terrain.elevation({ x: probe.x, y: probe.y - 30 })) / 60
  const contour = Math.atan2(gy, gx) + Math.PI / 2
  if (Math.hypot(gx, gy) > .006 && Math.abs(Math.sin(2 * (bearing - contour))) > Math.sin(Math.PI / 8)) bearing = contour
  const c = Math.cos(bearing), s = Math.sin(bearing), local = (p: Point) => ({ x: (p.x - origin.x) * c + (p.y - origin.y) * s, y: -(p.x - origin.x) * s + (p.y - origin.y) * c })
  // New surveyed units use the same0.1mm cadastral lattice as their later
  // differences. Existing district/water vertices are never rewritten.
  const world = (x: number, y: number) => ({ x: Math.round((origin.x + x * c - y * s) * 10000) / 10000, y: Math.round((origin.y + x * s + y * c) * 10000) / 10000 })
  const bounds = boundsOf(parts.flatMap(p => p.polygon.map(local))), random = seededRandom(`${input.seed}:actual-farm:${road.id}:${origin.x.toFixed(3)}:${origin.y.toFixed(3)}`)
  const suitable = (point: Point) => parts.some(region => pointInRegion(point, region) || onBoundary(point, region)) && !terrain.waterAt?.(point) && terrain.slope(point) <= .12 && (terrain.cultivable?.(point) ?? true)
  const divisions = (low: number, high: number, target: number, rng: () => number) => {
    const count = Math.max(1, Math.ceil((high - low) / target)), weights = Array.from({ length: count }, () => .65 + rng() * .7), total = weights.reduce((a, b) => a + b, 0), values = [low]
    for (const weight of weights) values.push(values.at(-1)! + (high - low) * weight / total)
    return values
  }
  type SurveyCell = { x0: number; x1: number; y0: number; y1: number; key: string }
  const rows = divisions(bounds.minY, bounds.maxY, 44 + random() * 12, random), plots: (PolygonRegion & { landUse: 'paddy' | 'dry-field' })[] = [], rejected: SurveyCell[] = []
  for (let row = 1; row < rows.length && plots.length < 2048; row++) {
    const columns = divisions(bounds.minX, bounds.maxX, 58 + random() * 24, seededRandom(`${input.seed}:${road.id}:field-band-${row}`))
    for (let col = 1; col < columns.length && plots.length < 2048; col++) {
      // Two metres of continuous grassed working access separates holdings.
      const x0 = columns[col - 1]! + 1, x1 = columns[col]! - 1, y0 = rows[row - 1]! + 1, y1 = rows[row]! - 1
      if (x1 - x0 < 12 || y1 - y0 < 12 || (x1 - x0) * (y1 - y0) < 200) continue
      const polygon = [world(x0, y0), world(x1, y0), world(x1, y1), world(x0, y1)]
      if (!agriculturalPlotSuitable(polygon, suitable) || sum(subtractRegions({ polygon }, parts)) > .001) { rejected.push({ x0: columns[col - 1]!, x1: columns[col]!, y0: rows[row - 1]!, y1: rows[row]!, key: `${row}:${col}` }); continue }
      plots.push({ polygon, landUse: agriculturalUse(polygon, terrain) })
    }
  }
  const remainingGround = () => {
    const indexed = plots.map(plot => ({ plot, bounds: boundsOf(plot.polygon) }))
    return parts.flatMap(region => { const bounds = boundsOf(region.polygon); return subtractRegions(region, indexed.filter(item => overlaps(bounds, item.bounds)).map(item => item.plot)) })
  }
  // A whole primary holding can fail at an irregular shore or hollow without
  // making its entire50×70m survey cell unusable. Refine only those rejected
  // cells, keeping the original access/contour bearing and coherent bands.
  // No successful title moves and no curved boundary clips a field rectangle.
  let remaining = remainingGround(), attempts = 0
  for (let pass = 0; pass < 3 && rejected.length && plots.length < 2048 && attempts < 2048; pass++) {
    const rng = seededRandom(`${input.seed}:${road.id}:remaining-field-bands-${pass}`), inset = 1.05, depth = pass === 0 ? 22 + rng() * 13 : pass === 1 ? 16 + rng() * 9 : 16 + rng() * 5, pitchY = (depth + inset * 2) / 4, phaseY = rng() * pitchY
    const added: { x0: number; x1: number; y0: number; y1: number }[] = []
    // The quarter-pitch search slides coherent whole holdings into actual free
    // components. It does not reuse the rejected coarse cell's unlucky cuts,
    // nor draw their bounding box or search probes as field boundaries.
    for (const component of remaining.slice().sort((a, b) => regionArea(b) - regionArea(a))) {
      const bounds = boundsOf(component.polygon.map(local))
      if (regionArea(component) < 260) continue
      for (let y = Math.floor((bounds.minY - phaseY) / pitchY) * pitchY + phaseY; y + depth < bounds.maxY + pitchY && plots.length < 2048 && attempts < 2048; y += pitchY) {
        const row = Math.round((y - phaseY) / pitchY), band = seededRandom(`${input.seed}:${road.id}:remaining-field-band-${pass}:${row}`), width = pass === 0 ? 32 + band() * 13 : pass === 1 ? 18 + band() * 12 : 12 + band() * 6, pitchX = (width + inset * 2) / 4, phaseX = band() * pitchX
        for (let x = Math.floor((bounds.minX - phaseX) / pitchX) * pitchX + phaseX; x + width < bounds.maxX + pitchX && plots.length < 2048 && attempts < 2048; x += pitchX) {
          const cell = { x0: x, x1: x + width + inset * 2, y0: y, y1: y + depth + inset * 2 }
          if (added.some(plot => cell.x0 < plot.x1 && cell.x1 > plot.x0 && cell.y0 < plot.y1 && cell.y1 > plot.y0)) continue
          const expanded = { polygon: [world(cell.x0, cell.y0), world(cell.x1, cell.y0), world(cell.x1, cell.y1), world(cell.x0, cell.y1)] }
          if (!expanded.polygon.every(p => pointInRegion(p, component) || onBoundary(p, component))) continue
          attempts++
          if (!agriculturalPlotSuitable(expanded.polygon, suitable) || sum(subtractRegions(expanded, [component])) > .001) continue
          const polygon = [world(cell.x0 + inset, cell.y0 + inset), world(cell.x1 - inset, cell.y0 + inset), world(cell.x1 - inset, cell.y1 - inset), world(cell.x0 + inset, cell.y1 - inset)]
          if (regionArea({ polygon }) < 200) continue
          plots.push({ polygon, landUse: agriculturalUse(polygon, terrain) }); added.push({ x0: cell.x0 + inset, x1: cell.x1 - inset, y0: cell.y0 + inset, y1: cell.y1 - inset })
        }
      }
    }
    remaining = remainingGround()
  }
  const indexed = plots.map(plot => ({ plot, bounds: boundsOf(plot.polygon) }))
  const bunds = input.regions.flatMap(region => { const bounds = boundsOf(region.polygon); return subtractRegions(region, indexed.filter(item => overlaps(bounds, item.bounds)).map(item => item.plot)) })
  return { plots, bunds, diagnostics: { plots: plots.length, servedParts: parts.length, areaError: sum(input.regions) - sum(plots) - sum(bunds), bearing } }
}
