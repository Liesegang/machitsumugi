import type { CityConfig, CityMap, Point } from './types'
import type { Annotation, LayerSettings, MapStyle } from '../map/render'

export interface Project {
  version: 2
  config: CityConfig
  annotations: Annotation[]
  layers: LayerSettings
  style: MapStyle
  /** Completed geometry is authoritative; importing it must not run a newer engine. */
  snapshot?: CityMap
}

export const STORAGE_KEY = 'machitsumugi.project.v2'
export const LEGACY_STORAGE_KEY = 'machitsumugi.project.v1'
export const MAX_PROJECT_FILE_BYTES = 40_000_000
export const MAX_PROJECT_JSON_LENGTH = 20_000_000
export const MAX_LOCAL_STORAGE_LENGTH = 2_000_000
export const ARCHIVE_DATABASE = 'machitsumugi.archive.v1'
const ARCHIVE_STORE = 'projects'
let archiveWrites: Promise<boolean> = Promise.resolve(true)
const CITY_TYPES = ['castle', 'temple', 'port', 'newtown', 'post', 'onsen'] as const
const TERRAINS = ['river', 'plain', 'coast'] as const
const FACILITIES = ['shrine', 'school', 'hospital', 'police', 'shop', 'park', 'castle', 'port', 'onsen'] as const
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
  return config
}

function sameConfig(a: CityConfig, b: CityConfig): boolean {
  return JSON.stringify({ ...a, era: a.era ?? 'present' }) === JSON.stringify({ ...b, era: b.era ?? 'present' })
}

