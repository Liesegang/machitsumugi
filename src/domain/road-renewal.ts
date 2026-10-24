import { controlledRoad, projectOnRoadSegment, roadLength, roadTravelSpeed } from './road-graph'
import type { PlanarRoadGraph } from './road-graph'
import type { RoadPlanner } from './road-planner'
import type { Point } from './types'

/** Fictional transport appraisal: existing inhabited frontages fund an upgrade,
 * never a scheduled cosmetic replacement. Construction/acquisition are charged
 * to the same capital account as new streets. The entire widened corridor must
 * still pass the ordinary terrain, water and rail survey. */
export function renewExistingRoad(input: { graph: PlanarRoadGraph; planner: Pick<RoadPlanner, 'validate' | 'cost'>; cells: { point: Point; households: number }[]; year: number; funds: number }) {
  if (input.year < 1955 || (input.year - 1955) % 10 || input.funds <= 0) return null
  const candidates = input.graph.roads.flatMap(road => {
    if (road.width >= 8 || road.bridge || controlledRoad(road) || !['lane', 'collector', 'highway'].includes(road.role) || input.year - (road.modifiedYear ?? road.builtYear) < 25) return []
    const length = roadLength(road.points)
    if (length < 100 || length > 1800) return []
    const minX = Math.min(...road.points.map(p => p.x)) - 180, maxX = Math.max(...road.points.map(p => p.x)) + 180, minY = Math.min(...road.points.map(p => p.y)) - 180, maxY = Math.max(...road.points.map(p => p.y)) + 180
    let households = 0
    for (const cell of input.cells) {
      if (!cell.households || cell.point.x < minX || cell.point.x > maxX || cell.point.y < minY || cell.point.y > maxY) continue
      let nearest = Infinity
      for (let i = 1; i < road.points.length; i++) {
        const p = projectOnRoadSegment(cell.point, road.points[i - 1]!, road.points[i]!).point
        nearest = Math.min(nearest, Math.hypot(p.x - cell.point.x, p.y - cell.point.y))
      }
      households += cell.households * Math.max(0, 1 - nearest / 180)
    }
    const trips = households * 2
    if (trips < 100) return []
    const role = road.role === 'highway' ? 'highway' as const : 'collector' as const
    // Narrow old routes impose a carriageway impedance, including otherwise
    // already classified highways; this is an explicit scenario assumption.
    const oldSpeed = roadTravelSpeed(road) * Math.min(1, road.width / 8), newSpeed = roadTravelSpeed({ role })
    const minutesSaved = length * .5 * (1 / oldSpeed - 1 / newSpeed)
    const surveyed = input.planner.cost(road.points, role)
    const cost = surveyed.cost * (8 - road.width) / 8 + length * (8 - road.width) * .45
    const benefit = trips * Math.max(0, minutesSaved) * 12
    if (!Number.isFinite(cost) || cost > input.funds || benefit <= cost || !input.planner.validate(road.points, 8)) return []
    return [{ road, width: 8, role, cost, trips, minutesSaved, value: benefit - cost }]
  }).sort((a, b) => b.value / b.cost - a.value / a.cost || a.road.id.localeCompare(b.road.id))
  const project = candidates[0]
  if (!project) return null
  const reason = `既存沿道の交通需要による拡幅（${Math.round(project.trips)}移動/日、${project.minutesSaved.toFixed(1)}分短縮、用地・工事費${Math.round(project.cost)}）`
  const updated = input.graph.modify(project.road.id, input.year, { width: project.width, role: project.role, reason, constructionCost: project.cost })
  return updated ? { road: updated, cost: project.cost, reason } : null
}
