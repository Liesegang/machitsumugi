import type { CityMap, District } from '../domain/types'
import { distance, pointInRegion } from '../domain/geometry'

export interface NameProposal { id: string; name: string; reason: string }
export function districtNamingContext(map: CityMap, district: District) {
  const inside = (point: { x: number; y: number }) => district.regions?.length ? district.regions.some(region => pointInRegion(point, region)) : distance(point, district.point) < 300
  const buildings = map.buildings.filter(b => inside(b.polygon[0]!))
  const years = buildings.flatMap(b => b.builtYear === undefined ? [] : [b.builtYear])
  return {
    id: district.id, kind: district.kind ?? 'town', provisionalName: district.name,
    position: [Math.round(district.point.x / map.width * 100), Math.round(district.point.y / map.height * 100)],
    terrain: map.config.terrain, relief: map.config.relief ?? 'hills', origin: map.config.type,
    buildings: buildings.length, firstRecordedBuildingYear: years.length ? Math.min(...years) : null,
    lodgings: buildings.filter(b => b.use === 'lodging').length,
    facilities: map.facilities.filter(f => inside(f.point)).map(f => f.kind),
  }
}
/** Model output is untrusted data. IDs, names and every batch are checked. */
export function parseNameProposals(text: string, districts: Pick<District, 'id' | 'kind'>[], used: string[] = []): NameProposal[] {
  if (text.length > 30_000) throw new Error('命名結果が長すぎます。')
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim()
  const value: unknown = JSON.parse(cleaned)
  if (!value || typeof value !== 'object' || !('names' in value) || !Array.isArray(value.names) || value.names.length !== districts.length) throw new Error('地名の件数が区域と一致しません。もう一度提案してください。')
  const ids = new Set<string>(), names = new Set(used)
  return value.names.map((row: unknown) => {
    if (!row || typeof row !== 'object' || !('id' in row) || !('name' in row) || !('reason' in row) || typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.reason !== 'string') throw new Error('地名の形式が正しくありません。')
    const district = districts.find(d => d.id === row.id)
    if (!district || ids.has(row.id)) throw new Error('区域のIDに不一致または重複があります。')
    const name = row.name.trim(), reason = row.reason.trim()
    if (!/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶー0-9０-９]{2,16}$/u.test(name) || names.has(name) || district.kind === 'ward' && !name.endsWith('区') || !reason || reason.length > 240) throw new Error('地名に重複または不適切な形式があります。もう一度提案してください。')
    ids.add(row.id); names.add(name)
    return { id: row.id, name, reason }
  })
}