/** Linear, bounded validation of a portable snapshot, without running the generator. */
function snapshotFrom(value: unknown, config: CityConfig): CityMap {
  const input = object(value, '保存済み地図')
  const width = number(input.width, '地図の幅', 100, 50_000)
  const height = number(input.height, '地図の高さ', 100, 50_000)
  const snapshotConfig = configFrom(input.config)
  if (!sameConfig(config, snapshotConfig)) throw new Error('街の設定と保存済み地図の設定が一致しません。')
  let pointCount = 0
  let entityCount = 0
  const margin = Math.max(width, height) / 4
  function point(value: unknown, label: string): Point {
    if (++pointCount > 750_000) throw new Error('保存済み地図の頂点数が上限を超えています。')
    const p = object(value, label)
    // Polygons and routes may cross the map boundary; the renderer clips them.
    return { x: number(p.x, `${label}の横位置`, -margin, width + margin), y: number(p.y, `${label}の縦位置`, -margin, height + margin) }
  }
  function points(value: unknown, label: string, polygon: boolean): Point[] {
    const list = array(value, label, polygon ? 2048 : 20_000)
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
      if (++entityCount > 250_000) throw new Error('保存済み地図の要素数が上限を超えています。')
      const input = object(item, label), id = string(input.id, `${label}のID`, 128)
      if (ids.has(id)) throw new Error(`${label}のIDに重複があります。`)
      ids.add(id)
      return read(input, id)
    })
  }
  const year = (value: unknown, label: string) => number(value, label, -10_000, 10_000, true)
  const map: CityMap = {
    width, height, config: snapshotConfig,
    description: string(input.description, '地図の説明', 5000, true),
    roads: entities(input.roads, '道路', 20_000, (r, id) => ({
      id, points: points(r.points, '道路の形', false), kind: choice(r.kind, ['arterial', 'local'] as const, '道路の種類'), width: number(r.width, '道路の幅', .1, 200),
      ...(r.builtYear === undefined ? {} : { builtYear: year(r.builtYear, '道路の建設年') }),
      ...(r.role === undefined ? {} : { role: choice(r.role, ['highway', 'collector', 'lane', 'access', 'bridge', 'farm'] as const, '道路の役割') }),
      ...(r.reason === undefined ? {} : { reason: string(r.reason, '道路の建設理由', 2000, true) }),
      ...(r.bridge === undefined ? {} : { bridge: boolean(r.bridge, '橋の指定') }),
      ...(r.phase === undefined ? {} : { phase: string(r.phase, '道路の成立段階', 128) }),
      ...(r.constructionCost === undefined ? {} : { constructionCost: number(r.constructionCost, '道路の建設費', 0, 1e15) }),
    })),
    buildings: entities(input.buildings, '建物', 60_000, (b, id) => ({
      id, polygon: points(b.polygon, '建物の形', true), kind: choice(b.kind, ['residential', 'commercial', 'public', 'industrial'] as const, '建物の種類'), height: number(b.height, '建物の階数', 1, 250, true),
      ...(b.parcelId === undefined ? {} : { parcelId: string(b.parcelId, '建物の敷地ID', 128) }),
      ...(b.builtYear === undefined ? {} : { builtYear: year(b.builtYear, '建物の建築年') }),
    })),
    areas: entities(input.areas, '土地', 10_000, (a, id) => ({
      id, polygon: points(a.polygon, '土地の形', true), kind: choice(a.kind, ['water', 'forest', 'park', 'field'] as const, '土地の種類'),
      ...(a.name === undefined ? {} : { name: string(a.name, '土地の名前', 200, true) }),
    })),
    railways: entities(input.railways, '線路', 100, (r, id) => {
      const path = points(r.points, '線路の形', false)
      const elevations = r.elevations === undefined ? undefined : array(r.elevations, '線路の標高', 20_000).map(value => number(value, '線路の標高', -10_000, 10_000))
      if (elevations && elevations.length !== path.length) throw new Error('線路の形と標高の件数が一致しません。')
      const structures = r.structures === undefined ? undefined : array(r.structures, '鉄道構造物', 2000).map(item => {
        const s = object(item, '鉄道構造物')
        return { kind: choice(s.kind, ['bridge', 'cutting', 'embankment'] as const, '鉄道構造物の種類'), from: point(s.from, '構造物の始点'), to: point(s.to, '構造物の終点'), maxHeight: number(s.maxHeight, '構造物の高さ', -10_000, 10_000) }
      })
      return { id, points: path, name: string(r.name, '路線名', 200), ...(elevations ? { elevations } : {}), ...(structures ? { structures } : {}) }
    }),
    stations: entities(input.stations, '駅', 100, (s, id) => ({ id, point: point(s.point, '駅の位置'), name: string(s.name, '駅名', 200) })),
    facilities: entities(input.facilities, '施設', 2000, (f, id) => ({ id, point: point(f.point, '施設の位置'), name: string(f.name, '施設名', 200), kind: choice(f.kind, FACILITIES, '施設の種類') })),
    districts: entities(input.districts, '地区', 2000, (d, id) => ({ id, point: point(d.point, '地区の位置'), name: string(d.name, '地区名', 200) })),
  }
  if (input.generatorVersion !== undefined) map.generatorVersion = string(input.generatorVersion, '生成エンジンの版', 128)
  if (input.year !== undefined) map.year = year(input.year, '地図の年代')
  if (input.blocks !== undefined) map.blocks = entities(input.blocks, '街区', 40_000, (b, id) => ({ id, polygon: points(b.polygon, '街区の形', true) }))
  if (input.growthLog !== undefined) map.growthLog = array(input.growthLog, '発展記録', 1000).map(item => {
    const log = object(item, '発展記録')
    return {
      phase: string(log.phase, '発展記録の段階', 128), roadsAdded: number(log.roadsAdded, '発展記録の道路数', 0, 20_000, true),
      ...(log.year === undefined ? {} : { year: year(log.year, '発展記録の年') }),
      ...(log.reason === undefined ? {} : { reason: string(log.reason, '発展の理由', 2000, true) }),
      ...(log.households === undefined ? {} : { households: number(log.households, '発展記録の世帯数', 0, 100_000_000, true) }),
      ...(log.unmetHouseholds === undefined ? {} : { unmetHouseholds: number(log.unmetHouseholds, '発展記録の未充足世帯数', 0, 100_000_000, true) }),
      ...(log.constructionCost === undefined ? {} : { constructionCost: number(log.constructionCost, '発展記録の建設費', 0, 1e15) }),
    }
  })
  if (input.parcels !== undefined) map.parcels = entities(input.parcels, '敷地', 80_000, (p, id) => {
    const createdYear = year(p.createdYear, '敷地の成立年'), developedYear = p.developedYear === undefined ? undefined : year(p.developedYear, '敷地の開発年')
    if (developedYear !== undefined && developedYear < createdYear) throw new Error('敷地の開発年が成立年より前になっています。')
    return { id, polygon: points(p.polygon, '敷地の形', true), entrance: point(p.entrance, '敷地の入口'), roadId: string(p.roadId, '接道先のID', 128), createdYear, ...(developedYear === undefined ? {} : { developedYear }), use: choice(p.use, ['residential', 'commercial', 'industrial'] as const, '敷地の用途') }
  })
  if (input.events !== undefined) map.events = entities(input.events, '都市の履歴', 100_000, (e, id) => ({ id, year: year(e.year, '履歴の年'), kind: choice(e.kind, ['road', 'construction', 'acquisition', 'railway'] as const, '履歴の種類'), entityId: string(e.entityId, '履歴の対象ID', 128), reason: string(e.reason, '履歴の理由', 2000, true) }))
  if (input.snapshots !== undefined) map.snapshots = array(input.snapshots, '人口と開発の記録', 1000).map(item => {
    const s = object(item, '人口と開発の記録'), count = (key: string) => number(s[key], `記録「${key}」`, 0, 100_000_000, true)
    return { year: year(s.year, '記録の年'), households: count('households'), capacity: count('capacity'), vacant: count('vacant'), unmet: count('unmet'), roads: count('roads'), buildings: count('buildings') }
  })
  if (map.parcels) {
    const roadIds = new Set(map.roads.map(r => r.id)), parcelIds = new Set(map.parcels.map(p => p.id))
    if (map.parcels.some(p => !roadIds.has(p.roadId))) throw new Error('敷地の接道先が保存済み地図にありません。')
    if (map.buildings.some(b => b.parcelId !== undefined && !parcelIds.has(b.parcelId))) throw new Error('建物の敷地が保存済み地図にありません。')
  }
  return map
}

