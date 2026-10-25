import type { Point, Road } from './types'
import type { PolygonRegion } from './geometry'
import { boundsOf, corridorPolygon, distance, distanceToSegment, overlaps, polygonOverlapsRegion, projectPoint } from './geometry'
import { MinHeap } from './road-graph'

export interface LayoutCoveragePrioritySite { id: string; point: Point; builtYear: number }
interface Segment { a: Point; b: Point; road: Road; length: number }
const key = (point: Point) => `${Math.round(point.x * 100000)},${Math.round(point.y * 100000)}`
const radius = 900

/** Ranking field only: exact dated public-road distance plus a clear dry last
 * leg. It grants no street/parcel and cannot override any engineering guard. */
export function buildLayoutCoveragePriority(input: { roads: readonly Road[]; sites: readonly LayoutCoveragePrioritySite[]; builtYear: number; excluded: readonly PolygonRegion[] }) {
  if (!input.sites.length) return { sites: [], distanceAt: (_point: Point) => Infinity }
  const roads = input.roads.filter(road => (road.builtYear ?? 1650) <= input.builtYear && !road.controlledAccess && !['expressway', 'ramp', 'farm'].includes(road.role ?? '') && (road.level ?? 0) === 0)
  const segments: Segment[] = roads.flatMap(road => road.points.slice(1).map((b, i) => ({ a: road.points[i]!, b, road, length: distance(road.points[i]!, b) }))).filter(segment => segment.length > 1e-7)
  const sites = input.sites.filter(site => site.builtYear <= input.builtYear && segments.some(segment => distanceToSegment(site.point, segment.a, segment.b) < 1e-7))
  if (!sites.length) return { sites, distanceAt: (_point: Point) => Infinity }
  const adjacency = new Map<string, { to: string; length: number }[]>()
  const connect = (a: Point, b: Point) => {
    const from = key(a), to = key(b), length = distance(a, b)
    if (from === to) return
    const first = adjacency.get(from) ?? []; first.push({ to, length }); adjacency.set(from, first)
    const second = adjacency.get(to) ?? []; second.push({ to: from, length }); adjacency.set(to, second)
  }
  for (const segment of segments) {
    const cuts = [segment.a, ...sites.filter(site => distanceToSegment(site.point, segment.a, segment.b) < 1e-7).map(site => site.point), segment.b].sort((a, b) => distance(segment.a, a) - distance(segment.a, b))
    for (let i = 1; i < cuts.length; i++) connect(cuts[i - 1]!, cuts[i]!)
  }
  const distances = new Map<string, number>(), heap = new MinHeap<{ node: string; distance: number }>()
  for (const site of sites) { const node = key(site.point); distances.set(node, 0); heap.push({ node, distance: 0 }, 0) }
  while (heap.size) {
    const current = heap.pop()!.value
    if (current.distance > distances.get(current.node)! + 1e-7) continue
    for (const next of adjacency.get(current.node) ?? []) {
      const length = current.distance + next.length
      if (length > radius || length >= (distances.get(next.to) ?? Infinity)) continue
      distances.set(next.to, length); heap.push({ node: next.to, distance: length }, length)
    }
  }
  const barriers = input.excluded.map(region => ({ region, bounds: boundsOf(region.polygon) })), bins = new Map<string, Segment[]>()
  const binKeys = (a: Point, b: Point) => {
    const result: string[] = []
    for (let x = Math.floor(Math.min(a.x, b.x) / 250); x <= Math.floor(Math.max(a.x, b.x) / 250); x++) for (let y = Math.floor(Math.min(a.y, b.y) / 250); y <= Math.floor(Math.max(a.y, b.y) / 250); y++) result.push(`${x}:${y}`)
    return result
  }
  for (const segment of segments) if (distances.has(key(segment.a)) || distances.has(key(segment.b)) || sites.some(site => distanceToSegment(site.point, segment.a, segment.b) < 1e-7)) {
    for (const bin of binKeys(segment.a, segment.b)) { const list = bins.get(bin) ?? []; list.push(segment); bins.set(bin, list) }
  }
  return {
    sites,
    distanceAt(point: Point) {
      if (sites.every(site => distance(point, site.point) > radius)) return Infinity
      const nearby = new Set<Segment>()
      for (const bin of binKeys({ x: point.x - radius, y: point.y - radius }, { x: point.x + radius, y: point.y + radius })) for (const segment of bins.get(bin) ?? []) nearby.add(segment)
      let best = Infinity
      for (const segment of nearby) {
        const projected = projectPoint(point, segment.a, segment.b), lastLeg = distance(point, projected)
        const network = Math.min((distances.get(key(segment.a)) ?? Infinity) + distance(segment.a, projected), (distances.get(key(segment.b)) ?? Infinity) + distance(segment.b, projected), ...sites.filter(site => distanceToSegment(site.point, segment.a, segment.b) < 1e-7).map(site => distance(site.point, projected)))
        if (network + lastLeg > radius || network + lastLeg >= best) continue
        const bounds = boundsOf([projected, point]), corridor = corridorPolygon(projected, point, .01)
        if (lastLeg > .01 && barriers.some(barrier => overlaps(bounds, barrier.bounds) && polygonOverlapsRegion(corridor, barrier.region))) continue
        best = network + lastLeg
      }
      return best
    },
  }
}
