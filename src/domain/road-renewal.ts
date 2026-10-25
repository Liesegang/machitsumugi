import { controlledRoad, roadLength } from './road-graph'
import type { PlanarRoadGraph, SimulatedRoad } from './road-graph'
import type { RoadPlanner } from './road-planner'
import { assignRoadTraffic } from './road-traffic'
import type { TrafficDestination } from './road-traffic'
import type { Point } from './types'

/** Fictional transport appraisal: existing inhabited frontages fund an upgrade,
 * never a scheduled cosmetic replacement. Construction/acquisition are charged
 * to the same capital account as new streets. The entire widened corridor must
 * still pass the ordinary terrain, water and rail survey. */
export function renewExistingRoad(input: { graph: PlanarRoadGraph; planner: Pick<RoadPlanner, 'validate' | 'cost' | 'railwayWidthAllows'>; cells: { point: Point; households: number }[]; destinations: TrafficDestination[]; year: number; funds: number; traffic?: ReturnType<typeof assignRoadTraffic>; actualStock?: boolean }) {
  if (input.year < 1955 || (input.year - 1955) % 10 || input.funds <= 0) return null
  const traffic = input.traffic ?? assignRoadTraffic({ roads: input.graph.roads, cells: input.cells, destinations: input.destinations, year: input.year })
  const candidates = input.graph.roads.flatMap(road => {
    const load = traffic.loads.get(road.id)
    if (!load || load.peakVehicles < 80 || road.width >= (input.actualStock ? 13 : 9.5) || road.bridge || controlledRoad(road) || input.year - (road.modifiedYear ?? road.builtYear) < 25) return []
    const length = roadLength(road.points)
    if (length < 45 || length > 2400) return []
    const role = road.role === 'highway' ? 'highway' as const : 'collector' as const
    // Existing-stock work can fit a smaller cross-section around a standing
    // station or house. Each option has its own full-width survey and cost;
    // historical construction rounds retain their previous single-width policy.
    const widths = input.actualStock ? [6.3, 8, 9.5, 13].filter(width => width > road.width) : [load.peakVehicles > 900 ? 13 : 9.5]
    return widths.flatMap(width => {
      if (!input.planner.validate(road.points, width) || !input.planner.railwayWidthAllows(road.points, road.width, width, role)) return []
      const trips = load.peakVehicles / .1
      const savedVehicleMinutes = Math.min(30 * trips, traffic.upgradeDailyVehicleMinutes(road.id, width, role))
      const minutesSaved = savedVehicleMinutes / trips
      const surveyed = input.planner.cost(road.points, role)
      const cost = surveyed.cost * (width - road.width) / width + length * (width - road.width) * .45
      const benefit = savedVehicleMinutes / 60 * 250 * 8 * .02
      if (!Number.isFinite(cost) || cost <= 0 || cost > input.funds || benefit <= cost) return []
      return [{ road, width, role, cost, trips, minutesSaved, benefit, value: benefit - cost, load }]
    })
  }).sort((a, b) => b.value / b.cost - a.value / a.cost || a.road.id.localeCompare(b.road.id))
  const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
  const away = (road: SimulatedRoad, p: Point) => { const points = distance(road.points[0]!, p) < .05 ? road.points : [...road.points].reverse(), next = points.find(q => distance(q, p) >= 8) ?? points.at(-1)!; return Math.atan2(next.y - p.y, next.x - p.x) }
  type Candidate = typeof candidates[number]
  const projects: { sections: Candidate[]; cost: number; benefit: number; length: number }[] = []
  for (const seed of candidates.slice(0, 16)) {
    const sections = [seed], used = new Set([seed.road.id]); let cost = seed.cost, benefit = seed.benefit, length = roadLength(seed.road.points)
    // Follow the same traffic stream across named-road boundaries. Every
    // section is independently surveyed; an unconnected short badge is not a corridor.
    for (const firstEnd of [seed.road.points[0]!, seed.road.points.at(-1)!]) {
      let current = seed, end = firstEnd
      for (let step = 0; step < 12; step++) {
        const incoming = away(current.road, end) + Math.PI
        const next = candidates.filter(c => !used.has(c.road.id) && c.load.peakVehicles >= seed.load.peakVehicles * .45 && [c.road.points[0]!, c.road.points.at(-1)!].some(p => distance(p, end) < .05))
          .map(c => ({ c, turn: Math.abs(Math.atan2(Math.sin(away(c.road, end) - incoming), Math.cos(away(c.road, end) - incoming))) }))
          .filter(c => c.turn < Math.PI / 3 && cost + c.c.cost <= input.funds && length + roadLength(c.c.road.points) <= 3000)
          .sort((a, b) => a.turn - b.turn || b.c.value / b.c.cost - a.c.value / a.c.cost)[0]?.c
        if (!next) break
        sections.push(next); used.add(next.road.id); cost += next.cost; benefit += next.benefit; length += roadLength(next.road.points)
        end = distance(next.road.points[0]!, end) < .05 ? next.road.points.at(-1)! : next.road.points[0]!; current = next
      }
    }
    if (length >= (input.actualStock ? 45 : 180)) projects.push({ sections, cost, benefit, length })
  }
  const project = projects.sort((a, b) => (b.benefit - b.cost) / b.cost - (a.benefit - a.cost) / a.cost || b.length - a.length)[0]
  if (!project) return null
  const trips = Math.max(...project.sections.map(s => s.trips)), minutesSaved = project.sections.reduce((sum, p) => sum + p.minutesSaved, 0)
  const reason = `交通量配分に基づく連続区間の拡幅（${Math.round(project.length)}m、最大${Math.round(trips)}台/日相当、用地・工事費${Math.round(project.cost)}）`
  const updated = input.graph.addBatch(project.sections.map(s => ({ points: s.road.points, modifies: s.road.id, metadata: { ...s.road, builtYear: input.year, width: s.width, role: s.role, reason, constructionCost: s.cost } })))
  return updated ? { road: updated[0]!, roads: updated, cost: project.cost, reason, trips, minutesSaved } : null
}
