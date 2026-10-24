import type { Area, Building, CityMap, Point, Railway, Road, Station } from './types'
import { boundsOf, corridorPolygon, distance, distanceToSegment, overlaps, pointInPolygon, pointInRegion, polygonArea, polygonOverlapsRegion, polygonsOverlap, segmentsCross, subtractRegions } from './geometry'
import { RailwayRoadConstraints } from './railway-road-constraints'

export type EditableEntityKind = 'building' | 'road' | 'area' | 'district' | 'facility' | 'railway' | 'station'
export type MapEdit = { id: string; year: number } & (
  | { operation: 'upsert'; targetKind: 'building'; value: Building }
  | { operation: 'upsert'; targetKind: 'road'; value: Road }
  | { operation: 'upsert'; targetKind: 'area'; value: Area }
  | { operation: 'delete'; targetKind: EditableEntityKind; targetId: string }
  | { operation: 'rename'; targetKind: Exclude<EditableEntityKind, 'road'>; targetId: string; name: string }
)
export const MAX_MAP_EDITS = 1000
export const MAX_EDIT_POINTS = 256
export interface MapEditIssue { id: string; reason: string }
const mapEditIssues = new WeakMap<CityMap, MapEditIssue[]>()
/** A hidden unsafe commitment remains in the project and can be corrected or
 * undone. Diagnostics belong to this materialized frame, never its archive. */
