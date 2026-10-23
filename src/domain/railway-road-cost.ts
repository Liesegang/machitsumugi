import type { Point, Road } from './types'

export interface RailRoadCrossing { point: Point; roadId: string; angle: number; major: boolean; cost: number }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const clamp = (v: number) => Math.max(0, Math.min(1, v))

/** Railways acquire their own corridor rather than repeatedly switching sides
 * of an inherited road. Costs are relative construction metres, not yen.
 * Existing roads remain in place; no future streets influence the 1900 route. */
export function railwayRoadCost(roads: readonly Road[]) {
  type Edge = { a: Point; b: Point; road: Road; base: number; major: boolean }
  const buckets = new Map<string, Edge[]>(), bucketSize = 180
  for (const road of roads) if ((road.builtYear ?? 1650) < 1900) for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1]!, b = road.points[i]!, major = road.kind === 'arterial' || road.role === 'highway' || road.role === 'collector'
    const edge = { a, b, road, major, base: major ? 700 : road.role === 'farm' ? 45 : 160 }
    for (let x = Math.floor(Math.min(a.x, b.x) / bucketSize); x <= Math.floor(Math.max(a.x, b.x) / bucketSize); x++) for (let y = Math.floor(Math.min(a.y, b.y) / bucketSize); y <= Math.floor(Math.max(a.y, b.y) / bucketSize); y++) {
      const key = `${x}:${y}`, values = buckets.get(key) ?? []; values.push(edge); buckets.set(key, values)
    }
  }
  if (!buckets.size) return { crossings: (_a: Point, _b: Point): RailRoadCrossing[] => [], edgeCost: (_a: Point, _b: Point) => 0, pointCost: (_p: Point) => 0 }
  const nearby = (a: Point, b: Point, pad = 0) => {
    const found = new Set<Edge>()
    for (let x = Math.floor((Math.min(a.x, b.x) - pad) / bucketSize); x <= Math.floor((Math.max(a.x, b.x) + pad) / bucketSize); x++) for (let y = Math.floor((Math.min(a.y, b.y) - pad) / bucketSize); y <= Math.floor((Math.max(a.y, b.y) + pad) / bucketSize); y++) for (const edge of buckets.get(`${x}:${y}`) ?? []) found.add(edge)
    return found
  }
  const crossings = (a: Point, b: Point): RailRoadCrossing[] => {
    const dx = b.x - a.x, dy = b.y - a.y, length = distance(a, b), found: RailRoadCrossing[] = []
    for (const edge of nearby(a, b)) {
      const c = edge.a, d = edge.b, ex = d.x - c.x, ey = d.y - c.y, denominator = dx * ey - dy * ex
      if (Math.abs(denominator) < 1e-10) continue
      const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / denominator, u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / denominator
      if (t <= 0 || t > 1 || u < 0 || u >= 1) continue
      const point = { x: a.x + dx * t, y: a.y + dy * t }, sine = Math.abs(denominator) / (length * distance(c, d) || 1), angle = Math.asin(clamp(sine))
      const cost = edge.base * (1 + Math.max(0, .5 - sine) * 5), previous = found.find(p => distance(p.point, point) < 1e-6)
      if (previous) { if (previous.cost < cost) Object.assign(previous, { roadId: edge.road.id, angle, major: edge.major, cost }) }
      else found.push({ point, roadId: edge.road.id, angle, major: edge.major, cost })
    }
    return found
  }
  return {
    crossings,
    edgeCost: (a: Point, b: Point) => crossings(a, b).reduce((sum, crossing) => sum + crossing.cost, 0),
    pointCost: (p: Point) => {
      let cost = 0
      for (const { a, b, road, major } of nearby(p, p, 60)) {
        const dx = b.x - a.x, dy = b.y - a.y, t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)), d = Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t), clearance = road.width / 2 + 10
        cost = Math.max(cost, d < clearance ? (1 - d / clearance) * 5 : major && d < 60 ? .25 * (1 - d / 60) ** 2 : 0)
      }
      return cost
    },
  }
}
