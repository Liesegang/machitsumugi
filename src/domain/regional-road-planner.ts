import type { Point } from './types'
import { RoadPlanner } from './road-planner'
import type { PlannedRoute, PlanningEnvironment, PlanningOptions } from './road-planner'
import type { RailwayCorridor } from './railway-road-constraints'

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
  waterAt(p: Point) { return this.planner.waterAt(this.move(p)) }
  validate(points: Point[], width: number, bridge = false) { return this.planner.validate(points.map(p => this.move(p)), width, bridge) }
  plan(start: Point, goal: Point, options: PlanningOptions): PlannedRoute | null {
    const route = this.planner.plan(this.move(start), this.move(goal), { ...options, ...(options.through ? { through: this.move(options.through) } : {}) })
    const local = (p: Point): Point => ({ x: p.x - this.padding, y: p.y - this.padding })
    return route ? { ...route, points: route.points.map(local), ...(route.surveyedBridgeSpans ? { surveyedBridgeSpans: route.surveyedBridgeSpans.map(span => ({ bankA: local(span.bankA), bankB: local(span.bankB) })) } : {}) } : null
  }
  /** A real surveyed endpoint beyond the displayed edge, shared by regional programmes. */
  beyondBoundary(edgeSite: Point, offset = 0): Point {
    const { width, height } = this.environment, inset = this.padding * .72
    const distances = [Math.abs(edgeSite.x), Math.abs(edgeSite.y), Math.abs(width - edgeSite.x), Math.abs(height - edgeSite.y)], side = distances.indexOf(Math.min(...distances))
    return side === 0 ? { x: -inset, y: edgeSite.y + offset } : side === 1 ? { x: edgeSite.x + offset, y: -inset } : side === 2 ? { x: width + inset, y: edgeSite.y + offset } : { x: edgeSite.x + offset, y: height + inset }
  }
  toBoundary(start: Point, edgeSite: Point, options: PlanningOptions): PlannedRoute | null {
    let best: PlannedRoute | null = null
    for (const offset of [0, -160, 160, -320, 320]) {
      const goal = this.beyondBoundary(edgeSite, offset)
      const route = this.plan(start, goal, options)
      if (route && (!best || route.cost < best.cost)) best = route
    }
    return best ? { ...best, boundaryContinuation: true } : null
  }
}
