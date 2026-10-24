import type { Building, Point } from './types'
import type { PolygonRegion } from './geometry'
import type { PlannedRoute } from './road-planner'
import { corridorPolygon, distance, pointInPolygon, polygonArea, polygonsOverlap, projectPoint, rectangle } from './geometry'
import { surveyDevelopmentSite } from './development-terrain'

export interface CampusProposal {
  buildings: Building[]; paths: PlannedRoute[]; clearings: PolygonRegion[]; plaza: PolygonRegion; cost: number
}
interface CampusInput {
  campus: Point[]; center: Point; entrance: Point; along: Point; across: Point; year: number; name: string; suffix: string
  elevation(point: Point): number; slope(point: Point): number; waterAt(point: Point): boolean
  canPlace(polygon: Point[]): boolean
  plan(from: Point, to: Point, buildings: Building[]): PlannedRoute | null
  budget: number
}

/** Compact fictional regional campus. Individual pads follow contours; no
 * giant flat platform is cut across an entire hillside to satisfy the option. */
export function surveyUniversityCampus(input: CampusInput): CampusProposal | null {
  const { center, along, across } = input
  const point = (x: number, y: number) => ({ x: center.x + along.x * x + across.x * y, y: center.y + along.y * x + across.y * y })
  const buildings: Building[] = [], pads: PolygonRegion[] = []
  let formation = 0
  const plans = [{ x: -52, y: -42, length: 40, depth: 13, floors: 3, name: '本館' }, { x: 46, y: -35, length: 34, depth: 12, floors: 3, name: '講義棟' }, { x: -48, y: 38, length: 30, depth: 14, floors: 2, name: '図書館' }, { x: 43, y: 43, length: 32, depth: 12, floors: 2, name: '研究棟' }]
  for (const [i, plan] of plans.entries()) {
    const p = point(plan.x, plan.y), gx = input.elevation({ x: p.x + 4, y: p.y }) - input.elevation({ x: p.x - 4, y: p.y }), gy = input.elevation({ x: p.x, y: p.y + 4 }) - input.elevation({ x: p.x, y: p.y - 4 })
    const magnitude = Math.hypot(gx, gy), direction = magnitude > .02 ? { x: -gy / magnitude, y: gx / magnitude } : along
    const polygon = rectangle(-plan.length / 2, -plan.depth / 2, plan.length, plan.depth).map(q => ({ x: p.x + direction.x * q.x - direction.y * q.y, y: p.y + direction.y * q.x + direction.x * q.y }))
    if (polygon.some(p => !pointInPolygon(p, input.campus) || input.waterAt(p)) || !input.canPlace(polygon) || buildings.some(building => polygonsOverlap(polygon, building.polygon))) continue
    const site = surveyDevelopmentSite(input, p, polygon)
    if (!site.viable || site.maximumFloors < plan.floors) continue
    formation += site.formationCost
    buildings.push({ id: `facility-building-university${input.suffix}-${i}`, polygon, kind: 'public', height: plan.floors, builtYear: input.year, name: `${input.name} ${plan.name}` }); pads.push({ polygon })
  }
  if (buildings.length < 3) return null
  const plaza: PolygonRegion = { polygon: rectangle(-8, -7, 16, 14).map(p => point(p.x, p.y)) }
  if (!input.canPlace(plaza.polygon) || plaza.polygon.some(input.waterAt) || !surveyDevelopmentSite(input, center, plaza.polygon).viable) return null
  const paths: PlannedRoute[] = [], approach = input.plan(input.entrance, center, buildings)
  if (!approach) return null
  paths.push(approach)
  for (const building of buildings) {
    let door: Point | undefined, best = Infinity
    for (let i = 0; i < building.polygon.length; i++) {
      const p = projectPoint(center, building.polygon[i]!, building.polygon[(i + 1) % building.polygon.length]!), d = distance(center, p)
      if (d < best) { best = d; door = { x: p.x + (center.x - p.x) / d * 2.5, y: p.y + (center.y - p.y) / d * 2.5 } }
    }
    const route = door && input.plan(center, door, buildings)
    if (!route) return null
    paths.push(route)
  }
  const pathMasks = paths.flatMap(route => route.points.slice(1).map((b, i) => ({ polygon: corridorPolygon(route.points[i]!, b, 1.8) })))
  if (pathMasks.some(region => region.polygon.some(p => !pointInPolygon(p, input.campus)) || buildings.some(building => polygonsOverlap(region.polygon, building.polygon)) || !input.canPlace(region.polygon))) return null
  // Explicit fictional credits: public construction .9/m² of total floor area,
  // plus surveyed earthwork, paths and .12/m² of the modest shared plaza.
  const cost = buildings.reduce((sum, building) => sum + polygonArea(building.polygon) * building.height * .9, 0) + formation + paths.reduce((sum, route) => sum + route.cost, 0) + polygonArea(plaza.polygon) * .12
  if (!Number.isFinite(cost) || cost > input.budget) return null
  return { buildings, paths, plaza, clearings: [...pads, plaza, ...pathMasks], cost }
}
