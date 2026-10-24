import type { CityMap, District } from './types'

/** Readable provisional place names; these are not claims about a real
 * settlement's etymology. The optional language model can rename them later. */
export const PLACE_STEMS = ['青葉', '若葉', '常盤', '千草', '小松', '高砂', '日和', '桜木', '松葉', '竹並', '楠木', '春日', '朝日', '明和', '睦', '弥生', '旭', '栄', '美和', '長和', '豊栄', '大和', '光', '早苗', '緑', '桜', '松原', '錦', '若松', '花園', '千代', '末広', '立花', '清和', '花咲', '杉並', '竹園', '月見', '野菊', '花里', '新栄', '幸', '寿', '大成', '瑞穂', '新生', '初音', '晴明', '文花', '卯月', '葉月', '皐月', '日吉', '小春', '陽光', '星見', '若草', '香澄'] as const
const hash = (value: string) => { let n = 2166136261; for (const c of value) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return n >>> 0 }

export function placeNameChoices(input: { seed: string; id: string; kind?: 'town' | 'ward'; direction?: string; nearWater?: boolean; onsen?: boolean }, used: ReadonlySet<string> = new Set()): string[] {
  const suffix = input.kind === 'ward' ? '区' : '町'
  const stems: string[] = [...PLACE_STEMS]
  if (input.nearWater) stems.push('水明', '水郷', '清水')
  if (input.onsen) stems.push('湯本', '湯ノ原', '湯端', '湯ノ里', '泉本')
  const familiar = new Set(stems.map(stem => stem + suffix))
  const qualified = new Set<string>()
  const names = new Set<string>()
  for (const stem of stems) {
    names.add(stem + suffix)
    for (const prefix of ['新', '本', '上', '下', '元', '仲', input.direction ?? '']) if (prefix && !stem.startsWith(prefix)) { names.add(prefix + stem + suffix); qualified.add(prefix + stem + suffix) }
    for (const part of ['原', '野', '里', '園']) {
      if (!stem.endsWith(part)) names.add(stem + part + suffix)
    }
  }
  const rank = (name: string) => familiar.has(name) ? 0 : qualified.has(name) ? 1 : 2
  return [...names].filter(name => !used.has(name)).sort((a, b) => rank(a) - rank(b) || hash(`${input.seed}:${input.id}:${a}`) - hash(`${input.seed}:${input.id}:${b}`) || a.localeCompare(b, 'ja'))
}

export function provisionalPlaceName(input: Parameters<typeof placeNameChoices>[0], used: ReadonlySet<string>) {
  const name = placeNameChoices(input, used)[0]
  if (!name) throw new Error('重複しない町名を割り当てられませんでした。区域をまとめるか地名を指定してください。')
  return name
}

/** Repair old placeholder labels without rerunning a saved world's simulation.
 * Explicit user/LLM names and every physical feature remain untouched. */
export function readableProvisionalNames(map: CityMap): CityMap {
  const ordinal = (district: District) => district.namingSource !== 'edited' && district.namingSource !== 'llm' && /^第[0-9０-９一二三四五六七八九十百千]+[町丁区]$/.test(district.name)
  const all = [...map.districts, ...(map.timeline?.districts.map(version => version.value) ?? [])]
  if (!all.some(ordinal)) return map
  const used = new Set([map.config.name, ...all.filter(district => !ordinal(district)).map(district => district.name)])
  const replacements = new Map<string, string>()
  for (const district of [...all].sort((a, b) => a.id.localeCompare(b.id))) if (ordinal(district) && !replacements.has(district.id)) {
    const direction = district.point.y < map.height * .35 ? '北' : district.point.y > map.height * .65 ? '南' : district.point.x < map.width * .35 ? '西' : district.point.x > map.width * .65 ? '東' : '中'
    const name = provisionalPlaceName({ seed: map.config.seed, id: district.id, kind: district.kind, direction }, used)
    replacements.set(district.id, name); used.add(name)
  }
  const rename = (district: District) => ordinal(district) && replacements.has(district.id) ? { ...district, name: replacements.get(district.id)! } : district
  return { ...map, districts: map.districts.map(rename), ...(map.timeline ? { timeline: { ...map.timeline, districts: map.timeline.districts.map(version => ({ ...version, value: rename(version.value) })) } } : {}) }
}
