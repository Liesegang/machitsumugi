import type { CityMap, District } from '../domain/types'
import { distance, distanceToSegment, pointInRegion } from '../domain/geometry'

export interface NameProposal { id: string; name: string; reason: string; source?: 'llm' | 'edited' }
/** Keep identity, spelling and geographical constraints outside the small model. */
export function districtNameCandidates(map: CityMap, district: District, used: string[] = []): string[] {
  const context = districtNamingContext(map, district)
  const suffix = district.kind === 'ward' ? '区' : '町'
  const neutral = ['青葉', '若葉', '常盤', '千草', '小松', '高砂', '日和', '桜木', '松葉', '竹並', '楠木', '春日', '朝日', '明和', '睦', '弥生', '旭', '栄', '美和', '長和', '豊栄', '大和', '光', '早苗']
  const direction = district.point.y < map.height * .35 ? '北' : district.point.y > map.height * .65 ? '南' : district.point.x < map.width * .35 ? '西' : district.point.x > map.width * .65 ? '東' : '中'
  const stems = [...neutral, ...neutral.map(stem => `${direction}${stem}`), ...neutral.map(stem => `${stem}台`)]
  if (context.nearWater) stems.push('水辺', '水郷', '水際', '水明', '清水')
  if (context.lodgings || context.facilities.includes('onsen')) stems.push('湯本', '湯ノ原', '湯端', '湯ノ里', '泉本', '泉中央')
  const unavailable = new Set([map.config.name, ...map.districts.map(d => d.name), ...used])
  const hash = (value: string) => { let n = 2166136261; for (const c of value) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return n >>> 0 }
  const available = [...new Set(stems.map(stem => stem + suffix))].filter(name => !unavailable.has(name))
  // Large regions can have hundreds of towns. Numbered chome are ordinary
  // Japanese address names and keep the candidate supply from running out.
  for (let number = 1; available.length < 16; number++) {
    for (const stem of neutral) {
      const name = district.kind === 'ward' ? `${stem}第${number}区` : `${stem}${number}丁目`
      if (!unavailable.has(name)) available.push(name)
    }
  }
  return available.sort((a, b) => hash(`${map.config.seed}:${district.id}:${a}`) - hash(`${map.config.seed}:${district.id}:${b}`)).slice(0, 16)
}
export function parseNameSelection(text: string, district: Pick<District, 'id' | 'kind'>, candidates: string[], used: string[], reason: string): NameProposal {
  if (text.length > 2000) throw new Error('命名結果が長すぎます。')
  const value: unknown = JSON.parse(text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim())
  if (!value || typeof value !== 'object' || !('choice' in value)) throw new Error('候補の番号を一つだけJSONで返してください。')
  // Small models sometimes quote an otherwise valid integer. Accept only its
  // canonical ASCII decimal spelling, then keep the same strict range check.
  const choice = typeof value.choice === 'string' && /^[1-9][0-9]?$/.test(value.choice) ? Number(value.choice) : value.choice
  if (typeof choice !== 'number' || !Number.isInteger(choice) || choice < 1 || choice > candidates.length) throw new Error('候補の番号を一つだけJSONで返してください。')
  return parseNameProposals(JSON.stringify({ names: [{ id: district.id, name: candidates[choice - 1], reason }] }), [district], used)[0]!
}
export function parseSingleNameProposal(text: string, district: Pick<District, 'id' | 'kind'>, used: string[], observedReason?: string): NameProposal {
  if (text.length > 10_000) throw new Error('命名結果が長すぎます。')
  const value: unknown = JSON.parse(text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim())
  if (!value || typeof value !== 'object' || !('name' in value) || observedReason === undefined && !('reason' in value)) throw new Error('町名を一件だけJSONで返してください。')
  // Entity identity belongs to the map; the language model only supplies text.
  return parseNameProposals(JSON.stringify({ names: [{ id: district.id, name: value.name, reason: observedReason ?? ('reason' in value ? value.reason : '') }] }), [district], used)[0]!
}
export function validateGeographicNames(map: CityMap, proposals: NameProposal[]) {
  for (const proposal of proposals) {
    const district = map.districts.find(d => d.id === proposal.id)
    if (!district) throw new Error('区域が見つかりません。')
    const context = districtNamingContext(map, district)
    if (/[湯泉]/.test(proposal.name) && !context.lodgings && !context.facilities.includes('onsen')) throw new Error(`${proposal.name}には温泉の根拠がありません。温泉を意味する語を使わず命名してください。`)
    if (/[川河沢津浜浦汐潮渚洲瀬湖池]/.test(proposal.name) && !context.nearWater) throw new Error('この区域は内陸です。住宅地・野原・方角に関連した別の地名を考えてください。')
  }
}
export function districtNamingContext(map: CityMap, district: District) {
  const inside = (point: { x: number; y: number }) => district.regions?.length ? district.regions.some(region => pointInRegion(point, region)) : distance(point, district.point) < 300
  const buildings = map.buildings.filter(b => inside(b.polygon[0]!))
  const years = buildings.flatMap(b => b.builtYear === undefined ? [] : [b.builtYear])
  const waters = map.areas.filter(a => a.kind === 'water' && !a.id.startsWith('moat-'))
  const waterDistance = waters.length ? Math.min(...waters.map(area => Math.min(...area.polygon.map((p, i) => distanceToSegment(district.point, p, area.polygon[(i + 1) % area.polygon.length]!))))) : Infinity
  const terrain = map.terrainSurface
  const elevation = terrain ? terrain.elevations[Math.max(0, Math.min(terrain.rows - 1, Math.round(district.point.y / terrain.cellSize))) * terrain.columns + Math.max(0, Math.min(terrain.columns - 1, Math.round(district.point.x / terrain.cellSize)))] : undefined
  const geography = [district.point.y < map.height * .35 ? '地域の北部' : district.point.y > map.height * .65 ? '地域の南部' : '地域の中央部', district.point.x < map.width * .35 ? '西寄り' : district.point.x > map.width * .65 ? '東寄り' : '', waterDistance < 150 ? '川や水辺に近い' : '水辺から離れた内陸', elevation === undefined ? '' : `標高約${Math.round(elevation)}m`, buildings.some(b => b.use === 'lodging') ? `温泉宿が${buildings.filter(b => b.use === 'lodging').length}軒ある` : '主に住宅の集まり']
  const motifs = [district.point.y < map.height * .35 ? '北' : district.point.y > map.height * .65 ? '南' : '中', district.point.x < map.width * .35 ? '西' : district.point.x > map.width * .65 ? '東' : '中央', waterDistance < 150 ? '水辺' : '野原', buildings.some(b => b.use === 'lodging') ? '湯' : '里']
  return {
    id: district.id, kind: district.kind ?? 'town', provisionalName: district.name,
    position: [Math.round(district.point.x / map.width * 100), Math.round(district.point.y / map.height * 100)],
    terrain: map.config.terrain, relief: map.config.relief ?? 'hills', origin: map.config.type,
    buildings: buildings.length, firstRecordedBuildingYear: years.length ? Math.min(...years) : null,
    lodgings: buildings.filter(b => b.use === 'lodging').length,
    facilities: map.facilities.filter(f => inside(f.point)).map(f => f.kind),
    observedFeatures: geography.filter(Boolean).join('。'),
    nearWater: waterDistance < 150, namingMotifs: motifs,
  }
}
/** Model output is untrusted data. IDs, names and every batch are checked. */
export function parseNameProposals(text: string, districts: Pick<District, 'id' | 'kind'>[], used: string[] = []): NameProposal[] {
  if (text.length > Math.min(2_000_000, districts.length * 500 + 1000)) throw new Error('命名結果が長すぎます。')
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim()
  const value: unknown = JSON.parse(cleaned)
  if (!value || typeof value !== 'object' || !('names' in value) || !Array.isArray(value.names) || value.names.length !== districts.length) throw new Error('地名の件数が区域と一致しません。もう一度提案してください。')
  const ids = new Set<string>(), names = new Set(used)
  return value.names.map((row: unknown) => {
    if (!row || typeof row !== 'object' || !('id' in row) || !('name' in row) || !('reason' in row) || typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.reason !== 'string') throw new Error('地名の形式が正しくありません。')
    const district = districts.find(d => d.id === row.id)
    if (!district || ids.has(row.id)) throw new Error('区域のIDに不一致または重複があります。')
    const name = row.name.trim(), reason = row.reason.trim()
    if (!/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶー0-9０-９]{2,16}$/u.test(name) || names.has(name) || district.kind === 'ward' && !name.endsWith('区') || district.kind !== 'ward' && !/(?:町|丁目)$/.test(name) || /^(住宅|住宅地|温泉宿|道路|地形)町$/.test(name) || !reason || reason.length > 240 || 'source' in row && row.source !== 'llm' && row.source !== 'edited') throw new Error('地名に重複または不適切な形式があります。もう一度提案してください。')
    ids.add(row.id); names.add(name)
    return { id: row.id, name, reason, ...('source' in row ? { source: row.source as 'llm' | 'edited' } : {}) }
  })
}
