import type { CityConfig, CityMap, Point, TerrainSurface, TimelineVersion } from './types'
import { sliceCityAtYear } from './timeline'
import { readableProvisionalNames } from './place-names'
import { validateMapEdits } from './map-edits'
import { encodeCompactProject, decodeCompactProject } from './project-compact'
import type { MapEdit } from './map-edits'
import type { Annotation, LayerSettings, MapStyle } from '../map/render'

export interface Project {
  version: 2
  config: CityConfig
  annotations: Annotation[]
  layers: LayerSettings
  style: MapStyle
  /** Completed geometry is authoritative; importing it must not run a newer engine. */
  snapshot?: CityMap
  /** Dated manual overlays. Never merge these into the generated snapshot. */
  edits?: MapEdit[]
}

export const STORAGE_KEY = 'machitsumugi.project.v2'
export const LEGACY_STORAGE_KEY = 'machitsumugi.project.v1'
// The 12 × 9 km preset covers nine small maps. Farmland and the full development
// history must survive export too; these limits bound imports without truncating
// that geometry. The combined budgets still apply across all individual arrays.
// The completed dense native12×9km compact-v2 wire is321,162,824 UTF8 bytes
// and321,158,394 characters. Retain finite transport headroom without dropping
// dated geometry; per-engine domain and individual geometry budgets follow.
export const MAX_PROJECT_FILE_BYTES = 384_000_000
export const MAX_PROJECT_JSON_LENGTH = 360_000_000
export const PROJECT_GEOMETRY_LIMITS = { points: 4_000_000, areaRingPoints: 32_768, entities: 750_000, roads: 100_000, buildings: 200_000, areas: 100_000, blocks: 160_000, parcels: 250_000, events: 300_000 } as const
// The dense continuous engine's completed12×9km project contains8,213,550 point
// occurrences across its entire history. Keep a finite budget for that engine;
// historical/layout projects retain4M.
export const CONTINUOUS_PROJECT_POINT_LIMIT = 9_000_000
// The dense12×9km land checkpoint already contains220,894 current buildings,
// 326,935 building versions and433,882 events: over1.03M portable entities
// before cover history. Keep finite measured headroom for this engine only.
export const CONTINUOUS_PROJECT_ENTITY_LIMITS = { entities: 1_250_000, buildings: 250_000, buildingVersions: 400_000, areaVersions: 200_000, events: 500_000 } as const
export const MAX_LOCAL_STORAGE_LENGTH = 2_000_000
export const ARCHIVE_DATABASE = 'machitsumugi.archive.v1'
const ARCHIVE_STORE = 'projects'
let archiveWrites: Promise<boolean> = Promise.resolve(true)
const CITY_TYPES = ['castle', 'temple', 'port', 'newtown', 'post', 'onsen'] as const
const TERRAINS = ['river', 'plain', 'coast'] as const
const FACILITIES = ['shrine', 'school', 'university', 'hospital', 'police', 'shop', 'park', 'castle', 'port', 'onsen'] as const
const STYLES = ['standard', 'mono', 'night'] as const
const LAYER_KEYS = ['buildings', 'roads', 'railway', 'labels', 'facilities', 'terrain', 'grid'] as const

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}の形式が正しくありません。`)
  return value as Record<string, unknown>
}

function string(value: unknown, label: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maxLength) {
    throw new Error(`${label}は${allowEmpty ? '0' : '1'}〜${maxLength}文字で指定してください。`)
  }
  return value
}

function number(value: unknown, label: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${label}は${min}〜${max}の${integer ? '整数' : '数値'}で指定してください。`)
  }
  return value
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}のオン・オフの指定が正しくありません。`)
  return value
}

function choice<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw new Error(`${label}の値に対応していません。`)
  return value as T
}

function array(value: unknown, label: string, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label}は${limit.toLocaleString()}件以内で指定してください。`)
  return value
}

function configFrom(value: unknown): CityConfig {
  const input = object(value, '街の設定')
  const facilities = array(input.facilities, '施設の一覧', FACILITIES.length).map(item => choice(item, FACILITIES, '施設'))
  if (new Set(facilities).size !== facilities.length) throw new Error('施設の一覧に重複があります。')
  const config: CityConfig = {
    name: string(input.name, '街の名前', 80), seed: string(input.seed, 'シード', 128),
    type: choice(input.type, CITY_TYPES, '街の成り立ち'), terrain: choice(input.terrain, TERRAINS, '地形'),
    density: number(input.density, '建物の密度', 0, 100), forest: number(input.forest, '森林の割合', 0, 100),
    railway: boolean(input.railway, '鉄道'), stations: number(input.stations, '駅の数', 1, 5, true),
    arterial: boolean(input.arterial, '幹線道路'), facilities,
  }
  if (input.era !== undefined) config.era = choice(input.era, ['historic', 'railway', 'present'] as const, '発展段階')
  if (input.cityEngine !== undefined) config.cityEngine = choice(input.cityEngine, ['history', 'layout', 'continuous'] as const, '生成方式')
  if (input.targetYear !== undefined) config.targetYear = number(input.targetYear, '表示年代', 1650, 2025, true)
  if (input.settlement !== undefined) config.settlement = choice(input.settlement, ['village', 'rural-town', 'regional-city', 'metropolis'] as const, '地域の規模')
  if (input.populationTrend !== undefined) config.populationTrend = choice(input.populationTrend, ['declining', 'stable', 'growing'] as const, '人口推移')
  if (input.coastType !== undefined) config.coastType = choice(input.coastType, ['bay', 'ria', 'delta', 'peninsula'] as const, '海岸の成り立ち')
  if (input.relief !== undefined) config.relief = choice(input.relief, ['lowland', 'hills', 'mountains'] as const, '地形の起伏')
  if (input.mapSize !== undefined) config.mapSize = choice(input.mapSize, ['small', 'medium', 'large'] as const, '地図の広さ')
  if (input.expressway !== undefined) config.expressway = boolean(input.expressway, '高速道路')
  if (input.bypass !== undefined) config.bypass = boolean(input.bypass, 'バイパス')
  if (input.subway !== undefined) config.subway = boolean(input.subway, '地下鉄')
  return config
}

