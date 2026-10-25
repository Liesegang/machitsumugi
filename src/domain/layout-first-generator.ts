import type { Area, Building, CityConfig, CityMap, FacilityKind, GrowthEvent, Point, Road, TimelineVersion } from './types'
import type { Bounds, PolygonRegion } from './geometry'
import { boundsOf, corridorPolygon, overlaps, pointInPolygon, polygonOverlapsRegion } from './geometry'
import { createTerrainModel } from './terrain'
import { resolveGenerationConfig } from './generation-config'
import type { GenerationTerrainSource } from './generation-terrain-cache'
import { terrainGenerationPreview } from './generator'
import { planLayoutFirstStationZones, planLayoutFirstZones } from './layout-first-zones'
import { reserveLayoutFirstCivics, resurveyLayoutFirstHospital, hospitalRepairReport } from './layout-first-civic'
import { surveyLayoutFirstRail } from './layout-first-rail'
import { buildLayoutFirstRoads } from './layout-first-roads'
import { augmentLayoutFirstRegional } from './layout-first-regional'
import { developLayoutFirstLand } from './layout-first-land'
import { buildLayoutFirstCover } from './layout-first-cover'
import { layoutFirstCoverHistory } from './layout-first-cover-history'
import { buildingServiceYears } from './building-lifecycle'
import { shoppingStreetHistory } from './commercial-history'
import { buildLayoutFirstDistricts } from './layout-first-districts'
import { createCityTimeline, sliceCityAtYear } from './timeline'
import { planSubway } from './subway'
import { extractStreetBlocks, materializeRoadJunctions } from './road-graph'
import { certifyLayoutAccess } from './layout-first-access'
import { LAYOUT_GENERATOR_VERSION } from './layout-first-types'
import type { LayoutFirstZone } from './layout-first-types'
import { layoutThroughRoadHistory } from './layout-first-road-designations'
import { regionQuery } from './region-query'

export { LAYOUT_GENERATOR_VERSION } from './layout-first-types'
const reports = new WeakMap<CityMap, { composition: { input: 'configuration-and-terrain-only'; inheritedRoads: 0; inheritedParcels: 0; inheritedBuildings: 0; center: Point; stationDoors: Point[]; streetBlocks: number }; zones: number; planningZones: readonly LayoutFirstZone[]; transport: ReturnType<typeof buildLayoutFirstRoads>['diagnostics']; rail: ReturnType<typeof surveyLayoutFirstRail>['diagnostics']; land: ReturnType<typeof developLayoutFirstLand>['metrics']; regional: ReturnType<typeof augmentLayoutFirstRegional>['diagnostics'] }>()
export const layoutGenerationReport = (map: CityMap) => reports.get(map)
const facilityOpening: Record<FacilityKind, number> = { castle: 1650, shrine: 1650, onsen: 1650, port: 1920, shop: 1700, school: 1875, police: 1880, hospital: 1920, park: 1955, university: 1965 }
const areaOpening = (area: Area) => area.id.startsWith('station-') ? 1900 : area.id.startsWith('facility-') ? facilityOpening[(Object.keys(facilityOpening) as FacilityKind[]).find(kind => area.id.includes(kind)) ?? 'park'] : 1650

/** Bucket complete polygons, rather than scanning every river bank per lot. */
function regionIndex(regions: readonly PolygonRegion[], cellSize = 120) {
  const bins = new Map<string, { region: PolygonRegion; bounds: Bounds }[]>()
  const large: { region: PolygonRegion; bounds: Bounds }[] = []
  for (const region of regions) {
    const bounds = boundsOf(region.polygon), value = { region, bounds }
    const x0 = Math.floor(bounds.minX / cellSize), x1 = Math.floor(bounds.maxX / cellSize), y0 = Math.floor(bounds.minY / cellSize), y1 = Math.floor(bounds.maxY / cellSize)
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 1000) { large.push(value); continue }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const key = `${x}:${y}`, list = bins.get(key) ?? []; list.push(value); bins.set(key, list) }
  }
  return (polygon: Point[]) => {
    const bounds = boundsOf(polygon), candidates = new Set(large.filter(value => overlaps(bounds, value.bounds)))
    for (let y = Math.floor(bounds.minY / cellSize); y <= Math.floor(bounds.maxY / cellSize); y++) for (let x = Math.floor(bounds.minX / cellSize); x <= Math.floor(bounds.maxX / cellSize); x++) for (const value of bins.get(`${x}:${y}`) ?? []) if (overlaps(bounds, value.bounds)) candidates.add(value)
    return [...candidates].some(value => polygonOverlapsRegion(polygon, value.region))
  }
}

