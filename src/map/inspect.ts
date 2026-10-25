import { boundsOf, distance, distanceToSegment, pointInRegion, polygonArea } from '../domain/geometry'
import type { Area, Building, CityMap, District, Facility, GrowthEvent, Point, Railway, Road } from '../domain/types'

export type MapFeature =
  | { type: 'building'; item: Building }
  | { type: 'facility'; item: Facility }
  | { type: 'road'; item: Road }
  | { type: 'railway'; item: Railway }
  | { type: 'district'; item: District }
  | { type: 'area'; item: Area }
const buildingNames = { residential: '住宅', commercial: '商業施設', public: '公共施設', industrial: '工業・倉庫' }
const facilityNames = { castle: '城跡', shrine: '神社', school: '学校', university: '大学', hospital: '病院', police: '交番', shop: '商店街', park: '公園', port: '港', onsen: '共同浴場' }
export function featureTitle(feature: MapFeature): string {
  const item = feature.item
  if (feature.type === 'building') {
    const building = feature.item
    return building.name || (building.use === 'lodging' ? building.lodgingType === 'hotel' ? 'ホテル' : '旅館' : building.id.startsWith('castle-') ? ({ 'castle-keep': '天守', 'castle-small-keep': '小天守', 'castle-palace': '本丸御殿', 'castle-ninomaru-palace': '二の丸御殿' }[building.id] || '城郭の建物') : buildingNames[building.kind])
  }
  if ('name' in item && item.name) return item.name
  if (feature.type === 'facility') return facilityNames[feature.item.kind]
  if (feature.type === 'road') return feature.item.role === 'expressway' ? '高速道路' : feature.item.bridge ? '橋梁' : feature.item.kind === 'arterial' ? '主要道路' : feature.item.role === 'farm' ? '農道' : '街路'
  if (feature.type === 'area') return feature.item.landUse === 'paddy' ? '水田' : feature.item.landUse === 'dry-field' ? '畑' : feature.item.landUse === 'woodland' ? '疎林' : feature.item.landUse === 'meadow' ? '草地' : feature.item.kind === 'forest' ? '森林' : feature.item.kind === 'water' ? '水域' : '土地'
  return '地区'
}
export function featureSummary(feature: MapFeature): string {
  if (feature.type === 'building') {
    const b = feature.item
    return `${b.height}階 · ${Math.round(polygonArea(b.polygon))} m²${b.guestRooms === undefined ? '' : ` · 客室${b.guestRooms}室`}${b.builtYear === undefined ? '' : ` · ${b.builtYear}年建築`}`
  }
  if (feature.type === 'road') {
    const road = feature.item
    return `幅員${road.width} m${road.builtYear === undefined ? '' : ` · ${road.builtYear}年成立`}${road.modifiedYear !== undefined && road.modifiedYear !== road.builtYear ? ` · ${road.modifiedYear}年改良` : ''}`
  }
  if (feature.type === 'railway') return feature.item.builtYear === undefined ? '地域鉄道' : `${feature.item.builtYear}年開業`
  if (feature.type === 'district') return `${feature.item.kind === 'ward' ? '区' : '町の区域'}${feature.item.foundedYear === undefined ? '' : ` · ${feature.item.foundedYear}年から敷地の記録あり`}`
  return ''
}
/** Read recorded events, including previous buildings on the same parcel. */
export function featureHistory(map: CityMap, feature: MapFeature): GrowthEvent[] {
  const ids = new Set([feature.item.id])
  if (feature.type === 'building' && feature.item.parcelId) {
    const parcel = map.parcels?.find(p => p.id === feature.item.parcelId)
    ids.add(feature.item.parcelId)
    for (const version of map.timeline?.buildings ?? []) if (version.value.parcelId === feature.item.parcelId) ids.add(version.value.id)
    if (parcel) {
      ids.add(`building-${parcel.id}`)
      const previousIds = new RegExp(`^building-${parcel.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9]+$`)
      for (const event of map.events ?? []) if (previousIds.test(event.entityId)) ids.add(event.entityId)
      for (const building of map.buildings) if (building.parcelId === parcel.id) ids.add(building.id)
    }
  }
  if (feature.type === 'facility') {
    if (feature.item.id === `facility-${feature.item.kind}` || feature.item.id === 'origin') {
      const stems = [`facility-building-${feature.item.kind}`, `facility-lot-${feature.item.kind}`, `facility-access-${feature.item.kind}`]
      const belongs = (id: string) => stems.some(stem => id === stem || id.startsWith(`${stem}-`))
      for (const event of map.events ?? []) if (belongs(event.entityId)) ids.add(event.entityId)
      for (const b of map.buildings) if (belongs(b.id) || feature.item.kind === 'castle' && b.id.startsWith('castle-')) ids.add(b.id)
    }
  }
  if (feature.type === 'district' && feature.item.regions) {
    for (const b of map.buildings) if (feature.item.regions.some(region => pointInRegion(b.polygon[0]!, region))) ids.add(b.id)
    for (const p of map.parcels ?? []) if (feature.item.regions.some(region => pointInRegion(p.entrance, region))) ids.add(p.id)
  }
  const recorded = (map.events ?? []).filter(event => ids.has(event.entityId)).sort((a, b) => a.year - b.year || a.id.localeCompare(b.id))
  // An explicit construction year is a stored fact, even for a landmark whose
  // creation predates the current event log. Never invent a historical story.
  const year = 'builtYear' in feature.item ? feature.item.builtYear : undefined
  if (year !== undefined && !recorded.some(event => event.year === year)) recorded.unshift({ id: `recorded-${feature.item.id}`, entityId: feature.item.id, year, kind: feature.type === 'railway' ? 'railway' : feature.type === 'road' ? 'road' : 'construction', reason: feature.type === 'road' ? '道の成立' : feature.type === 'railway' ? '路線の開業年' : '建物の建築年' })
  if (feature.type === 'road' && feature.item.modifiedYear !== undefined && feature.item.modifiedYear !== year && !recorded.some(event => event.year === feature.item.modifiedYear)) recorded.push({ id: `recorded-modification-${feature.item.id}`, entityId: feature.item.id, year: feature.item.modifiedYear, kind: 'road', reason: feature.item.reason || '道路の改良' })
  return recorded.sort((a, b) => a.year - b.year)
}