function sameConfig(a: CityConfig, b: CityConfig): boolean {
  const normalized = ({ era, relief, ...rest }: CityConfig) => ({ ...rest, era: era ?? 'present', relief: relief ?? 'hills' })
  return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b))
}

/** Linear, bounded validation of a portable snapshot, without running the generator. */
function snapshotFrom(value: unknown, config: CityConfig): CityMap {
  const input = object(value, '保存済み地図')
  const width = number(input.width, '地図の幅', 100, 50_000)
  const height = number(input.height, '地図の高さ', 100, 50_000)
  const snapshotConfig = configFrom(input.config)
  if (!sameConfig(config, snapshotConfig)) throw new Error('街の設定と保存済み地図の設定が一致しません。')
  const pointLimit = config.cityEngine === 'continuous' ? CONTINUOUS_PROJECT_POINT_LIMIT : PROJECT_GEOMETRY_LIMITS.points
  const continuous = config.cityEngine === 'continuous'
  const entityLimit = continuous ? CONTINUOUS_PROJECT_ENTITY_LIMITS.entities : PROJECT_GEOMETRY_LIMITS.entities
  const buildingLimit = continuous ? CONTINUOUS_PROJECT_ENTITY_LIMITS.buildings : PROJECT_GEOMETRY_LIMITS.buildings
  const buildingVersionLimit = continuous ? CONTINUOUS_PROJECT_ENTITY_LIMITS.buildingVersions : PROJECT_GEOMETRY_LIMITS.buildings
  const areaVersionLimit = continuous ? CONTINUOUS_PROJECT_ENTITY_LIMITS.areaVersions : PROJECT_GEOMETRY_LIMITS.areas
  const eventLimit = continuous ? CONTINUOUS_PROJECT_ENTITY_LIMITS.events : PROJECT_GEOMETRY_LIMITS.events
  let pointCount = 0
  let entityCount = 0
  const margin = Math.max(width, height) / 4
  function point(value: unknown, label: string): Point {
    if (++pointCount > pointLimit) throw new Error('保存済み地図の頂点数が上限を超えています。')
    const p = object(value, label)
    // Polygons and routes may cross the map boundary; the renderer clips them.
    return { x: number(p.x, `${label}の横位置`, -margin, width + margin), y: number(p.y, `${label}の縦位置`, -margin, height + margin) }
  }
  function points(value: unknown, label: string, polygon: boolean, polygonLimit = 2048): Point[] {
    const list = array(value, label, polygon ? polygonLimit : 20_000)
    if (list.length < (polygon ? 3 : 2)) throw new Error(`${label}の頂点が不足しています。`)
    const result = list.map(p => point(p, label))
    if (!result.some((p, i) => i > 0 && (p.x !== result[0].x || p.y !== result[0].y))) throw new Error(`${label}の形が正しくありません。`)
    if (polygon) {
      const area = result.reduce((sum, p, i) => { const next = result[(i + 1) % result.length]; return sum + p.x * next.y - next.x * p.y }, 0)
      if (Math.abs(area) < .000001) throw new Error(`${label}の面積がありません。`)
    }
    return result
  }
  function entities<T>(value: unknown, label: string, limit: number, read: (input: Record<string, unknown>, id: string) => T): T[] {
    const ids = new Set<string>()
    return array(value, label, limit).map(item => {
      if (++entityCount > entityLimit) throw new Error('保存済み地図の要素数が上限を超えています。')
      const input = object(item, label), id = string(input.id, `${label}のID`, 128)
      if (ids.has(id)) throw new Error(`${label}のIDに重複があります。`)
      ids.add(id)
      return read(input, id)
    })
  }
  const year = (value: unknown, label: string) => number(value, label, -10_000, 10_000, true)
  const readRoad = (r: Record<string, unknown>, id: string) => ({
      id, points: points(r.points, '道路の形', false), kind: choice(r.kind, ['arterial', 'local'] as const, '道路の種類'), width: number(r.width, '道路の幅', .1, 200),
      ...(r.builtYear === undefined ? {} : { builtYear: year(r.builtYear, '道路の建設年') }),
      ...(r.modifiedYear === undefined ? {} : { modifiedYear: year(r.modifiedYear, '道路の改修年') }),
      ...(r.role === undefined ? {} : { role: choice(r.role, ['highway', 'collector', 'lane', 'access', 'bridge', 'farm', 'expressway', 'ramp'] as const, '道路の役割') }),
      ...(r.level === undefined ? {} : { level: number(r.level, '道路の階層', -10, 10, true) }),
      ...(r.controlledAccess === undefined ? {} : { controlledAccess: boolean(r.controlledAccess, '沿道からの進入制限') }),
      ...(r.boundaryContinuation === undefined ? {} : { boundaryContinuation: boolean(r.boundaryContinuation, '範囲外への道路継続') }),
      ...(r.throughRouteId === undefined ? {} : { throughRouteId: string(r.throughRouteId, '連続幹線の計画ID', 128) }),
      ...(r.reason === undefined ? {} : { reason: string(r.reason, '道路の建設理由', 2000, true) }),
      ...(r.bridge === undefined ? {} : { bridge: boolean(r.bridge, '橋の指定') }),
      ...(r.surveyedBridgeSpans === undefined ? {} : { surveyedBridgeSpans: array(r.surveyedBridgeSpans, '測量済みの橋', 2000).map(value => {
        const span = object(value, '測量済みの橋')
        return { bankA: point(span.bankA, '橋の片岸'), bankB: point(span.bankB, '橋の対岸'), ...(span.riverId === undefined ? {} : { riverId: string(span.riverId, '河川のID', 128) }), ...(span.candidateId === undefined ? {} : { candidateId: string(span.candidateId, '架橋候補のID', 128) }) }
      }) }),
      ...(r.phase === undefined ? {} : { phase: string(r.phase, '道路の成立段階', 128) }),
      ...(r.constructionCost === undefined ? {} : { constructionCost: number(r.constructionCost, '道路の建設費', 0, 1e15) }),
    })
  const readBuilding = (b: Record<string, unknown>, id: string) => ({
      id, polygon: points(b.polygon, '建物の形', true), kind: choice(b.kind, ['residential', 'commercial', 'public', 'industrial'] as const, '建物の種類'), height: number(b.height, '建物の階数', 1, 250, true),
      ...(b.parcelId === undefined ? {} : { parcelId: string(b.parcelId, '建物の敷地ID', 128) }),
      ...(b.builtYear === undefined ? {} : { builtYear: year(b.builtYear, '建物の建築年') }),
      ...(b.occupancy === undefined ? {} : { occupancy: choice(b.occupancy, ['occupied', 'vacant', 'underused'] as const, '建物の利用状況') }),
      ...(b.occupiedHouseholds === undefined ? {} : { occupiedHouseholds: number(b.occupiedHouseholds, '入居世帯数', 0, 100_000, true) }),
      ...(b.use === undefined ? {} : { use: choice(b.use, ['lodging'] as const, '建物の用途') }),
      ...(b.lodgingType === undefined ? {} : { lodgingType: choice(b.lodgingType, ['ryokan', 'hotel'] as const, '宿泊施設の種類') }),
      ...(b.guestRooms === undefined ? {} : { guestRooms: number(b.guestRooms, '客室数', 1, 10_000, true) }),
      ...(b.name === undefined ? {} : { name: string(b.name, '建物の名前', 200) }),
    })
  const readArea = (a: Record<string, unknown>, id: string) => ({
      id, polygon: points(a.polygon, '土地の形', true, PROJECT_GEOMETRY_LIMITS.areaRingPoints), kind: choice(a.kind, ['water', 'forest', 'park', 'field'] as const, '土地の種類'),
      ...(a.name === undefined ? {} : { name: string(a.name, '土地の名前', 200, true) }),
      ...(a.waterLevel === undefined ? {} : { waterLevel: number(a.waterLevel, '水平水面の標高', -10_000, 10_000) }),
      ...(a.landUse === undefined ? {} : { landUse: choice(a.landUse, ['farmland', 'paddy', 'dry-field', 'meadow', 'woodland', 'wetland', 'vacant'] as const, '土地の用途') }),
      ...(a.holes === undefined ? {} : { holes: array(a.holes, '土地の内周', 10_000).map(hole => points(hole, '土地の内周の形', true, PROJECT_GEOMETRY_LIMITS.areaRingPoints)) }),
    })
  const readRailway = (r: Record<string, unknown>, id: string) => {
      const path = points(r.points, '線路の形', false)
      const elevations = r.elevations === undefined ? undefined : array(r.elevations, '線路の標高', 20_000).map(value => number(value, '線路の標高', -10_000, 10_000))
      if (elevations && elevations.length !== path.length) throw new Error('線路の形と標高の件数が一致しません。')
      const structures = r.structures === undefined ? undefined : array(r.structures, '鉄道構造物', 2000).map(item => {
        const s = object(item, '鉄道構造物')
        return { kind: choice(s.kind, ['bridge', 'cutting', 'embankment'] as const, '鉄道構造物の種類'), from: point(s.from, '構造物の始点'), to: point(s.to, '構造物の終点'), maxHeight: number(s.maxHeight, '構造物の高さ', -10_000, 10_000), ...(s.length === undefined ? {} : { length: number(s.length, '鉄道構造物の延長', 0, 500_000) }) }
      })
      const junction = r.junction === undefined ? undefined : object(r.junction, '鉄道の分岐')
      return { id, points: path, name: string(r.name, '路線名', 200), ...(r.mode === undefined ? {} : { mode: choice(r.mode, ['surface', 'subway'] as const, '鉄道の運行方式') }), ...(elevations ? { elevations } : {}), ...(structures ? { structures } : {}), ...(junction ? { junction: { parentId: string(junction.parentId, '分岐元の路線', 128), point: point(junction.point, '分岐点') } } : {}), ...(r.builtYear === undefined ? {} : { builtYear: year(r.builtYear, '鉄道開通年') }) }
    }
  const readStation = (s: Record<string, unknown>, id: string) => ({ id, point: point(s.point, '駅の位置'), name: string(s.name, '駅名', 200), ...(s.mode === undefined ? {} : { mode: choice(s.mode, ['surface', 'subway'] as const, '駅の方式') }), ...(s.railwayId === undefined ? {} : { railwayId: string(s.railwayId, '駅の所属路線', 128) }), ...(s.builtYear === undefined ? {} : { builtYear: year(s.builtYear, '駅開業年') }), ...(s.entrance === undefined ? {} : { entrance: point(s.entrance, '駅の地上出入口') }), ...(s.buildingPolygon === undefined ? {} : { buildingPolygon: points(s.buildingPolygon, '駅舎の敷地', true, 32) }) })
  const readFacility = (f: Record<string, unknown>, id: string) => ({ id, point: point(f.point, '施設の位置'), name: string(f.name, '施設名', 200), kind: choice(f.kind, FACILITIES, '施設の種類') })
  const readDistrict = (d: Record<string, unknown>, id: string) => ({
      id, point: point(d.point, '地区の位置'), name: string(d.name, '地区名', 200),
      ...(d.kind === undefined ? {} : { kind: choice(d.kind, ['town', 'ward'] as const, '区域の種類') }),
      ...(d.parentId === undefined ? {} : { parentId: string(d.parentId, '所属区域', 128) }),
      ...(d.foundedYear === undefined ? {} : { foundedYear: year(d.foundedYear, '地区成立年') }),
      ...(d.nameOrigin === undefined ? {} : { nameOrigin: string(d.nameOrigin, '地名の由来', 600) }),
      ...(d.namingSource === undefined ? {} : { namingSource: choice(d.namingSource, ['provisional', 'llm', 'edited'] as const, '命名方法') }),
      ...(d.regions === undefined ? {} : { regions: array(d.regions, '地区の区域', 4000).map(item => {
        const region = object(item, '地区の区域')
        return { polygon: points(region.polygon, '区域境界', true, PROJECT_GEOMETRY_LIMITS.areaRingPoints), ...(region.holes === undefined ? {} : { holes: array(region.holes, '区域の穴', 1000).map(hole => points(hole, '区域の穴の境界', true, PROJECT_GEOMETRY_LIMITS.areaRingPoints)) }) }
      }) }),
    })

  const readParcel = (p: Record<string, unknown>, id: string) => {
    const createdYear = year(p.createdYear, '敷地の成立年'), developedYear = p.developedYear === undefined ? undefined : year(p.developedYear, '敷地の開発年'), retiredYear = p.retiredYear === undefined ? undefined : year(p.retiredYear, '敷地の廃止年')
    if (developedYear !== undefined && developedYear < createdYear) throw new Error('敷地の開発年が成立年より前になっています。')
    if (retiredYear !== undefined && retiredYear < createdYear) throw new Error('敷地の廃止年が成立年より前になっています。')
    return { id, polygon: points(p.polygon, '敷地の形', true), entrance: point(p.entrance, '敷地の入口'), ...(p.access === undefined ? {} : { access: points(p.access, '敷地の通路', false) }), roadId: string(p.roadId, '接道先のID', 128), createdYear, ...(developedYear === undefined ? {} : { developedYear }), ...(retiredYear === undefined ? {} : { retiredYear }), use: choice(p.use, ['residential', 'commercial', 'industrial'] as const, '敷地の用途') }
  }
  const readEvent = (e: Record<string, unknown>, id: string) => ({ id, year: year(e.year, '履歴の年'), kind: choice(e.kind, ['road', 'construction', 'demolition', 'acquisition', 'railway'] as const, '履歴の種類'), entityId: string(e.entityId, '履歴の対象ID', 128), reason: string(e.reason, '履歴の理由', 2000, true) })
  const readSurface = (value: unknown): TerrainSurface => {
    const surface = object(value, '地形の標高')
    const columns = number(surface.columns, '標高の列数', 2, 2001, true), rows = number(surface.rows, '標高の行数', 2, 2001, true)
    if (columns * rows > 400_000) throw new Error('標高データが大きすぎます。')
    const cellSize = number(surface.cellSize, '標高の間隔', 1, 1000)
    const elevations = array(surface.elevations, '標高データ', 400_000).map(z => number(z, '地盤標高', -10_000, 10_000))
    if (elevations.length !== columns * rows || Math.abs((columns - 1) * cellSize - width) > cellSize || Math.abs((rows - 1) * cellSize - height) > cellSize) throw new Error('標高データと地図の範囲が一致しません。')
    return { columns, rows, cellSize, elevations }
  }
  const map: CityMap = {
    width, height, config: snapshotConfig,
    description: string(input.description, '地図の説明', 5000, true),
    roads: entities(input.roads, '道路', PROJECT_GEOMETRY_LIMITS.roads, readRoad),
    buildings: entities(input.buildings, '建物', buildingLimit, readBuilding),
    areas: entities(input.areas, '土地', PROJECT_GEOMETRY_LIMITS.areas, readArea),
    railways: entities(input.railways, '線路', 100, readRailway),
    stations: entities(input.stations, '駅', 100, readStation),
    facilities: entities(input.facilities, '施設', 2000, readFacility),
    districts: entities(input.districts, '地区', 2000, readDistrict),
  }
  if (input.generatorVersion !== undefined) map.generatorVersion = string(input.generatorVersion, '生成エンジンの版', 128)
  if (input.unplacedFacilities !== undefined) map.unplacedFacilities = array(input.unplacedFacilities, '未成立の施設', 20).map(item => { const value = object(item, '未成立の施設'); return { kind: choice(value.kind, FACILITIES, '未成立施設の種類'), reason: string(value.reason, '未成立の理由', 2000) } })
  if (input.terrainSimulation !== undefined) {
    const s = object(input.terrainSimulation, '地形計算の体積収支')
    map.terrainSimulation = {
      resolution: number(s.resolution, '地形計算の格子幅', 1, 10_000), steps: number(s.steps, '地形計算の反復数', 0, 10_000, true), elapsedYears: number(s.elapsedYears, '地形計算の年数', 0, 1e9),
      bedrockErodedVolume: number(s.bedrockErodedVolume, '岩盤の削剥体積', 0, 1e18), storedSedimentVolume: number(s.storedSedimentVolume, '堆積物の貯留体積', 0, 1e18), exportedSedimentVolume: number(s.exportedSedimentVolume, '領域外への土砂排出', 0, 1e18), sedimentBalanceError: number(s.sedimentBalanceError, '土砂の収支誤差', -1e18, 1e18), groundBalanceError: number(s.groundBalanceError, '地盤の収支誤差', -1e18, 1e18),
      localExcavationVolume: number(s.localExcavationVolume, '局所河床の掘削体積', 0, 1e18), localDepositionVolume: number(s.localDepositionVolume, '局所河床の堆積体積', 0, 1e18), localExportedVolume: number(s.localExportedVolume, '局所河床の土砂排出', 0, 1e18), localBalanceError: number(s.localBalanceError, '局所河床の収支誤差', -1e18, 1e18),
    }
  }
  if (input.terrainSurface !== undefined) map.terrainSurface = readSurface(input.terrainSurface)
  if (input.regionalContext !== undefined) {
    const context = object(input.regionalContext, '広域地形'), surface = object(context.surface, '広域の標高')
    const extent = number(context.extent, '広域地形の範囲', 1000, 500_000)
    const columns = number(surface.columns, '広域標高の列数', 2, 1001, true), rows = number(surface.rows, '広域標高の行数', 2, 1001, true), cellSize = number(surface.cellSize, '広域標高の間隔', 1, 10_000)
    if (columns * rows > 100_000) throw new Error('広域の標高データが大きすぎます。')
    const elevations = array(surface.elevations, '広域の標高データ', 100_000).map(z => number(z, '広域の地盤標高', -10_000, 10_000))
    if (elevations.length !== columns * rows || Math.abs((columns - 1) * cellSize - extent) > cellSize || Math.abs((rows - 1) * cellSize - extent) > cellSize) throw new Error('広域の標高と範囲が一致しません。')
    const crop = array(context.crop, '地図を生成した範囲', 4).map(value => { const p = object(value, '広域上の生成区域'); return { x: number(p.x, '広域上のX座標', 0, extent), y: number(p.y, '広域上のY座標', 0, extent) } })
    if (crop.length !== 4) throw new Error('広域上の生成区域は4隅で指定してください。')
    map.regionalContext = { extent, surface: { columns, rows, cellSize, elevations }, crop }
  }
  if (input.year !== undefined) map.year = year(input.year, '地図の年代')
  if (input.blocks !== undefined) map.blocks = entities(input.blocks, '街区', PROJECT_GEOMETRY_LIMITS.blocks, (b, id) => ({ id, polygon: points(b.polygon, '街区の形', true) }))
  if (input.growthLog !== undefined) map.growthLog = array(input.growthLog, '発展記録', 1000).map(item => {
    const log = object(item, '発展記録')
    return {
      phase: string(log.phase, '発展記録の段階', 128), roadsAdded: number(log.roadsAdded, '発展記録の道路数', 0, PROJECT_GEOMETRY_LIMITS.roads, true),
      ...(log.year === undefined ? {} : { year: year(log.year, '発展記録の年') }),
      ...(log.reason === undefined ? {} : { reason: string(log.reason, '発展の理由', 2000, true) }),
      ...(log.households === undefined ? {} : { households: number(log.households, '発展記録の世帯数', 0, 100_000_000, true) }),
      ...(log.unmetHouseholds === undefined ? {} : { unmetHouseholds: number(log.unmetHouseholds, '発展記録の未充足世帯数', 0, 100_000_000, true) }),
      ...(log.constructionCost === undefined ? {} : { constructionCost: number(log.constructionCost, '発展記録の建設費', 0, 1e15) }),
    }
  })
  if (input.parcels !== undefined) map.parcels = entities(input.parcels, '敷地', PROJECT_GEOMETRY_LIMITS.parcels, readParcel)
  if (input.events !== undefined) map.events = entities(input.events, '都市の履歴', eventLimit, readEvent)
  if (input.snapshots !== undefined) map.snapshots = array(input.snapshots, '人口と開発の記録', 1000).map(item => {
    const s = object(item, '人口と開発の記録'), count = (key: string) => number(s[key], `記録「${key}」`, 0, 100_000_000, true)
    return { year: year(s.year, '記録の年'), households: count('households'), capacity: count('capacity'), vacant: count('vacant'), unmet: count('unmet'), roads: count('roads'), buildings: count('buildings') }
  })
  if (input.timeline !== undefined) {
    const archive = object(input.timeline, '年代履歴')
    if (archive.version !== 1) throw new Error('年代履歴の形式に対応していません。')
    const fromYear = number(archive.fromYear, '履歴の開始年', 1650, 2025, true), throughYear = number(archive.throughYear, '履歴の最終年', fromYear, 2025, true)
    function versions<T>(value: unknown, label: string, limit: number, read: (input: Record<string, unknown>, id: string) => T): TimelineVersion<T>[] {
      const intervals = new Map<string, { from: number; to: number }[]>()
      const records = array(value, label, limit).map(item => {
        const version = object(item, label), from = number(version.from, '有効開始年', fromYear, throughYear, true)
        const to = version.to === undefined ? undefined : number(version.to, '有効終了年', from + 1, throughYear + 1, true)
        const entity = object(version.value, label), id = string(entity.id, '履歴の対象ID', 128)
        for (const inception of ['builtYear', 'createdYear', 'foundedYear']) if (entity[inception] !== undefined && year(entity[inception], '成立年') > from) throw new Error(`${label}の有効開始年が成立年より前です。`)
        const ranges = intervals.get(id) ?? []; ranges.push({ from, to: to ?? throughYear + 1 }); intervals.set(id, ranges)
        return { from, ...(to === undefined ? {} : { to }), value: entities([entity], label, 1, read)[0]! }
      })
      for (const ranges of intervals.values()) {
        ranges.sort((a, b) => a.from - b.from)
        if (ranges.some((range, i) => i > 0 && ranges[i - 1]!.to > range.from)) throw new Error(`${label}の有効期間が重複しています。`)
      }
      return records
    }
    const roads = versions(archive.roads, '道路履歴', PROJECT_GEOMETRY_LIMITS.roads, readRoad)
    const buildings = versions(archive.buildings, '建物履歴', buildingVersionLimit, readBuilding)
    const parcels = versions(archive.parcels, '敷地履歴', PROJECT_GEOMETRY_LIMITS.parcels, readParcel)
    const buildingIds = new Set(buildings.map(v => v.value.id)), roadIds = new Set(roads.map(v => v.value.id)), parcelIds = new Set(parcels.map(v => v.value.id))
    if (parcels.some(v => !roadIds.has(v.value.roadId)) || buildings.some(v => v.value.parcelId !== undefined && !parcelIds.has(v.value.parcelId))) throw new Error('年代履歴の敷地・接道の参照先がありません。')
    const buildingIntervals = new Map<string, TimelineVersion<(typeof buildings)[number]['value']>[]>()
    for (const version of buildings) { const records = buildingIntervals.get(version.value.id) ?? []; records.push(version); buildingIntervals.set(version.value.id, records) }
    const states = new Set<string>()
    const buildingStates = array(archive.buildingStates, '利用状況履歴', PROJECT_GEOMETRY_LIMITS.events).map(item => {
      if (++entityCount > entityLimit) throw new Error('保存済み地図の要素数が上限を超えています。')
      const state = object(item, '利用状況履歴'), id = string(state.id, '建物履歴ID', 128), from = number(state.from, '利用状況の年', fromYear, throughYear, true), key = `${id}:${from}`
      if (!buildingIds.has(id) || !buildingIntervals.get(id)?.some(version => version.from <= from && (version.to === undefined || from < version.to)) || states.has(key)) throw new Error('利用状況履歴の参照先または年代が正しくありません。')
      states.add(key)
      return { id, from, ...(state.occupancy === undefined ? {} : { occupancy: choice(state.occupancy, ['occupied', 'vacant', 'underused'] as const, '建物の利用状況') }), ...(state.occupiedHouseholds === undefined ? {} : { occupiedHouseholds: number(state.occupiedHouseholds, '入居世帯数', 0, 100_000, true) }) }
    })
    let elevationCount = 0
    const terrainSurfaces = array(archive.terrainSurfaces, '標高履歴', 4).map(item => {
      const version = object(item, '標高履歴'), from = number(version.from, '標高の有効開始年', fromYear, throughYear, true), to = version.to === undefined ? undefined : number(version.to, '標高の有効終了年', from + 1, throughYear + 1, true)
      const value = readSurface(version.value); elevationCount += value.elevations.length
      if (elevationCount > 800_000) throw new Error('標高履歴が大きすぎます。')
      return { from, ...(to === undefined ? {} : { to }), value }
    }).sort((a, b) => a.from - b.from)
    if (terrainSurfaces.some((v, i) => i > 0 && (terrainSurfaces[i - 1]!.to ?? throughYear + 1) > v.from)) throw new Error('標高履歴の有効期間が重複しています。')
    const readSnapshot = (value: unknown) => { const s = object(value, '人口記録'), count = (key: string) => number(s[key], `記録${key}`, 0, 100_000_000, true); return { year: number(s.year, '記録の年', fromYear, throughYear, true), households: count('households'), capacity: count('capacity'), vacant: count('vacant'), unmet: count('unmet'), roads: count('roads'), buildings: count('buildings') } }
    map.timeline = { version: 1, fromYear, throughYear, roads, buildings, parcels, buildingStates, terrainSurfaces,
      areas: versions(archive.areas, '土地履歴', areaVersionLimit, readArea),
      railways: versions(archive.railways, '線路履歴', 300, readRailway), stations: versions(archive.stations, '駅履歴', 300, readStation),
      facilities: versions(archive.facilities, '施設履歴', 6000, readFacility), districts: versions(archive.districts, '地区履歴', 10_000, readDistrict),
      events: archive.events === undefined ? [] : entities(archive.events, '都市履歴', eventLimit, readEvent),
      snapshots: archive.snapshots === undefined ? [] : array(archive.snapshots, '人口履歴', 1000).map(readSnapshot),
      growthLog: archive.growthLog === undefined ? [] : array(archive.growthLog, '発展履歴', 1000).map(item => { const log = object(item, '発展履歴'); return { phase: string(log.phase, '段階', 128), roadsAdded: number(log.roadsAdded, '道路数', 0, PROJECT_GEOMETRY_LIMITS.roads, true), ...(log.year === undefined ? {} : { year: number(log.year, '発展年', fromYear, throughYear, true) }), ...(log.reason === undefined ? {} : { reason: string(log.reason, '発展理由', 2000, true) }), ...(log.households === undefined ? {} : { households: number(log.households, '発展世帯数', 0, 100_000_000, true) }), ...(log.unmetHouseholds === undefined ? {} : { unmetHouseholds: number(log.unmetHouseholds, '未充足世帯数', 0, 100_000_000, true) }), ...(log.constructionCost === undefined ? {} : { constructionCost: number(log.constructionCost, '発展建設費', 0, 1e15) }) } }),
    }
    const selectedYear = map.year ?? config.targetYear ?? throughYear
    if (selectedYear < fromYear || selectedYear > throughYear) throw new Error('表示年代が保存済み履歴の範囲外です。')
    return readableProvisionalNames(sliceCityAtYear(map, selectedYear))
  }
  if (map.parcels) {
    const roadIds = new Set(map.roads.map(r => r.id)), parcelIds = new Set(map.parcels.map(p => p.id))
    if (map.parcels.some(p => !roadIds.has(p.roadId))) throw new Error('敷地の接道先が保存済み地図にありません。')
    if (map.buildings.some(b => b.parcelId !== undefined && !parcelIds.has(b.parcelId))) throw new Error('建物の敷地が保存済み地図にありません。')
  }
  return readableProvisionalNames(map)
}

