import { corridorPolygon, distance, pointInRegion, polygonOverlapsRegion, projectPoint } from './geometry'
import { RoadPlanner } from './road-planner'
import type { PlanningTerrain } from './road-planner'
import type { castleLayout } from './castle-layout'
import type { Area, Point, Road } from './types'

/** A short, physically surveyed approach to the real outer gate. This does not
 * invent a moat bridge or move the gate to whichever street happens to be near.
 * If the inherited1650 streets cannot reach that gate, no access is asserted. */
export function surveyCastleAccess(input: { castle: ReturnType<typeof castleLayout>; width: number; height: number; roads: Road[]; areas: Area[]; terrain: PlanningTerrain }) {
  const { castle } = input, width = 4
  const waterAt = (point: Point) => input.terrain.waterAt(point) || castle.areas.some(area => pointInRegion(point, area))
  const environment = { width: input.width, height: input.height, areas: input.areas, terrain: { ...input.terrain, waterAt } }
  const planner = new RoadPlanner({ ...environment, core: castle.core }), gatePlanner = new RoadPlanner({ ...environment, core: null })
  const crossing = [castle.gate.outside, castle.gate.inside]
  if (!gatePlanner.validate(crossing, width)) return null
  const candidates = input.roads.filter(road => (road.builtYear ?? 1650) <= 1650 && !road.bridge && !road.controlledAccess && road.role !== 'expressway' && road.role !== 'ramp' && !road.id.startsWith('castle-')).flatMap(road => road.points.slice(1).map((b, i) => {
    const point = projectPoint(castle.gate.outside, road.points[i]!, b)
    return { road, point, segment: i + 1, distance: distance(point, castle.gate.outside) }
  })).filter(candidate => candidate.distance < 400).sort((a, b) => a.distance - b.distance || a.road.id.localeCompare(b.road.id) || a.segment - b.segment)
  for (const candidate of candidates.slice(0, 12)) {
    const route = candidate.distance < 16 ? planner.validate([candidate.point, castle.gate.outside], width) ? { points: [candidate.point, castle.gate.outside], length: candidate.distance, cost: candidate.distance * .68 } : null : planner.plan(candidate.point, castle.gate.outside, { role: 'access', width, allowBridge: false, maxNodes: 5000 })
    if (!route || route.length > Math.max(80, candidate.distance * 2) || !Number.isFinite(route.cost) || route.cost > 800) continue
    const points = [...route.points, castle.gate.inside]
    if (points.slice(1).some((point, i) => castle.structures.some(building => polygonOverlapsRegion(corridorPolygon(points[i]!, point, width / 2), building)))) continue
    return { attach: { roadId: candidate.road.id, point: candidate.point, segment: candidate.segment }, road: { id: 'castle-gate-approach', points, width, kind: 'local', role: 'access', builtYear: 1650, reason: `成立期の街道から城門へ接続する通路（測量工費${Math.round(route.cost)}単位）` } as Road, cost: route.cost }
  }
  return null
}