export function getMapEditIssues(map: CityMap): MapEditIssue[] { return [...(mapEditIssues.get(map) ?? [])] }
const keys = { building: 'buildings', road: 'roads', area: 'areas', district: 'districts', facility: 'facilities', railway: 'railways', station: 'stations' } as const
const kinds = Object.keys(keys) as EditableEntityKind[]
const record = (value: unknown) => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('編集データの形式が正しくありません。'); return value as Record<string, unknown> }
const text = (value: unknown, label: string, maximum = 128) => { if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`${label}は1〜${maximum}文字で指定してください。`); return value }
const number = (value: unknown, label: string, min: number, max: number, integer = false) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) throw new Error(`${label}は${min}〜${max}の${integer ? '整数' : '数値'}で指定してください。`); return value }
function choice<T extends string>(value: unknown, allowed: readonly T[], label: string): T { if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${label}に対応していません。`); return value as T }

/** Normalize only documented editing fields. The immutable generated snapshot
 * is kept separately; imports cannot smuggle arbitrary model properties here. */
export function validateMapEdits(input: unknown, width: number, height: number): MapEdit[] {
  if (!Array.isArray(input) || input.length > MAX_MAP_EDITS) throw new Error(`手動編集は${MAX_MAP_EDITS}件以内で保存してください。`)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('編集対象の地図範囲が正しくありません。')
  const ids = new Set<string>()
  return input.map(value => {
    const edit = record(value), id = text(edit.id, '編集ID'), year = number(edit.year, '編集年', 1650, 2025, true)
    if (ids.has(id)) throw new Error('編集IDが重複しています。'); ids.add(id)
    const operation = choice(edit.operation, ['upsert', 'delete', 'rename'] as const, '編集方法'), targetKind = choice(edit.targetKind, kinds, '編集対象')
    if (operation === 'delete') return { id, year, operation, targetKind, targetId: text(edit.targetId, '対象ID') }
    if (operation === 'rename') {
      if (targetKind === 'road') throw new Error('道路の名称変更には対応していません。')
      return { id, year, operation, targetKind, targetId: text(edit.targetId, '対象ID'), name: text(edit.name, '名前', 200) }
    }
    const item = record(edit.value), entityId = text(item.id, '地物ID')
    let pointCount = 0
    const points = (value: unknown, polygon: boolean): Point[] => {
      if (!Array.isArray(value) || value.length < (polygon ? 3 : 2) || value.length > MAX_EDIT_POINTS) throw new Error(`形は${polygon ? 3 : 2}〜${MAX_EDIT_POINTS}頂点で指定してください。`)
      const result = value.map(value => { const p = record(value); return { x: number(p.x, 'X座標', 0, width), y: number(p.y, 'Y座標', 0, height) } })
      if (polygon && distance(result[0]!, result.at(-1)!) < 1e-7) result.pop()
      pointCount += result.length
      if (pointCount > MAX_EDIT_POINTS || result.length < (polygon ? 3 : 2)) throw new Error(`1件の編集の合計頂点数は${MAX_EDIT_POINTS}以内にしてください。`)
      if (result.some((p, i) => result.slice(i + 1).some(q => distance(p, q) < 1e-7))) throw new Error('同じ頂点を重ねた形は指定できません。')
      if (polygon && polygonArea(result) < 1) throw new Error('土地・建物の面積は1m²以上にしてください。')
      if (selfIntersects(result, polygon)) throw new Error('自分自身と交差する形は指定できません。')
      return result
    }
    const builtYear = (value: unknown) => value === undefined ? year : number(value, '成立年', 1650, year, true)
    const name = item.name === undefined ? {} : { name: text(item.name, '名前', 200) }
    if (targetKind === 'building') return { id, year, operation, targetKind, value: { id: entityId, polygon: points(item.polygon, true), kind: choice(item.kind, ['residential', 'commercial', 'public', 'industrial'] as const, '建物の用途'), height: number(item.height, '階数', 1, 250, true), builtYear: builtYear(item.builtYear),
      ...(item.parcelId === undefined ? {} : { parcelId: text(item.parcelId, '建物の敷地ID') }),
      ...(item.occupancy === undefined ? {} : { occupancy: choice(item.occupancy, ['occupied', 'vacant', 'underused'] as const, '建物の利用状況') }),
      ...(item.occupiedHouseholds === undefined ? {} : { occupiedHouseholds: number(item.occupiedHouseholds, '入居世帯数', 0, 100_000, true) }),
      ...(item.use === undefined ? {} : { use: choice(item.use, ['lodging'] as const, '建物の用途') }),
      ...(item.lodgingType === undefined ? {} : { lodgingType: choice(item.lodgingType, ['ryokan', 'hotel'] as const, '宿泊施設の種類') }),
      ...(item.guestRooms === undefined ? {} : { guestRooms: number(item.guestRooms, '客室数', 1, 10_000, true) }), ...name } }
    if (targetKind === 'road') {
      if (item.bridge !== undefined && typeof item.bridge !== 'boolean') throw new Error('橋の指定が正しくありません。')
      if (item.controlledAccess !== undefined && typeof item.controlledAccess !== 'boolean') throw new Error('道路の通行制限が正しくありません。')
      if (item.boundaryContinuation !== undefined && typeof item.boundaryContinuation !== 'boolean') throw new Error('範囲外への道路継続の指定が正しくありません。')
      return { id, year, operation, targetKind, value: { id: entityId, points: points(item.points, false), kind: choice(item.kind, ['arterial', 'local'] as const, '道路の種類'), width: number(item.width, '道路幅', 1.5, 60), builtYear: builtYear(item.builtYear), ...(item.modifiedYear === undefined ? {} : { modifiedYear: number(item.modifiedYear, '道路変更年', 1650, year, true) }), ...(item.bridge === undefined ? {} : { bridge: item.bridge as boolean }), ...(item.level === undefined ? {} : { level: number(item.level, '道路の高さ区分', 0, 1, true) }), ...(item.controlledAccess === undefined ? {} : { controlledAccess: item.controlledAccess as boolean }), ...(item.boundaryContinuation === undefined ? {} : { boundaryContinuation: item.boundaryContinuation as boolean }), ...(item.role === undefined ? {} : { role: choice(item.role, ['highway', 'collector', 'lane', 'access', 'bridge', 'farm', 'expressway', 'ramp'] as const, '道路の役割') }), reason: '手動編集で配置した道路' } }
    }
    if (targetKind !== 'area') throw new Error('追加・移動できる地物は建物・道路・土地です。')
    const kind = choice(item.kind, ['forest', 'park', 'field'] as const, '土地の種類'), polygon = points(item.polygon, true)
    const holes = item.holes === undefined ? undefined : (() => { if (!Array.isArray(item.holes) || item.holes.length > 16) throw new Error('土地の内周は16個以内で指定してください。'); return item.holes.map(hole => points(hole, true)) })()
    for (const [i, hole] of (holes ?? []).entries()) if (!hole.every(p => pointInPolygon(p, polygon)) || hole.some((p, j) => polygon.some((q, k) => segmentsCross(p, hole[(j + 1) % hole.length]!, q, polygon[(k + 1) % polygon.length]!))) || holes!.slice(0, i).some(other => polygonsOverlap(hole, other))) throw new Error('土地の内周が外周・他の内周と交差しています。')
    if (polygonArea(polygon) - (holes ?? []).reduce((sum, ring) => sum + polygonArea(ring), 0) < 1) throw new Error('土地の有効面積は1m²以上にしてください。')
    return { id, year, operation, targetKind, value: { id: entityId, kind, polygon, ...(holes?.length ? { holes } : {}), ...(kind === 'field' ? { landUse: choice(item.landUse ?? 'meadow', ['meadow', 'woodland', 'paddy', 'dry-field'] as const, '土地の用途') } : {}), ...name } }
  })
}

function selfIntersects(points: Point[], closed: boolean) {
  const count = closed ? points.length : points.length - 1
  for (let i = 0; i < count; i++) for (let j = i + 2; j < count; j++) {
    if (closed && i === 0 && j === count - 1) continue
    const a = points[i]!, b = points[(i + 1) % points.length]!, c = points[j]!, d = points[(j + 1) % points.length]!
    if (segmentsCross(a, b, c, d) || distanceToSegment(a, c, d) < 1e-7 || distanceToSegment(b, c, d) < 1e-7 || distanceToSegment(c, a, b) < 1e-7 || distanceToSegment(d, a, b) < 1e-7) return true
    const cross = (p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (Math.abs(cross(c)) < 1e-8 && Math.abs(cross(d)) < 1e-8 && overlaps(boundsOf([a, b]), boundsOf([c, d]))) return true
  }
  return false
}

/** Return a concise placement failure for the editor. This validates geometry
 * and existing physical features, without terrain/urban simulation. */
export function editingError(map: CityMap, command: MapEdit): string | null {
  let edit: MapEdit
  try { edit = validateMapEdits([command], map.width, map.height)[0]! } catch (error) { return error instanceof Error ? error.message : '編集内容を確認してください。' }
  return placementError(map, edit)
}
function placementError(map: CityMap, edit: MapEdit): string | null {
  const existing = map[keys[edit.targetKind]].find(entity => entity.id === (edit.operation === 'upsert' ? edit.value.id : edit.targetId))
  if (edit.operation !== 'upsert') {
    if (!existing) return '編集する地物が見つかりません。'
    if (edit.operation === 'delete' && edit.targetKind === 'area' && 'kind' in existing && existing.kind === 'water') return '水域の形は編集できません。'
    return null
  }
  if (edit.targetKind === 'area' && existing && 'kind' in existing && existing.kind === 'water') return '水域の形は編集できません。'
  const water = map.areas.filter(area => area.kind === 'water')
  const buildingPolygons = map.buildings.filter(b => edit.targetKind !== 'building' || b.id !== edit.value.id).map(b => b.polygon)
  const stationPolygons = map.stations.flatMap(station => station.buildingPolygon ? [station.buildingPolygon] : [])
  const overlapsWater = (polygon: Point[]) => { const bounds = boundsOf(polygon); return water.some(area => overlaps(bounds, boundsOf(area.polygon)) && polygonOverlapsRegion(polygon, area)) }
  const overlapsBuilding = (polygon: Point[]) => { const bounds = boundsOf(polygon); return [...buildingPolygons, ...stationPolygons].some(other => overlaps(bounds, boundsOf(other)) && polygonsOverlap(polygon, other)) }
  const surfaceRailways = map.railways.filter(railway => railway.mode !== 'subway')
  if (edit.targetKind === 'road') {
    const road = edit.value
    const footprints = road.points.slice(1).map((p, i) => corridorPolygon(road.points[i]!, p, road.width / 2))
    if (footprints.some(overlapsBuilding)) return '道路が既存の建物・駅舎と重なります。'
    if (footprints.some(overlapsWater) && !road.bridge) return '川を渡る道路は「橋」を選んでください。'
    if (road.bridge && [road.points[0]!, road.points.at(-1)!].some(p => water.some(area => pointInRegion(p, area)))) return '橋の両端を陸上に置いてください。'
    if ((road.level ?? 0) === 0) {
      // Centreline checks alone miss a wide street running beside the track.
      // Keep perpendicular station-forecourt terminals possible, but prevent
      // parallel road surfaces from occupying the railway's physical corridor.
      if (road.points.slice(1).some((b, i) => surfaceRailways.some(railway => railway.points.slice(1).some((d, j) => {
        const a = road.points[i]!, c = railway.points[j]!, cosine = Math.abs(((b.x - a.x) * (d.x - c.x) + (b.y - a.y) * (d.y - c.y)) / (distance(a, b) * distance(c, d) || 1))
        return cosine > Math.cos(Math.PI / 6) && polygonsOverlap(footprints[i]!, corridorPolygon(c, d, 4))
      })))) return '地上の線路用地と道路が重なります。'
      const constraints = new RailwayRoadConstraints(surfaceRailways), inherited = map.roads.filter(other => (other.level ?? 0) === 0 && !other.controlledAccess && other.role !== 'expressway' && other.role !== 'ramp')
      constraints.updateExistingRoads(inherited)
      const existingCrossings = inherited.flatMap(other => constraints.crossings(other.points))
      if (!Number.isFinite(constraints.pathCost(road.points, road.role ?? 'lane')) || constraints.crossings(road.points).some(hit => !existingCrossings.some(other => other.railwayId === hit.railwayId && distance(other.point, hit.point) <= 2))) return '地上線を新たに横断する道路は配置できません。既存の踏切へ接続してください。'
    }
    return null
  }
  const region = edit.value
  if (overlapsWater(region.polygon)) return '水域と重なる場所には配置できません。'
  if (edit.targetKind === 'building') {
    if (overlapsBuilding(region.polygon)) return '既存の建物・駅舎と重なります。'
    if (map.roads.some(road => road.points.slice(1).some((p, i) => polygonOverlapsRegion(region.polygon, { polygon: corridorPolygon(road.points[i]!, p, road.width / 2) })))) return '道路上には建物を配置できません。'
    if (surfaceRailways.some(railway => railway.points.slice(1).some((p, i) => polygonOverlapsRegion(region.polygon, { polygon: corridorPolygon(railway.points[i]!, p, 4) })))) return '地上の線路上には建物を配置できません。'
  }
  return null
}

/** Manual overlays are dated commands over a generated frame. The underlying
 * history, stock, parcels and simulation budgets are never rewritten. */
export function applyMapEdits(base: CityMap, commands: MapEdit[]): CityMap {
  if (!commands.length) return base
  // Array order is the Undo journal, not the city's chronology: users can edit
  // an earlier frame after a later one. Stable sorting preserves same-year intent.
  const edits = finalEdits(validateMapEdits(commands, base.width, base.height).filter(edit => edit.year <= (base.year ?? base.config.targetYear ?? 2025)).sort((a, b) => a.year - b.year))
  const manualBuildingIds = new Set<string>(), acquiredBuildingIds = new Set<string>(), deletedBuildingIds = new Set<string>()
  const historicalBuildingIds = new Set(base.timeline?.buildings.map(version => version.value.id))
  const issues: MapEditIssue[] = []
  let map = base
  // Final tombstones also remove their physical obstacles. Applying these first
  // keeps a deleted route from suppressing a building in the displayed frame.
  for (const edit of [...edits.filter(edit => edit.operation === 'delete'), ...edits.filter(edit => edit.operation !== 'delete')]) {
    const key = keys[edit.targetKind], entities = map[key]
    if (edit.operation === 'delete') {
      // A tombstone cannot be used to erase immutable sea/river physics.
      if (edit.targetKind === 'area' && map.areas.some(area => area.id === edit.targetId && area.kind === 'water')) { issues.push({ id: edit.id, reason: '水域の形は編集できません。' }); continue }
      if (edit.targetKind === 'building') deletedBuildingIds.add(edit.targetId)
      const railway = edit.targetKind === 'railway' ? map.railways.find(railway => railway.id === edit.targetId) : undefined
      const stations = railway ? map.stations.filter(station => !belongsToRailway(station, railway, map.railways)) : map.stations
      map = { ...map, [key]: entities.filter(entity => entity.id !== edit.targetId), ...(railway ? { stations } : {}) }; continue
    }
    if (edit.operation === 'rename') { map = { ...map, [key]: entities.map(entity => entity.id === edit.targetId ? { ...entity, name: edit.name, ...(edit.targetKind === 'district' ? { namingSource: 'edited' as const } : {}) } : entity) }; continue }
    if (edit.targetKind !== 'area') {
      const footprints = edit.targetKind === 'building' ? [edit.value.polygon] : edit.value.points.slice(1).map((p, i) => corridorPolygon(edit.value.points[i]!, p, edit.value.width / 2))
      // Check imported and future-frame replays against the same physical
      // constraints as interactive placement. Later generated houses can be
      // acquired, while contemporary stock and manual buildings stay protected.
      const historical = base.timeline?.buildings.filter(version => version.from <= edit.year && (version.to === undefined || edit.year < version.to)).map(version => version.value) ?? []
      const buildingsAtCommitment = [...historical.filter(building => !manualBuildingIds.has(building.id) && !acquiredBuildingIds.has(building.id) && !deletedBuildingIds.has(building.id)),
        ...map.buildings.filter(building => manualBuildingIds.has(building.id) || !historicalBuildingIds.has(building.id) && (building.builtYear ?? 1650) <= edit.year)]
      const failure = placementError({ ...map, buildings: buildingsAtCommitment }, edit)
      if (failure) { issues.push({ id: edit.id, reason: failure }); continue }
      // A manual commitment persists when later generated stock is materialized.
      // Acquisition affects this visible frame only; Undo restores the archive.
      const buildings = map.buildings.filter(building => {
        if (manualBuildingIds.has(building.id) || !footprints.some(polygon => overlaps(boundsOf(polygon), boundsOf(building.polygon)) && polygonsOverlap(polygon, building.polygon))) return true
        acquiredBuildingIds.add(building.id); return false
      })
      if (edit.targetKind === 'building') manualBuildingIds.add(edit.value.id)
      map = { ...map, buildings, [key]: [...(edit.targetKind === 'building' ? buildings : entities).filter(entity => entity.id !== edit.value.id), edit.value], areas: cutAreas(map.areas, footprints.map(polygon => ({ polygon })), edit.id) }
      continue
    }
    const paint = edit.value, bounds = boundsOf(paint.polygon)
    if (map.areas.some(area => area.id === paint.id && area.kind === 'water')) { issues.push({ id: edit.id, reason: '水域の形は編集できません。' }); continue }
    // A later building (including another manual commitment) masks the land
    // cover instead of growing trees through a roof or painting crops on it.
    const masks = [...map.buildings.map(building => ({ polygon: building.polygon })), ...map.stations.flatMap(station => station.buildingPolygon ? [{ polygon: station.buildingPolygon }] : []), ...map.areas.filter(area => area.kind === 'water'),
      ...map.roads.filter(road => (road.level ?? 0) === 0).flatMap(road => road.points.slice(1).map((p, i) => ({ polygon: corridorPolygon(road.points[i]!, p, road.width / 2) }))),
      ...map.railways.filter(railway => railway.mode !== 'subway').flatMap(railway => railway.points.slice(1).map((p, i) => ({ polygon: corridorPolygon(railway.points[i]!, p, 4) }))),
    ].filter(region => overlaps(bounds, boundsOf(region.polygon)))
    const pieces = subtractRegions(paint, masks).map((piece, i) => ({ ...paint, polygon: piece.polygon, holes: piece.holes, id: i ? splitId(paint.id, edit.id, i) : paint.id }))
    map = { ...map, areas: [...cutAreas(map.areas.filter(area => area.id !== paint.id), [paint], edit.id), ...pieces] }
  }
  if (issues.length) { if (map === base) map = { ...base }; mapEditIssues.set(map, issues) }
  return map
}
function belongsToRailway(station: Station, railway: Railway, railways: Railway[]): boolean {
  if (station.railwayId) return station.railwayId === railway.id
  if ((station.mode ?? 'surface') !== (railway.mode ?? 'surface')) return false
  const onRoute = (route: Railway) => route.points.slice(1).reduce((nearest, p, i) => Math.min(nearest, distanceToSegment(station.point, route.points[i]!, p)), Infinity)
  const nearest = onRoute(railway)
  // Legacy files lack ownership IDs. At a junction or equally close parallel
  // line keep the ambiguous marker rather than deleting another route's station.
  return nearest <= 10 && !railways.some(other => other.id !== railway.id && (other.mode ?? 'surface') === (railway.mode ?? 'surface') && onRoute(other) <= nearest + 1e-7)
}
/** Resolve replacement/move/delete before acquiring ground so an old footprint
 * does not leave a phantom demolition or land-use hole behind. */
function finalEdits(edits: MapEdit[]): MapEdit[] {
  const resolved = new Map<string, { edit: MapEdit; index: number }>()
  edits.forEach((edit, index) => {
    const key = `${edit.targetKind}:${edit.operation === 'upsert' ? edit.value.id : edit.targetId}`, prior = resolved.get(key), previous = prior?.edit
    if (edit.operation === 'rename' && previous?.operation === 'upsert') resolved.set(key, { index: prior!.index, edit: { ...previous, value: { ...previous.value, name: edit.name } } as MapEdit })
    else if (edit.operation !== 'rename' || previous?.operation !== 'delete') resolved.set(key, { edit, index })
  })
  return [...resolved.values()].sort((a, b) => a.index - b.index).map(value => value.edit)
}
function cutAreas(areas: Area[], masks: { polygon: Point[]; holes?: Point[][] }[], editId: string): Area[] {
  const cuts = masks.map(mask => ({ mask, bounds: boundsOf(mask.polygon) }))
  return areas.flatMap(area => {
    if (area.kind === 'water') return [area]
    const bounds = boundsOf(area.polygon), relevant = cuts.filter(cut => overlaps(bounds, cut.bounds)).map(cut => cut.mask)
    if (!relevant.length) return [area]
    return subtractRegions(area, relevant).map((piece, i) => ({ ...area, polygon: piece.polygon, holes: piece.holes, id: i ? splitId(area.id, editId, i) : area.id }))
  })
}
function splitId(id: string, editId: string, index: number) {
  let hash = 2166136261
  for (const c of `${id}:${editId}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619)
  return `${id.slice(0, 100)}~${(hash >>> 0).toString(36)}~${index}`
}
