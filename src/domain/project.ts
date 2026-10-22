import type { CityConfig } from './types'
import type { Annotation, LayerSettings, MapStyle } from '../map/render'

export interface Project {
  version: 1
  config: CityConfig
  annotations: Annotation[]
  layers: LayerSettings
  style: MapStyle
}

export const STORAGE_KEY = 'machitsumugi.project.v1'
const MAX_JSON_LENGTH = 5_000_000
const CITY_TYPES = ['castle', 'temple', 'port', 'newtown', 'post', 'onsen'] as const
const TERRAINS = ['river', 'plain', 'coast'] as const
const FACILITIES = ['shrine', 'school', 'hospital', 'police', 'shop', 'park', 'castle', 'port', 'onsen'] as const
const STYLES = ['standard', 'mono', 'night'] as const
const LAYER_KEYS = ['buildings', 'roads', 'railway', 'labels', 'facilities', 'terrain', 'grid'] as const

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}の形式が正しくありません。`)
  }
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

/** Reconstruct known fields rather than trusting imported objects or prototypes. */
export function validateProject(data: unknown): Project {
  const project = object(data, 'プロジェクト')
  if (project.version !== 1) throw new Error('このプロジェクトの保存形式には対応していません。バージョン1のJSONを選んでください。')
  const input = object(project.config, '街の設定')
  if (!Array.isArray(input.facilities) || input.facilities.length > FACILITIES.length) {
    throw new Error('施設の一覧が正しくありません。')
  }
  const facilities = input.facilities.map((item) => choice(item, FACILITIES, '施設'))
  if (new Set(facilities).size !== facilities.length) throw new Error('施設の一覧に重複があります。')
  const config: CityConfig = {
    name: string(input.name, '街の名前', 80),
    seed: string(input.seed, 'シード', 128),
    type: choice(input.type, CITY_TYPES, '街の成り立ち'),
    terrain: choice(input.terrain, TERRAINS, '地形'),
    density: number(input.density, '建物の密度', 0, 100),
    forest: number(input.forest, '森林の割合', 0, 100),
    railway: boolean(input.railway, '鉄道'),
    stations: number(input.stations, '駅の数', 1, 5, true),
    arterial: boolean(input.arterial, '幹線道路'),
    facilities,
  }
  if (!Array.isArray(project.annotations) || project.annotations.length > 1000) {
    throw new Error('メモは1,000件以内で指定してください。')
  }
  const usedIds = new Set<string>()
  const annotations: Annotation[] = project.annotations.map((item, index) => {
    const label = `メモ${index + 1}`
    const annotation = object(item, label)
    const point = object(annotation.point, `${label}の位置`)
    const id = string(annotation.id, `${label}のID`, 128)
    if (usedIds.has(id)) throw new Error('メモのIDに重複があります。')
    usedIds.add(id)
    return {
      id,
      point: {
        x: number(point.x, `${label}の横位置`, 0, 100_000),
        y: number(point.y, `${label}の縦位置`, 0, 100_000),
      },
      name: string(annotation.name, `${label}の名前`, 120),
      note: string(annotation.note, `${label}の本文`, 5000, true),
      secret: boolean(annotation.secret, `${label}のGM専用設定`),
    }
  })
  const inputLayers = object(project.layers, 'レイヤー')
  const layers = Object.fromEntries(LAYER_KEYS.map((key) => [key, boolean(inputLayers[key], `レイヤー「${key}」`)])) as unknown as LayerSettings
  return { version: 1, config, annotations, layers, style: choice(project.style, STYLES, '地図の配色') }
}

export function parseProject(text: string): Project {
  if (text.length > MAX_JSON_LENGTH) throw new Error('プロジェクトが大きすぎます。5MB以内のJSONを選んでください。')
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('JSONを読み取れませんでした。「設定を保存」で書き出したJSONを選んでください。')
  }
  return validateProject(data)
}

export function loadProject(): Project | null {
  try {
    const text = globalThis.localStorage.getItem(STORAGE_KEY)
    return text ? parseProject(text) : null
  } catch {
    return null
  }
}

export function persistProject(project: Project): boolean {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(validateProject(project)))
    return true
  } catch {
    return false
  }
}

export function downloadProject(project: Project): void {
  const validated = validateProject(project)
  const blob = new Blob([JSON.stringify(validated, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const safeName = validated.config.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 60) || '街紡ぎ'
  link.href = url
  link.download = `${safeName}-machitsumugi.json`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
