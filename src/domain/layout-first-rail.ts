import type { Area, CityConfig, Point, Railway, Road, Station } from './types'
import type { PolygonRegion } from './geometry'
import type { LayoutFirstZone } from './layout-first-types'
import type { TerrainModel } from './terrain'
import { distance, distanceToSegment, pointInRegion, polygonOverlapsRegion, rectangle, segmentsCross } from './geometry'
import { planRailway } from './railway-planner'
import type { RailwayPlan } from './railway-planner'

type RailTerrain = Pick<TerrainModel, 'areas' | 'elevation' | 'slope' | 'waterAt'> & Partial<Pick<TerrainModel, 'channelAt'>>
export interface LayoutFirstRailInput {
  config: CityConfig
  width: number
  height: number
  terrain: RailTerrain
  center: Point
  zones: readonly LayoutFirstZone[]
  reserves: readonly PolygonRegion[]
  roads?: Road[]
}
export interface LayoutFirstRailResult {
  railways: Railway[]
  stations: Station[]
  /** Reserve these complete forecourts before assigning residential parcels. */
  stationGrounds: Area[]
  /** Public roads stop outside reserved grounds; these paths reach the doors. */
  accessTargets: { id: string; point: Point; builtYear: number }[]
  stationPaths: Road[]
  diagnostics: {
    requestedStations: number
    placedStations: number
    reason?: string
    alignment?: RailwayPlan['diagnostics']
  }
}

interface StationCandidate {
  point: Point
  along: number
  tangent: Point
  score: number
  building: Point[]
  forecourt: Point[]
  entrance: Point
  gate: Point
}
const MINIMUM_SPACING = 650
const nearestDistance = (point: Point, points: Point[]) => Math.min(...points.slice(1).map((b, i) => distanceToSegment(point, points[i]!, b)))

/** One physically surveyed regional line. Stations have dry, reserved land and
 * a street-facing entrance; their road approaches are constructed by the next
 * layout stage. This does not manufacture short, one-station branch lines. */
