import type { Point, Road } from './types'
import type { Bounds, PolygonRegion } from './geometry'
import { boundsOf, corridorPolygon, distance, overlaps, pointInPolygon, projectPoint, segmentsCross } from './geometry'
import { regionQuery } from './region-query'

interface AccessTerrain {
  waterAt(point: Point): boolean
  elevation(point: Point): number
  slope(point: Point): number
}

function index<T extends { bounds: Bounds }>(items: T[], step = 200) {
  const bins = new Map<string, T[]>(), large: T[] = []
  for (const item of items) {
    const b = item.bounds, x0 = Math.floor(b.minX / step), x1 = Math.floor(b.maxX / step), y0 = Math.floor(b.minY / step), y1 = Math.floor(b.maxY / step)
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 200) { large.push(item); continue }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const key = `${x}:${y}`, group = bins.get(key) ?? []; group.push(item); bins.set(key, group)
    }
  }
  return (bounds: Bounds) => {
    const found = new Set(large.filter(item => overlaps(bounds, item.bounds)))
    for (let y = Math.floor(bounds.minY / step); y <= Math.floor(bounds.maxY / step); y++) for (let x = Math.floor(bounds.minX / step); x <= Math.floor(bounds.maxX / step); x++) {
      for (const item of bins.get(`${x}:${y}`) ?? []) if (overlaps(bounds, item.bounds)) found.add(item)
    }
    return found
  }
}

/** Test each final working field's entrance, not the pre-acquisition centre.
 * Current public roads can serve old holdings. The connecting 2.4m farm access
 * must be dry, traversable and free of acquired property/rail corridors; a road
 * on the far side of a river does not supply an imaginary bridge.
 */
export function agriculturalAccessSurvey(roads: Road[], terrain: AccessTerrain, barriers: PolygonRegion[]) {
  const roadIndex = index(roads.filter(r => !r.controlledAccess && r.role !== 'expressway' && r.role !== 'ramp').flatMap(road => road.points.slice(1).flatMap((b, i) => {
    const a = road.points[i]!
    return distance(a, b) > .01 ? [{ a, b, road, bounds: boundsOf([a, b]) }] : []
  })))
  const barrierIndex = index(barriers.map(region => ({ bounds: boundsOf(region.polygon), contains: regionQuery([region]) })))
  // Exact local edge queries avoid repeatedly scanning a whole river/forest
  // polygon for each possible entrance in a densely subdivided town.
  const edgeIndex = index(barriers.flatMap(region => [region.polygon, ...region.holes ?? []].flatMap(ring => ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length]!
    return { a, b, bounds: boundsOf([a, b]) }
  }))))
  return (region: PolygonRegion): boolean => {
    const bounds = boundsOf(region.polygon), nearby = roadIndex({ minX: bounds.minX - 200, maxX: bounds.maxX + 200, minY: bounds.minY - 200, maxY: bounds.maxY + 200 })
    const routes: { entrance: Point; end: Point; length: number }[] = []
    for (const { a, b, road } of nearby) {
      const pairs: { entrance: Point; foot: Point }[] = region.polygon.map(entrance => ({ entrance, foot: projectPoint(entrance, a, b) }))
      for (const foot of [a, b]) for (let i = 0; i < region.polygon.length; i++) pairs.push({ entrance: projectPoint(foot, region.polygon[i]!, region.polygon[(i + 1) % region.polygon.length]!), foot })
      for (const { entrance, foot } of pairs) {
        const length = distance(entrance, foot), reach = road.role === 'farm' ? 180 : 200
        if (length > reach + road.width / 2) continue
        const edge = Math.min(road.width / 2, length), fraction = length ? edge / length : 0
        routes.push({ entrance, end: { x: foot.x + (entrance.x - foot.x) * fraction, y: foot.y + (entrance.y - foot.y) * fraction }, length: Math.max(0, length - edge) })
      }
    }
    routes.sort((a, b) => a.length - b.length)
    const seen = new Set<string>()
    for (const route of routes) {
      const { entrance, end, length } = route, key = `${Math.round(entrance.x)}:${Math.round(entrance.y)}:${Math.round(end.x)}:${Math.round(end.y)}`
      if (seen.has(key)) continue
      seen.add(key)
      if (length > .01) {
        const corridor = corridorPolygon(entrance, end, 1.2)
        const bounds = boundsOf(corridor)
        if ([...barrierIndex(bounds)].some(barrier => corridor.some(barrier.contains)) || [...edgeIndex(bounds)].some(edge => pointInPolygon(edge.a, corridor) || corridor.some((a, i) => segmentsCross(a, corridor[(i + 1) % corridor.length]!, edge.a, edge.b)))) continue
      }
      const steps = Math.max(1, Math.ceil(length / 4)), nx = length ? -(end.y - entrance.y) / length : 0, ny = length ? (end.x - entrance.x) / length : 0
      let passable = true, previous: Point | undefined
      for (let j = 0; j <= steps && passable; j++) {
        const t = j / steps, center = { x: entrance.x + (end.x - entrance.x) * t, y: entrance.y + (end.y - entrance.y) * t }
        for (const side of [-1.2, 0, 1.2]) {
          const point = { x: center.x + nx * side, y: center.y + ny * side }
          if (terrain.waterAt(point) || terrain.slope(point) > .18) { passable = false; break }
        }
        if (previous && Math.abs(terrain.elevation(center) - terrain.elevation(previous)) > distance(center, previous) * .18) passable = false
        previous = center
      }
      if (passable) return true
    }
    return false
  }
}
