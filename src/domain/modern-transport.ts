import type { Point } from './types'
import { PlanarRoadGraph, roadLength } from './road-graph'
import { RoadPlanner } from './road-planner'
import type { PlannedRoute } from './road-planner'
import { RegionalRoadPlanner } from './regional-road-planner'

export interface ModernTransportProject {
  mainline: PlannedRoute
  accesses: { route: PlannedRoute; role: 'collector' | 'ramp'; width: number; level: number; controlledAccess: boolean }[]
  role: 'highway' | 'expressway'; width: number; cost: number; benefit: number; trips: number; minutesSaved: number
}
export interface ModernTransportPlanningLimits {
  maxPairs?: number; maxAnchors?: number; maxDeltas?: number; maxNodes?: number
}
interface Input {
  graph: PlanarRoadGraph; planner: RoadPlanner; regionalPlanner: RegionalRoadPlanner
  width: number; height: number; households: number; jobs: number; funds: number; kind: 'bypass' | 'expressway'; year?: number
  /** Bound candidate work without relaxing engineering/benefit acceptance. */
  planningLimits?: ModernTransportPlanningLimits
}
const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y)
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
function along(points: Point[], chainage: number) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!, length = distance(a, b)
    if (chainage <= length) return { point: lerp(a, b, chainage / (length || 1)), heading: Math.atan2(b.y - a.y, b.x - a.x) }
    chainage -= length
  }
  const a = points.at(-2)!, b = points.at(-1)!
  return { point: b, heading: Math.atan2(b.y - a.y, b.x - a.x) }
}

/** A bounded regional transport programme, selected from inherited trade portals.
 * Mainline crossovers are grade separated. Each interchange has a real surface
 * access street and two tangent slip ramps; frontage parcels cannot use them.
 * Relative costs and trip rates are explicit scenario assumptions, not forecasts. */