/** Reconstruct known fields, migrating v1 settings while retaining v2 geometry. */
export function validateProject(data: unknown): Project {
  const input = object(data, 'プロジェクト')
  if (input.version !== 1 && input.version !== 2) throw new Error('このプロジェクトの保存形式には対応していません。バージョン1または2のJSONを選んでください。')
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
  return { version: 2, config, annotations, layers, style: choice(input.style, STYLES, '地図の配色'), ...(snapshot ? { snapshot } : {}) }
}

export function parseProject(text: string): Project {
  if (text.length > MAX_PROJECT_JSON_LENGTH) throw new Error('プロジェクトが大きすぎます。40 MB以内のJSONを選んでください。')
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
    return persistValidatedLocal(validateProject(project))
  } catch { return false }
}

function persistValidatedLocal(project: Project): boolean {
  try {
    const text = JSON.stringify(project)
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
        tx.objectStore(ARCHIVE_STORE).put(project, 'current')
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
  try { validated = validateProject(project); if (!validated.snapshot) return false } catch { return false }
  const localSaved = persistValidatedLocal(validated)
  const pending = archiveWrites.then(() => writeArchive(validated), () => writeArchive(validated))
  archiveWrites = pending
  return await pending || localSaved
}

export function downloadProject(project: Project): void {
  const validated = validateProject(project), text = JSON.stringify(validated)
  if (text.length > MAX_PROJECT_JSON_LENGTH) throw new Error('保存できるプロジェクトの大きさを超えています。')
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  if (blob.size > MAX_PROJECT_FILE_BYTES) throw new Error('保存できるプロジェクトの大きさを超えています。')
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  // oxlint-disable-next-line no-control-regex -- Windows filenames cannot contain control characters.
  const safeName = validated.config.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 60) || '街紡ぎ'
  link.href = url
  link.download = `${safeName}-machitsumugi.json`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