/** Reconstruct known fields, retaining authoritative geometry in every wire form. */
export function validateProject(data: unknown): Project {
  if (data && typeof data === 'object' && (data as { version?: unknown }).version === 3) data = decodeCompactProject(data)
  const input = object(data, 'プロジェクト')
  if (input.version !== 1 && input.version !== 2) throw new Error('このプロジェクトの保存形式には対応していません。設定を保存して書き出したJSONを選んでください。')
  const config = configFrom(input.config)
  const snapshot = input.version === 2 && input.snapshot !== undefined ? snapshotFrom(input.snapshot, config) : undefined
  const usedIds = new Set<string>()
  const annotations: Annotation[] = array(input.annotations, 'メモ', 1000).map((item, index) => {
    const label = `メモ${index + 1}`, annotation = object(item, label), point = object(annotation.point, `${label}の位置`), id = string(annotation.id, `${label}のID`, 128)
    if (usedIds.has(id)) throw new Error('メモのIDに重複があります。')
    usedIds.add(id)
    return { id, point: { x: number(point.x, `${label}の横位置`, 0, snapshot?.width ?? 100_000), y: number(point.y, `${label}の縦位置`, 0, snapshot?.height ?? 100_000) }, name: string(annotation.name, `${label}の名前`, 120), note: string(annotation.note, `${label}の本文`, 5000, true), secret: boolean(annotation.secret, `${label}のGM専用設定`) }
  })
  const inputLayers = object(input.layers, 'レイヤー')
  const layers = Object.fromEntries(LAYER_KEYS.map(key => [key, boolean(inputLayers[key], `レイヤー「${key}」`)])) as unknown as LayerSettings
  if (inputLayers.districts !== undefined) layers.districts = boolean(inputLayers.districts, 'レイヤー「districts」')
  const factor = config.mapSize === 'large' ? 3 : config.mapSize === 'medium' ? 2 : 1
  const edits = input.edits === undefined ? undefined : validateMapEdits(input.edits, snapshot?.width ?? 4000 * factor, snapshot?.height ?? 3000 * factor)
  return { version: 2, config, annotations, layers, style: choice(input.style, STYLES, '地図の配色'), ...(snapshot ? { snapshot } : {}), ...(edits === undefined ? {} : { edits }) }
}