export function surveyLayoutFirstRail(input: LayoutFirstRailInput): LayoutFirstRailResult {
  const requested = input.config.railway ? Math.max(1, Math.min(5, Math.round(input.config.stations))) : 0
  const empty = (reason?: string): LayoutFirstRailResult => ({ railways: [], stations: [], stationGrounds: [], accessTargets: [], stationPaths: [], diagnostics: { requestedStations: requested, placedStations: 0, ...(reason ? { reason } : {}) } })
  if (!requested) return empty()
  const zones = input.zones.filter(zone => zone.kind !== 'rural' && zone.kind !== 'industrial')
  const hub = [...zones].sort((a, b) => (b.kind === 'historic' ? 1 : 0) - (a.kind === 'historic' ? 1 : 0) || b.density * b.radius ** 2 - a.density * a.radius ** 2)[0]
  // Existing engineering code recognizes this private planning tag. These
  // regions never enter the map's entity table, where IDs must be unique.
  const planningAreas: Area[] = [...input.terrain.areas, ...input.reserves.map(region => ({ ...region, id: 'historic-core', kind: 'park' as const }))]
  const plan = planRailway({ width: input.width, height: input.height, seed: input.config.seed, origin: hub?.center ?? input.center,
    terrain: { ...input.terrain, areas: planningAreas }, inheritedRoads: input.roads,
    settlements: zones.length ? zones.map(zone => ({ point: zone.center, demand: Math.max(.1, zone.density) * zone.radius ** 2 })) : undefined,
    allowTerminus: input.config.terrain === 'coast' || input.config.type === 'port' || input.config.type === 'onsen' })
  if (!plan) return empty('地形と曲線・勾配の条件を満たす地域鉄道の経路を確保できませんでした。')
  // Validate actual corridor shoulders against every reserved civic compound,
  // including narrow encounters between the engineering planner's samples.
  for (let i = 1; i < plan.points.length; i++) {
    const a = plan.points[i - 1]!, b = plan.points[i]!
    if (input.reserves.some(region => pointInRegion(a, region) || pointInRegion(b, region) || region.polygon.some((p, j) => {
      const q = region.polygon[(j + 1) % region.polygon.length]!
      return segmentsCross(a, b, p, q) || distanceToSegment(p, a, b) < 7.5 || distanceToSegment(a, p, q) < 7.5 || distanceToSegment(b, p, q) < 7.5
    }))) return empty('鉄道の有効幅が予約済みの公共用地に接するため、この経路は採用できませんでした。')
  }
  const chain = [0]
  for (let i = 1; i < plan.points.length; i++) chain.push(chain[i - 1]! + distance(plan.points[i - 1]!, plan.points[i]!))
  const length = chain.at(-1)!, candidates: StationCandidate[] = []
  const bounded = (p: Point) => p.x >= 4 && p.y >= 4 && p.x <= input.width - 4 && p.y <= input.height - 4
  const reserved = (polygon: Point[]) => input.reserves.some(region => polygonOverlapsRegion(polygon, region))
  for (let i = 1; i + 1 < plan.points.length; i++) {
    if (chain[i]! < 160 || length - chain[i]! < (plan.terminus ? 0 : 160) || i % 3 !== 0) continue
    const point = plan.points[i]!, previous = plan.points[i - 1]!, next = plan.points[i + 1]!
    if (input.terrain.waterAt(point) || input.terrain.slope(point) > .10 || Math.abs(plan.elevations[i]! - input.terrain.elevation(point)) > 2.5) continue
    if (zones.length && !zones.some(zone => distance(zone.center, point) <= zone.radius + 350)) continue
    const span = distance(previous, next), tangent = { x: (next.x - previous.x) / span, y: (next.y - previous.y) / span }
    if (!Number.isFinite(tangent.x + tangent.y)) continue
    for (const side of [1, -1]) {
      const transform = (x: number, y: number) => ({ x: point.x + tangent.x * x - tangent.y * y * side, y: point.y + tangent.y * x + tangent.x * y * side })
      const building = rectangle(-15, 9, 30, 10).map(p => transform(p.x, p.y))
      const forecourt = rectangle(-25, 8, 50, 34).map(p => transform(p.x, p.y))
      const gate = transform(0, 47)
      const publicGatePad = rectangle(-4, 43, 8, 8).map(p => transform(p.x, p.y))
      const samples = [...forecourt, ...building, ...publicGatePad, gate, transform(0, 26), ...forecourt.map((p, n) => ({ x: (p.x + forecourt[(n + 1) % forecourt.length]!.x) / 2, y: (p.y + forecourt[(n + 1) % forecourt.length]!.y) / 2 }))]
      if (reserved(forecourt) || reserved(publicGatePad) || samples.some(p => !bounded(p) || input.terrain.waterAt(p) || input.terrain.slope(p) > .12)) continue
      if (input.terrain.areas.some(area => area.kind === 'water' && (polygonOverlapsRegion(forecourt, area) || polygonOverlapsRegion(publicGatePad, area)))) continue
      if (input.roads?.some(road => forecourt.some((p, n) => road.points.slice(1).some((b, j) => segmentsCross(p, forecourt[(n + 1) % forecourt.length]!, road.points[j]!, b) || distanceToSegment(p, road.points[j]!, b) < road.width / 2)))) continue
      const levels = samples.map(input.terrain.elevation)
      if (!levels.every(Number.isFinite) || Math.max(...levels) - Math.min(...levels) > 2) continue
      // A forecourt must not sit across another bend of its own railway.
      if (forecourt.some(p => nearestDistance(p, plan.points) < 6)) continue
      const entrance = transform(0, 22)
      const targetDistance = Math.min(distance(point, input.center), ...zones.map(zone => distance(point, zone.center)))
      const roadDistance = input.roads?.length ? Math.min(...input.roads.filter(road => !road.controlledAccess).map(road => nearestDistance(entrance, road.points))) : 0
      // The two banks of the railway are distinct acquisition choices. A tie
      // on the platform point previously always selected the first normal,
      // sometimes leaving the entrance across the track from every old street.
      // Prefer the town-facing forecourt before any new crossing is proposed.
      const townApproach = distance(gate, input.center)
      candidates.push({ point, along: chain[i]!, tangent, building, forecourt, entrance, gate, score: targetDistance + townApproach * .5 + Math.min(1500, roadDistance) * .4 + input.terrain.slope(point) * 2000 })
    }
  }
  const count = Math.min(requested, Math.max(1, Math.floor((length - 320) / MINIMUM_SPACING) + 1))
  const selected: StationCandidate[] = []
  const targets = Array.from({ length: count }, (_, i) => length * (i + 1) / (count + 1))
  // Serve the main existing/proposed centre first, then separated portions of
  // the same line. Fixed sort ties and IDs make independent reruns reproducible.
  const central = [...candidates].sort((a, b) => a.score - b.score || a.along - b.along)[0]
  if (central) selected.push(central)
  for (const target of targets.sort((a, b) => Math.abs(b - (central?.along ?? length / 2)) - Math.abs(a - (central?.along ?? length / 2)))) {
    if (selected.length >= count) break
    const candidate = candidates.filter(c => selected.every(s => Math.abs(s.along - c.along) >= MINIMUM_SPACING && !polygonOverlapsRegion(c.forecourt, { polygon: s.forecourt })))
      .sort((a, b) => Math.abs(a.along - target) + a.score * .25 - Math.abs(b.along - target) - b.score * .25 || a.along - b.along)[0]
    if (candidate) selected.push(candidate)
  }
  if (!selected.length) return empty('鉄道沿いに駅舎と駅前広場を置ける乾燥地盤を確保できませんでした。')
  selected.sort((a, b) => a.along - b.along)
  const base = input.config.name.replace(/[市町村]$/, ''), centralIndex = selected.indexOf(central!)
  const stations: Station[] = selected.map((site, index) => {
    const dx = site.point.x - central!.point.x, dy = site.point.y - central!.point.y
    const direction = Math.abs(dx) > Math.abs(dy) ? dx < 0 ? '西' : '東' : dy < 0 ? '北' : '南'
    return { id: `station-${index}`, name: index === centralIndex ? `${base}駅` : `${direction}${base}${selected.length > 3 ? index + 1 : ''}駅`, point: site.point, railwayId: 'railway-main', builtYear: 1900, entrance: site.entrance, buildingPolygon: site.building }
  })
  return { railways: [{ id: 'railway-main', name: `${base}線`, points: plan.points, elevations: plan.elevations, structures: plan.structures, builtYear: 1900 }], stations,
    stationGrounds: selected.map((site, i) => ({ id: `station-forecourt-${i}`, kind: 'field', landUse: 'vacant', polygon: site.forecourt, name: `${stations[i]!.name}前広場` })),
    accessTargets: selected.map((site, i) => ({ id: `station-access-${i}`, point: site.gate, builtYear: 1900 })),
    stationPaths: selected.map((site, i) => ({ id: `station-access-${i}`, points: [site.gate, site.entrance], width: 3, role: 'access', kind: 'local', builtYear: 1900, reason: '駅前の公道から駅舎の入口に至る歩行者動線' })),
    diagnostics: { requestedStations: requested, placedStations: stations.length, alignment: plan.diagnostics, ...(stations.length < requested ? { reason: '駅間隔と駅舎・駅前広場の地盤条件を満たす地点に駅を絞りました。' } : {}) } }
}