/** Physical frames are replaced; a continuing institution is not an immortal building. */
function civicBuildingHistory(buildings: Building[], seed: string, throughYear: number): TimelineVersion<Building>[] {
  return buildings.flatMap(building => {
    const from = building.builtYear ?? 1650
    // Preserved castle masonry/keeps are explicitly historical monuments.
    if (building.id.startsWith('castle-') || from >= 1980) return [{ from, value: building }]
    const versions: TimelineVersion<Building>[] = []
    let opening = from, generation = 0
    while (opening <= throughYear) {
      const center = building.polygon.reduce((sum, p) => ({ x: sum.x + p.x / building.polygon.length, y: sum.y + p.y / building.polygon.length }), { x: 0, y: 0 })
      const scale = opening < 1900 ? .78 : opening < 1955 ? .9 : 1
      const value = { ...building, id: generation ? `${building.id}-replacement-${opening}` : building.id, builtYear: opening,
        height: opening < 1900 ? Math.min(2, building.height) : opening < 1955 ? Math.min(3, building.height) : building.height,
        polygon: scale === 1 ? building.polygon : building.polygon.map(p => ({ x: center.x + (p.x - center.x) * scale, y: center.y + (p.y - center.y) * scale })) }
      const renewal = Math.min(opening + buildingServiceYears(seed, value), throughYear + 1)
      versions.push({ from: opening, ...(renewal <= throughYear ? { to: renewal } : {}), value })
      opening = renewal; generation++
    }
    return versions
  })
}

