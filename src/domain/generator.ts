import type { Area, Building, CityConfig, CityMap, CityType, Facility, FacilityKind, Point, Road } from './types'
import { createTerrainModel } from './terrain'
import { simulateUrbanGrowth } from './urban-growth'
import { boundsOf, distance, distanceToSegment, overlaps, pathPointAt, pointInPolygon, polygonsOverlap, projectPoint, rectangle, segmentsCross } from './geometry'
import type { Bounds } from './geometry'
import { developLand, EPOCH_YEAR, GENERATOR_VERSION } from './land-development'
import { extractStreetBlocks } from './road-graph'
import { planRailway } from './railway-planner'
import { RoadPlanner } from './road-planner'

export const DEFAULT_CONFIG: CityConfig = {
  name: '水杜市', seed: 'minato-2026', type: 'castle', terrain: 'river', density: 65, forest: 30,
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
const W = 4000, H = 3000
const facilityNames: Record<FacilityKind, string> = { shrine: '八幡神社', school: '第一小学校', hospital: '市民病院', police: '中央交番', shop: '中央商店街', park: 'ふれあい公園', castle: '城跡公園', port: '港・魚市場', onsen: '共同浴場' }
const facilityInception: Record<FacilityKind, number> = { shrine: 1650, school: 1875, hospital: 1920, police: 1880, shop: 1700, park: 1955, castle: 1650, port: 1650, onsen: 1650 }
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

function spatialIndex<T extends { bounds: Bounds }>(size = 100) {
  const buckets = new Map<string, T[]>()
  const keys = function* (b: Bounds) { for (let x = Math.floor(b.minX / size); x <= Math.floor(b.maxX / size); x++) for (let y = Math.floor(b.minY / size); y <= Math.floor(b.maxY / size); y++) yield `${x},${y}` }
  return {
    add(item: T) { for (const key of keys(item.bounds)) { const bucket = buckets.get(key) ?? []; bucket.push(item); buckets.set(key, bucket) } },
    query(bounds: Bounds) { const found = new Set<T>(); for (const key of keys(bounds)) for (const item of buckets.get(key) ?? []) if (overlaps(bounds, item.bounds)) found.add(item); return found },
  }
}

/** Geographic suitability, transport history, then demand-led street and frontage growth. */
export function generateCity(input: CityConfig, onProgress?: (label: string) => void): CityMap {
  const config: CityConfig = { ...input, facilities: [...input.facilities], density: clamp(input.density, 0, 100), forest: clamp(input.forest, 0, 100), stations: clamp(Math.round(input.stations), 1, 5), era: input.era ?? 'present' }
  if ((config.type === 'port' || config.facilities.includes('port')) && config.terrain === 'plain') config.terrain = 'coast'
  const year = EPOCH_YEAR[config.era ?? 'present']
  onProgress?.('広域の地形と水系を計算中…')
  const terrain = createTerrainModel({ width: W, height: H, seed: config.seed, terrain: config.terrain, forest: config.forest, type: config.type })
  const origin = terrain.cityOrigin, areas: Area[] = [...terrain.areas], facilities: Facility[] = [], buildings: Building[] = []
  for (const area of areas) if (area.id === 'river') area.name = `${config.name.replace(/[市町村]$/, '')}川`
  const hasCore = config.type === 'castle' || config.type === 'temple'
  const core: Point[] | null = hasCore ? [{ x: -205, y: -135 }, { x: -85, y: -180 }, { x: 125, y: -165 }, { x: 205, y: -55 }, { x: 185, y: 145 }, { x: 40, y: 190 }, { x: -155, y: 155 }, { x: -215, y: 40 }].map(p => ({ x: origin.x + p.x, y: origin.y + p.y })) : null
  if (core) {
    const kind = config.type === 'castle' ? 'castle' : 'shrine', selected = config.facilities.includes(kind)
    const name = kind === 'castle' ? `${config.name.replace(/[市町村]$/, '')}城跡` : '水明大社'
    areas.push({ id: 'historic-core', polygon: core, kind: 'park', name: selected ? name : undefined })
    if (selected) facilities.push({ id: 'origin', point: origin, kind, name })
    if (kind === 'castle') {
      const outer = core.map(p => ({ x: origin.x + (p.x - origin.x) * .67, y: origin.y + (p.y - origin.y) * .67 }))
      const inner = outer.map(p => ({ x: origin.x + (p.x - origin.x) * .82, y: origin.y + (p.y - origin.y) * .82 }))
      for (let i = 0; i < outer.length; i++) areas.push({ id: `moat-${i}`, kind: 'water', polygon: [outer[i]!, outer[(i + 1) % outer.length]!, inner[(i + 1) % inner.length]!, inner[i]!] })
    }
  }

  const railways: CityMap['railways'] = [], stations: CityMap['stations'] = []
  onProgress?.('鉄道の経路を計算中…')
  if (config.railway && config.era !== 'historic') {
    const railwayPlan = planRailway({ width: W, height: H, seed: config.seed, origin, terrain, core })
    if (!railwayPlan) throw new Error('この地形では鉄道の勾配・曲率条件を満たす経路を確保できませんでした。鉄道を外すか、シードを変更してください。')
    const points = railwayPlan.points
    const base = config.name.replace(/[市町村]$/, '')
    railways.push({ id: 'railway-main', name: `${base}線`, points, elevations: railwayPlan.elevations, structures: railwayPlan.structures })
    for (let i = 0; i < config.stations; i++) {
      const t = (i + 1) / (config.stations + 1)
      let point = pathPointAt(points, t)
      for (let attempt = 0; attempt < 20 && (terrain.waterAt(point) || areas.some(a => a.kind !== 'field' && pointInPolygon(point, a.polygon))); attempt++) point = pathPointAt(points, clamp(t + (attempt % 2 ? -1 : 1) * Math.ceil(attempt / 2 + 1) * .008, .07, .93))
      const name = i === Math.floor(config.stations / 2) ? `${base}駅` : `${i < config.stations / 2 ? '北' : '南'}${base}${config.stations > 3 && i > 0 && i < config.stations - 1 ? '本町' : ''}駅`
      stations.push({ id: `station-${i}`, name, point })
    }
  }
  const growth = simulateUrbanGrowth({ width: W, height: H, seed: config.seed, type: config.type, center: origin, core, areas, arterial: config.arterial, railway: config.railway && config.era !== 'historic', stationPoints: stations.map(s => s.point), terrainModel: terrain, bridgeSites: terrain.bridgeSites, era: config.era, density: config.density, onProgress: year => onProgress?.(`街路・土地利用を計算 · ${year}年`) })
  const roads: Road[] = growth.roads
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
  const obstacle = (area: Area, year = 0) => ({ polygon: area.polygon, bounds: boundsOf(area.polygon), year })
  const obstacles = areas.filter(a => a.kind !== 'field').map(a => obstacle(a))
  const footprints = spatialIndex<{ building: Building; bounds: Bounds }>()
  const reserves: (Bounds & { year: number })[] = []
  const canBuild = (polygon: Point[], checkReserve = true, asOf: number = year) => {
    const bounds = boundsOf(polygon)
    if (bounds.minX < 18 || bounds.maxX > W - 18 || bounds.minY < 18 || bounds.maxY > H - 18 || (checkReserve && reserves.some(b => b.year <= asOf && overlaps(b, bounds)))) return false
    if (obstacles.some(o => o.year <= asOf && overlaps(bounds, o.bounds) && polygonsOverlap(polygon, o.polygon))) return false
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
  const nearestRoad = (point: Point) => {
    let best: { road: Road; point: Point; segment: number; distance: number } | null = null
    for (const road of roads) if (!road.bridge && road.role !== 'farm') for (let i = 1; i < road.points.length; i++) {
      const p = projectPoint(point, road.points[i - 1]!, road.points[i]!), d = distance(p, point)
      if (!best || d < best.distance) best = { road, point: p, segment: i, distance: d }
    }
    return best
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
  for (const [index, kind] of [...new Set(config.facilities)].filter(kind => facilityInception[kind] <= year && !facilities.some(f => f.kind === kind)).entries()) {
    const target = kind === 'port' ? { x: origin.x + 240, y: origin.y } : kind === 'shop' && stations.length ? stations[Math.floor(stations.length / 2)]!.point : { x: origin.x + Math.cos(index * 2.4) * 520, y: origin.y + Math.sin(index * 2.4) * 460 }
    const sites = kind === 'port' ? candidates.filter(p => terrain.slope(p) < .18 && canBuild(rectangle(p.x - 32, p.y - 32, 64, 64), false)).map(point => ({ point, access: nearestRoad(point) })).filter(c => c.access && c.access.distance > 36 && c.access.distance < 1600) : available
    const ranked = sites.filter(c => facilities.every(f => distance(f.point, c.point) > 155)).filter(c => {
      const p = c.point
      if (kind !== 'port' || config.terrain === 'plain') return true
      let bank = Infinity
      for (const water of areas.filter(a => a.id === 'river' || a.id === 'sea')) for (let i = 0; i < water.polygon.length; i++) bank = Math.min(bank, distanceToSegment(p, water.polygon[i]!, water.polygon[(i + 1) % water.polygon.length]!))
      return bank > 35 && bank < 175
    }).filter(c => c.access && canBuild(facilityLot(kind, c.point, c.access).campus, false)).sort((a, b) => distance(a.point, target) - distance(b.point, target))
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
    reserves.push({ ...boundsOf(lot.campus), year: driveway.builtYear! })
    if (kind === 'shrine' || kind === 'park') {
      const area: Area = { id: `facility-lot-${kind}`, kind: 'park', polygon: lot.campus, name: kind === 'park' ? name : undefined }
      areas.push(area); obstacles.push(obstacle(area, driveway.builtYear))
    } else {
      addBuilding({ id: `facility-building-${kind}`, polygon: lot.building, kind: kind === 'port' ? 'industrial' : kind === 'shop' ? 'commercial' : 'public', height: kind === 'hospital' ? 5 : kind === 'school' ? 3 : 2, builtYear: driveway.builtYear }, false)
      if (kind === 'school') { const yard: Area = { id: 'school-yard', kind: 'park', polygon: lot.schoolYard }; areas.push(yard); obstacles.push(obstacle(yard, driveway.builtYear)) }
    }
  }

  onProgress?.('敷地と住宅・建替えを計算中…')
  const development = developLand({ config, roads, center: origin, stations, centers: growth.centers,
    canPlace: (polygon, asOf) => canBuild(polygon, true, asOf), slope: terrain.slope })
  for (const building of development.buildings) {
    buildings.push(building)
    footprints.add({ building, bounds: boundsOf(building.polygon) })
  }

  // Lowland agriculture predates the town. A coherent irrigation/ownership layout
  // is generated independently of current buildings; later transport and development
  // convert whole cultivation plots. Missing plots therefore reflect land conversion.
  onProgress?.('耕地の転用と地図の仕上げ…')
  const convertedLand = spatialIndex<{ polygon: Point[]; bounds: Bounds }>()
  for (const p of development.parcels.filter(p => p.developedYear)) convertedLand.add({ polygon: p.polygon, bounds: boundsOf(p.polygon) })
  const inheritedRoads = roads.filter(r => (r.builtYear ?? 1650) <= 1650 && !r.bridge)
  const river = terrain.rivers[0], first = river?.points[0], last = river?.points.at(-1)
  const fieldAngle = first && last ? Math.atan2(last.y - first.y, last.x - first.x) - Math.PI / 2 : 0
  const co = Math.cos(fieldAngle), si = Math.sin(fieldAngle)
  const survey = (x: number, y: number) => ({ x: W / 2 + x * co - y * si, y: H / 2 + x * si + y * co })
  for (let row = -45; row <= 45; row++) for (let col = -45; col <= 45; col++) {
    const localX = col * 66, localY = row * 44, center = survey(localX + 33, localY + 22)
    if (center.x < 0 || center.x > W || center.y < 0 || center.y > H || !terrain.cultivable(center)) continue
    const accessible = inheritedRoads.some(r => r.points.slice(1).some((b, i) => distanceToSegment(center, r.points[i]!, b) < 550))
    if (!accessible) continue
    const polygon = [survey(localX + 1, localY + 1), survey(localX + 65, localY + 1), survey(localX + 65, localY + 43), survey(localX + 1, localY + 43)], bounds = boundsOf(polygon)
    if (!polygon.every(p => terrain.cultivable(p)) || !canBuild(polygon) || [...convertedLand.query(bounds)].some(f => polygonsOverlap(polygon, f.polygon))) continue
    areas.push({ id: `cultivation-${col}-${row}`, kind: 'field', polygon })
  }
  const names = ['本町', '新町', '桜町', '西町', '東町', '緑ヶ丘', '南台']
  const districts: CityMap['districts'] = growth.centers.filter(c => c.kind !== 'industrial').map((center, i) => ({ id: `district-${i}`, point: { x: clamp(center.point.x + 180, 140, W - 140), y: clamp(center.point.y + 150, 160, H - 160) }, name: `${names[i % names.length]}${i > 6 ? Math.floor(i / 7) + 1 : ''}` }))
  return { width: W, height: H, config, buildings, roads, areas, railways, stations, facilities, districts, description: CITY_PRESETS.find(p => p.id === config.type)!.description, growthLog: growth.growthLog, generatorVersion: GENERATOR_VERSION, year,
    parcels: development.parcels, snapshots: development.snapshots, blocks,
    events: [
      ...roads.map(r => ({ id: `event-${r.id}`, year: r.builtYear ?? 1650, kind: 'road' as const, entityId: r.id, reason: r.reason ?? '初期の広域街道' })),
      ...railways.map(r => ({ id: `event-${r.id}`, year: 1900, kind: 'railway' as const, entityId: r.id, reason: '地域鉄道の開通' })),
      ...development.events,
    ] }
}
