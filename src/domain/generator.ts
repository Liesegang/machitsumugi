import type { Area, Building, CityConfig, CityMap, CityType, Facility, FacilityKind, GrowthEvent, Point, Road, TimelineVersion } from './types'
import { createCityTimeline } from './timeline'
import { agriculturalHistory } from './agricultural-history'
import { shoppingStreetHistory } from './commercial-history'
import type { AgriculturalAcquisition, AgriculturalTitle } from './agricultural-history'
import { createTerrainModel } from './terrain'
import { riparianWetlandMargin } from './riparian-wetland'
import { simulateUrbanGrowth } from './urban-growth'
import type { UrbanGrowthResult } from './urban-growth'
import { boundsOf, corridorPolygon, distance, distanceToSegment, intersectRegions, overlaps, pathPointAt, pointInPolygon, pointInRegion, polygonArea, polygonOverlapsRegion, polygonsOverlap, projectPoint, rectangle, regionArea, segmentsCross, subtractRegions } from './geometry'
import type { PolygonRegion } from './geometry'
import type { Bounds } from './geometry'
import { developLand, GENERATOR_VERSION } from './land-development'
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
import { applyHarborTerrain, harborAreaHistory, harborTerrainAt } from './harbor-terrain'
import type { HarborPlatform } from './harbor-terrain'
import { surveyCastleLayout } from './castle-layout'
import { surveyCastleAccess } from './castle-access'
import { buildDistricts } from './districts'
import { civicTransportAcquisitions } from './civic-transport'
import { finalizeCivicRoadHistory } from './rail-access-acquisition'
import { retireCivicPavementReservations } from './civic-access-retention'
import { finalizeActualStockTransport } from './actual-stock-transport'
import { resolveGenerationConfig } from './generation-config'
import type { RegionalPreview } from './regional-terrain'
import { planSubway } from './subway'
import { surveyStationArchitecture } from './station-architecture'
import { surveyUniversityCampus } from './civic-campus'
import type { CampusProposal } from './civic-campus'
import { civicWoodlandHistory } from './civic-woodland'
import type { WoodlandClearing } from './civic-woodland'
import { surveyDevelopmentSite } from './development-terrain'
import { naturalWoodlandContours } from './natural-cover'

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
const facilityNames: Record<FacilityKind, string> = { shrine: '八幡神社', school: '第一小学校', university: '地域大学', hospital: '市民病院', police: '中央交番', shop: '中央商店街', park: 'ふれあい公園', castle: '城跡公園', port: '港・魚市場', onsen: '共同浴場' }
const facilityInception: Record<FacilityKind, number> = { shrine: 1650, school: 1875, university: 1965, hospital: 1920, police: 1880, shop: 1700, park: 1955, castle: 1650, port: 1650, onsen: 1650 }
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
export function terrainGenerationPreview(config: CityConfig, onProgress?: (label: string) => void, onPreview?: (map: CityMap) => void) {
  return (frame: RegionalPreview) => {
    const extent = (frame.surface.columns - 1) * frame.surface.cellSize
    onProgress?.(frame.cached ? '計算済みの地形を読み込み中…' : frame.process === 'marine' ? `沿岸の侵食・土砂移動と堆積 · ${frame.iteration} / ${frame.iterations} 回` : frame.iteration ? `侵食・土砂の運搬と堆積 · ${frame.iteration} / ${frame.iterations} 回` : '広域地形の初期標高')
    onPreview?.({ width: extent, height: extent, config, terrainSurface: frame.surface, previewSeaLevel: frame.seaLevel, previewPhase: frame.iteration ? 'erosion' : 'landscape', areas: [], roads: [], buildings: [], stations: [], railways: [], facilities: [], districts: [], description: '広域の標高と陰影', generatorVersion: GENERATOR_VERSION })
  }
}

