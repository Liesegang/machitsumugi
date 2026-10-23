import type { CityMap, District } from '../domain/types'
import { distance, distanceToSegment, pointInRegion } from '../domain/geometry'

export interface NameProposal { id: string; name: string; reason: string }
export function validateGeographicNames(map: CityMap, proposals: NameProposal[]) {
  for (const proposal of proposals) {
    const district = map.districts.find(d => d.id === proposal.id)
    if (!district) throw new Error('区域が見つかりません。')
    const context = districtNamingContext(map, district)
    if (/[湯泉]/.test(proposal.name) && !context.lodgings && !context.facilities.includes('onsen')) throw new Error(`${proposal.name}には温泉の根拠がありません。温泉を意味する語を使わず命名してください。`)
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
  return {
    id: district.id, kind: district.kind ?? 'town', provisionalName: district.name,
    position: [Math.round(district.point.x / map.width * 100), Math.round(district.point.y / map.height * 100)],
    terrain: map.config.terrain, relief: map.config.relief ?? 'hills', origin: map.config.type,
    buildings: buildings.length, firstRecordedBuildingYear: years.length ? Math.min(...years) : null,
    lodgings: buildings.filter(b => b.use === 'lodging').length,
    facilities: map.facilities.filter(f => inside(f.point)).map(f => f.kind),
    observedFeatures: geography.filter(Boolean).join('。'),
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
    if (!/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶー0-9０-９]{2,16}$/u.test(name) || names.has(name) || district.kind === 'ward' && !name.endsWith('区') || district.kind !== 'ward' && /[市区県府都]$/.test(name) || !reason || reason.length > 240) throw new Error('地名に重複または不適切な形式があります。もう一度提案してください。')
    ids.add(row.id); names.add(name)
    return { id: row.id, name, reason }
  })
}