export function parseProject(text: string): Project {
  if (text.length > MAX_PROJECT_JSON_LENGTH) throw new Error('プロジェクトが大きすぎます。文字数の上限を超えています。')
  let data: unknown
  try { data = JSON.parse(text) } catch { throw new Error('JSONを読み取れませんでした。「設定を保存」で書き出したJSONを選んでください。') }
  return validateProject(data)
}

export function loadProject(): Project | null {
  try {
    for (const key of [STORAGE_KEY, LEGACY_STORAGE_KEY]) {
      const text = globalThis.localStorage.getItem(key)
      if (text) { try { return parseProject(text) } catch { /* Try a valid legacy backup. */ } }
    }
  } catch { /* Storage can be disabled by browser policy. */ }
  return null
}

export function persistProject(project: Project): boolean {
  try {
    return persistValidatedLocal(validateProject(portableProject(project)))
  } catch { return false }
}

function persistValidatedLocal(project: Project): boolean {
  try {
    const text = JSON.stringify(portableProject(project))
    // Keep a small-map/legacy fallback; large complete maps live in IndexedDB.
    if (text.length > MAX_LOCAL_STORAGE_LENGTH) return false
    globalThis.localStorage.setItem(STORAGE_KEY, text)
    return true
  } catch { return false }
}

