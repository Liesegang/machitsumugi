import type { Point } from './types'
import { extractStreetBlocks, projectOnRoadSegment } from './road-graph.ts'
import type { PlanarRoadGraph } from './road-graph'
export interface OccupiedSite { point: Point; households: number; area?: number; frontageDepth?: number }
export interface NeighborhoodSurvey { a: Point; b: Point; chord: number; trips: number; key: string }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** Spatial query shared by trip appraisal and the later acquisition survey. */
export function occupiedSitesNear(occupied: OccupiedSite[]) {
  const buckets = new Map<string, OccupiedSite[]>()
  for (const cell of occupied) {
    const key = `${Math.floor(cell.point.x / 150)}:${Math.floor(cell.point.y / 150)}`, bucket = buckets.get(key) ?? []
    bucket.push(cell); buckets.set(key, bucket)
  }
  return (point: Point) => {
    const found: OccupiedSite[] = [], x = Math.floor(point.x / 150), y = Math.floor(point.y / 150)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const cell of buckets.get(`${x + dx}:${y + dy}`) ?? []) if (distance(point, cell.point) < 150) found.push(cell)
    return found
  }
}

/** Candidate geometry follows occupied edges of actual bounded street faces.
 * Larger inherited blocks can justify longer local links; no unbounded all-pair
 * search or street spacing grid is introduced. Physical appraisal happens later. */
export function surveyNeighborhoodConnections(input: { graph: PlanarRoadGraph; cells: OccupiedSite[]; maximumSpan?: number }): NeighborhoodSurvey[] {
  const { graph } = input
  const occupied = input.cells.filter(cell => cell.households > 0)
  if (!occupied.length) return []
  const nearby = occupiedSitesNear(occupied)
  const surveys = new Map<string, NeighborhoodSurvey>()
  const faces = extractStreetBlocks(graph.roads).map(polygon => ({ polygon, area: Math.abs(polygon.reduce((sum, p, i) => { const q = polygon[(i + 1) % polygon.length]!; return sum + p.x * q.y - q.x * p.y }, 0)) / 2 })).filter(face => face.area > 90_000)
  const spanAt = (point: Point) => {
    let span = 300
    for (const face of faces) if (face.polygon.some((end, i) => distance(point, projectOnRoadSegment(point, face.polygon[(i + face.polygon.length - 1) % face.polygon.length]!, end).point) < .15)) span = Math.max(span, Math.min(input.maximumSpan ?? 900, Math.sqrt(face.area)))
    return span
  }
  for (const cell of occupied) {
    const first = graph.nearest(cell.point, (cell.frontageDepth ?? 40) + 5)
    if (!first) continue
    const span = spanAt(first.point), reach = span > 300 ? span + (cell.frontageDepth ?? 40) : 260
    for (const last of graph.projections(cell.point, reach, span > 300 ? 24 : 5)) {
      const chord = distance(first.point, last.point)
      if (chord < 70 || chord > span) continue
      // Disjoint residential catchments avoid counting a household's own trips
      // to itself where the two 150m walksheds overlap.
      const a = first.point, b = last.point
      const householdsA = nearby(a).filter(site => distance(site.point, a) < distance(site.point, b)).reduce((sum, site) => sum + site.households * (1 - distance(site.point, a) / 150), 0)
      const householdsB = nearby(b).filter(site => distance(site.point, b) <= distance(site.point, a)).reduce((sum, site) => sum + site.households * (1 - distance(site.point, b) / 150), 0)
      const trips = 2.4 * Math.sqrt(householdsA * householdsB)
      if (trips <= 0) continue
      // A 40m survey cell merges near-identical proposals; it never positions
      // a street. The endpoints remain exact projections on inherited roads.
      const ends = [a, b].map(p => `${Math.round(p.x / 40)},${Math.round(p.y / 40)}`).sort(), key = ends.join(':')
      const previous = surveys.get(key)
      if (!previous || trips / chord > previous.trips / previous.chord) surveys.set(key, { a, b, chord, trips, key })
    }
  }
  return [...surveys.values()].sort((a, b) => b.trips / b.chord - a.trips / a.chord || a.key.localeCompare(b.key))
}
