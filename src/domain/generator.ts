import type { Area, Building, CityConfig, CityMap, CityType, Facility, FacilityKind, Point, Road } from './types'
import { createTerrainModel } from './terrain'
import { simulateUrbanGrowth } from './urban-growth'
import type { UrbanGrowthResult } from './urban-growth'
import { boundsOf, corridorPolygon, distance, distanceToSegment, intersectRegions, overlaps, pathPointAt, pointInPolygon, pointInRegion, polygonOverlapsRegion, polygonsOverlap, projectPoint, rectangle, regionArea, segmentsCross, subtractRegions } from './geometry'
import type { PolygonRegion } from './geometry'
import type { Bounds } from './geometry'
import { developLand, GENERATOR_VERSION } from './land-development'
import { simulationEndYear } from './simulation-calendar'
import type { GenerationTerrainSource } from './generation-terrain-cache'
import { extractStreetBlocks } from './road-graph'
import { planRailway } from './railway-planner'
import { planRailwayBranches } from './railway-network'
import { scenarioDemandAtYear } from './urban-growth'
import { RoadPlanner } from './road-planner'
import type { PlannedRoute } from './road-planner'
import { stationAccess } from './station-access-survey'
import type { StationAccessSurvey } from './station-access-survey'
import { agriculturalPlots, agriculturalPlotSuitable, agriculturalRemnantSuitable, contourNaturalLand, settlementDensity } from './land-use'
import { agriculturalAccessSurvey } from './agricultural-access'
import { applyHarborTerrain } from './harbor-terrain'
import type { HarborPlatform } from './harbor-terrain'
import { castleLayout } from './castle-layout'

export const DEFAULT_CONFIG: CityConfig = {
  name: '水杜市', seed: 'minato-2026', type: 'castle', terrain: 'river', relief: 'hills', density: 65, forest: 30,
  railway: true, stations: 3, arterial: true, facilities: ['castle', 'shrine', 'school', 'hospital', 'police', 'shop', 'park'], era: 'present',
}
export const CITY_PRESETS: { id: CityType; name: string; description: string }[] = [
  { id: 'castle', name: '城下町', description: '城郭と街道を核に成立。鉄道開通後は駅前にも市街地が育ちます。' },
  { id: 'temple', name: '門前町', description: '寺社と参道沿いの商業から、周辺の住宅地へ広がります。' },
  { id: 'port', name: '港町', description: '港の市場・倉庫と、内陸へ通じる道に沿って市街地が育ちます。' },
  { id: 'newtown', name: '新興住宅地', description: '駅を中心に、計画された住区を段階的に開発します。' },
  { id: 'post', name: '宿場町', description: '旧街道沿いの宿と商業から、細長い市街地が生まれます。' },
  { id: 'onsen', name: '温泉町', description: '谷の通り道と湯の周辺に、旅館街と集落が育ちます。' },
]
const facilityNames: Record<FacilityKind, string> = { shrine: '八幡神社', school: '第一小学校', hospital: '市民病院', police: '中央交番', shop: '中央商店街', park: 'ふれあい公園', castle: '城跡公園', port: '港・魚市場', onsen: '共同浴場' }
const facilityInception: Record<FacilityKind, number> = { shrine: 1650, school: 1875, hospital: 1920, police: 1880, shop: 1700, park: 1955, castle: 1650, port: 1650, onsen: 1650 }
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

function stationSiteSuitable(point: Point, terrain: ReturnType<typeof createTerrainModel>, areas: Area[]) {
  if (terrain.slope(point) > .14) return false
  return [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: -8, y: 0 }, { x: 0, y: 8 }, { x: 0, y: -8 }].every(offset => {
    const p = { x: point.x + offset.x, y: point.y + offset.y }
    return !terrain.waterAt(p) && terrain.slope(p) < .18 && !areas.some(area => area.kind !== 'field' && pointInRegion(p, area))
  })
}
/** Keep stations on the continuous line, but reserve dry, approachable platform sites. */
function stationSites(points: Point[], count: number, terrain: ReturnType<typeof createTerrainModel>, areas: Area[], target?: Point, access?: StationAccessSurvey, terminal?: Point): Point[] {
  if (!count) return []
  const nominal = Array.from({ length: count }, (_, i) => (i + 1) / (count + 1))
  if (terminal) nominal[count - 1] = 1
  if (target && count) {
    let best = Infinity, fraction = .5
    for (let i = 0; i <= 200; i++) { const t = i / 200, d = distance(pathPointAt(points, t), target); if (d < best) { best = d; fraction = t } }
    let nearest = 0
    for (let i = 1; i < nominal.length; i++) if (Math.abs(nominal[i]! - fraction) < Math.abs(nominal[nearest]! - fraction)) nearest = i
    nominal[nearest] = clamp(fraction, nearest ? nominal[nearest - 1]! + .35 / (count + 1) : .05, nearest + 1 < count ? nominal[nearest + 1]! - .35 / (count + 1) : .95)
  }
  // A coastal terminal is the actual last passenger destination, rather than
  // an arbitrary station followed by unused track into the countryside.
  if (terminal) nominal[count - 1] = 1
  const fractions = [...new Set([...nominal, ...Array.from({ length: 226 }, (_, i) => .05 + i * .004)].map(t => Math.round(t * 1e8) / 1e8))].sort((a, b) => a - b)
  const candidates = fractions.map(t => {
    const point = pathPointAt(points, t)
    let roadDistance = access ? Infinity : 0
    for (const road of access?.roads ?? []) for (let i = 1; i < road.points.length; i++) roadDistance = Math.min(roadDistance, distanceToSegment(point, road.points[i - 1]!, road.points[i]!))
    return { t, point, roadDistance }
  }).filter(({ point, roadDistance }) => {
    // Rail can cross a steep cutting; a station also needs a road approach at
    // ground level. Point-only water checks left stations on 22% valley sides.
    return roadDistance <= 1800 && stationSiteSuitable(point, terrain, areas) && !access?.rejected.some(p => distance(p, point) < 35)
  })
  const gap = .35 / (count + 1), parents: Int32Array[] = []
  let costs = new Float64Array(candidates.length).fill(Infinity)
  for (let station = 0; station < count; station++) {
    const next = new Float64Array(candidates.length).fill(Infinity), parent = new Int32Array(candidates.length).fill(-1)
    let cursor = 0, best = Infinity, bestIndex = -1
    for (let j = 0; j < candidates.length; j++) {
      if (station > 0) while (cursor < j && candidates[j]!.t - candidates[cursor]!.t >= gap) {
        if (costs[cursor]! < best) { best = costs[cursor]!; bestIndex = cursor }
        cursor++
      }
      if (terminal && station === count - 1 && distance(candidates[j]!.point, terminal) > 1e-7) continue
      if (station === 0 || Number.isFinite(best)) {
        // Station spacing is a preference. Acquiring a site close to an old
        // street is preferable to surveying repeated long access/bridge works.
        next[j] = (station === 0 ? 0 : best) + (candidates[j]!.t - nominal[station]!) ** 2 + .03 * (candidates[j]!.roadDistance / 500) ** 2
        parent[j] = bestIndex
      }
    }
    parents.push(parent); costs = next
  }
  let last = -1
  for (let j = 0; j < costs.length; j++) if (last < 0 || costs[j]! < costs[last]!) last = j
  if (last < 0 || !Number.isFinite(costs[last]!)) throw new Error('この地形では指定駅数の陸上用地と間隔を確保できませんでした。駅数を減らすか、シードを変更してください。')
  const selected: Point[] = []
  for (let station = count - 1; station >= 0; station--) { selected.push(candidates[last]!.point); last = parents[station]![last]! }
  selected.reverse()
  if (access) for (const point of selected) if (!stationAccess(point, access)) {
    access.rejected.push(point)
    if (++access.attempts > 24) throw new Error('この地形では既存の街路へ接続できる駅用地を指定数確保できませんでした。駅数を減らすか、シードを変更してください。')
    return stationSites(points, count, terrain, areas, target, access, terminal)
  }
  return selected
}

