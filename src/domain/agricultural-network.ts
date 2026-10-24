import type { Point } from './types'
import type { PlanarRoadGraph } from './road-graph'
import type { RoadPlanner, PlannedRoute } from './road-planner'

export interface AgriculturalSector { id: string; point: Point; ownerResistance: number }
interface AccessProject { route: PlannedRoute; sector: AgriculturalSector; year: 1650; width: number; reason: string }

/** Yield one physically surveyed project at a time. The caller adopts it with
 * the normal road/funds/history machinery before requesting the next project.
 * A sector across water is not served merely because a road is close on paper;
 * newly connected sectors can provide a source for previously blocked land.
 */
export function* surveyAgriculturalAccessProjects(input: { graph: PlanarRoadGraph; planner: RoadPlanner; sectors: AgriculturalSector[] }): Generator<AccessProject> {
  const { graph, planner } = input, pending = new Set(input.sectors)
  const tested = new Map<AgriculturalSector, Set<string>>()
  while (pending.size) {
    const revision = graph.topologyRevision
    const ranked = [...pending].map(sector => ({ sector, near: graph.nearest(sector.point, 900) }))
      .filter(candidate => candidate.near).sort((a, b) => (b.sector.ownerResistance + .3) / (100 + b.near!.distance) - (a.sector.ownerResistance + .3) / (100 + a.near!.distance) || a.sector.id.localeCompare(b.sector.id))
    let adopted = false
    for (const { sector } of ranked) {
      const projections = graph.projections(sector.point, 900, 24)
      const sources = projections.filter((projection, i) => !projections.slice(0, i).some(other => other.road.id === projection.road.id)).slice(0, 3)
      if (sources.length < 3) for (const projection of projections) {
        if (sources.every(source => Math.hypot(source.point.x - projection.point.x, source.point.y - projection.point.y) > 180)) sources.push(projection)
        if (sources.length === 3) break
      }
      const tried = tested.get(sector) ?? new Set<string>(); tested.set(sector, tried)
      let project: PlannedRoute | undefined
      for (const source of sources) {
        const key = `${source.road.id}:${source.point.x}:${source.point.y}:${source.road.width}`
        if (tried.has(key)) continue
        tried.add(key)
        if (source.distance <= 150 && planner.validate([source.point, sector.point], 3.5)) {
          // This is the same short, surveyed private field access checked by
          // agriculturalAccessSurvey, not an unrecorded public road project.
          pending.delete(sector); break
        }
        const route = planner.plan(source.point, sector.point, { role: 'farm', width: 3.5, alignment: 'planned', allowBridge: false, maximumGrade: .12, maxNodes: 1800 })
        if (!route || route.length > source.distance * 1.55 || route.cost >= 700 || route.bridgeLength > 0) continue
        if (!project || route.cost < project.cost) project = route
      }
      if (!pending.has(sector) || !project) continue
      yield { route: project, sector, year: 1650, width: 3.5, reason: '連続する耕作区域へ既存街道・農道から全幅測量して接続する農道' }
      pending.delete(sector)
      if (graph.topologyRevision !== revision) { adopted = true; break }
    }
    // Failed physical source/target pairs are never surveyed again. Only a new
    // accepted connection can expose another real source for blocked sectors.
    if (!adopted) break
  }
}
