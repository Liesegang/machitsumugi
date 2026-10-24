import type { Point, Railway, TerrainSurface } from './types'
import { corridorPolygon, distance, distanceToSegment, intersectRegions, pointInRegion, projectPoint, regionArea } from './geometry'

const surveyedBridges = new WeakMap<Railway, [number, number][]>()
function bridgeRanges(railway: Railway) {
  const cached = surveyedBridges.get(railway)
  if (cached) return cached
  const along = [0]
  for (let i = 1; i < railway.points.length; i++) along.push(along[i - 1]! + distance(railway.points[i - 1]!, railway.points[i]!))
  const location = (p: Point) => {
    let best = { distance: Infinity, along: 0 }
    for (let i = 1; i < railway.points.length; i++) { const a = railway.points[i - 1]!, b = railway.points[i]!, q = projectPoint(p, a, b), d = distance(p, q); if (d < best.distance) best = { distance: d, along: along[i - 1]! + distance(a, q) } }
    return best.along
  }
  const result = (railway.structures ?? []).filter(s => s.kind === 'bridge').map(s => { const a = location(s.from), b = location(s.to); return [Math.min(a, b), Math.max(a, b)] as [number, number] })
  surveyedBridges.set(railway, result)
  return result
}
function ground(surface: TerrainSurface, p: Point): number | undefined {
  const x = p.x / surface.cellSize, y = p.y / surface.cellSize
  if (x < 0 || y < 0 || x > surface.columns - 1 || y > surface.rows - 1) return undefined
  const i = Math.min(surface.columns - 2, Math.floor(x)), j = Math.min(surface.rows - 2, Math.floor(y)), u = x - i, v = y - j
  const z = (a: number, b: number) => surface.elevations[b * surface.columns + a]!
  return (z(i, j) * (1 - u) + z(i + 1, j) * u) * (1 - v) + (z(i, j + 1) * (1 - u) + z(i + 1, j + 1) * u) * v
}

/** Land contact and vertical clearance are different facts. Only an explicit
 * bridge with a surveyed deck/ground clearance proves that paving can survive
 * beneath it. Missing bridge profile data never proves a severance acquisition. */
export function railwayPavingContact(railway: Railway, segment: number, paving: Point[], surface?: TerrainSurface): 'none' | 'ground' | 'separated' | 'uncertain' {
  const a = railway.points[segment]!, b = railway.points[segment + 1]!, corridor = corridorPolygon(a, b, 7.5)
  const intersection = intersectRegions({ polygon: paving }, { polygon: corridor })
  if (intersection.reduce((n, r) => n + regionArea(r), 0) <= .01) return 'none'
  const bridge = bridgeRanges(railway)
  if (!bridge.length) return 'ground'
  let along = 0
  for (let i = 1; i <= segment; i++) along += distance(railway.points[i - 1]!, railway.points[i]!)
  const length = distance(a, b), middle = along + length / 2
  if (!bridge.some(([lo, hi]) => middle >= lo - 1e-6 && middle <= hi + 1e-6)) return 'ground'
  if (!surface || !railway.elevations || !Number.isFinite(railway.elevations[segment]) || !Number.isFinite(railway.elevations[segment + 1])) return 'uncertain'
  const sample = (p: Point) => {
    const q = projectPoint(p, a, b), t = distance(a, q) / (length || 1), z = ground(surface, p)
    return z !== undefined && railway.elevations![segment]! * (1 - t) + railway.elevations![segment + 1]! * t - z >= 4.5
  }
  const samples = intersection.flatMap(r => [...r.polygon, ...r.polygon.map((p, i) => ({ x: (p.x + r.polygon[(i + 1) % r.polygon.length]!.x) / 2, y: (p.y + r.polygon[(i + 1) % r.polygon.length]!.y) / 2 }))])
  return samples.every(sample) ? 'separated' : 'uncertain'
}

/** A small edge overlap is not a severance. Require a witness at which the
 * centre and BOTH original paved shoulders are taken by the ground railway. */
export function pavingFullyTaken(a: Point, b: Point, width: number, railway: Railway, surface?: TerrainSurface) {
  const paving = corridorPolygon(a, b, width / 2), groundSections = railway.points.slice(1).flatMap((q, i) => {
    const p = railway.points[i]!
    if (distanceToSegment(a, p, q) > distance(a, b) + 20 && distanceToSegment(b, p, q) > distance(a, b) + 20) return []
    return railwayPavingContact(railway, i, paving, surface) === 'ground' ? [{ polygon: corridorPolygon(p, q, 7.5) }] : []
  })
  if (!groundSections.length) return false
  const length = distance(a, b), dx = (b.x - a.x) / (length || 1), dy = (b.y - a.y) / (length || 1), count = Math.max(1, Math.ceil(length))
  for (let i = 0; i <= count; i++) {
    const p = { x: a.x + (b.x - a.x) * i / count, y: a.y + (b.y - a.y) * i / count }
    if ([-1, 0, 1].every(side => groundSections.some(region => pointInRegion({ x: p.x - dy * width / 2 * side, y: p.y + dx * width / 2 * side }, region)))) return true
  }
  return false
}