function openArchive(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let finished = false
    const timer = globalThis.setTimeout(() => { finished = true; reject(new Error('地図保存領域に接続できませんでした。')) }, 2500)
    const fail = () => { if (finished) return; finished = true; clearTimeout(timer); reject(new Error('地図保存領域を利用できません。')) }
    try {
      const request = globalThis.indexedDB.open(ARCHIVE_DATABASE, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(ARCHIVE_STORE)) request.result.createObjectStore(ARCHIVE_STORE)
      }
      request.onsuccess = () => {
        if (finished) { request.result.close(); return }
        finished = true; clearTimeout(timer)
        request.result.onversionchange = () => request.result.close()
        resolve(request.result)
      }
      request.onerror = fail
      request.onblocked = fail
    } catch { fail() }
  })
}

async function readArchive(): Promise<unknown> {
  const db = await openArchive()
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(ARCHIVE_STORE, 'readonly'), request = tx.objectStore(ARCHIVE_STORE).get('current')
      let result: unknown
      request.onsuccess = () => { result = request.result }
      tx.oncomplete = () => { db.close(); resolve(result) }
      tx.onabort = tx.onerror = () => { db.close(); reject(new Error('保存済み地図を読み込めませんでした。')) }
    } catch (error) { db.close(); reject(error) }
  })
}

