import type { Point, Road } from './types'
import type { RoadRole } from './road-graph'
import { RoadPlanner } from './road-planner'
import type { PlannedRoute, PlanningEnvironment, PlanningOptions } from './road-planner'
import type { RailwayCorridor } from './railway-road-constraints'

/** Administrative designation does not require a13m engineering cross-section.
 * Only an actually surveyed regional continuation can receive this designation. */
export function regionalRoadKind(arterial: boolean, boundaryContinuation: boolean | undefined, role: RoadRole): Road['kind'] {
  return arterial && boundaryContinuation && ['highway', 'collector', 'lane', 'bridge'].includes(role) ? 'arterial' : 'local'
}

export interface BoundaryPortalOptions {
  width: number
  /** Restrict the search to the same boundary as this original edge survey. */
  preferred?: Point
  /** Search forward into a neighbouring valley/pass, independently of river outlets. */
  direction?: Point
  maxCandidates?: number
}

/** Plans into real surrounding terrain. The full canonical route is retained;
 * the map canvas clips it at the crop edge, rather than drawing a false end cap. */
export class RegionalRoadPlanner {
  private planner: RoadPlanner
  private padding: number
  private environment: PlanningEnvironment
  private railwayCorridors: RailwayCorridor[] = []
  setRailwayCorridors(corridors: RailwayCorridor[]) {
    if (corridors.length === this.railwayCorridors.length && corridors.every((corridor, i) => corridor === this.railwayCorridors[i])) return
    this.railwayCorridors = corridors.slice()
    this.planner.setRailwayCorridors(corridors.map(corridor => ({ ...corridor, points: corridor.points.map(p => ({ x: p.x + this.padding, y: p.y + this.padding })) })))
  }
  setRailwayRoadNetwork(roads: readonly import('./types').Road[]) {
    this.planner.setRailwayRoadNetwork(roads.map(road => ({ ...road, points: road.points.map(point => ({ x: point.x + this.padding, y: point.y + this.padding })) })))
  }
  railwayAllows(points: Point[], role: import('./road-graph').RoadRole) {
    return this.planner.railwayAllows(points.map(point => ({ x: point.x + this.padding, y: point.y + this.padding })), role)
  }
  constructor(environment: PlanningEnvironment, padding = 450) {
    const continuation = environment.terrain?.continuationTerrain
    if (!continuation) throw new Error('Regional roads require actual surrounding terrain samples')
    if (continuation.contains && [{ x: -padding - 24, y: -padding - 24 }, { x: environment.width + padding + 24, y: -padding - 24 }, { x: -padding - 24, y: environment.height + padding + 24 }, { x: environment.width + padding + 24, y: environment.height + padding + 24 }].some(p => !continuation.contains!(p))) throw new Error('Regional terrain does not cover the planning frame and interpolation margin')
    this.environment = environment; this.padding = padding
    const move = (p: Point): Point => ({ x: p.x + padding, y: p.y + padding }), local = (p: Point): Point => ({ x: p.x - padding, y: p.y - padding })
    const original = environment.terrain!
    this.planner = new RoadPlanner({
      width: environment.width + padding * 2, height: environment.height + padding * 2,
      waterGeometryBounds: { minX: padding, minY: padding, maxX: environment.width + padding, maxY: environment.height + padding },
      core: environment.core?.map(move) ?? null,
      areas: environment.areas.map(area => ({ ...area, polygon: area.polygon.map(move), ...(area.holes ? { holes: area.holes.map(hole => hole.map(move)) } : {}) })),
      exactLandCost: environment.exactLandCost,
      landCost: environment.landCost ? p => environment.landCost!(local(p)) : undefined,
      terrain: {
        elevation: p => continuation.elevation(local(p)), slope: p => continuation.slope(local(p)), waterAt: p => continuation.waterAt(local(p)),
        seaAt: continuation.seaAt ? p => continuation.seaAt!(local(p)) : undefined,
        bridgeSites: (environment.bridgeSites ?? original.bridgeSites).map(move),
        bridgeCandidates: original.bridgeCandidates?.map(site => ({ ...site, point: move(site.point), bankA: move(site.bankA), bankB: move(site.bankB) })),
        wetness: original.wetness ? p => original.wetness!(local(p)) : undefined,
      },
    })
  }
  private move(p: Point): Point { return { x: p.x + this.padding, y: p.y + this.padding } }
  private boundarySide(point: Point): number {
    const { width, height } = this.environment
    const distances = [Math.abs(point.x), Math.abs(point.y), Math.abs(width - point.x), Math.abs(height - point.y)]
    return distances.indexOf(Math.min(...distances))
  }
  waterAt(p: Point) { return this.planner.waterAt(this.move(p)) }
  validate(points: Point[], width: number, bridge = false) { return this.planner.validate(points.map(p => this.move(p)), width, bridge) }
  plan(start: Point, goal: Point, options: PlanningOptions): PlannedRoute | null {
    const route = this.planner.plan(this.move(start), this.move(goal), { ...options, ...(options.through ? { through: this.move(options.through) } : {}) })
    const local = (p: Point): Point => ({ x: p.x - this.padding, y: p.y - this.padding })
    return route ? { ...route, points: route.points.map(local), ...(route.surveyedBridgeSpans ? { surveyedBridgeSpans: route.surveyedBridgeSpans.map(span => ({ ...span, bankA: local(span.bankA), bankB: local(span.bankB) })) } : {}) } : null
  }
  /** Existing relative construction-credit proxy over the surveyed terrain;
   * this is neither currency nor the A* priority/heuristic. */
  cost(points: Point[], role: import('./road-graph').RoadRole, surveyedBridge = false): PlannedRoute {
    const route = this.planner.cost(points.map(point => this.move(point)), role, surveyedBridge)
    return { ...route, points: route.points.map(point => ({ x: point.x - this.padding, y: point.y - this.padding })) }
  }
  /** A real surveyed endpoint beyond the displayed edge, shared by regional programmes. */
  beyondBoundary(edgeSite: Point, offset = 0): Point {
    const { width, height } = this.environment, inset = this.padding * .72
    const side = this.boundarySide(edgeSite)
    return side === 0 ? { x: -inset, y: edgeSite.y + offset } : side === 1 ? { x: edgeSite.x + offset, y: -inset } : side === 2 ? { x: width + inset, y: edgeSite.y + offset } : { x: edgeSite.x + offset, y: height + inset }
  }
  /** Cheap, bounded surveys of actual surrounding terrain. These are candidate
   * endpoints, not accepted roads: callers must plan and validate the full route.
   * A river source inside the crop does not preclude an independent land pass. */
  boundaryPortals(start: Point, options: BoundaryPortalOptions): Point[] {
    const { width, height } = this.environment, inset = this.padding * .72
    const preferredSide = options.preferred ? this.boundarySide(options.preferred) : undefined
    const magnitude = options.direction ? Math.hypot(options.direction.x, options.direction.y) : 0
    const candidates: { point: Point; score: number }[] = []
    for (let side = 0; side < 4; side++) {
      if (preferredSide !== undefined && side !== preferredSide) continue
      const span = side % 2 === 0 ? height : width, clearance = Math.max(24, options.width + 2)
      const samples = Math.min(64, Math.max(2, Math.ceil(span / 180)))
      for (let i = 0; i <= samples; i++) {
        const along = clearance + (span - 2 * clearance) * i / samples
        const boundary = side === 0 ? { x: 0, y: along } : side === 1 ? { x: along, y: 0 } : side === 2 ? { x: width, y: along } : { x: along, y: height }
        const point = side === 0 ? { x: -inset, y: along } : side === 1 ? { x: along, y: -inset } : side === 2 ? { x: width + inset, y: along } : { x: along, y: height + inset }
        const dx = point.x - start.x, dy = point.y - start.y, distance = Math.hypot(dx, dy)
        const alignment = magnitude ? (dx * options.direction!.x + dy * options.direction!.y) / (distance * magnitude || 1) : 1
        if (magnitude && alignment < .15) continue
        let terrainPenalty = 0, dry = true
        // A few field probes reject obviously wet/steep portals before any A*.
        // They do not stand in for the full-width continuous route validation.
        for (const t of [0, .25, .5, .75, 1]) {
          const localProbe = { x: boundary.x + (point.x - boundary.x) * t, y: boundary.y + (point.y - boundary.y) * t }
          if (!this.planner.suitable(this.move(localProbe), options.width)) { dry = false; break }
          const grade = this.environment.terrain!.continuationTerrain!.slope(localProbe)
          terrainPenalty += grade * grade * 95 / 5
        }
        if (!dry) continue
        const preferredDistance = options.preferred ? Math.hypot(boundary.x - options.preferred.x, boundary.y - options.preferred.y) : 0
        candidates.push({ point, score: distance * (1 + terrainPenalty * .15 + (1 - alignment) * .7) + preferredDistance * .35 })
      }
    }
    candidates.sort((a, b) => a.score - b.score || a.point.x - b.point.x || a.point.y - b.point.y)
    const selected: Point[] = [], limit = Math.min(12, Math.max(1, Math.floor(options.maxCandidates ?? 8)))
    for (const candidate of candidates) {
      if (selected.some(point => Math.hypot(point.x - candidate.point.x, point.y - candidate.point.y) < 240)) continue
      selected.push(candidate.point)
      if (selected.length === limit) break
    }
    return selected
  }
  toBoundary(start: Point, edgeSite: Point, options: PlanningOptions): PlannedRoute | null {
    let best: PlannedRoute | null = null
    for (const offset of [0, -160, 160, -320, 320]) {
      const goal = this.beyondBoundary(edgeSite, offset)
      const route = this.plan(start, goal, options)
      if (route && (!best || route.cost < best.cost)) best = route
    }
    if (best) return { ...best, boundaryContinuation: true }
    // The original five surveys can all fall on a cliff or inlet while another
    // dry corridor exists farther along the same real boundary. Bound expensive
    // route searches after the coarse portal survey instead of scanning every site.
    for (const goal of this.boundaryPortals(start, { width: options.width, preferred: edgeSite, maxCandidates: 6 })) {
      const route = this.plan(start, goal, options)
      if (route) return { ...route, boundaryContinuation: true }
    }
    return null
  }
}