/** Spatial final form first. History only dates physically surveyed geometry. */
export function generateLayoutCity(input: CityConfig, onProgress?: (label: string) => void, onPreview?: (map: CityMap) => void, terrainSource: GenerationTerrainSource = createTerrainModel): CityMap {
  const resolved = resolveGenerationConfig(input), requestedYear = resolved.year
  const config: CityConfig = { ...resolved.config, cityEngine: 'layout', targetYear: 2025 }
  const { width, height, terrainInput } = resolved
  const terrain = terrainSource({ ...terrainInput, onTerrainPreview: terrainGenerationPreview(config, onProgress, onPreview) })
  const world = terrain.hydrology
  const cellSize = 25, columns = width / cellSize + 1, rows = height / cellSize + 1, elevations: number[] = []
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) elevations.push(Math.round(terrain.elevation({ x: x * cellSize, y: y * cellSize }) * 100) / 100)
  const terrainSurface = { cellSize, columns, rows, elevations }
  const stride = 3, regionalElevations: number[] = []
  for (let y = 0; y < world.rows; y += stride) for (let x = 0; x < world.columns; x += stride) regionalElevations.push(world.rawDEM[y * world.columns + x]!)
  const { worldAnchor, localAnchor, angle, mirrored } = world.frame, mirror = mirrored ? -1 : 1, c = Math.cos(angle), s = Math.sin(angle)
  const crop = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }].map(p => {
    const dx = (p.x - localAnchor.x) * mirror, dy = p.y - localAnchor.y
    return { x: worldAnchor.x + c * dx - s * dy, y: worldAnchor.y + s * dx + c * dy }
  })
  const regionalContext = { surface: { columns: Math.floor((world.columns - 1) / stride) + 1, rows: Math.floor((world.rows - 1) / stride) + 1, cellSize: world.resolution * stride, elevations: regionalElevations }, extent: world.extent, crop }
  const naturalAreas = terrain.areas.map(area => ({ ...area, ...(area.id === 'river' ? { name: `${config.name.replace(/[市町村]$/, '')}川` } : {}) }))
  const frame = (partial: Partial<CityMap>, previewPhase: CityMap['previewPhase']): CityMap => ({ width, height, config, generatorVersion: LAYOUT_GENERATOR_VERSION, year: 2025, terrainSurface, regionalContext, areas: naturalAreas, buildings: [], roads: [], railways: [], stations: [], facilities: [], districts: [], description: '街区から設計', ...partial, previewPhase })
  onPreview?.(frame({}, 'hydrology'))
  onProgress?.('低地・斜面と両岸の住区を選定中…')
  const brief = planLayoutFirstZones({ config, width, height, terrain })
  onProgress?.('学校・公園・病院などの用地を先に確保中…')
  const civicInput = { config, width, height, terrain, ...brief }
  let civic = reserveLayoutFirstCivics(civicInput)
  // Forest is cleared only on actual adopted grounds by the cover stage. It is
  // not an immutable obstacle to surveying future urban infrastructure.
  const planningAreas = [...naturalAreas.filter(area => area.kind === 'water'), ...civic.areas]
  const planningTerrain = { ...terrain, areas: planningAreas }
  onProgress?.('連続する本線と駅舎・駅前広場を測量中…')
  const rail = surveyLayoutFirstRail({ config, width, height, terrain: planningTerrain, ...brief, reserves: civic.reserves })
  if (config.railway && (!rail.railways.length || config.stations > 0 && !rail.stations.length)) {
    throw new Error('地形に沿う本線と駅の用地を確保できませんでした。生成を中止しました。', { cause: { rail: rail.diagnostics } })
  }
  const reserves = [...civic.reserves, ...rail.stationGrounds]
  let reservedAt = regionQuery(reserves)
  // The brief cannot invent a station neighbourhood before rail has acquired
  // a door and a public gate. Land intensity is measured from these real doors
  // through the connected public streets after their blocks have been built.
  const plannedZones = [...brief.zones, ...planLayoutFirstStationZones({ config, width, height, terrain, zones: brief.zones, stations: rail.stations, gates: rail.accessTargets })]
  onProgress?.('外へ続く幹線・橋と住区内の街路を接続中…')
  const transport = buildLayoutFirstRoads({ seed: config.seed, center: brief.center, settlement: config.settlement, density: config.density, arterial: config.arterial, zones: plannedZones, railways: rail.railways, reservedRegions: reserves,
    accessTargets: [...civic.accessTargets, ...rail.accessTargets], environment: { width, height, core: null, areas: planningAreas, terrain: planningTerrain, bridgeSites: terrain.bridgeSites, exactLandCost: true, landCost: p => reservedAt(p) ? Infinity : 0 } })
  // The street survey may acquire physically enclosed infill ground between
  // the original neighbourhood briefs. Develop and clear that accepted frame,
  // rather than treating initial planning outlines as permanent urban holes.
  const zones = transport.zones
  const regional = augmentLayoutFirstRegional({ config, width, height, terrain: planningTerrain, areas: planningAreas, reserves, railways: rail.railways, transport })
  let roads: Road[] = materializeRoadJunctions([...regional.roads, ...civic.roads, ...rail.stationPaths])
  let access = certifyLayoutAccess({ width, height, roads, targets: [...civic.accessTargets, ...rail.accessTargets] })
  if (access.unserved.includes('facility-access-hospital') || civic.unplacedFacilities.some(item => item.kind === 'hospital')) {
    // A physically dry campus can still face an impassable approach. Re-survey
    // only that programme against actual public pavement, retaining all other
    // surveyed sites, roads and the same already-computed terrain.
    const revised = resurveyLayoutFirstHospital(civicInput, civic, roads, rail.railways, rail.stationGrounds)
    if (revised !== civic) {
      civic = revised
      reserves.splice(0, reserves.length, ...civic.reserves, ...rail.stationGrounds)
      reservedAt = regionQuery(reserves)
      planningAreas.splice(0, planningAreas.length, ...naturalAreas.filter(area => area.kind === 'water'), ...civic.areas)
      roads = materializeRoadJunctions([...regional.roads, ...civic.roads, ...rail.stationPaths])
      access = certifyLayoutAccess({ width, height, roads, targets: [...civic.accessTargets, ...rail.accessTargets] })
      transport.diagnostics.unservedAccessIds = transport.diagnostics.unservedAccessIds.filter(id => access.unserved.includes(id))
    }
  }
  // A small supplementary park must not strand a complete city programme.
  // Keep only satellite grounds whose actual entrance was connected; selected
  // primary facilities retain the strict completion requirement below.
  const omitted = civic.optionalProgrammes.filter(programme => access.unserved.includes(programme.accessId))
  if (omitted.length) {
    const facilityIds = new Set(omitted.map(programme => programme.facilityId)), areaIds = new Set(omitted.flatMap(programme => programme.areaIds)), roadIds = new Set(omitted.flatMap(programme => programme.roadIds)), accessIds = new Set(omitted.map(programme => programme.accessId)), ground = new Set(omitted.flatMap(programme => programme.reserves))
    civic.facilities = civic.facilities.filter(facility => !facilityIds.has(facility.id))
    civic.areas = civic.areas.filter(area => !areaIds.has(area.id))
    civic.roads = civic.roads.filter(road => !roadIds.has(road.id))
    civic.accessTargets = civic.accessTargets.filter(target => !accessIds.has(target.id))
    reserves.splice(0, reserves.length, ...reserves.filter(region => !ground.has(region)))
    reservedAt = regionQuery(reserves)
    roads = roads.filter(road => !roadIds.has(road.id))
    transport.diagnostics.unservedAccessIds = transport.diagnostics.unservedAccessIds.filter(id => !accessIds.has(id))
    access = certifyLayoutAccess({ width, height, roads, targets: [...civic.accessTargets, ...rail.accessTargets] })
  }
  // Show the actual surveyed transport stage even when a later completion
  // check must stop generation. A preview never certifies a completed city.
  onPreview?.(frame({ roads, areas: [...naturalAreas, ...civic.areas, ...rail.stationGrounds], railways: rail.railways, stations: rail.stations, buildings: civic.buildings, facilities: civic.facilities }, 'roads'))
  if (access.unserved.length) {
    const names = [...new Set(access.unserved.map(id => civic.facilities.find(facility => id.includes(facility.kind))?.name ?? (id.startsWith('station-') ? '駅前広場' : '公共施設')))]
    throw new Error(`${names.join('・')}への道を、外へ続く公道に接続できませんでした。生成を中止しました。`, { cause: { access, transport: transport.diagnostics, hospitalRepair: hospitalRepairReport(civic), outsideRoads: roads.filter(road => road.boundaryContinuation).map(road => ({ id: road.id, builtYear: road.builtYear, from: road.points[0], to: road.points.at(-1) })) } })
  }
  const designatedRoadHistory: TimelineVersion<Road>[] = config.arterial ? layoutThroughRoadHistory(roads, width, height) : roads.map(value => ({ from: value.builtYear ?? 1650, value }))
  roads = designatedRoadHistory.filter(version => version.to === undefined).map(version => version.value)
  onPreview?.(frame({ roads, areas: [...naturalAreas, ...civic.areas, ...rail.stationGrounds], railways: rail.railways, stations: rail.stations, buildings: civic.buildings, facilities: civic.facilities }, 'roads'))
  const railwayRegions = rail.railways.flatMap(line => line.points.slice(1).map((p, i) => ({ polygon: corridorPolygon(line.points[i]!, p, 7) })))
  const blocked = regionIndex([...planningAreas.filter(area => area.kind === 'water'), ...reserves, ...railwayRegions])
  const physicalLand = (polygon: Point[]) => {
    if (polygon.some(p => p.x < 1 || p.y < 1 || p.x > width - 1 || p.y > height - 1) || blocked(polygon)) return false
    const b = boundsOf(polygon)
    for (let y = b.minY; y <= b.maxY; y += 10) for (let x = b.minX; x <= b.maxX; x += 10) if (pointInPolygon({ x, y }, polygon) && (terrain.waterAt({ x, y }) || terrain.slope({ x, y }) > .16)) return false
    return polygon.every(p => !terrain.waterAt(p) && terrain.slope(p) <= .16)
  }
  onProgress?.('街区の奥行きに合わせて宅地・店舗・集合住宅を配置中…')
  // Civic paths, station approaches and regional roads have now been adopted.
  // Their cuts change the real faces; the transport draft is no longer the
  // final cadastral frame supplied to land development.
  const blocks = extractStreetBlocks(roads).map((polygon, i) => ({ id: `layout-block-${i}`, polygon }))
  const land = developLayoutFirstLand({ config, roads, zones, center: transport.center, stations: rail.stations, blocks, reserves, canPlace: physicalLand, slope: terrain.slope, elevation: terrain.elevation })
  onProgress?.('農地・森林・草地と市街地の境界を整備中…')
  const coverInput = { config, width, height, terrain: { ...terrain, areas: [...naturalAreas, ...civic.areas.filter(area => area.kind === 'water')] }, zones, parcels: land.parcels, roads, reserves, buildings: [...land.buildings, ...civic.buildings] }
  const cover = buildLayoutFirstCover(coverInput)
  const civicGrounds = civic.areas.filter(area => area.kind !== 'water')
  const areas: Area[] = [...cover, ...civicGrounds, ...rail.stationGrounds]
  const civicHistory = civicBuildingHistory(civic.buildings, config.seed, 2025)
  const buildings = [...land.buildings, ...civicHistory.filter(version => version.to === undefined).map(version => version.value)]
  const roadHistory: TimelineVersion<Road>[] = designatedRoadHistory.flatMap(version => {
    const { from, to, value: road } = version
    if (from >= 1955 || road.width <= 5 || road.role === 'bridge' || road.role === 'access') return [version]
    // A designation change cannot widen a physical cross-section. Only the
    // separate 1955 pavement update changes this dated width.
    const historicWidth = Math.min(road.width, road.width >= 10 ? 6 : 4.5)
    if (to !== undefined && to <= 1955) return [{ ...version, value: { ...road, width: historicWidth } }]
    return [{ from, to: 1955, value: { ...road, width: historicWidth } }, { from: 1955, ...(to === undefined ? {} : { to }), value: { ...road, modifiedYear: 1955, reason: '既存の街路用地内で拡幅・舗装を更新' } }]
  })
  const shopHistory = config.facilities.includes('shop') ? shoppingStreetHistory({ buildings: land.history.buildings, parcels: land.history.parcels, roads: roadHistory, name: '中央商店街', throughYear: 2025 }) : []
  const coverHistory = layoutFirstCoverHistory({ input: coverInput, finalCover: cover, roadHistory, reserveDates: reserves.map(region => {
    const area = [...civic.areas, ...rail.stationGrounds].find(area => area.polygon === region.polygon)
    return { region, from: area ? areaOpening(area) : 1650 }
  }) })
  const facilities = [...civic.facilities, ...shopHistory.filter(v => v.to === undefined).map(v => v.value)]
  const missing = config.facilities.filter(kind => !facilities.some(facility => facility.kind === kind))
  if (missing.length) {
    const labels: Record<FacilityKind, string> = { castle: '城跡', shrine: '寺社', school: '学校', university: '大学', hospital: '病院', police: '警察署', shop: '商店街', park: '公園', port: '港', onsen: '温泉街' }
    throw new Error(`${missing.map(kind => labels[kind]).join('・')}の用地と接道を確保できませんでした。生成を中止しました。`, { cause: { missing, unplaced: civic.unplacedFacilities, access, transport: transport.diagnostics } })
  }
  const subway = planSubway({ config, throughYear: 2025, roads: roadHistory, buildings: land.history.buildings, stations: rail.stations, terrain })
  const railways = [...rail.railways, ...(subway ? [subway.railway] : [])], stations = [...rail.stations, ...(subway?.stations ?? [])]
  onProgress?.('町域と建て替え・道路改良の年代を記録中…')
  const districts = buildLayoutFirstDistricts({ width, height, config, roads, blocks, parcels: land.parcels, areas, stations, facilities })
  const civicEvents = civicHistory.flatMap((version): GrowthEvent[] => [
    { id: `event-${version.value.id}-construction`, year: version.from, entityId: version.value.id, kind: 'construction', reason: `${version.value.name ?? '公共施設の建物'}の建築` },
    ...(version.to === undefined ? [] : [{ id: `event-${version.value.id}-demolition`, year: version.to, entityId: version.value.id, kind: 'demolition' as const, reason: '建て替えに伴う旧建物の解体' }]),
  ])
  const events = [...land.events, ...civicEvents, ...roads.map(road => ({ id: `event-${road.id}`, year: road.builtYear ?? 1650, entityId: road.id, kind: 'road' as const, reason: road.reason ?? '地形と街区に沿った街路整備' })), ...railways.map(line => ({ id: `event-${line.id}`, year: line.builtYear ?? 1900, entityId: line.id, kind: 'railway' as const, reason: line.mode === 'subway' ? '既存市街地を結ぶ地下鉄の開通' : '地域を通る鉄道路線の開通' }))]
  const stages = [1650, 1900, 1955, 1975, 1995, 2025]
  const growthLog = stages.map((year, i) => ({ phase: `${year}年`, year, roadsAdded: roadHistory.filter(v => v.from <= year && v.from > (stages[i - 1] ?? 1649) && v.value.modifiedYear !== v.from).length, reason: year === 1650 ? '旧市街と地域街道' : year === 1900 ? '鉄道開通と駅前市街' : '測量した住区の開発と既存建物の建て替え' }))
  const map: CityMap = { width, height, config, roads, buildings, areas, railways, stations, facilities, districts, parcels: land.parcels, blocks, events, growthLog, terrainSurface, regionalContext, year: 2025, generatorVersion: LAYOUT_GENERATOR_VERSION, description: '地形・外部交通・公共施設の用地を先に確保し、街区と敷地を組み立てた地図。',
    unplacedFacilities: config.facilities.filter(kind => !facilities.some(f => f.kind === kind)).map(kind => ({ kind, reason: civic.unplacedFacilities.find(item => item.kind === kind)?.reason ?? (kind === 'shop' ? '連続した店舗の接道を確保できませんでした。' : '測量した候補地を公道に接続できませんでした。') })),
    terrainSimulation: { resolution: world.resolution, steps: world.erosion.iterations, elapsedYears: world.erosion.elapsedYears, bedrockErodedVolume: world.sediment.erodedSourceVolume, storedSedimentVolume: world.sediment.storedVolume, exportedSedimentVolume: world.sediment.exportedVolume, sedimentBalanceError: world.sediment.massBalanceError, groundBalanceError: world.erosion.terrainBalanceError, localExcavationVolume: world.bankSediment?.totalExcavationVolume ?? 0, localDepositionVolume: world.bankSediment?.depositedVolume ?? 0, localExportedVolume: world.bankSediment?.totalExportedVolume ?? 0, localBalanceError: world.bankSediment?.totalMassBalanceError ?? 0 } }
  map.timeline = createCityTimeline(map, { roads: roadHistory, buildings: [...land.history.buildings, ...civicHistory], parcels: land.history.parcels, buildingStates: land.history.buildingStates,
    facilities: [...civic.facilities.map(value => ({ from: facilityOpening[value.kind], value })), ...shopHistory],
    areas: [...coverHistory, ...civicGrounds.map(value => ({ from: areaOpening(value), value })), ...rail.stationGrounds.map(value => ({ from: 1900, value }))] })
  onPreview?.(frame(map, 'development'))
  const result = sliceCityAtYear(map, requestedYear)
  reports.set(result, { composition: { input: 'configuration-and-terrain-only', inheritedRoads: 0, inheritedParcels: 0, inheritedBuildings: 0, center: transport.center, stationDoors: rail.stations.map(station => station.entrance ?? station.point), streetBlocks: blocks.length }, zones: zones.length, planningZones: zones, transport: transport.diagnostics, rail: rail.diagnostics, land: land.metrics, regional: regional.diagnostics })
  return result
}