type Hit = { feature: MapFeature; polygon?: Point[]; holes?: Point[][]; a?: Point; b?: Point; pad?: number }
/** A shared index makes mouse movement independent of the total house count. */
export function createMapInspector(map: CityMap) {
  const buckets = new Map<string, Hit[]>(), cell = 100
  const insert = (hit: Hit, points: Point[], pad = 0) => {
    const box = boundsOf(points)
    for (let x = Math.floor((box.minX - pad) / cell); x <= Math.floor((box.maxX + pad) / cell); x++) for (let y = Math.floor((box.minY - pad) / cell); y <= Math.floor((box.maxY + pad) / cell); y++) {
      const key = `${x}:${y}`, bucket = buckets.get(key) ?? []
      bucket.push(hit); buckets.set(key, bucket)
    }
  }
  for (const b of map.buildings) insert({ feature: { type: 'building', item: b }, polygon: b.polygon }, b.polygon)
  for (const road of map.roads) for (let i = 1; i < road.points.length; i++) insert({ feature: { type: 'road', item: road }, a: road.points[i - 1], b: road.points[i], pad: road.width / 2 }, [road.points[i - 1]!, road.points[i]!], road.width / 2)
  for (const railway of map.railways) for (let i = 1; i < railway.points.length; i++) insert({ feature: { type: 'railway', item: railway }, a: railway.points[i - 1], b: railway.points[i], pad: 3 }, [railway.points[i - 1]!, railway.points[i]!], 3)
  for (const district of map.districts.filter(d => d.kind !== 'ward')) for (const region of district.regions ?? []) insert({ feature: { type: 'district', item: district }, ...region }, region.polygon)
  const ranks = { facility: 0, building: 1, railway: 2, road: 3, district: 4, area: 5 }
  return (point: Point, tolerance: number, visible: { buildings: boolean; facilities: boolean; roads: boolean; railway: boolean; terrain: boolean; labels: boolean }): MapFeature | undefined => {
    if (visible.facilities) {
      const facility = map.facilities.find(f => distance(point, f.point) < tolerance * 2)
      if (facility) return { type: 'facility', item: facility }
    }
    const hits = new Set<Hit>()
    for (let x = Math.floor((point.x - tolerance) / cell); x <= Math.floor((point.x + tolerance) / cell); x++) for (let y = Math.floor((point.y - tolerance) / cell); y <= Math.floor((point.y + tolerance) / cell); y++) for (const hit of buckets.get(`${x}:${y}`) ?? []) hits.add(hit)
    const found = [...hits].filter(hit => {
      if (hit.feature.type === 'building') return visible.buildings && pointInRegion(point, { polygon: hit.polygon! })
      if (hit.feature.type === 'district') return visible.labels && pointInRegion(point, { polygon: hit.polygon!, holes: hit.holes })
      if (hit.feature.type === 'road' && !visible.roads || hit.feature.type === 'railway' && !visible.railway) return false
      return hit.a && hit.b && distanceToSegment(point, hit.a, hit.b) <= (hit.pad ?? 0) + tolerance
    }).sort((a, b) => ranks[a.feature.type] - ranks[b.feature.type])
    if (found[0]) return found[0].feature
    if (visible.labels) {
      const district = map.districts.find(d => distance(point, d.point) < tolerance * 2)
      if (district) return { type: 'district', item: district }
    }
    // Natural cover can have thousands of vertices; only evaluate it on click,
    // rather than scanning every land polygon on each mouse movement.
    return undefined
  }
}