async function writeArchive(project: Project): Promise<boolean> {
  try {
    const db = await openArchive()
    return await new Promise<boolean>(resolve => {
      try {
        const tx = db.transaction(ARCHIVE_STORE, 'readwrite')
        tx.objectStore(ARCHIVE_STORE).put(portableProject(project), 'current')
        // Only a committed transaction counts as saved. An abort retains the prior map.
        tx.oncomplete = () => { db.close(); resolve(true) }
        tx.onabort = tx.onerror = () => { db.close(); resolve(false) }
      } catch { db.close(); resolve(false) }
    })
  } catch { return false }
}

/** Probe the archive before generation; older small/legacy saves remain readable. */
export async function loadProjectArchive(): Promise<Project | null> {
  try {
    const stored = await readArchive()
    if (stored !== undefined) return validateProject(stored)
  } catch { /* A disabled, corrupt or unavailable archive can still have a local fallback. */ }
  return loadProject()
}

/** Serialize archive transactions so an older async save cannot overtake a later map. */
export async function persistProjectArchive(project: Project): Promise<boolean> {
  let validated: Project
  try { validated = validateProject(portableProject(project)); if (!validated.snapshot) return false } catch { return false }
  // IndexedDB already clones the value. Stringifying a large complete map merely
  // to discover that it cannot fit localStorage doubled autosave work and memory.
  // The legacy/small-map fallback is only needed if the primary archive fails.
  const save = async () => await writeArchive(validated) || persistValidatedLocal(validated)
  const pending = archiveWrites.then(save, save)
  archiveWrites = pending
  return pending
}