export function generateCity(input: CityConfig, onProgress?: (label: string) => void, onPreview?: (map: CityMap) => void, terrainSource: GenerationTerrainSource = createTerrainModel): CityMap {
  const { config, year, width: W, height: H, factor, terrainInput } = resolveGenerationConfig(input)
  onProgress?.('広域の地形と水系を計算中…')
  let terrain = terrainSource({ ...terrainInput, onTerrainPreview: terrainGenerationPreview(config, onProgress, onPreview) })
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
  const surface = (model = terrain) => {
    if (sampledSurface?.model === model) return sampledSurface.surface
    const cellSize = 25, columns = W / cellSize + 1, rows = H / cellSize + 1, elevations: number[] = []
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) elevations.push(Math.round(model.elevation({ x: x * cellSize, y: y * cellSize }) * 100) / 100)
    const surface = { columns, rows, cellSize, elevations }
    sampledSurface = { model, surface }
    return surface
  }
  const origin = terrain.cityOrigin, areas: Area[] = terrain.areas.map(area => ({ ...area })), facilities: Facility[] = [], buildings: Building[] = []
  const preview = (roads: CityMap['roads'] = [], railways: CityMap['railways'] = [], stations: CityMap['stations'] = [], houses: Building[] = buildings, previewPhase: CityMap['previewPhase'] = 'hydrology', asOf = year) => onPreview?.({ width: W, height: H, config, buildings: houses, roads, areas, railways, stations, facilities, districts: [], description: '生成途中', generatorVersion: GENERATOR_VERSION, year: asOf, previewPhase, terrainSurface: surface(), regionalContext })
  preview()
  for (const area of areas) if (area.id === 'river') area.name = `${config.name.replace(/[市町村]$/, '')}川`
  const castle = config.type === 'castle' ? surveyCastleLayout(origin, config.seed, { width: W, height: H, terrain, waterAreas: areas.filter(area => area.kind === 'water'), riverTangent: terrain.channelAt(origin)?.tangent }) : null
  const core: Point[] | null = castle?.core ?? (config.type === 'temple' ? rectangle(origin.x - 170, origin.y - 155, 340, 310) : null)
  if (core) {
    const kind = config.type === 'castle' ? 'castle' : 'shrine', selected = config.facilities.includes(kind)
    const name = kind === 'castle' ? `${config.name.replace(/[市町村]$/, '')}城跡` : '水明大社'
    areas.push({ id: 'historic-core', polygon: core, kind: 'park', name: selected ? name : undefined })
    if (selected) facilities.push({ id: 'origin', point: castle?.point ?? origin, kind, name })
    if (kind === 'shrine' && selected) {
      const polygon = rectangle(origin.x - 24, origin.y - 15, 48, 30)
      const samples = [...polygon, origin, ...polygon.map((p, i) => ({ x: (p.x + polygon[(i + 1) % polygon.length]!.x) / 2, y: (p.y + polygon[(i + 1) % polygon.length]!.y) / 2 }))]
      if (samples.every(p => pointInPolygon(p, core) && !naturalTerrain.waterAt(p) && naturalTerrain.slope(p) < .15 && !naturalTerrain.areas.some(area => area.kind !== 'field' && pointInRegion(p, area)))) buildings.push({ id: 'origin-shrine-building', polygon, kind: 'public', height: 2, builtYear: 1650, name })
    }
    if (kind === 'castle' && castle) {
      areas.push(...castle.areas, ...castle.grounds)
      if (selected) buildings.push(...castle.structures)
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
    const railwayPlan = planRailway({ width: W, height: H, seed: config.seed, origin, terrain: railTerrain, core, settlements: hubs, inheritedRoads: inherited.roads, allowTerminus: config.terrain === 'coast' || config.type === 'port' || config.type === 'onsen' })
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
      stations.push({ id: `station-${i}`, name, point, railwayId: 'railway-main', builtYear: 1900 })
    }
    for (const [i, point] of branchStations.entries()) stations.push({ id: `station-${mainCount + i}`, name: `${base}${config.type === 'port' ? '港' : i ? '本町' : '中央'}駅`, point, railwayId: `railway-branch-${i}`, builtYear: 1900 })
    for (const station of stations) { const route = stationAccess(station.point, stationSurvey); if (route) stationAccessProjects.push({ station: station.point, route }) }
    preview(inherited.roads, railways, stations, buildings, 'railway')
    return { stationPoints: stations.map(s => s.point), stationAccessProjects, railwayCorridors: railways }
  }
  const civicPopulations = new Map<number, { point: Point; households: number }[]>()
  const growth = simulateUrbanGrowth({ ...config, width: W, height: H, seed: config.seed, type: config.type, center: origin, core, areas, arterial: config.arterial, railway: config.railway && year >= 1900, stationPoints: [], onRailwayPlanning: config.railway && year >= 1900 ? configureRailway : undefined, terrainModel: terrain, bridgeSites: terrain.bridgeSites, untilYear: year, era: config.era, density: config.density, onProgress: year => onProgress?.(`街路・土地利用を計算 · ${year}年`), onPreview: (roads, asOf) => preview(roads, railways, stations, buildings, 'roads', asOf), onCivicPopulation: config.facilities.includes('park') ? (asOf, population) => civicPopulations.set(asOf, population) : undefined })
  const roads: Road[] = growth.roads
  onProgress?.('街区と既存道路への接続を整理中…')
  const retiredCivicRoads: TimelineVersion<Road>[] = []
  const growthRoadIds = new Set(growth.roadHistory.map(version => version.value.id))
  const roadsAt = (asOf: number): Road[] => [...growth.roadHistory.filter(version => version.from <= asOf && (version.to === undefined || asOf < version.to)).map(version => version.value), ...retiredCivicRoads.filter(version => version.from <= asOf && asOf < version.to!).map(version => version.value), ...roads.filter(road => !growthRoadIds.has(road.id) && (road.builtYear ?? 1650) <= asOf)]
  const routeVersions = () => [...new Set([...roads, ...growth.roadHistory.map(version => version.value), ...retiredCivicRoads.map(version => version.value)])]
  const ensureRoadJunction = (id: string, point: Point) => {
    for (const road of routeVersions().filter(road => road.id === id)) {
      if (road.points.some(p => distance(p, point) < 1e-7)) continue
      for (let i = 1; i < road.points.length; i++) if (distanceToSegment(point, road.points[i - 1]!, road.points[i]!) < 1e-7) { road.points.splice(i, 0, { ...point }); break }
    }
  }
  preview(roads, railways, stations, buildings, 'roads')
  const nearestRoad = (point: Point, asOf: number = year) => {
    let best: { road: Road; point: Point; segment: number; distance: number } | null = null
    for (const road of roadsAt(asOf)) if (!road.bridge && !road.controlledAccess && road.role !== 'expressway' && road.role !== 'ramp' && road.role !== 'farm') for (let i = 1; i < road.points.length; i++) {
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
      for (const existing of routeVersions()) if (!existing.controlledAccess && existing.role !== 'expressway' && existing.role !== 'ramp' && (existing.level ?? 0) === (road.level ?? 0)) for (let j = 1; j < existing.points.length; j++) {
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
    const connected = { ...road, points }
    roads.push(connected)
    return connected
  }
  if (castle) {
    const approach = surveyCastleAccess({ castle, width: W, height: H, roads: roadsAt(1650), areas, terrain })
    if (approach) {
      ensureRoadJunction(approach.attach.roadId, approach.attach.point)
      insertConnectedRoad(approach.road)
    }
    const interiorPlanner = new RoadPlanner({ width: W, height: H, core: null, areas, terrain: { ...terrain, waterAt: point => terrain.waterAt(point) || castle.areas.some(area => pointInRegion(point, area)) } })
    for (const path of castle.paths) if (interiorPlanner.validate(path.points, path.width)) insertConnectedRoad(path)
  }
  // The 1900 railway and inherited street growth see the NATURAL coast. Only
  // afterwards can a 1920 project reclaim land; its reserved ground is dated
  // below, so old houses can exist on the dry portion until acquisition.
  let harbor: HarborPlatform | null = null
  let preHarborWoodland: (PolygonRegion & { year: number })[] = []
  const preHarborAreas = [...areas], preHarborTerrain = terrain, naturalSurface = surface()
  const harborProposal = applyHarborTerrain(terrain, { width: W, height: H, seed: config.seed, originClearance: core ? 280 : 90, throughYear: year, capitalBudget: 4000 + config.density * (config.type === 'port' ? 180 : 90), enabled: year >= 1920 && config.terrain === 'coast' && config.facilities.includes('port') })
  if (harborProposal.harbor) {
    const site = harborProposal.harbor, access = nearestRoad(site.landwardAccess, 1920)
    const firstTerrain = harborProposal.terrainAt(1920)
    const proposedAreas = [...firstTerrain.areas, ...areas.filter(a => a.id === 'historic-core' || a.id.startsWith('moat-') || a.id.startsWith('castle-'))]
    const planner = new RoadPlanner({ width: W, height: H, areas: proposedAreas, core, terrain: firstTerrain })
    const quayCenter = { x: (site.quay[0].x + site.quay[1].x) / 2 - site.outward.x * 8, y: (site.quay[0].y + site.quay[1].y) / 2 - site.outward.y * 8 }
    const quayEnds = site.quay.map((p, i) => ({ x: p.x - site.outward.x * 8 + site.tangent.x * (i ? -8 : 8), y: p.y - site.outward.y * 8 + site.tangent.y * (i ? -8 : 8) }))
    const preferred = access && access.distance < 1500 ? planner.plan(access.point, site.landwardAccess, { role: 'collector', width: 6, allowBridge: false, endHeading: Math.atan2(site.outward.y, site.outward.x), maxNodes: 12000 }) : null
    const approach = preferred ?? (access && access.distance < 1500 ? planner.plan(access.point, site.landwardAccess, { role: 'access', width: 6, allowBridge: false, maxNodes: 12000 }) : null)
    const entryHeading = approach ? Math.atan2(approach.points.at(-1)!.y - approach.points.at(-2)!.y, approach.points.at(-1)!.x - approach.points.at(-2)!.x) : 0
    const spine = preferred ? [site.landwardAccess, quayCenter] : approach ? planner.plan(site.landwardAccess, quayCenter, { role: 'access', width: 6, allowBridge: false, startHeading: entryHeading, endHeading: Math.atan2(site.outward.y, site.outward.x), maxNodes: 12000 })?.points : null
    const quay = [quayEnds[0]!, quayCenter, quayEnds[1]!]
    if (access && approach && spine && planner.validate(spine, 6) && planner.validate(quay, 6)) {
      const accepted = [site.stages[0]!]
      harbor = { ...site, stages: accepted }; terrain = firstTerrain
      areas.splice(0, areas.length, ...proposedAreas)
      ensureRoadJunction(access.road.id, access.point)
      insertConnectedRoad({ id: 'harbor-approach', points: approach.points, kind: 'local', width: 6, role: preferred ? 'collector' : 'access', builtYear: 1920, reason: '既存街路に接続する港湾造成事業の進入路' })
      insertConnectedRoad({ id: 'harbor-spine', points: spine, kind: 'local', width: 6, role: 'access', builtYear: 1920, reason: '港の荷捌き場と岸壁を結ぶ構内道路' })
      insertConnectedRoad({ id: 'harbor-quay', points: quay, kind: 'local', width: 6, role: 'collector', builtYear: 1920, reason: '直線岸壁の陸側に確保した荷役道路' })
      for (const stage of site.stages.slice(1)) {
        const stageTerrain = harborTerrainAt(preHarborTerrain, [...accepted, stage], stage.constructionYear)
        const stageAreas = [...stageTerrain.areas, ...preHarborAreas.filter(a => a.id === 'historic-core' || a.id.startsWith('moat-') || a.id.startsWith('castle-'))]
        const stagePlanner = new RoadPlanner({ width: W, height: H, areas: stageAreas, core, terrain: stageTerrain })
        const source = nearestRoad(stage.landwardAccess, stage.constructionYear)
        const approach = source && stagePlanner.plan(source.point, stage.landwardAccess, { role: 'access', width: 6, allowBridge: false, maxNodes: 3000 })
        const ends = stage.quay.map((p, i) => ({ x: p.x - stage.outward.x * 8 + stage.tangent.x * (i ? -8 : 8), y: p.y - stage.outward.y * 8 + stage.tangent.y * (i ? -8 : 8) }))
        const center = stage.internalPath.at(-1)!, quay = [ends[0]!, center, ends[1]!]
        if (!source || !approach || !stagePlanner.validate(stage.internalPath, 6) || !stagePlanner.validate(quay, 6)) continue
        accepted.push(stage)
        ensureRoadJunction(source.road.id, source.point)
        insertConnectedRoad({ id: `harbor-approach-${stage.constructionYear}`, points: approach.points, kind: 'local', role: 'access', width: 6, builtYear: stage.constructionYear, reason: '既設港湾道路に接続する段階的な埠頭拡張' })
        insertConnectedRoad({ id: `harbor-spine-${stage.constructionYear}`, points: stage.internalPath, kind: 'local', role: 'access', width: 6, builtYear: stage.constructionYear, reason: '水面の船溜まりを残して増設した埠頭の荷役道路' })
        insertConnectedRoad({ id: `harbor-quay-${stage.constructionYear}`, points: quay, kind: 'local', role: 'collector', width: 6, builtYear: stage.constructionYear, reason: '増設岸壁の陸側荷役道路' })
      }
      harbor = { ...site, stages: accepted, reclaimedRegions: accepted.flatMap(stage => stage.reclaimedRegions), reclaimedArea: accepted.reduce((sum, stage) => sum + stage.reclaimedArea, 0), earthworkVolume: accepted.reduce((sum, stage) => sum + stage.earthworkVolume, 0), constructionCost: accepted.reduce((sum, stage) => sum + stage.constructionCost, 0) }
      terrain = harborTerrainAt(preHarborTerrain, accepted, year)
      preHarborWoodland = accepted.flatMap(stage => preHarborAreas.filter(a => a.kind === 'forest').flatMap(area => intersectRegions(area, { polygon: stage.platform }).map(region => ({ ...region, year: stage.constructionYear }))))
      areas.splice(0, areas.length, ...terrain.areas, ...preHarborAreas.filter(a => a.id === 'historic-core' || a.id.startsWith('moat-') || a.id.startsWith('castle-')))
    }
  }
  const blocks = extractStreetBlocks(roads).map(polygon => {
    let hash = 2166136261
    for (const p of polygon) for (const n of [Math.round(p.x * 10), Math.round(p.y * 10)]) hash = Math.imul(hash ^ n, 16777619)
    return { id: `block-${hash >>> 0}`, polygon }
  })

  type Segment = { a: Point; b: Point; pad: number; bounds: Bounds; year: number; to?: number }
  const transport = spatialIndex<Segment>()
  const datedRoads = (): TimelineVersion<Road>[] => [...growth.roadHistory, ...retiredCivicRoads, ...roads.filter(road => !growthRoadIds.has(road.id)).map(road => ({ from: road.builtYear ?? 1650, value: road }))]
  for (const version of [...datedRoads(), ...railways.filter(railway => railway.mode !== 'subway').map(railway => ({ from: railway.builtYear ?? 1900, value: { ...railway, width: 15 }, to: undefined }))]) for (let i = 1; i < version.value.points.length; i++) {
    const road = version.value
    const a = road.points[i - 1]!, b = road.points[i]!, pad = road.width / 2 + 2
    const bounds = boundsOf([a, b]); bounds.minX -= pad; bounds.maxX += pad; bounds.minY -= pad; bounds.maxY += pad
    transport.add({ a, b, pad, bounds, year: version.from, to: version.to })
  }
  const obstacle = (area: Area, year = 0) => ({ polygon: area.polygon, holes: area.holes, bounds: boundsOf(area.polygon), year, kind: area.kind })
  const obstacles = areas.filter(a => a.kind !== 'field').map(a => obstacle(a))
  const footprints = spatialIndex<{ building: Building; bounds: Bounds }>()
  const reserves: { polygon: Point[]; bounds: Bounds; year: number }[] = []
  const landRetired = new Map<Point[], number>(), buildingRetired = new Map<string, number>()
  const reserveActive = (reserve: (typeof reserves)[number], asOf: number) => reserve.year <= asOf && (landRetired.get(reserve.polygon) ?? Infinity) > asOf
  const canBuild = (polygon: Point[], checkReserve = true, asOf: number = year, allowWoodland = false) => {
    const bounds = boundsOf(polygon)
    if (harbor?.stages.some(stage => asOf < stage.constructionYear && stage.reclaimedRegions.some(region => polygonOverlapsRegion(polygon, region)))) return false
    if (preHarborWoodland.some(region => asOf < region.year && polygonOverlapsRegion(polygon, region))) return false
    if (bounds.minX < 18 || bounds.maxX > W - 18 || bounds.minY < 18 || bounds.maxY > H - 18 || (checkReserve && reserves.some(b => reserveActive(b, asOf) && overlaps(b.bounds, bounds) && polygonsOverlap(polygon, b.polygon)))) return false
    if (obstacles.some(o => (!allowWoodland || o.kind !== 'forest') && o.year <= asOf && (landRetired.get(o.polygon) ?? Infinity) > asOf && overlaps(bounds, o.bounds) && polygonOverlapsRegion(polygon, o))) return false
    for (const record of footprints.query(bounds)) if ((record.building.builtYear ?? 1700) <= asOf && (buildingRetired.get(record.building.id) ?? Infinity) > asOf && polygonsOverlap(polygon, record.building.polygon)) return false
    for (const s of transport.query(bounds)) if (s.year <= asOf && (s.to === undefined || asOf < s.to) && (pointInPolygon(s.a, polygon) || pointInPolygon(s.b, polygon) || polygon.some((p, i) => segmentsCross(p, polygon[(i + 1) % polygon.length]!, s.a, s.b) || distanceToSegment(p, s.a, s.b) < s.pad || distanceToSegment(s.a, p, polygon[(i + 1) % polygon.length]!) < s.pad || distanceToSegment(s.b, p, polygon[(i + 1) % polygon.length]!) < s.pad))) return false
    return true
  }
  const addBuilding = (building: Building, checkReserve = true, asOf: number = year, allowWoodland = false) => {
    building.polygon = building.polygon.map(p => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }))
    if (!canBuild(building.polygon, checkReserve, asOf, allowWoodland)) return false
    buildings.push(building); footprints.add({ building, bounds: boundsOf(building.polygon) }); return true
  }

  const candidates: Point[] = []
  for (let y = 110; y < H - 110; y += 65) for (let x = 110; x < W - 110; x += 65) candidates.push({ x, y })
  if (harbor) {
    const site = harbor
    const point = { x: (site.quay[0].x + site.quay[1].x) / 2 - site.outward.x * 40, y: (site.quay[0].y + site.quay[1].y) / 2 - site.outward.y * 40 }
    facilities.push({ id: 'facility-port', point, name: facilityNames.port, kind: 'port' })
    for (const stage of site.stages) {
    const frontage = distance(stage.quay[0], stage.quay[1]), suffix = stage.constructionYear === 1920 ? '' : `-${stage.constructionYear}`
    const yard: Area = { id: `harbor-yard${suffix}`, kind: 'field', landUse: 'vacant', polygon: stage.platform, name: '港湾荷捌き場' }
    areas.push(yard)
    reserves.push({ polygon: stage.platform, bounds: boundsOf(stage.platform), year: stage.constructionYear })
    for (const [i, side] of [-1, 1].entries()) for (const width of [60, 48, 40]) {
      const along = side * (frontage / 2 - width / 2 - 10), depth = width > 50 ? 30 : 26
      const center = { x: (stage.quay[0].x + stage.quay[1].x) / 2 + stage.tangent.x * along - stage.outward.x * 40, y: (stage.quay[0].y + stage.quay[1].y) / 2 + stage.tangent.y * along - stage.outward.y * 40 }
      const polygon = rectangle(-width / 2, -depth / 2, width, depth).map(p => ({ x: center.x + stage.tangent.x * p.x + stage.outward.x * p.y, y: center.y + stage.tangent.y * p.x + stage.outward.y * p.y }))
      if (polygon.every(p => pointInRegion(p, yard)) && addBuilding({ id: `harbor-warehouse-${i}${suffix}`, polygon, kind: 'industrial', height: 1, builtYear: stage.constructionYear }, false, stage.constructionYear)) break
    }
    }
  }
  const availableAt = (asOf: number, reach = 120, allowWoodland = false) => {
    const streets = roadsAt(asOf).filter(road => !road.bridge && !road.controlledAccess && road.role !== 'expressway' && road.role !== 'ramp' && road.role !== 'farm')
    if (!streets.length) return []
    const segments = spatialIndex<{ road: Road; a: Point; b: Point; segment: number; bounds: Bounds }>()
    const streetBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    for (const road of streets) for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!, bounds = boundsOf([a, b])
      segments.add({ road, a, b, bounds, segment: i - 1 }); streetBounds.minX = Math.min(streetBounds.minX, bounds.minX); streetBounds.minY = Math.min(streetBounds.minY, bounds.minY); streetBounds.maxX = Math.max(streetBounds.maxX, bounds.maxX); streetBounds.maxY = Math.max(streetBounds.maxY, bounds.maxY)
    }
    const sites: { point: Point; access: NonNullable<ReturnType<typeof nearestRoad>> }[] = []
    for (const point of candidates) {
      if (point.x < streetBounds.minX - reach || point.x > streetBounds.maxX + reach || point.y < streetBounds.minY - reach || point.y > streetBounds.maxY + reach || naturalTerrain.slope(point) >= .18) continue
      let access: NonNullable<ReturnType<typeof nearestRoad>> | undefined
      for (const segment of segments.query({ minX: point.x - reach, minY: point.y - reach, maxX: point.x + reach, maxY: point.y + reach })) {
        const p = projectPoint(point, segment.a, segment.b), d = distance(point, p)
        if (!access || d < access.distance) access = { road: segment.road, point: p, segment: segment.segment, distance: d }
      }
      if (access && access.distance > 36 && access.distance < reach && canBuild(rectangle(point.x - 32, point.y - 32, 64, 64), false, asOf, allowWoodland)) sites.push({ point, access })
    }
    return sites
  }
  const reserveCostAt = (asOf: number) => {
    const active = reserves.filter(reserve => reserveActive(reserve, asOf))
    return (point: Point) => active.some(reserve => point.x >= reserve.bounds.minX && point.x <= reserve.bounds.maxX && point.y >= reserve.bounds.minY && point.y <= reserve.bounds.maxY && pointInPolygon(point, reserve.polygon)) ? Infinity : 0
  }
  const accessAvoidsReserves = (path: Point[], width: number, asOf: number) => path.slice(1).every((b, i) => {
    const polygon = corridorPolygon(path[i]!, b, width / 2), bounds = boundsOf(polygon)
    return reserves.filter(reserve => reserveActive(reserve, asOf) && overlaps(bounds, reserve.bounds)).every(reserve => !polygonOverlapsRegion(polygon, reserve))
  })
  const facilityLot = (kind: FacilityKind, point: Point, access: NonNullable<ReturnType<typeof nearestRoad>>, neighbourhood = false, campusSpan: [number, number] = [220, 180]) => {
    const width = neighbourhood ? 48 : kind === 'university' ? campusSpan[0] : kind === 'park' ? 144 : kind === 'school' || kind === 'port' ? 108 : kind === 'hospital' ? 88 : kind === 'police' ? 46 : 74
    const depth = neighbourhood ? 42 : kind === 'university' ? campusSpan[1] : kind === 'park' ? 116 : kind === 'school' ? 88 : kind === 'port' ? 80 : kind === 'hospital' ? 70 : kind === 'police' ? 48 : 68
    const nx = (point.x - access.point.x) / access.distance, ny = (point.y - access.point.y) / access.distance
    const tr = (x: number, y: number) => ({ x: point.x + ny * x + nx * y, y: point.y - nx * x + ny * y })
    const rect = (x: number, y: number, w: number, h: number) => rectangle(x, y, w, h).map(p => tr(p.x, p.y))
    const building = kind === 'school' ? [{ x: -40, y: -24 }, { x: 40, y: -24 }, { x: 40, y: -5 }, { x: 0, y: -5 }, { x: 0, y: 19 }, { x: -40, y: 19 }].map(p => tr(p.x, p.y)) : kind === 'port' ? rect(-40, -22, 80, 44) : kind === 'hospital' ? rect(-32, -23, 64, 46) : kind === 'police' ? rect(-13, -11, 26, 22) : rect(-22, -17, 44, 34)
    return { campus: rect(-width / 2, -depth / 2, width, depth), building, entrance: tr(0, -depth / 2 + 3), schoolYard: rect(4, 4, 44, 32), along: { x: ny, y: -nx }, across: { x: nx, y: ny } }
  }
  // The requested kind's target bearing is stable when the selected end year
  // makes additional facilities eligible. Site and access surveys use only the
  // roads/constraints present when that facility was first constructed.
  const facilityOrder = [...new Set(config.facilities)].filter(kind => kind !== 'shop' && !(config.type === 'castle' && kind === 'castle') && !(config.type === 'temple' && kind === 'shrine'))
  type CivicIdentity = { id: string; name: string; neighbourhood: boolean }
  type CivicSite = { kind: FacilityKind; year: number; version: number; point: Point; facility: Facility; lot: ReturnType<typeof facilityLot>; accessRoad: Road; paths: Road[]; buildings: Building[]; areas: Area[]; active: boolean; identity?: CivicIdentity }
  const civicSites: CivicSite[] = [], civicEvents: GrowthEvent[] = [], facilityDates = new Map<Facility, number>(), civicUnavailable = new Map<FacilityKind, string>()
  if (config.type === 'castle' && !castle) civicUnavailable.set('castle', '城郭全体の乾燥地盤・斜面・堀と城門への接近路を満たす用地を確保できませんでした。')
  const woodlandClearings: WoodlandClearing[] = []
  const civicRouteRecords = new Map<string, Segment[]>()
  let historicThermalCenter: Point | undefined
  const placedYear = (facility: Facility) => facilityDates.get(facility) ?? (facility.id === 'facility-port' && harbor ? 1920 : facilityInception[facility.kind])
  const placeFacility = (kind: FacilityKind, constructionYear: number, version = 0, relocationTarget?: Point, identity?: CivicIdentity): CivicSite | null => {
    onProgress?.(`${identity?.name ?? facilityNames[kind]}の用地・接道を計算 · ${constructionYear}年`)
    const allowWoodland = kind === 'park' || kind === 'university'
    const index = facilityOrder.indexOf(kind)
    const visibleAreas = areas.filter(area => (obstacles.find(obstacle => obstacle.polygon === area.polygon)?.year ?? 0) <= constructionYear && (landRetired.get(area.polygon) ?? Infinity) > constructionYear)
    const planningTerrain = harbor ? harborTerrainAt(preHarborTerrain, harbor.stages, constructionYear) : naturalTerrain
    const planningAreas = harbor ? [...planningTerrain.areas, ...visibleAreas.filter(area => area.kind !== 'water' && area.kind !== 'forest')] : visibleAreas
    const facilityPlanner = new RoadPlanner({ width: W, height: H, areas: planningAreas, core, terrain: planningTerrain, landCost: reserveCostAt(constructionYear), exactLandCost: true })
    facilityPlanner.setRailwayCorridors(railways.filter(railway => railway.mode !== 'subway' && (railway.builtYear ?? 1900) <= constructionYear))
    const target = relocationTarget ?? (kind === 'port' ? { x: origin.x + 240, y: origin.y } : kind === 'shop' && stations.length ? stations[Math.floor(stations.length / 2)]!.point : { x: origin.x + Math.cos(index * 2.4) * 520, y: origin.y + Math.sin(index * 2.4) * 460 })
    const sites = availableAt(constructionYear, kind === 'port' ? 1600 : kind === 'university' ? 420 : kind === 'park' && !identity?.neighbourhood ? 280 : 120, allowWoodland)
    const population = civicPopulations.get(constructionYear) ?? civicPopulations.get([...civicPopulations.keys()].filter(date => date <= constructionYear).at(-1) ?? 0) ?? []
    const served = identity?.neighbourhood ? new Map(sites.map(site => [site.point, population.reduce((sum, cell) => distance(cell.point, site.point) < 320 ? sum + cell.households : sum, 0)])) : undefined
    const campusSpans: [number, number][] = kind === 'university' && (config.settlement === 'metropolis' || config.settlement === 'regional-city') ? [[320, 260], [220, 180]] : [[220, 180]]
    const ranked = sites.flatMap(c => campusSpans.map(span => ({ ...c, lot: facilityLot(kind, c.point, c.access, identity?.neighbourhood, span) }))).filter(c => facilities.filter(f => placedYear(f) <= constructionYear).every(f => distance(f.point, c.point) > 155)).filter(c => !identity?.neighbourhood || facilities.filter(f => f.kind === 'park').every(f => distance(f.point, c.point) > 430) && naturalTerrain.slope(c.point) < .08 && (served?.get(c.point) ?? 0) >= 45).filter(c => {
      const p = c.point
      if (kind !== 'port' || config.terrain === 'plain') return true
      let bank = Infinity
      for (const water of planningAreas.filter(a => a.id === 'river' || a.id === 'sea')) for (let i = 0; i < water.polygon.length; i++) bank = Math.min(bank, distanceToSegment(p, water.polygon[i]!, water.polygon[(i + 1) % water.polygon.length]!))
      return bank > 35 && bank < 175
    }).filter(c => {
      if (!c.access) return false
      const campus = c.lot.campus
      if (kind === 'school' || kind === 'hospital' || kind === 'police') {
        const samples = [...campus, ...campus.map((p, i) => ({ x: (p.x + campus[(i + 1) % campus.length]!.x) / 2, y: (p.y + campus[(i + 1) % campus.length]!.y) / 2 })), c.point], levels = samples.map(p => naturalTerrain.elevation(p))
        if (Math.max(...levels) - Math.min(...levels) > 3 || samples.some(p => naturalTerrain.slope(p) > .08 || naturalTerrain.wetness(p) > .52 || (() => { const channel = naturalTerrain.channelAt(p); return channel !== null && channel.bankDistance < 90 && naturalTerrain.elevation(p) - channel.surfaceElevation < 3 })())) return false
      }
      return canBuild(campus, true, constructionYear, allowWoodland) && !harbor?.stages.some(stage => stage.constructionYear <= constructionYear && polygonsOverlap(campus, stage.platform))
    }).sort((a, b) => {
      if (!version && served) { const difference = served.get(b.point)! - served.get(a.point)!; if (difference) return difference }
      const siteCost = (c: typeof a) => distance(c.point, target) + (kind === 'university' ? naturalTerrain.slope(c.point) * 4000 + (polygonArea(c.lot.campus) < 70000 ? 180 : 0) : 0)
      return siteCost(a) - siteCost(b)
    })
    let accessPath: Point[] | null = null, accessCost = 0
    let campusProposal: CampusProposal | undefined, parkPlaza: PolygonRegion | undefined, parkPath: PlannedRoute | undefined
    const suffix = version ? `-relocation-${constructionYear}-${version}` : ''
    const name = identity?.name ?? (kind === 'school' ? `${config.name.replace(/[市町村]$/, '')}第一小学校` : kind === 'university' ? `${config.name.replace(/[市町村]$/, '')}大学` : facilityNames[kind])
    const chosen = ranked.slice(0, version ? 96 : kind === 'university' ? 32 : 24).find(c => {
      if (!c.access) return false
      const proposedLot = c.lot, entrance = proposedLot.entrance
      const route = facilityPlanner.plan(c.access.point, entrance, { role: 'access', width: 3.5, maxNodes: 6000, ...(allowWoodland ? { maximumGrade: .14 } : {}) })
      if (!route || !Number.isFinite(route.cost) || !accessAvoidsReserves(route.points, 3.5, constructionYear)) return false
      const localBounds = boundsOf(proposedLot.campus), offset = { x: localBounds.minX - 10, y: localBounds.minY - 10 }, local = (p: Point) => ({ x: p.x - offset.x, y: p.y - offset.y }), global = (p: Point) => ({ x: p.x + offset.x, y: p.y + offset.y })
      const woodedSite = planningAreas.some(area => area.kind === 'forest' && polygonOverlapsRegion(proposedLot.campus, area)), reserveCost = reserveCostAt(constructionYear)
      let cachedInternal: { structures: Building[]; planner: RoadPlanner } | undefined
      const internalRoute = (a: Point, b: Point, structures: Building[]) => {
        // Campus paths need a few hundred metres of actual terrain, not another
        // pair of 12km-wide survey arrays for every individual lecture hall.
        if (!cachedInternal || cachedInternal.structures !== structures) cachedInternal = { structures, planner: new RoadPlanner({ width: localBounds.maxX - localBounds.minX + 20, height: localBounds.maxY - localBounds.minY + 20, areas: [], core: null, exactLandCost: true,
          terrain: { elevation: p => naturalTerrain.elevation(global(p)), slope: p => naturalTerrain.slope(global(p)), waterAt: p => naturalTerrain.waterAt(global(p)), bridgeSites: [] },
          landCost: p => { const q = global(p); return !pointInPolygon(q, proposedLot.campus) || structures.some(building => pointInPolygon(q, building.polygon) || building.polygon.some((a, i) => distanceToSegment(q, a, building.polygon[(i + 1) % building.polygon.length]!) < 1.6)) ? Infinity : reserveCost(q) + (woodedSite ? 2.4 : 0) },
        }) }
        const route = cachedInternal.planner.plan(local(a), local(b), { role: 'access', width: 2.8, alignment: 'planned', maximumGrade: .14, maxNodes: 1800 })
        return route ? { ...route, points: route.points.map(global) } : null
      }
      if (kind === 'university') {
        const budget = clamp(scenarioDemandAtYear(config, constructionYear).households * 4, 6500, 60000) - route.cost
        const proposal = surveyUniversityCampus({ campus: proposedLot.campus, center: c.point, entrance, along: proposedLot.along, across: proposedLot.across, year: constructionYear, name, suffix,
          elevation: naturalTerrain.elevation, slope: naturalTerrain.slope, waterAt: naturalTerrain.waterAt, canPlace: polygon => canBuild(polygon, true, constructionYear, true), budget,
          plan: internalRoute,
        })
        if (!proposal) return false
        campusProposal = proposal
      }
      if (kind === 'park') {
        const plaza = { polygon: rectangle(-8, -7, 16, 14).map(p => ({ x: c.point.x + proposedLot.along.x * p.x + proposedLot.across.x * p.y, y: c.point.y + proposedLot.along.y * p.x + proposedLot.across.y * p.y })) }
        const formation = surveyDevelopmentSite(naturalTerrain, c.point, plaza.polygon)
        if (!formation.viable) return false
        const path = internalRoute(entrance, c.point, [])
        if (!path || !accessAvoidsReserves(path.points, 2.8, constructionYear)) return false
        const budget = clamp(scenarioDemandAtYear(config, constructionYear).households * .8, 1000, 12000)
        if (route.cost + path.cost + formation.formationCost > budget) return false
        parkPlaza = plaza; parkPath = path
      }
      accessPath = route.points
      accessCost = route.cost
      return true
    }); if (!chosen || !chosen.access) return null
    const { point } = chosen
    // Earlier facility junctions subdivide this route; cached segment indices are stale.
    const access = nearestRoad(point, constructionYear)!
    const lot = chosen.lot
    const driveway: Road = { id: `${identity ? `${identity.id}-access` : `facility-access-${kind}`}${suffix}`, points: accessPath!, kind: 'local', width: 3.5, role: 'access', builtYear: constructionYear, reason: version ? '交通用地取得に伴う公共施設の移転先への接道' : '公共施設用地の接道' }
    ensureRoadJunction(access.road.id, access.point)
    roads.push(driveway)
    for (let i = 1; i < driveway.points.length; i++) {
      const a = driveway.points[i - 1]!, b = driveway.points[i]!, drivewayBounds = boundsOf([a, b]), pad = 3
      const record = { a, b, pad, bounds: { minX: drivewayBounds.minX - pad, minY: drivewayBounds.minY - pad, maxX: drivewayBounds.maxX + pad, maxY: drivewayBounds.maxY + pad }, year: driveway.builtYear! }
      transport.add(record); const records = civicRouteRecords.get(driveway.id) ?? []; records.push(record); civicRouteRecords.set(driveway.id, records)
    }
    const facility: Facility = { id: identity?.id ?? `facility-${kind}`, point, name, kind }
    facilities.push(facility); facilityDates.set(facility, constructionYear)
    const site: CivicSite = { kind, year: constructionYear, version, point, facility, lot, accessRoad: driveway, paths: [driveway], buildings: [], areas: [], active: true, identity }
    reserves.push({ polygon: lot.campus, bounds: boundsOf(lot.campus), year: driveway.builtYear! })
    for (let i = 1; i < driveway.points.length; i++) woodlandClearings.push({ polygon: corridorPolygon(driveway.points[i - 1]!, driveway.points[i]!, driveway.width / 2 + .25), year: constructionYear })
    const internalPaths = campusProposal?.paths ?? (parkPath ? [parkPath] : [])
    for (const [i, route] of internalPaths.entries()) {
      const road: Road = { id: `${identity?.id ?? `facility-access-${kind}`}-internal-${i}${suffix}`, points: route.points, kind: 'local', width: 2.8, role: 'access', builtYear: constructionYear, reason: kind === 'university' ? '丘の等高線に沿って講義棟・図書館を接続する学内通路' : '樹林を残した公園の入口と小広場を結ぶ園路' }
      const connected = insertConnectedRoad(road)
      site.paths.push(connected)
      for (let n = 1; n < connected.points.length; n++) {
        const a = connected.points[n - 1]!, b = connected.points[n]!, pad = road.width / 2 + .25, polygon = corridorPolygon(a, b, pad), bounds = boundsOf(polygon)
        const record = { a, b, pad, bounds, year: constructionYear }
        transport.add(record); const records = civicRouteRecords.get(road.id) ?? []; records.push(record); civicRouteRecords.set(road.id, records); woodlandClearings.push({ polygon, year: constructionYear })
      }
    }
    if (kind === 'shrine') {
      const building: Building = { id: `facility-building-shrine${suffix}`, polygon: lot.building, kind: 'public', height: 2, builtYear: constructionYear, name }
      if (!addBuilding(building, false, constructionYear)) throw new Error('神社の敷地調査と建築判定が一致しません。')
      site.buildings.push(building)
    }
    if (kind === 'university' && campusProposal) {
      for (const building of campusProposal.buildings) {
        if (!addBuilding(building, false, constructionYear, true)) throw new Error('大学の敷地調査と建築判定が一致しません。')
        site.buildings.push(building)
      }
      for (const building of site.buildings) {
        const center = building.polygon.reduce((sum, p) => ({ x: sum.x + p.x / building.polygon.length, y: sum.y + p.y / building.polygon.length }), { x: 0, y: 0 })
        // A narrow maintenance verge includes the rounded surveyed facade;
        // clearing must not retain centimetre slivers of forest under a wall.
        woodlandClearings.push({ polygon: building.polygon.map(p => ({ x: center.x + (p.x - center.x) * 1.04, y: center.y + (p.y - center.y) * 1.04 })), year: constructionYear })
      }
      woodlandClearings.push(...campusProposal.clearings.slice(campusProposal.buildings.length).map(region => ({ polygon: region.polygon, year: constructionYear })))
      const area: Area = { id: `facility-lot-university${suffix}`, kind: 'park', polygon: campusProposal.plaza.polygon }
      areas.push(area); obstacles.push(obstacle(area, constructionYear)); site.areas.push(area)
    } else if (kind === 'shrine' || kind === 'park') {
      const wooded = kind === 'park' && planningAreas.some(area => area.kind === 'forest' && polygonOverlapsRegion(lot.campus, area))
      const polygon = wooded && parkPlaza ? parkPlaza.polygon : lot.campus
      const area: Area = { id: `${identity?.id ?? `facility-lot-${kind}`}${suffix}`, kind: 'park', polygon, name: kind === 'park' ? name : undefined }
      areas.push(area); obstacles.push(obstacle(area, driveway.builtYear)); site.areas.push(area)
      if (kind === 'park' && parkPlaza) woodlandClearings.push({ polygon: parkPlaza.polygon, year: constructionYear })
    } else {
      const building: Building = { id: `facility-building-${kind}${suffix}`, polygon: lot.building, kind: kind === 'port' ? 'industrial' : kind === 'shop' ? 'commercial' : 'public', height: kind === 'hospital' ? 5 : kind === 'school' ? 3 : 2, builtYear: driveway.builtYear }
      if (!addBuilding(building, false, constructionYear)) throw new Error('公共施設の敷地調査と建築判定が一致しません。')
      site.buildings.push(building)
      if (kind === 'school') { const yard: Area = { id: `school-yard${suffix}`, kind: 'park', polygon: lot.schoolYard }; areas.push(yard); obstacles.push(obstacle(yard, driveway.builtYear)); site.areas.push(yard) }
    }
    civicSites.push(site)
    for (const [i, entity] of (site.buildings.length ? site.buildings : site.areas).entries()) civicEvents.push({ id: `civic-construction-${facility.id}-${constructionYear}-${version}-${i}`, kind: 'construction', year: constructionYear, entityId: entity.id, reason: version ? `交通用地取得に伴う${name}の移転・再建` : kind === 'university' ? `${name}の個別建築床・学内通路整備（地域整備枠、用地・建築・造成・通路費${Math.round(campusProposal!.cost + accessCost)}）` : `${name}の敷地取得・建設` })
    if (kind === 'onsen' && !version) historicThermalCenter = point
    return site
  }

  let parkSerial = 0
  const placeNeighbourhoodParks = (asOf: number) => {
    if (!config.facilities.includes('park') || asOf < 1955) return
    const wanted = Math.min(12, Math.floor(scenarioDemandAtYear(config, asOf).households / 900))
    while (facilities.filter(facility => facility.id.startsWith('neighbourhood-park-')).length < wanted) {
      const name = `${['さくら', 'みどり', 'あけぼの', 'けやき', 'ひだまり', 'つばき'][parkSerial % 6]}${parkSerial >= 6 ? '第二' : ''}公園`
      const identity = { id: `neighbourhood-park-${parkSerial}`, name, neighbourhood: true }
      if (!placeFacility('park', asOf, 0, origin, identity)) break
      parkSerial++
    }
  }
  // Civic history is replayed alongside the already surveyed transport dates.
  // A later road acquires the site then; relocation cannot alter the1875survey.
  const acquisitionAt = civicTransportAcquisitions(datedRoads().map(version => ({ ...version.value, builtYear: version.from })), railways, year)
  const founding = [...facilityOrder].filter(kind => facilityInception[kind] <= year && !facilities.some(facility => facility.kind === kind)).sort((a, b) => facilityInception[a] - facilityInception[b] || facilityOrder.indexOf(a) - facilityOrder.indexOf(b))
  const firstFacilityYear = Math.min(...founding.map(kind => facilityInception[kind]))
  const civicYears = [...new Set([...founding.map(kind => facilityInception[kind]), ...civicPopulations.keys(), ...datedRoads().map(version => version.from).filter(date => date >= firstFacilityYear && date <= year), ...(Number.isFinite(firstFacilityYear) ? [year] : [])])].sort((a, b) => a - b)
  const attemptedNetworks = new Map<FacilityKind, string>()
  let civicCursor = 0, acquisitions = 0
  while (true) {
    const nextYear = civicYears[civicCursor] ?? Infinity
    const next = civicSites.filter(site => site.active).map(site => ({ site, acquisition: acquisitionAt(site.lot.campus, site.year, site.accessRoad.id) })).filter((item): item is { site: CivicSite; acquisition: NonNullable<ReturnType<typeof acquisitionAt>> } => item.acquisition !== null).sort((a, b) => a.acquisition.year - b.acquisition.year || a.site.facility.id.localeCompare(b.site.facility.id))[0]
    if (next && next.acquisition.year <= nextYear) {
      if (++acquisitions > 1024) throw new Error('交通用地取得に伴う公共施設の移転が収束しません。')
      const { site, acquisition } = next
      site.active = false; landRetired.set(site.lot.campus, acquisition.year)
      for (const road of site.paths) {
        const index = roads.indexOf(road); if (index >= 0) roads.splice(index, 1)
        retiredCivicRoads.push({ from: road.builtYear ?? site.year, to: acquisition.year, value: road })
        retireCivicPavementReservations(civicRouteRecords.get(road.id) ?? [], road.id, site.accessRoad.id, acquisition.year)
      }
      for (const area of site.areas) { landRetired.set(area.polygon, acquisition.year); const index = areas.indexOf(area); if (index >= 0) areas.splice(index, 1) }
      for (const building of site.buildings) { buildingRetired.set(building.id, acquisition.year); const index = buildings.indexOf(building); if (index >= 0) buildings.splice(index, 1) }
      const index = facilities.indexOf(site.facility); if (index >= 0) facilities.splice(index, 1)
      for (const [i, entity] of (site.buildings.length ? site.buildings : site.areas).entries()) civicEvents.push({ id: `civic-acquisition-${site.facility.id}-${site.year}-${site.version}-${acquisition.year}-${i}`, kind: 'acquisition', year: acquisition.year, entityId: entity.id, reason: `${acquisition.routeId}の${acquisition.mode === 'road' ? '道路' : '鉄道'}用地として${site.facility.name}の旧敷地を取得・撤去` })
      if (!placeFacility(site.kind, acquisition.year, site.version + 1, site.point, site.identity)) civicUnavailable.set(site.kind, `${acquisition.year}年の交通用地取得で旧敷地を撤去しましたが、地盤・接道条件を満たす移転先を確保できませんでした。`)
      continue
    }
    if (!Number.isFinite(nextYear)) break
    for (const kind of founding.filter(kind => facilityInception[kind] <= nextYear && !facilities.some(facility => facility.kind === kind))) {
      const network = roadsAt(nextYear).map(road => `${road.id}:${road.modifiedYear ?? road.builtYear}:${road.width}`).join('|')
      if (attemptedNetworks.get(kind) === network) continue
      attemptedNetworks.set(kind, network)
      const previous = civicSites.filter(site => site.kind === kind).at(-1)
      if (placeFacility(kind, nextYear, previous ? previous.version + 1 : 0, previous?.point, previous?.identity)) civicUnavailable.delete(kind)
    }
    if (civicPopulations.has(nextYear)) placeNeighbourhoodParks(nextYear)
    civicCursor++
  }
  const woodlandSource = harborAreaHistory(preHarborAreas.filter(area => area.kind === 'forest'), harbor?.stages ?? [])
  const woodlandVersions = civicWoodlandHistory(woodlandSource, woodlandClearings, year)
  areas.splice(0, areas.length, ...areas.filter(area => area.kind !== 'forest'), ...woodlandVersions.filter(version => version.from <= year && (version.to === undefined || year < version.to)).map(version => version.value))
  for (const site of civicSites.filter(site => site.kind === 'university' || site.kind === 'park')) {
    const trees = woodlandVersions.filter(version => version.from <= site.year && (version.to === undefined || site.year < version.to)).map(version => version.value)
    const paths = site.paths.flatMap(road => road.points.slice(1).map((b, i) => ({ polygon: corridorPolygon(road.points[i]!, b, road.width / 2 + .25) })))
    const grass = subtractRegions({ polygon: site.lot.campus }, [...trees, ...site.buildings.map(building => ({ polygon: building.polygon })), ...site.areas, ...paths])
    for (const [i, region] of grass.entries()) {
      const area: Area = { id: `${site.facility.id}-grass-${site.version}-${i}`, kind: 'field', landUse: 'meadow', ...region }
      site.areas.push(area); if (site.active) areas.push(area)
    }
  }
  onProgress?.('敷地と住宅・建替えを計算中…')
  const development = developLand({ config, roads, roadHistory: datedRoads(), center: origin, thermalCenter: historicThermalCenter, stations, centers: growth.centers,
    canPlace: (polygon, asOf) => canBuild(polygon, true, asOf), slope: naturalTerrain.slope, elevation: naturalTerrain.elevation })
  for (const building of development.buildings) {
    buildings.push(building)
    footprints.add({ building, bounds: boundsOf(building.polygon) })
  }
  const subway = planSubway({ config, throughYear: year, roads: datedRoads(), buildings: development.history.buildings, stations, terrain: naturalTerrain })
  if (subway) { railways.push(subway.railway); stations.push(...subway.stations) }
  stations.splice(0, stations.length, ...surveyStationArchitecture({ stations, railways, roads: routeVersions(), width: W, height: H,
    buildingVersions: [...development.history.buildings, ...civicSites.flatMap(site => site.buildings.map(building => ({ from: site.year, value: building })))], buildings,
    waterAt: naturalTerrain.waterAt, slope: naturalTerrain.slope, elevation: naturalTerrain.elevation }))
  const shopHistory = config.facilities.includes('shop') ? shoppingStreetHistory({ buildings: development.history.buildings, parcels: development.history.parcels, roads: datedRoads(), name: facilityNames.shop, throughYear: year }) : []
  for (const version of shopHistory) if (version.to === undefined || year < version.to) facilities.push(version.value)
  preview(roads, railways, stations, buildings, 'development')

  // Lowland agriculture predates the town. A coherent irrigation/ownership layout
  // is generated independently of current buildings; later transport and development
  // convert only the actual acquired ground; the remainder retains its land use.
  onProgress?.('耕地の転用と地図の仕上げ…')
  type LandMask = PolygonRegion & { bounds: Bounds }
  const occupied = spatialIndex<LandMask>(), convertedLand = spatialIndex<LandMask>()
  const addOccupied = (region: PolygonRegion) => { const record = { ...region, bounds: boundsOf(region.polygon) }; occupied.add(record); convertedLand.add(record) }
  for (const area of areas) addOccupied(area)
  for (const p of development.parcels) {
    if (p.developedYear) addOccupied(p)
    else { const record = { polygon: p.polygon, bounds: boundsOf(p.polygon) }; convertedLand.add(record) }
  }
  for (const reserve of reserves) if (reserveActive(reserve, year)) addOccupied(reserve)
  for (const b of buildings) if (!b.parcelId) addOccupied(b)
  for (const station of stations) if (station.buildingPolygon) addOccupied({ polygon: station.buildingPolygon })
  for (const route of [...roads, ...railways.filter(r => r.mode !== 'subway').map(r => ({ ...r, width: 15 }))]) for (let i = 1; i < route.points.length; i++) {
    if (distance(route.points[i - 1]!, route.points[i]!) < .01) continue
    const polygon = corridorPolygon(route.points[i - 1]!, route.points[i]!, route.width / 2 + 1)
    addOccupied({ polygon })
  }
  const mapBoundary = { polygon: rectangle(0, 0, W, H) }
  const densityAt = settlementDensity(development.parcels)
  const settled = contourNaturalLand(W, H, p => densityAt(p) - .13, 24).flatMap(region => intersectRegions(region, mapBoundary))
  const wetlands = contourNaturalLand(W, H, p => riparianWetlandMargin(p, terrain)).flatMap(region => intersectRegions(region, mapBoundary))
  for (const region of settled) convertedLand.add({ ...region, bounds: boundsOf(region.polygon) })
  for (const region of wetlands) { const record = { ...region, bounds: boundsOf(region.polygon) }; convertedLand.add(record) }
  const inheritedRoads = roadsAt(1650).filter(r => !r.controlledAccess)
  const agriculturalRiver = naturalTerrain.rivers.find(r => r.id === 'river') ?? naturalTerrain.rivers[0]
  const naturalFarmLimits = spatialIndex<LandMask>()
  for (const region of [...preHarborAreas.filter(area => area.kind === 'water' || area.kind === 'forest'), ...wetlands]) naturalFarmLimits.add({ ...region, bounds: boundsOf(region.polygon) })
  const titles: AgriculturalTitle[] = []
  for (const { id, polygon, center, landUse } of agriculturalPlots(W, H, config.seed, agriculturalRiver?.points, naturalTerrain, inheritedRoads)) {
    if (center.x < 0 || center.x > W || center.y < 0 || center.y > H || !naturalTerrain.cultivable(center)) continue
    const bounds = boundsOf(polygon)
    if (!agriculturalPlotSuitable(polygon, naturalTerrain.cultivable, [...naturalFarmLimits.query(bounds)])) continue
    const regions = intersectRegions({ polygon }, mapBoundary)
    if (regions.length) titles.push({ id, regions, landUse })
  }
  const farmAcquisitions: AgriculturalAcquisition[] = []
  for (const area of preHarborAreas.filter(area => area.kind !== 'water' && area.kind !== 'forest')) farmAcquisitions.push({ polygon: area.polygon, holes: area.holes, year: 1650 })
  const acquiredParcelIds = new Set<string>()
  for (const version of development.history.parcels) if (!acquiredParcelIds.has(version.value.id)) { acquiredParcelIds.add(version.value.id); farmAcquisitions.push({ polygon: version.value.polygon, year: version.value.createdYear }) }
  for (const site of civicSites) farmAcquisitions.push({ polygon: site.lot.campus, year: site.year })
  for (const building of buildings.filter(building => !building.parcelId)) farmAcquisitions.push({ polygon: building.polygon, year: building.builtYear ?? 1650 })
  for (const station of stations) if (station.buildingPolygon) farmAcquisitions.push({ polygon: station.buildingPolygon, year: station.builtYear ?? 1900 })
  if (harbor) for (const stage of harbor.stages) farmAcquisitions.push({ polygon: stage.platform, year: stage.constructionYear })
  for (const version of [...datedRoads(), ...railways.filter(railway => railway.mode !== 'subway').map(railway => ({ from: railway.builtYear ?? 1900, value: { ...railway, width: 15 } }))]) {
    const route = version.value
    for (let i = 1; i < route.points.length; i++) if (distance(route.points[i - 1]!, route.points[i]!) >= .01) farmAcquisitions.push({ polygon: corridorPolygon(route.points[i - 1]!, route.points[i]!, route.width / 2 + 1), year: version.from })
  }
  const agriculturalVersions = agriculturalHistory(titles, farmAcquisitions, year, asOf => {
    const pastParcels = development.history.parcels.filter(version => version.from <= asOf && (version.to === undefined || asOf < version.to)).map(version => version.value)
    const density = settlementDensity(pastParcels)
    const visibleTerrain = harbor ? harborTerrainAt(preHarborTerrain, harbor.stages, asOf) : naturalTerrain
    const pastAreas = [...(harbor ? [...visibleTerrain.areas, ...preHarborAreas.filter(area => area.id === 'historic-core' || area.id.startsWith('castle-') || area.id.startsWith('moat-'))] : preHarborAreas).filter(area => area.kind === 'water' || area.id === 'historic-core' || area.id.startsWith('castle-') || area.id.startsWith('moat-')), ...woodlandVersions.filter(version => version.from <= asOf && (version.to === undefined || asOf < version.to)).map(version => version.value)]
    const pastSites = civicSites.filter(site => site.year <= asOf && (landRetired.get(site.lot.campus) ?? Infinity) > asOf)
    const access = agriculturalAccessSurvey(roadsAt(asOf), visibleTerrain, [
      ...pastAreas, ...pastParcels, ...pastSites.map(site => ({ polygon: site.lot.campus })), ...wetlands,
      ...stations.filter(station => station.buildingPolygon && (station.builtYear ?? 1900) <= asOf).map(station => ({ polygon: station.buildingPolygon! })),
      ...railways.filter(railway => railway.mode !== 'subway' && (railway.builtYear ?? 1900) <= asOf).flatMap(railway => railway.points.slice(1).flatMap((b, i) => distance(railway.points[i]!, b) > .01 ? [{ polygon: corridorPolygon(railway.points[i]!, b, 8.5) }] : [])),
    ])
    return (region, originalArea) => {
      const center = region.polygon.reduce((sum, p) => ({ x: sum.x + p.x / region.polygon.length, y: sum.y + p.y / region.polygon.length }), { x: 0, y: 0 })
      return agriculturalRemnantSuitable(region, originalArea, density(center)) && access(region)
    }
  })
  for (const version of agriculturalVersions) if (version.to === undefined || year < version.to) {
    areas.push(version.value)
    const record = { polygon: version.value.polygon, holes: version.value.holes, bounds: boundsOf(version.value.polygon) }
    convertedLand.add(record); occupied.add(record)
  }
  // Unbuilt land still has a physical cover. Continuous contours follow occupation
  // and wet lowlands; small clipping tiles bound complexity but are never outlined.
  let coverSerial = 0
  const emitCover = (sources: PolygonRegion[], landUse: 'meadow' | 'woodland' | 'wetland' | 'vacant', masks: ReturnType<typeof spatialIndex<LandMask>>) => {
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
  const sparseWoodland = naturalWoodlandContours({ width: W, height: H, seed: config.seed, forest: config.forest, settlement: config.settlement, origin,
    elevation: naturalTerrain.elevation, slope: naturalTerrain.slope, wetness: naturalTerrain.wetness })
  emitCover(sparseWoodland, 'woodland', convertedLand)
  for (const region of sparseWoodland) convertedLand.add({ ...region, bounds: boundsOf(region.polygon) })
  emitCover([mapBoundary], 'meadow', convertedLand)
  const districts = buildDistricts({ width: W, height: H, config, roads, blocks, parcels: development.parcels, areas, stations, facilities })
  const originalRoads = new Map<string, TimelineVersion<Road>>()
  for (const version of datedRoads()) if (!originalRoads.has(version.value.id) || originalRoads.get(version.value.id)!.from > version.from) originalRoads.set(version.value.id, version)
  const map: CityMap = { width: W, height: H, config, buildings, roads, areas, railways, stations, facilities, districts, description: CITY_PRESETS.find(p => p.id === config.type)!.description, growthLog: growth.growthLog, generatorVersion: GENERATOR_VERSION, year, terrainSurface: surface(), regionalContext,
    unplacedFacilities: config.facilities.filter(kind => facilityInception[kind] <= year && !facilities.some(facility => facility.kind === kind)).map(kind => ({ kind, reason: civicUnavailable.get(kind) ?? (kind === 'shop' ? '商店街を構成する連続した商業敷地が成立していません。' : '水域・地盤・接道の条件を満たす用地を確保できませんでした。') })),
    terrainSimulation: { resolution: naturalTerrain.hydrology.resolution, steps: naturalTerrain.hydrology.erosion.iterations, elapsedYears: naturalTerrain.hydrology.erosion.elapsedYears,
      bedrockErodedVolume: naturalTerrain.hydrology.sediment.erodedSourceVolume, storedSedimentVolume: naturalTerrain.hydrology.sediment.storedVolume, exportedSedimentVolume: naturalTerrain.hydrology.sediment.exportedVolume, sedimentBalanceError: naturalTerrain.hydrology.sediment.massBalanceError, groundBalanceError: naturalTerrain.hydrology.erosion.terrainBalanceError,
      localExcavationVolume: naturalTerrain.hydrology.bankSediment?.totalExcavationVolume ?? 0, localDepositionVolume: naturalTerrain.hydrology.bankSediment?.depositedVolume ?? 0, localExportedVolume: naturalTerrain.hydrology.bankSediment?.totalExportedVolume ?? 0, localBalanceError: naturalTerrain.hydrology.bankSediment?.totalMassBalanceError ?? 0 },
    parcels: development.parcels, snapshots: development.snapshots, blocks,
    events: [
      ...roads.map(r => ({ id: `event-${r.id}`, year: r.builtYear ?? 1650, kind: 'road' as const, entityId: r.id, reason: originalRoads.get(r.id)?.value.reason ?? r.reason ?? '初期の広域街道' })),
      ...growth.roadHistory.filter(version => version.value.modifiedYear === version.from).map(version => ({ id: `event-road-renewal-${version.value.id}-${version.from}`, year: version.from, kind: 'road' as const, entityId: version.value.id, reason: version.value.reason })),
      ...railways.map(r => ({ id: `event-${r.id}`, year: r.builtYear ?? 1900, kind: 'railway' as const, entityId: r.id, reason: r.mode === 'subway' ? '既存市街地・乗換駅の需要に基づく地下鉄の開通' : '地域鉄道の開通' })),
      ...civicEvents,
      ...development.events,
      ...(harbor?.stages.map(stage => ({ id: stage.constructionYear === 1920 ? 'event-harbor-reclamation' : `event-harbor-reclamation-${stage.constructionYear}`, year: stage.constructionYear, kind: 'acquisition' as const, entityId: stage.constructionYear === 1920 ? 'harbor-yard' : `harbor-yard-${stage.constructionYear}`, reason: `既存岸に接続する約${(stage.reclaimedArea / 10000).toFixed(2)}haの埋立と岸壁整備。盛土搬入${Math.round(stage.importedFillVolume)}m³・切土再利用${Math.round(stage.reusedCutVolume)}m³（港湾公費枠${Math.round(stage.constructionCost)}）。` })) ?? []),
      ...buildings.filter(b => b.id.startsWith('harbor-warehouse')).map(b => ({ id: `event-${b.id}`, year: b.builtYear ?? 1920, kind: 'construction' as const, entityId: b.id, reason: '造成した港湾用地に接道する荷役倉庫の建設' })),
    ] }
  const through = (from: number, to: number | undefined) => ({ from, ...(to === undefined ? {} : { to }) })
  const areaVersions: TimelineVersion<Area>[] = []
  // Ground cover precedes titles and civic grounds in paint order. Historical
  // cultivated versions consequently restore the actual unacquired old titles.
  const parcelGrounds = development.history.parcels.map(version => ({ ...version, bounds: boundsOf(version.value.polygon) }))
  for (const area of areas.filter(area => area.id.startsWith('land-'))) {
    const bounds = boundsOf(area.polygon)
    const from = area.landUse === 'vacant' ? Math.min(year, ...parcelGrounds.filter(version => overlaps(bounds, version.bounds) && polygonOverlapsRegion(area.polygon, version.value)).map(version => version.value.createdYear)) : 1650
    areaVersions.push({ from, value: area })
  }
  areaVersions.push(...harborAreaHistory(preHarborAreas.filter(area => area.kind === 'water'), harbor?.stages ?? []))
  areaVersions.push(...woodlandVersions)
  for (const value of preHarborAreas.filter(area => area.kind !== 'water' && area.kind !== 'forest')) areaVersions.push({ from: 1650, value })
  for (const site of civicSites) for (const value of site.areas) areaVersions.push({ ...through(site.year, landRetired.get(site.lot.campus)), value })
  if (harbor) for (const stage of harbor.stages) for (const value of areas.filter(area => area.id === (stage.constructionYear === 1920 ? 'harbor-yard' : `harbor-yard-${stage.constructionYear}`))) areaVersions.push({ from: stage.constructionYear, value })
  areaVersions.push(...agriculturalVersions)
  const civicBuildingHistory = civicSites.flatMap(site => site.buildings.map(building => ({ ...through(site.year, buildingRetired.get(building.id)), value: building })))
  const civicFacilityHistory = [...civicSites.map(site => ({ ...through(site.year, landRetired.get(site.lot.campus)), value: site.facility })), ...shopHistory]
  const suppliedFacilityIds = new Set(civicFacilityHistory.map(version => version.value.id))
  for (const value of facilities) if (!suppliedFacilityIds.has(value.id)) civicFacilityHistory.push({ from: value.id === 'facility-port' && harbor ? 1920 : facilityInception[value.kind], value })
  map.timeline = createCityTimeline(map, { fromYear: 1650, throughYear: year,
    roads: datedRoads(), buildings: [...development.history.buildings, ...civicBuildingHistory], parcels: development.history.parcels, buildingStates: development.history.buildingStates,
    facilities: civicFacilityHistory, areas: areaVersions,
    terrainSurfaces: harbor ? [{ from: 1650, to: 1920, value: naturalSurface }, ...harbor.stages.map((stage, i) => ({ from: stage.constructionYear, ...(harbor!.stages[i + 1] ? { to: harbor!.stages[i + 1]!.constructionYear } : {}), value: surface(harborTerrainAt(preHarborTerrain, harbor!.stages, stage.constructionYear)) }))] : [{ from: 1650, value: naturalSurface }],
  })
  const served = finalizeCivicRoadHistory(map).map
  // The coarse market integration precedes cadastral housing. Use the actual
  // occupied stock once it exists, spending only the unspent road account.
  // This appends current-year works; it cannot use future households to rewrite
  // an earlier street network or rerun construction when the slider moves.
  onProgress?.('実際の居住地と交通量から道路整備を評価中…')
  return finalizeActualStockTransport(served, { funds: growth.remainingTransportCapital, terrain, core }).map

}