function spatialIndex<T extends { bounds: Bounds }>(size = 100) {
  const buckets = new Map<string, T[]>()
  const keys = function* (b: Bounds) { for (let x = Math.floor(b.minX / size); x <= Math.floor(b.maxX / size); x++) for (let y = Math.floor(b.minY / size); y <= Math.floor(b.maxY / size); y++) yield `${x},${y}` }
  return {
    add(item: T) { for (const key of keys(item.bounds)) { const bucket = buckets.get(key) ?? []; bucket.push(item); buckets.set(key, bucket) } },
    query(bounds: Bounds) { const found = new Set<T>(); for (const key of keys(bounds)) for (const item of buckets.get(key) ?? []) if (overlaps(bounds, item.bounds)) found.add(item); return found },
  }
}

/** Geographic suitability, transport history, then demand-led street and frontage growth. */
export function generateCity(input: CityConfig, onProgress?: (label: string) => void, onPreview?: (map: CityMap) => void, terrainSource: GenerationTerrainSource = createTerrainModel): CityMap {
  const factor = input.mapSize === 'large' ? 3 : input.mapSize === 'medium' ? 2 : 1, W = 4000 * factor, H = 3000 * factor
  const config: CityConfig = { ...input, facilities: [...input.facilities], density: clamp(input.density, 0, 100), forest: clamp(input.forest, 0, 100), stations: clamp(Math.round(input.stations), 1, 5), era: input.era ?? 'present' }
  if ((config.type === 'port' || config.facilities.includes('port')) && config.terrain === 'plain') config.terrain = 'coast'
  const year = simulationEndYear(config)
  if (input.targetYear !== undefined) config.targetYear = year
  onProgress?.('広域の地形と水系を計算中…')
  let terrain = terrainSource({ width: W, height: H, seed: config.seed, terrain: config.terrain, coastType: config.coastType, relief: config.relief, forest: config.forest, type: config.type, settlement: config.settlement, onTerrainPreview: frame => {
    const extent = (frame.surface.columns - 1) * frame.surface.cellSize
    onProgress?.(frame.cached ? '計算済みの地形を読み込み中…' : frame.iteration ? `侵食・土砂の運搬と堆積 · ${frame.iteration} / ${frame.iterations} 回` : '広域地形の初期標高')
    onPreview?.({ width: extent, height: extent, config, terrainSurface: frame.surface, previewSeaLevel: frame.seaLevel, previewPhase: frame.iteration ? 'erosion' : 'landscape', areas: [], roads: [], buildings: [], stations: [], railways: [], facilities: [], districts: [], description: '広域の標高と陰影', generatorVersion: GENERATOR_VERSION })
  } })
  const naturalTerrain = terrain
  const regionalContext = (() => {
    const world = terrain.hydrology, stride = 3, columns = Math.floor((world.columns - 1) / stride) + 1, elevations: number[] = []
    for (let y = 0; y < world.rows; y += stride) for (let x = 0; x < world.columns; x += stride) elevations.push(world.rawDEM[y * world.columns + x]!)
    const { worldAnchor, localAnchor, angle, mirrored } = world.frame, mirror = mirrored ? -1 : 1, c = Math.cos(angle), s = Math.sin(angle)
    const crop = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }].map(p => {
      const dx = (p.x - localAnchor.x) * mirror, dy = p.y - localAnchor.y
      return { x: worldAnchor.x + c * dx - s * dy, y: worldAnchor.y + s * dx + c * dy }
    })
    return { surface: { columns, rows: columns, cellSize: world.resolution * stride, elevations }, extent: world.extent, crop }
  })()
  onPreview?.({ width: regionalContext.extent, height: regionalContext.extent, config, terrainSurface: regionalContext.surface, previewCrop: regionalContext.crop, previewPhase: 'erosion', areas: [], roads: [], buildings: [], stations: [], railways: [], facilities: [], districts: [], description: '生成区域と広域地形', generatorVersion: GENERATOR_VERSION })
  let sampledSurface: { model: typeof terrain; surface: NonNullable<CityMap['terrainSurface']> } | undefined
  const surface = () => {
    if (sampledSurface?.model === terrain) return sampledSurface.surface
    const cellSize = 25, columns = W / cellSize + 1, rows = H / cellSize + 1, elevations: number[] = []
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) elevations.push(Math.round(terrain.elevation({ x: x * cellSize, y: y * cellSize }) * 100) / 100)
    const surface = { columns, rows, cellSize, elevations }
    sampledSurface = { model: terrain, surface }
    return surface
  }
  const origin = terrain.cityOrigin, areas: Area[] = terrain.areas.map(area => ({ ...area })), facilities: Facility[] = [], buildings: Building[] = []
  const preview = (roads: CityMap['roads'] = [], railways: CityMap['railways'] = [], stations: CityMap['stations'] = [], houses: Building[] = buildings, previewPhase: CityMap['previewPhase'] = 'hydrology', asOf = year) => onPreview?.({ width: W, height: H, config, buildings: houses, roads, areas, railways, stations, facilities, districts: [], description: '生成途中', generatorVersion: GENERATOR_VERSION, year: asOf, previewPhase, terrainSurface: surface(), regionalContext })
  preview()
  for (const area of areas) if (area.id === 'river') area.name = `${config.name.replace(/[市町村]$/, '')}川`
  const hasCore = config.type === 'castle' || config.type === 'temple'
  const castle = config.type === 'castle' ? castleLayout(origin, config.seed, terrain.channelAt(origin)?.tangent) : null
  const core: Point[] | null = castle?.core ?? (hasCore ? rectangle(origin.x - 170, origin.y - 155, 340, 310) : null)
  if (core) {
    const kind = config.type === 'castle' ? 'castle' : 'shrine', selected = config.facilities.includes(kind)
    const name = kind === 'castle' ? `${config.name.replace(/[市町村]$/, '')}城跡` : '水明大社'
    areas.push({ id: 'historic-core', polygon: core, kind: 'park', name: selected ? name : undefined })
    if (selected) facilities.push({ id: 'origin', point: castle?.point ?? origin, kind, name })
    if (kind === 'castle') {
      areas.push(...castle!.areas)
      if (selected) buildings.push(...castle!.structures)
    }
  }

  const railways: CityMap['railways'] = [], stations: CityMap['stations'] = []
  const stationAccessProjects: { station: Point; route: PlannedRoute }[] = []
  const configureRailway = (inherited: Pick<UrbanGrowthResult, 'roads' | 'centers'>) => {
    onProgress?.('1895年までの集落・街道から鉄道の経路を計算中…')
    const historic = inherited.centers.filter(center => center.activeYear < 1900 && inherited.roads.some(road => road.points.some(p => distance(p, center.point) < 240)))
    const demand = scenarioDemandAtYear(config, 1900), totalWeight = historic.reduce((sum, center) => sum + center.weight, 0)
    const hubs = historic.map(center => ({ point: center.point, demand: (demand.households + demand.jobs * (config.type === 'port' ? 2 : .6)) * center.weight / Math.max(.1, totalWeight), reason: config.type === 'port' ? '既存港と地域鉄道を結ぶ旅客・荷役輸送' : '旧街道沿いの市場集落への鉄道接続' }))
    const railTerrain = { ...terrain, areas }
    const railwayPlan = planRailway({ width: W, height: H, seed: config.seed, origin, terrain: railTerrain, core, settlements: hubs, inheritedRoads: inherited.roads, allowTerminus: config.terrain === 'coast' || config.type === 'port' })
    if (!railwayPlan) throw new Error('この地形では鉄道の勾配・曲率条件を満たす経路を確保できませんでした。鉄道を外すか、シードを変更してください。')
    onProgress?.('駅用地と既存街路への接続を確認中…')
    const points = railwayPlan.points
    const stationSurvey: StationAccessSurvey = { roads: inherited.roads, planner: new RoadPlanner({ width: W, height: H, areas, core, terrain }), routes: new Map(), rejected: [], attempts: 0 }
    const base = config.name.replace(/[市町村]$/, '')
    railways.push({ id: 'railway-main', name: `${base}線`, points, elevations: railwayPlan.elevations, structures: railwayPlan.structures, builtYear: 1900 })
    stationSurvey.planner.setRailwayCorridors(railways)
    const branchStations: Point[] = []
    // A 4x3km neighbourhood is ordinarily a window on one regional line. Feeder
    // network projects need a wider set of separated towns, not short city spurs.
    if (config.stations > 1 && factor > 1) {
      onProgress?.('鉄道以前の集落と支線の需要を確認中…')
      const mainStationOptions = Array.from({ length: Math.min(2, config.stations - 1) + 1 }, (_, branches) => stationSites(points, config.stations - branches, terrain, areas, railwayPlan.stationTargets?.[0], stationSurvey, railwayPlan.terminus))
      const branches = planRailwayBranches({ width: W, height: H, main: railwayPlan, terrain: railTerrain, core, inheritedRoads: inherited.roads, hubs, maxBranches: Math.min(2, config.stations - 1), mainStationOptions })
      for (const branch of branches) {
        // Reserve a passenger site toward the actual demand hub, not halfway
        // along a rural feeder. If no dry station fits, that project is omitted.
        const station = branch.points.at(-1)!
        const id = `railway-branch-${branchStations.length}`
        stationSurvey.planner.setRailwayCorridors([...railways, { id, points: branch.points, builtYear: 1900 }])
        stationSurvey.routes.clear()
        if (!stationSiteSuitable(station, terrain, areas) || !stationAccess(station, stationSurvey)) { stationSurvey.planner.setRailwayCorridors(railways); stationSurvey.routes.clear(); continue }
        railways.push({ id, name: config.type === 'port' ? `${base}臨港線` : `${base}市街線${branchStations.length ? '支線' : ''}`, points: branch.points, elevations: branch.elevations, structures: branch.structures, builtYear: 1900, junction: { parentId: 'railway-main', point: points[branch.parentIndex]! } })
        branchStations.push(station)
      }
    }
    const mainCount = config.stations - branchStations.length
    const mainSites = stationSites(points, mainCount, terrain, areas, railwayPlan.stationTargets?.[0], stationSurvey, railwayPlan.terminus)
    const centerStation = railwayPlan.terminus ? mainCount - 1 : Math.floor(mainCount / 2), centralPoint = mainSites[centerStation]!
    for (const [i, point] of mainSites.entries()) {
      const dx = point.x - centralPoint.x, dy = point.y - centralPoint.y, direction = Math.abs(dx) > Math.abs(dy) ? dx < 0 ? '西' : '東' : dy < 0 ? '北' : '南'
      const name = i === centerStation ? `${base}駅` : `${direction}${base}${mainCount > 3 && i > 0 && i < mainCount - 1 ? '本町' : ''}駅`
      stations.push({ id: `station-${i}`, name, point })
    }
    for (const [i, point] of branchStations.entries()) stations.push({ id: `station-${mainCount + i}`, name: `${base}${config.type === 'port' ? '港' : i ? '本町' : '中央'}駅`, point })
    for (const station of stations) { const route = stationAccess(station.point, stationSurvey); if (route) stationAccessProjects.push({ station: station.point, route }) }
    preview(inherited.roads, railways, stations, buildings, 'railway')
    return { stationPoints: stations.map(s => s.point), stationAccessProjects, railwayCorridors: railways }
  }
  const growth = simulateUrbanGrowth({ ...config, width: W, height: H, seed: config.seed, type: config.type, center: origin, core, areas, arterial: config.arterial, railway: config.railway && year >= 1900, stationPoints: [], onRailwayPlanning: config.railway && year >= 1900 ? configureRailway : undefined, terrainModel: terrain, bridgeSites: terrain.bridgeSites, untilYear: year, era: config.era, density: config.density, onProgress: year => onProgress?.(`街路・土地利用を計算 · ${year}年`), onPreview: (roads, asOf) => preview(roads, railways, stations, buildings, 'roads', asOf) })
  const roads: Road[] = growth.roads
  preview(roads, railways, stations, buildings, 'roads')
  const nearestRoad = (point: Point, asOf: number = year) => {
    let best: { road: Road; point: Point; segment: number; distance: number } | null = null
    for (const road of roads) if (!road.bridge && !road.controlledAccess && road.role !== 'expressway' && road.role !== 'ramp' && road.role !== 'farm' && (road.builtYear ?? 1650) <= asOf) for (let i = 1; i < road.points.length; i++) {
      const p = projectPoint(point, road.points[i - 1]!, road.points[i]!), d = distance(p, point)
      if (!best || d < best.distance) best = { road, point: p, segment: i, distance: d }
    }
    return best
  }
  const insertConnectedRoad = (road: Road) => {
    const points: Point[] = [road.points[0]!]
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!, dx = b.x - a.x, dy = b.y - a.y
      const junctions: { point: Point; t: number }[] = []
      for (const existing of roads) if (!existing.controlledAccess && existing.role !== 'expressway' && existing.role !== 'ramp' && (existing.level ?? 0) === (road.level ?? 0)) for (let j = 1; j < existing.points.length; j++) {
        const c = existing.points[j - 1]!, d = existing.points[j]!
        if (!segmentsCross(a, b, c, d)) continue
        const ex = d.x - c.x, ey = d.y - c.y, denominator = dx * ey - dy * ex
        const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / denominator
        const point = { x: a.x + dx * t, y: a.y + dy * t }
        junctions.push({ point, t })
        existing.points.splice(j, 0, point); j++
      }
      junctions.sort((a, b) => a.t - b.t)
      for (const junction of junctions) if (distance(points.at(-1)!, junction.point) > 1e-7) points.push(junction.point)
      if (distance(points.at(-1)!, b) > 1e-7) points.push(b)
    }
    roads.push({ ...road, points })
  }
  // The 1900 railway and inherited street growth see the NATURAL coast. Only
  // afterwards can a 1920 project reclaim land; its reserved ground is dated
  // below, so old houses can exist on the dry portion until acquisition.
  let harbor: HarborPlatform | null = null
  let preHarborWoodland: PolygonRegion[] = []
  const harborProposal = applyHarborTerrain(terrain, { width: W, height: H, seed: config.seed, originClearance: core ? 280 : 90, enabled: year >= 1920 && config.terrain === 'coast' && config.facilities.includes('port') })
  if (harborProposal.harbor) {
    const site = harborProposal.harbor, access = nearestRoad(site.landwardAccess, 1920)
    const proposedAreas = [...harborProposal.terrain.areas, ...areas.filter(a => a.id === 'historic-core' || a.id.startsWith('moat-'))]
    const planner = new RoadPlanner({ width: W, height: H, areas: proposedAreas, core, terrain: harborProposal.terrain })
    const quayCenter = { x: (site.quay[0].x + site.quay[1].x) / 2 - site.outward.x * 8, y: (site.quay[0].y + site.quay[1].y) / 2 - site.outward.y * 8 }
    const quayEnds = site.quay.map((p, i) => ({ x: p.x - site.outward.x * 8 + site.tangent.x * (i ? -8 : 8), y: p.y - site.outward.y * 8 + site.tangent.y * (i ? -8 : 8) }))
    const preferred = access && access.distance < 1500 ? planner.plan(access.point, site.landwardAccess, { role: 'collector', width: 6, allowBridge: false, endHeading: Math.atan2(site.outward.y, site.outward.x), maxNodes: 12000 }) : null
    const approach = preferred ?? (access && access.distance < 1500 ? planner.plan(access.point, site.landwardAccess, { role: 'access', width: 6, allowBridge: false, maxNodes: 12000 }) : null)
    const entryHeading = approach ? Math.atan2(approach.points.at(-1)!.y - approach.points.at(-2)!.y, approach.points.at(-1)!.x - approach.points.at(-2)!.x) : 0
    const spine = preferred ? [site.landwardAccess, quayCenter] : approach ? planner.plan(site.landwardAccess, quayCenter, { role: 'access', width: 6, allowBridge: false, startHeading: entryHeading, endHeading: Math.atan2(site.outward.y, site.outward.x), maxNodes: 12000 })?.points : null
    const quay = [quayEnds[0]!, quayCenter, quayEnds[1]!]
    if (access && approach && spine && planner.validate(spine, 6) && planner.validate(quay, 6)) {
      preHarborWoodland = areas.filter(a => a.kind === 'forest').flatMap(area => intersectRegions(area, { polygon: site.platform }))
      harbor = site; terrain = harborProposal.terrain
      areas.splice(0, areas.length, ...proposedAreas)
      if (!access.road.points.some(p => distance(p, access.point) < 1e-7)) access.road.points.splice(access.segment, 0, access.point)
      insertConnectedRoad({ id: 'harbor-approach', points: approach.points, kind: 'local', width: 6, role: preferred ? 'collector' : 'access', builtYear: 1920, reason: '既存街路に接続する港湾造成事業の進入路' })
      insertConnectedRoad({ id: 'harbor-spine', points: spine, kind: 'local', width: 6, role: 'access', builtYear: 1920, reason: '港の荷捌き場と岸壁を結ぶ構内道路' })
      insertConnectedRoad({ id: 'harbor-quay', points: quay, kind: 'local', width: 6, role: 'collector', builtYear: 1920, reason: '直線岸壁の陸側に確保した荷役道路' })
    }
  }
  const blocks = extractStreetBlocks(roads).map(polygon => {
    let hash = 2166136261
    for (const p of polygon) for (const n of [Math.round(p.x * 10), Math.round(p.y * 10)]) hash = Math.imul(hash ^ n, 16777619)
    return { id: `block-${hash >>> 0}`, polygon }
  })

  type Segment = { a: Point; b: Point; pad: number; bounds: Bounds; year: number }
  const transport = spatialIndex<Segment>()
  for (const road of [...roads.map(r => ({ ...r, street: true })), ...railways.map(r => ({ ...r, width: 15, street: false }))]) for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1]!, b = road.points[i]!, pad = road.width / 2 + 2
    const bounds = boundsOf([a, b]); bounds.minX -= pad; bounds.maxX += pad; bounds.minY -= pad; bounds.maxY += pad
    transport.add({ a, b, pad, bounds, year: road.street ? ('builtYear' in road && typeof road.builtYear === 'number' ? road.builtYear : 1650) : 1900 })
  }
  const obstacle = (area: Area, year = 0) => ({ polygon: area.polygon, holes: area.holes, bounds: boundsOf(area.polygon), year })
  const obstacles = areas.filter(a => a.kind !== 'field').map(a => obstacle(a))
  const footprints = spatialIndex<{ building: Building; bounds: Bounds }>()
  const reserves: { polygon: Point[]; bounds: Bounds; year: number }[] = []
  const canBuild = (polygon: Point[], checkReserve = true, asOf: number = year) => {
    const bounds = boundsOf(polygon)
    if (harbor && asOf < harbor.constructionYear && harbor.reclaimedRegions.some(region => polygonOverlapsRegion(polygon, region))) return false
    if (harbor && asOf < harbor.constructionYear && preHarborWoodland.some(region => polygonOverlapsRegion(polygon, region))) return false
    if (bounds.minX < 18 || bounds.maxX > W - 18 || bounds.minY < 18 || bounds.maxY > H - 18 || (checkReserve && reserves.some(b => b.year <= asOf && overlaps(b.bounds, bounds) && polygonsOverlap(polygon, b.polygon)))) return false
    if (obstacles.some(o => o.year <= asOf && overlaps(bounds, o.bounds) && polygonOverlapsRegion(polygon, o))) return false
    for (const record of footprints.query(bounds)) if ((record.building.builtYear ?? 1700) <= asOf && polygonsOverlap(polygon, record.building.polygon)) return false
    for (const s of transport.query(bounds)) if (s.year <= asOf && (pointInPolygon(s.a, polygon) || pointInPolygon(s.b, polygon) || polygon.some((p, i) => segmentsCross(p, polygon[(i + 1) % polygon.length]!, s.a, s.b) || distanceToSegment(p, s.a, s.b) < s.pad || distanceToSegment(s.a, p, polygon[(i + 1) % polygon.length]!) < s.pad || distanceToSegment(s.b, p, polygon[(i + 1) % polygon.length]!) < s.pad))) return false
    return true
  }
  const addBuilding = (building: Building, checkReserve = true) => {
    building.polygon = building.polygon.map(p => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }))
    if (!canBuild(building.polygon, checkReserve)) return false
    buildings.push(building); footprints.add({ building, bounds: boundsOf(building.polygon) }); return true
  }

  const candidates: Point[] = []
  for (let y = 110; y < H - 110; y += 65) for (let x = 110; x < W - 110; x += 65) candidates.push({ x, y })
  if (harbor) {
    const site = harbor, frontage = distance(site.quay[0], site.quay[1])
    const point = { x: (site.quay[0].x + site.quay[1].x) / 2 - site.outward.x * 40, y: (site.quay[0].y + site.quay[1].y) / 2 - site.outward.y * 40 }
    const yard: Area = { id: 'harbor-yard', kind: 'field', landUse: 'vacant', polygon: site.platform, name: '港湾荷捌き場' }
    areas.push(yard)
    reserves.push({ polygon: site.platform, bounds: boundsOf(site.platform), year: 1920 })
    facilities.push({ id: 'facility-port', point, name: facilityNames.port, kind: 'port' })
    for (const [i, side] of [-1, 1].entries()) for (const width of [60, 48, 40]) {
      const along = side * (frontage / 2 - width / 2 - 10), depth = width > 50 ? 30 : 26
      const center = { x: site.landwardAccess.x + site.tangent.x * along + site.outward.x * 75, y: site.landwardAccess.y + site.tangent.y * along + site.outward.y * 75 }
      const polygon = rectangle(-width / 2, -depth / 2, width, depth).map(p => ({ x: center.x + site.tangent.x * p.x + site.outward.x * p.y, y: center.y + site.tangent.y * p.x + site.outward.y * p.y }))
      if (polygon.every(p => pointInRegion(p, yard)) && addBuilding({ id: `harbor-warehouse-${i}`, polygon, kind: 'industrial', height: 1, builtYear: 1920 }, false)) break
    }
  }
  const available = candidates.filter(p => terrain.slope(p) < .18 && canBuild(rectangle(p.x - 32, p.y - 32, 64, 64), false)).map(point => ({ point, access: nearestRoad(point) })).filter(c => c.access && c.access.distance < 120 && c.access.distance > 36)
  const facilityPlanner = new RoadPlanner({ width: W, height: H, areas, core, terrain })
  const facilityLot = (kind: FacilityKind, point: Point, access: NonNullable<ReturnType<typeof nearestRoad>>) => {
    const width = kind === 'school' || kind === 'port' ? 108 : kind === 'hospital' ? 88 : kind === 'police' ? 46 : 74
    const depth = kind === 'school' ? 88 : kind === 'port' ? 80 : kind === 'hospital' ? 70 : kind === 'police' ? 48 : 68
    const nx = (point.x - access.point.x) / access.distance, ny = (point.y - access.point.y) / access.distance
    const tr = (x: number, y: number) => ({ x: point.x + ny * x + nx * y, y: point.y - nx * x + ny * y })
    const rect = (x: number, y: number, w: number, h: number) => rectangle(x, y, w, h).map(p => tr(p.x, p.y))
    const building = kind === 'school' ? [{ x: -40, y: -24 }, { x: 40, y: -24 }, { x: 40, y: -5 }, { x: 0, y: -5 }, { x: 0, y: 19 }, { x: -40, y: 19 }].map(p => tr(p.x, p.y)) : kind === 'port' ? rect(-40, -22, 80, 44) : kind === 'hospital' ? rect(-32, -23, 64, 46) : kind === 'police' ? rect(-13, -11, 26, 22) : rect(-22, -17, 44, 34)
    return { campus: rect(-width / 2, -depth / 2, width, depth), building, entrance: tr(0, -depth / 2 + 3), schoolYard: rect(4, 4, 44, 32) }
  }
  for (const [index, kind] of [...new Set(config.facilities)].filter(kind => kind !== 'shop' && facilityInception[kind] <= year && !facilities.some(f => f.kind === kind)).entries()) {
    const target = kind === 'port' ? { x: origin.x + 240, y: origin.y } : kind === 'shop' && stations.length ? stations[Math.floor(stations.length / 2)]!.point : { x: origin.x + Math.cos(index * 2.4) * 520, y: origin.y + Math.sin(index * 2.4) * 460 }
    const sites = kind === 'port' ? candidates.filter(p => terrain.slope(p) < .18 && canBuild(rectangle(p.x - 32, p.y - 32, 64, 64), false)).map(point => ({ point, access: nearestRoad(point) })).filter(c => c.access && c.access.distance > 36 && c.access.distance < 1600) : available
    const ranked = sites.filter(c => facilities.every(f => distance(f.point, c.point) > 155)).filter(c => {
      const p = c.point
      if (kind !== 'port' || config.terrain === 'plain') return true
      let bank = Infinity
      for (const water of areas.filter(a => a.id === 'river' || a.id === 'sea')) for (let i = 0; i < water.polygon.length; i++) bank = Math.min(bank, distanceToSegment(p, water.polygon[i]!, water.polygon[(i + 1) % water.polygon.length]!))
      return bank > 35 && bank < 175
    }).filter(c => {
      if (!c.access) return false
      const campus = facilityLot(kind, c.point, c.access).campus
      if (kind === 'school' || kind === 'hospital' || kind === 'police') {
        const samples = [...campus, ...campus.map((p, i) => ({ x: (p.x + campus[(i + 1) % campus.length]!.x) / 2, y: (p.y + campus[(i + 1) % campus.length]!.y) / 2 })), c.point], levels = samples.map(p => naturalTerrain.elevation(p))
        if (Math.max(...levels) - Math.min(...levels) > 3 || samples.some(p => naturalTerrain.slope(p) > .08 || naturalTerrain.wetness(p) > .52 || (() => { const channel = naturalTerrain.channelAt(p); return channel !== null && channel.bankDistance < 90 && naturalTerrain.elevation(p) - channel.surfaceElevation < 3 })())) return false
      }
      return canBuild(campus, false) && (!harbor || !polygonsOverlap(campus, harbor.platform))
    }).sort((a, b) => distance(a.point, target) - distance(b.point, target))
    let accessPath: Point[] | null = null
    const chosen = ranked.slice(0, 24).find(c => {
      if (!c.access) return false
      const entrance = facilityLot(kind, c.point, c.access).entrance
      const route = facilityPlanner.plan(c.access.point, entrance, { role: 'access', width: 3.5, maxNodes: 6000 })
      if (!route) return false
      accessPath = route.points
      return true
    }); if (!chosen || !chosen.access) continue
    const { point } = chosen
    // Earlier facility junctions subdivide this route; cached segment indices are stale.
    const access = nearestRoad(point)!
    const lot = facilityLot(kind, point, access)
    const driveway: Road = { id: `facility-access-${kind}`, points: accessPath!, kind: 'local', width: 3.5, role: 'access', builtYear: Math.max(facilityInception[kind], access.road.builtYear ?? 1700), reason: '公共施設用地の接道' }
    if (!access.road.points.some(p => distance(p, access.point) < 1e-7)) access.road.points.splice(access.segment, 0, access.point)
    roads.push(driveway)
    for (let i = 1; i < driveway.points.length; i++) {
      const a = driveway.points[i - 1]!, b = driveway.points[i]!, drivewayBounds = boundsOf([a, b]), pad = 3
      transport.add({ a, b, pad, bounds: { minX: drivewayBounds.minX - pad, minY: drivewayBounds.minY - pad, maxX: drivewayBounds.maxX + pad, maxY: drivewayBounds.maxY + pad }, year: driveway.builtYear! })
    }
    const name = kind === 'school' ? `${config.name.replace(/[市町村]$/, '')}第一小学校` : facilityNames[kind]
    facilities.push({ id: `facility-${kind}`, point, name, kind })
    reserves.push({ polygon: lot.campus, bounds: boundsOf(lot.campus), year: driveway.builtYear! })
    if (kind === 'shrine' || kind === 'park') {
      const area: Area = { id: `facility-lot-${kind}`, kind: 'park', polygon: lot.campus, name: kind === 'park' ? name : undefined }
      areas.push(area); obstacles.push(obstacle(area, driveway.builtYear))
    } else {
      addBuilding({ id: `facility-building-${kind}`, polygon: lot.building, kind: kind === 'port' ? 'industrial' : kind === 'shop' ? 'commercial' : 'public', height: kind === 'hospital' ? 5 : kind === 'school' ? 3 : 2, builtYear: driveway.builtYear }, false)
      if (kind === 'school') { const yard: Area = { id: 'school-yard', kind: 'park', polygon: lot.schoolYard }; areas.push(yard); obstacles.push(obstacle(yard, driveway.builtYear)) }
    }
  }

  if (config.facilities.includes('park') && year >= 1955) {
    // Neighbourhood parks serve the population already supported by the street
    // simulation. Reserving them before parcel development makes the actual
    // acquired ground unavailable for later houses, rather than painting green
    // over buildings or placing parks in unserved countryside.
    const demand = scenarioDemandAtYear(config, year), wanted = Math.min(12, Math.floor(demand.households / 900))
    const population = growth.developmentCells.filter(cell => cell.households > 0)
    for (let serial = 0; serial < wanted; serial++) {
      const parks = facilities.filter(f => f.kind === 'park')
      const sites = available.filter(site => site.access && parks.every(park => distance(park.point, site.point) > 430) && terrain.slope(site.point) < .08).map(site => ({ ...site, served: population.reduce((sum, cell) => distance(cell.point, site.point) < 320 ? sum + cell.households : sum, 0) })).filter(site => site.served >= 45).sort((a, b) => b.served - a.served || distance(a.point, origin) - distance(b.point, origin))
      let adopted = false
      for (const site of sites.slice(0, 24)) {
        const access = nearestRoad(site.point)
        if (!access || access.distance < 30) continue
        const dx = (site.point.x - access.point.x) / access.distance, dy = (site.point.y - access.point.y) / access.distance
        const tr = (x: number, y: number) => ({ x: site.point.x + dy * x + dx * y, y: site.point.y - dx * x + dy * y })
        const campus = rectangle(-24, -21, 48, 42).map(p => tr(p.x, p.y))
        if (!canBuild(campus, false) || reserves.some(r => polygonsOverlap(campus, r.polygon))) continue
        const planner = new RoadPlanner({ width: W, height: H, areas, core, terrain }), route = planner.plan(access.point, tr(0, -19), { role: 'access', width: 3, maxNodes: 4000 })
        if (!route) continue
        const id = `neighbourhood-park-${serial}`, name = `${['さくら', 'みどり', 'あけぼの', 'けやき', 'ひだまり', 'つばき'][serial % 6]}${serial >= 6 ? '第二' : ''}公園`
        if (!access.road.points.some(p => distance(p, access.point) < 1e-7)) access.road.points.splice(access.segment, 0, access.point)
        const driveway: Road = { id: `${id}-access`, points: route.points, kind: 'local', width: 3, role: 'access', builtYear: Math.max(1955, access.road.builtYear ?? 1700), reason: '住宅地の徒歩圏に設ける街区公園への接道' }
        roads.push(driveway)
        for (let i = 1; i < driveway.points.length; i++) { const a = driveway.points[i - 1]!, b = driveway.points[i]!, bounds = boundsOf([a, b]); transport.add({ a, b, pad: 2.5, bounds: { minX: bounds.minX - 2.5, maxX: bounds.maxX + 2.5, minY: bounds.minY - 2.5, maxY: bounds.maxY + 2.5 }, year: driveway.builtYear! }) }
        const area: Area = { id, kind: 'park', polygon: campus, name }; areas.push(area); obstacles.push(obstacle(area, driveway.builtYear)); reserves.push({ polygon: campus, bounds: boundsOf(campus), year: driveway.builtYear! }); facilities.push({ id, name, kind: 'park', point: site.point }); adopted = true; break
      }
      if (!adopted) break
    }
  }
  onProgress?.('敷地と住宅・建替えを計算中…')
  const development = developLand({ config, roads, center: origin, thermalCenter: facilities.find(f => f.kind === 'onsen')?.point, stations, centers: growth.centers,
    canPlace: (polygon, asOf) => canBuild(polygon, true, asOf), slope: naturalTerrain.slope, elevation: naturalTerrain.elevation })
  for (const building of development.buildings) {
    buildings.push(building)
    footprints.add({ building, bounds: boundsOf(building.polygon) })
  }
  if (config.facilities.includes('shop') && year >= facilityInception.shop) {
    // A shopping street is a connected series of actual street-front shops,
    // never a standalone rectangular building with a "shopping street" label.
    const parcelRoads = new Map(development.parcels.map(p => [p.id, p.roadId]))
    const shops = buildings.filter(b => b.kind === 'commercial' && b.use !== 'lodging' && b.parcelId)
    let best: { point: Point; count: number } | undefined
    for (const road of roads.filter(r => !r.bridge && !r.controlledAccess && r.role !== 'expressway' && r.role !== 'ramp' && r.role !== 'farm')) {
      const frontage = shops.filter(b => parcelRoads.get(b.parcelId!) === road.id).map(b => ({ x: b.polygon.reduce((sum, p) => sum + p.x, 0) / b.polygon.length, y: b.polygon.reduce((sum, p) => sum + p.y, 0) / b.polygon.length }))
      for (const p of frontage) {
        const cluster = frontage.filter(q => distance(p, q) < 160)
        if (cluster.length >= 3 && (!best || cluster.length > best.count)) {
          let nearest = p, separation = Infinity
          for (let i = 1; i < road.points.length; i++) { const q = projectPoint(p, road.points[i - 1]!, road.points[i]!), d = distance(p, q); if (d < separation) { nearest = q; separation = d } }
          best = { point: nearest, count: cluster.length }
        }
      }
    }
    if (best) facilities.push({ id: 'facility-shop', point: best.point, kind: 'shop', name: facilityNames.shop })
  }
  preview(roads, railways, stations, buildings, 'development')

  // Lowland agriculture predates the town. A coherent irrigation/ownership layout
  // is generated independently of current buildings; later transport and development
  // convert only the actual acquired ground; the remainder retains its land use.
  onProgress?.('耕地の転用と地図の仕上げ…')
  type LandMask = PolygonRegion & { bounds: Bounds }
  const occupied = spatialIndex<LandMask>(), convertedLand = spatialIndex<LandMask>(), agriculturalAcquisitions = spatialIndex<LandMask>(), naturalAgriculturalLimits = spatialIndex<LandMask>()
  const addOccupied = (region: PolygonRegion, acquired = true) => { const record = { ...region, bounds: boundsOf(region.polygon) }; occupied.add(record); convertedLand.add(record); if (acquired) agriculturalAcquisitions.add(record); else naturalAgriculturalLimits.add(record) }
  for (const area of areas) addOccupied(area, area.kind !== 'water' && area.kind !== 'forest')
  for (const p of development.parcels) {
    if (p.developedYear) addOccupied(p)
    else { const record = { polygon: p.polygon, bounds: boundsOf(p.polygon) }; convertedLand.add(record); agriculturalAcquisitions.add(record) }
  }
  for (const reserve of reserves) addOccupied(reserve)
  for (const b of buildings) if (!b.parcelId) addOccupied(b)
  for (const route of [...roads, ...railways.map(r => ({ ...r, width: 15 }))]) for (let i = 1; i < route.points.length; i++) {
    if (distance(route.points[i - 1]!, route.points[i]!) < .01) continue
    const polygon = corridorPolygon(route.points[i - 1]!, route.points[i]!, route.width / 2 + 1)
    addOccupied({ polygon })
  }
  const mapBoundary = { polygon: rectangle(0, 0, W, H) }
  const densityAt = settlementDensity(development.parcels)
  const settled = contourNaturalLand(W, H, p => densityAt(p) - .13, 24).flatMap(region => intersectRegions(region, mapBoundary))
  const bankDistance = terrain.bankDistance ?? ((p: Point) => Math.min(...terrain.rivers.flatMap(r => r.points.slice(1).map((b, i) => Math.max(0, distanceToSegment(p, r.points[i]!, b) - (r.widths[i] ?? 10) / 2)))))
  const wetlands = contourNaturalLand(W, H, p => Math.min(.085 - terrain.slope(p), terrain.wetness(p) - .58, (60 - bankDistance(p)) / 100)).flatMap(region => intersectRegions(region, mapBoundary))
  for (const region of settled) convertedLand.add({ ...region, bounds: boundsOf(region.polygon) })
  for (const region of wetlands) { const record = { ...region, bounds: boundsOf(region.polygon) }; convertedLand.add(record); naturalAgriculturalLimits.add(record) }
  const inheritedRoads = roads.filter(r => (r.builtYear ?? 1650) <= 1650 && !r.controlledAccess)
  const agriculturalRiver = terrain.rivers.find(r => r.id === 'river') ?? terrain.rivers[0]
  const farmAccess = agriculturalAccessSurvey(roads, terrain, [
    ...areas, ...development.parcels, ...reserves, ...buildings.filter(b => !b.parcelId), ...wetlands,
    ...railways.flatMap(railway => railway.points.slice(1).flatMap((b, i) => distance(railway.points[i]!, b) > .01 ? [{ polygon: corridorPolygon(railway.points[i]!, b, 8.5) }] : [])),
  ])
  for (const { id, polygon, center, landUse } of agriculturalPlots(W, H, config.seed, agriculturalRiver?.points, terrain, inheritedRoads)) {
    if (center.x < 0 || center.x > W || center.y < 0 || center.y > H || !terrain.cultivable(center)) continue
    const bounds = boundsOf(polygon)
    // A natural slope/wetland limit decides whether this surveyed
    // farming unit is viable as a whole. Only actual later acquisitions cut it;
    // a smooth suitability contour must never manufacture an arc-shaped title.
    if (!agriculturalPlotSuitable(polygon, terrain.cultivable, [...naturalAgriculturalLimits.query(bounds)])) continue
    const surveyed = intersectRegions({ polygon }, mapBoundary), originalArea = surveyed.reduce((sum, region) => sum + regionArea(region), 0)
    const clipped = surveyed.flatMap(region => subtractRegions(region, [...agriculturalAcquisitions.query(bounds)]))
    for (const [part, region] of clipped.entries()) if (agriculturalRemnantSuitable(region, originalArea, densityAt(center)) && farmAccess(region)) {
      areas.push({ id: `cultivation-${id}-${part}`, kind: 'field', landUse, ...region })
      const record = { ...region, bounds: boundsOf(region.polygon) }
      convertedLand.add(record); occupied.add(record)
    }
  }
  // Unbuilt land still has a physical cover. Continuous contours follow occupation
  // and wet lowlands; small clipping tiles bound complexity but are never outlined.
  let coverSerial = 0
  const emitCover = (sources: PolygonRegion[], landUse: 'meadow' | 'wetland' | 'vacant', masks: ReturnType<typeof spatialIndex<LandMask>>) => {
    for (const source of sources) {
      const bounds = boundsOf(source.polygon)
      for (let x = Math.max(0, Math.floor(bounds.minX / 400) * 400); x < Math.min(W, bounds.maxX); x += 400) for (let y = Math.max(0, Math.floor(bounds.minY / 400) * 400); y < Math.min(H, bounds.maxY); y += 400) {
        const tile = { polygon: rectangle(x, y, Math.min(400, W - x), Math.min(400, H - y)) }
        for (const piece of intersectRegions(source, tile).flatMap(region => subtractRegions(region, [...masks.query(boundsOf(region.polygon))]))) if (regionArea(piece) >= 20) areas.push({ id: `land-${landUse}-${coverSerial++}`, kind: 'field', landUse, ...piece })
      }
    }
  }
  emitCover(settled, 'vacant', occupied)
  for (const region of settled) occupied.add({ ...region, bounds: boundsOf(region.polygon) })
  emitCover(wetlands, 'wetland', occupied)
  for (const region of wetlands) occupied.add({ ...region, bounds: boundsOf(region.polygon) })
  for (const parcel of development.parcels.filter(p => !p.developedYear)) emitCover([parcel], 'vacant', occupied)
  emitCover([mapBoundary], 'meadow', convertedLand)
  const names = ['本町', '新町', '桜町', '西町', '東町', '緑ヶ丘', '南台']
  const districts: CityMap['districts'] = growth.centers.filter(c => c.kind !== 'industrial').map((center, i) => ({ id: `district-${i}`, point: { x: clamp(center.point.x + 180, 140, W - 140), y: clamp(center.point.y + 150, 160, H - 160) }, name: `${names[i % names.length]}${i > 6 ? Math.floor(i / 7) + 1 : ''}` }))
  return { width: W, height: H, config, buildings, roads, areas, railways, stations, facilities, districts, description: CITY_PRESETS.find(p => p.id === config.type)!.description, growthLog: growth.growthLog, generatorVersion: GENERATOR_VERSION, year, terrainSurface: surface(), regionalContext,
    unplacedFacilities: config.facilities.filter(kind => facilityInception[kind] <= year && !facilities.some(facility => facility.kind === kind)).map(kind => ({ kind, reason: kind === 'shop' ? '商店街を構成する連続した商業敷地が成立していません。' : '水域・地盤・接道の条件を満たす用地を確保できませんでした。' })),
    terrainSimulation: { resolution: naturalTerrain.hydrology.resolution, steps: naturalTerrain.hydrology.erosion.iterations, elapsedYears: naturalTerrain.hydrology.erosion.elapsedYears,
      bedrockErodedVolume: naturalTerrain.hydrology.sediment.erodedSourceVolume, storedSedimentVolume: naturalTerrain.hydrology.sediment.storedVolume, exportedSedimentVolume: naturalTerrain.hydrology.sediment.exportedVolume, sedimentBalanceError: naturalTerrain.hydrology.sediment.massBalanceError, groundBalanceError: naturalTerrain.hydrology.erosion.terrainBalanceError,
      localExcavationVolume: naturalTerrain.hydrology.bankSediment?.totalExcavationVolume ?? 0, localDepositionVolume: naturalTerrain.hydrology.bankSediment?.depositedVolume ?? 0, localExportedVolume: naturalTerrain.hydrology.bankSediment?.totalExportedVolume ?? 0, localBalanceError: naturalTerrain.hydrology.bankSediment?.totalMassBalanceError ?? 0 },
    parcels: development.parcels, snapshots: development.snapshots, blocks,
    events: [
      ...roads.map(r => ({ id: `event-${r.id}`, year: r.builtYear ?? 1650, kind: 'road' as const, entityId: r.id, reason: r.reason ?? '初期の広域街道' })),
      ...railways.map(r => ({ id: `event-${r.id}`, year: 1900, kind: 'railway' as const, entityId: r.id, reason: '地域鉄道の開通' })),
      ...development.events,
      ...(harbor ? [{ id: 'event-harbor-reclamation', year: 1920, kind: 'acquisition' as const, entityId: 'harbor-yard', reason: `既存岸へ接続する港湾用地の取得と約${(harbor.reclaimedArea / 10000).toFixed(2)}haの埋立造成` }] : []),
      ...buildings.filter(b => b.id.startsWith('harbor-warehouse')).map(b => ({ id: `event-${b.id}`, year: 1920, kind: 'construction' as const, entityId: b.id, reason: '造成した港湾用地に接道する荷役倉庫の建設' })),
    ] }
}