/** The archive already owns every geometry version. Do not serialize a second
 * copy of the selected frame (or a full map for each five-year date). */
export function portableProject(project: Project): Project {
  const snapshot = project.snapshot
  return snapshot?.timeline ? { ...project, snapshot: { ...snapshot, roads: [], buildings: [], areas: [], railways: [], stations: [], facilities: [], districts: [], parcels: undefined, blocks: undefined, terrainSurface: undefined, events: undefined, snapshots: undefined, growthLog: undefined } } : project
}

/** Compact wire storage changes representation only. The normal validator
 * still checks every decoded entity, point and date, with the existing caps. */
export function serializeProject(project: Project): string {
  const value = portableProject(project)
  const text = JSON.stringify(project.config.cityEngine === 'continuous' ? encodeCompactProject(value) : value)
  if (text.length > MAX_PROJECT_JSON_LENGTH) throw new Error('保存できるプロジェクトの大きさを超えています。')
  return text
}

export function downloadProject(project: Project): void {
  const validated = validateProject(portableProject(project)), text = serializeProject(validated)
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  if (blob.size > MAX_PROJECT_FILE_BYTES) throw new Error('保存できるプロジェクトの大きさを超えています。')
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  // oxlint-disable-next-line no-control-regex -- Windows filenames cannot contain control characters.
  const safeName = validated.config.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 60) || '架空日本地図ジェネレーター'
  link.href = url
  link.download = `${safeName}-machitsumugi.json`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