export function planModernTransport(input: Input): ModernTransportProject | null {
  const { graph, planner, regionalPlanner, width, height } = input
  if (!input.households || input.funds <= 0) return null
  const outside = (p: Point) => p.x < 0 || p.y < 0 || p.x > width || p.y > height
  const portals: Point[] = []
  for (const road of graph.roads.filter(road => road.boundaryContinuation && !road.controlledAccess)) for (const p of [road.points[0]!, road.points.at(-1)!]) {
    if (outside(p) && portals.every(other => distance(p, other) > 300)) portals.push(p)
  }
  const expressway = input.kind === 'expressway', role = expressway ? 'expressway' : 'highway', carriageway = expressway ? 22 : 16
  const trips = input.households * (expressway ? 1.8 : 1.1) + input.jobs * (expressway ? .8 : .5)
  const limit = (value: number | undefined, fallback: number) => value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback
  const maxPairs = limit(input.planningLimits?.maxPairs, Infinity), maxAnchors = limit(input.planningLimits?.maxAnchors, 8), maxDeltas = limit(input.planningLimits?.maxDeltas, 5)
  const mainlineNodes = limit(input.planningLimits?.maxNodes, 20000), accessNodes = limit(input.planningLimits?.maxNodes, 9000)
  const pairs = portals.flatMap((a, i) => portals.slice(i + 1).map(b => ({ a, b, oldTime: graph.travelTime(a, b) })))
    .filter(pair => distance(pair.a, pair.b) > Math.min(width, height) * .6 && Number.isFinite(pair.oldTime))
    .sort((a, b) => b.oldTime - a.oldTime)
  let best: ModernTransportProject | null = null
  for (const pair of pairs.slice(0, maxPairs)) {
    const mainline = regionalPlanner.plan(pair.a, pair.b, { role, width: carriageway, allowBridge: true, maxNodes: mainlineNodes })
    if (!mainline || mainline.cost > input.funds || (!expressway && graph.hasAcuteMajorCrossing(mainline.points))) continue
    const accesses: ModernTransportProject['accesses'] = []
    if (expressway) {
      const length = roadLength(mainline.points), interchanges: Point[] = []
      // Two separated, actually reachable access areas are necessary before a
      // new controlled corridor can produce any local travel-time benefit.
      for (const fraction of [.28, .72]) {
        let found = false
        for (const delta of [0, -180, 180, -360, 360].slice(0, maxDeltas)) {
          const centerChainage = Math.max(430, Math.min(length - 430, length * fraction + delta)), center = along(mainline.points, centerChainage)
          if (center.point.x < 200 || center.point.y < 200 || center.point.x > width - 200 || center.point.y > height - 200 || interchanges.some(p => distance(p, center.point) < 700)) continue
          siteSearch: for (const side of [-1, 1]) for (const offset of [210, 300]) {
            const normal = center.heading + Math.PI / 2 * side, forecourt = { x: center.point.x + Math.cos(normal) * offset, y: center.point.y + Math.sin(normal) * offset }
            if (!planner.suitable(forecourt, 10)) continue
            const anchors = graph.projections(forecourt, 650, maxAnchors).filter(anchor => anchor.road.role !== 'farm' && distance(anchor.point, forecourt) > 60)
            for (const anchor of anchors) {
              const startHeading = graph.junctionHeading(anchor.point, forecourt)
              if (startHeading === null) continue
              const service = planner.plan(anchor.point, forecourt, { role: 'collector', width: 9, startHeading, endHeading: normal + Math.PI, maxNodes: accessNodes })
              if (!service || graph.hasAcuteMajorCrossing(service.points)) continue
              const rampA = along(mainline.points, centerChainage - 320), rampB = along(mainline.points, centerChainage + 320)
              const first = planner.plan(forecourt, rampA.point, { role: 'ramp', width: 7, startHeading: center.heading + Math.PI, endHeading: rampA.heading + Math.PI, maxNodes: accessNodes })
              const second = planner.plan(forecourt, rampB.point, { role: 'ramp', width: 7, startHeading: center.heading, endHeading: rampB.heading, maxNodes: accessNodes })
              if (!first || !second) continue
              accesses.push({ route: service, role: 'collector', width: 9, level: 0, controlledAccess: false }, { route: first, role: 'ramp', width: 7, level: 1, controlledAccess: true }, { route: second, role: 'ramp', width: 7, level: 1, controlledAccess: true })
              interchanges.push(center.point); found = true; break
            }
            if (found) break siteSearch
          }
          if (found) break
        }
        if (!found) break
      }
      if (interchanges.length < 2) continue
    }
    // Evaluate the complete proposed graph. A motorway passing near a market
    // cannot save its travellers time unless its actual ramp route does so.
    const trial = graph.fork(), year = input.year ?? 1985
    const metadata = { builtYear: year, phase: 'suburban', reason: 'regional transport feasibility trial', constructionCost: 0, kind: 'arterial' as const }
    if (!trial.add(mainline.points, { ...metadata, id: 'trial-mainline', role, width: carriageway, level: expressway ? 1 : 0, controlledAccess: expressway, boundaryContinuation: true }, false)) continue
    let feasible = true
    for (const [i, access] of accesses.entries()) if (!trial.add(access.route.points, { ...metadata, id: `trial-access-${i}`, role: access.role, width: access.width, level: access.level, controlledAccess: access.controlledAccess, preserveEndpoint: true })) { feasible = false; break }
    if (!feasible) continue
    const minutesSaved = Math.max(0, pair.oldTime - trial.travelTime(pair.a, pair.b))
    const cost = mainline.cost + accesses.reduce((sum, access) => sum + access.route.cost, 0)
    // Same credit/person-hour and discounted travel horizon as local public
    // projects. Access ramps and streets are included in both cost and time.
    const benefit = minutesSaved * trips / 60 * 250 * 8 * .02
    if (cost > input.funds || benefit <= cost) continue
    const candidate: ModernTransportProject = { mainline: { ...mainline, boundaryContinuation: true }, accesses, role, width: carriageway, cost, benefit, trips, minutesSaved }
    if (!best || candidate.benefit - candidate.cost > best.benefit - best.cost) best = candidate
  }
  return best
}
