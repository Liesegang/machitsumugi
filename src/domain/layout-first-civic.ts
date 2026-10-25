import type { Area, Building, CityConfig, Facility, FacilityKind, Point, Railway, Road } from './types'
import type { PolygonRegion } from './geometry'
import type { TerrainModel } from './terrain'
import type { LayoutFirstZone } from './layout-first-types'
import { boundsOf, corridorPolygon, distance, distanceToSegment, overlaps, pointInPolygon, pointInRegion, polygonOverlapsRegion, rectangle, seededRandom } from './geometry'
import { surveyDevelopmentSite } from './development-terrain'
import { surveyCastleLayout } from './castle-layout'
import { controlledRoad, materializeRoadJunctions } from './road-graph'
import { certifyLayoutAccess } from './layout-first-access'

export interface LayoutFirstCivicInput {
  config: CityConfig; width: number; height: number
  terrain: Pick<TerrainModel, 'areas' | 'elevation' | 'slope' | 'waterAt'> & Partial<Pick<TerrainModel, 'channelAt'>>
  center: Point; zones: readonly LayoutFirstZone[]
}
export interface LayoutFirstCivicResult {
  areas: Area[]; buildings: Building[]; facilities: Facility[]; roads: Road[]
  reserves: PolygonRegion[]
  accessTargets: { id: string; point: Point; builtYear: number }[]
  unplacedFacilities: { kind: FacilityKind; reason: string }[]
  optionalAccessIds: string[]
  /** The orchestrator may remove a satellite that cannot acquire public access,
   * before assigning any household land. The primary programme stays mandatory. */
  optionalProgrammes: { accessId: string; facilityId: string; areaIds: string[]; roadIds: string[]; reserves: PolygonRegion[] }[]
}
interface LocalBuilding { polygon: Point[]; floors: number; label: string; lodging?: boolean }
interface LocalPattern { width: number; depth: number; buildings: LocalBuilding[]; areas: { polygon: Point[]; label?: string; park?: boolean }[]; paths: Point[][] }
interface HospitalRepairReport {
  anchors: number; connectedAnchors: number; selectedAnchors: number; examinedSites: number; attemptedSites: number
  rejected: Record<string, number>; samples: { point: Point; reason: string }[]; adopted?: Point
}
const hospitalRepairs = new WeakMap<LayoutFirstCivicResult, HospitalRepairReport>()
export const hospitalRepairReport = (programme: LayoutFirstCivicResult) => hospitalRepairs.get(programme)
const names: Record<FacilityKind, string> = { castle: '城跡公園', shrine: '八幡神社', school: '第一小学校', hospital: '市民病院', police: '中央警察署', university: '地域大学', park: '中央公園', port: '港・魚市場', onsen: '共同浴場', shop: '中央商店街' }
const openings: Record<FacilityKind, number> = { castle: 1650, shrine: 1650, school: 1875, hospital: 1920, police: 1880, university: 1965, park: 1955, port: 1920, onsen: 1650, shop: 1750 }
const line = (...pairs: [number, number][]) => pairs.map(([x, y]) => ({ x, y }))
const block = (x: number, y: number, w: number, h: number, floors: number, label: string, lodging = false): LocalBuilding => ({ polygon: rectangle(x, y, w, h), floors, label, ...(lodging ? { lodging } : {}) })

function pattern(kind: FacilityKind, compact = false): LocalPattern {
  if (kind === 'university') {
    if (compact) return { width: 220, depth: 180, buildings: [block(-72, -45, 40, 13, 3, '本館'), block(29, -41, 34, 12, 3, '講義棟'), block(-63, 31, 30, 14, 2, '図書館'), block(27, 37, 32, 12, 2, '研究棟')], areas: [{ polygon: rectangle(-8, -7, 16, 14), park: true }], paths: [line([0, -96], [0, 65]), line([0, -38], [-28, -38]), line([0, -35], [25, -35]), line([0, 38], [-29, 38]), line([0, 43], [23, 43])] }
    return { width: 320, depth: 260, buildings: [block(-96, -64, 56, 18, 4, '本館'), block(39, -61, 50, 18, 4, '講義棟'), block(-89, 43, 46, 18, 3, '図書館'), block(39, 45, 52, 18, 4, '研究棟'), block(-130, -8, 36, 16, 2, '学生会館'), block(95, -8, 36, 16, 2, '講堂'), block(-27, 85, 54, 22, 2, '体育館')], areas: [{ polygon: rectangle(-8, -7, 16, 14), park: true }], paths: [line([0, -136], [0, 81]), line([0, -55], [-36, -55]), line([0, -52], [35, -52]), line([0, 52], [-39, 52]), line([0, 54], [35, 54]), line([0, 0], [-90, 0]), line([0, 0], [91, 0])] }
  }
  if (kind === 'school') return { width: 170, depth: 145, buildings: [
    { polygon: line([-65, -42], [55, -42], [55, -22], [-45, -22], [-45, 30], [-65, 30]), floors: 3, label: '校舎' }, block(-72, 45, 38, 18, 1, '体育館')],
    areas: [{ polygon: rectangle(-22, -10, 84, 62), label: '校庭', park: true }], paths: [line([0, -78.5], [0, -46]), line([0, -62], [74, -62], [74, 25], [66, 25]), line([0, -62], [-78, -62], [-78, 52], [-76, 52])] }
  if (kind === 'hospital') return { width: 130, depth: 110, buildings: [{ polygon: line([-48, -25], [-18, -25], [-18, 0], [18, 0], [18, -25], [48, -25], [48, 40], [18, 40], [18, 15], [-18, 15], [-18, 40], [-48, 40]), floors: 5, label: '診療棟・病棟' }], areas: [], paths: [line([0, -61], [0, -4])] }
  if (kind === 'police') return { width: 65, depth: 65, buildings: [block(-18, -4, 36, 23, 2, '庁舎')], areas: [], paths: [line([0, -38.5], [0, -8])] }
  if (kind === 'shrine') return { width: 100, depth: 110, buildings: [block(-24, 0, 48, 22, 2, '拝殿'), block(-40, 30, 24, 14, 1, '社務所')], areas: [{ polygon: rectangle(-50, -55, 100, 110), park: true }], paths: [line([0, -61], [0, -4]), line([0, -12], [-30, -12], [-30, 26])] }
  if (kind === 'park') return { width: 160, depth: 135, buildings: [], areas: [{ polygon: rectangle(-80, -67.5, 160, 135), park: true }], paths: [line([0, -73.5], [0, -48]), line([0, -48], [-48, -30], [-52, 28], [0, 42], [48, 25], [46, -28], [0, -48])] }
  if (kind === 'onsen') return { width: 180, depth: 150, buildings: [block(-24, -15, 48, 30, 2, '共同浴場'), block(-70, -35, 30, 20, 2, '松風旅館', true), block(35, -22, 42, 25, 3, '川辺旅館', true), block(-45, 35, 54, 24, 3, '山の宿', true), block(25, 35, 42, 24, 2, '竹屋旅館', true)], areas: [], paths: [line([0, -81], [0, -19]), line([0, -55], [-36, -55], [-36, -25]), line([0, -55], [31, -55], [31, -10]), line([0, -65], [-80, -65], [-80, 65], [-18, 65], [-18, 63]), line([0, -65], [83, -65], [83, 65], [46, 65], [46, 63])] }
  return { width: 150, depth: 90, buildings: [block(-58, -10, 62, 26, 2, '魚市場'), block(20, -10, 40, 26, 1, '荷捌き倉庫')], areas: [{ polygon: rectangle(-70, 36, 140, 8), label: '岸壁荷捌き場' }], paths: [line([0, -51], [0, -16]), line([0, -30], [65, -30], [65, 30], [0, 30]), line([65, 30], [-65, 30])] }
}

/** Reserve the requested public programme before streets and private titles.
 * Woodland can be cleared; water and unformable building pads remain physical
 * exclusions. Site retries are finite and independent of a fiscal growth loop. */
export function reserveLayoutFirstCivics(input: LayoutFirstCivicInput): LayoutFirstCivicResult {
  return civicProgramme(input)
}

/** Repair one hypothetical reservation against the public streets that really
 * exist, before household land is adopted. Reuse these roads unchanged and
 * append the returned civic roads; no terrain/rail or other programme is rerun.
 * If no complete surveyed repair fits, return the previous programme intact. */
export function resurveyLayoutFirstHospital(input: LayoutFirstCivicInput, previous: LayoutFirstCivicResult, roads: Road[], railways: Railway[] = [], protectedGround: readonly PolygonRegion[] = []): LayoutFirstCivicResult {
  if (!input.config.facilities.includes('hospital')) return previous
  return civicProgramme(input, { previous, roads, railways, protectedGround })
}

function civicProgramme(input: LayoutFirstCivicInput, repair?: { previous: LayoutFirstCivicResult; roads: Road[]; railways: Railway[]; protectedGround: readonly PolygonRegion[] }): LayoutFirstCivicResult {
  const repairReport: HospitalRepairReport = { anchors: 0, connectedAnchors: 0, selectedAnchors: 0, examinedSites: 0, attemptedSites: 0, rejected: {}, samples: [] }
  let candidatePoint: Point | undefined
  const reject = (reason: string) => {
    if (repair) { repairReport.rejected[reason] = (repairReport.rejected[reason] ?? 0) + 1; if (candidatePoint && repairReport.samples.length < 40) repairReport.samples.push({ point: candidatePoint, reason }) }
    return false
  }
  const isHospital = (id: string) => /^(?:facility-(?:lot|building|access)-hospital)(?:-|$)/.test(id) || id === 'facility-hospital'
  const oldHospitalPolygons = repair?.previous.areas.filter(area => isHospital(area.id)).map(area => area.polygon) ?? []
  const samePolygon = (a: Point[], b: Point[]) => a === b || a.length === b.length && a.every((p, i) => distance(p, b[i]!) < 1e-7)
  const result: LayoutFirstCivicResult = repair ? {
    areas: repair.previous.areas.filter(area => !isHospital(area.id)), buildings: repair.previous.buildings.filter(building => !isHospital(building.id)),
    facilities: repair.previous.facilities.filter(facility => !isHospital(facility.id)), roads: repair.previous.roads.filter(road => !isHospital(road.id)),
    reserves: repair.previous.reserves.filter(region => !oldHospitalPolygons.some(polygon => samePolygon(polygon, region.polygon))),
    accessTargets: repair.previous.accessTargets.filter(target => !isHospital(target.id)), unplacedFacilities: repair.previous.unplacedFacilities.filter(item => item.kind !== 'hospital'),
    optionalAccessIds: [...repair.previous.optionalAccessIds], optionalProgrammes: [...repair.previous.optionalProgrammes],
  } : { areas: [], buildings: [], facilities: [], roads: [], reserves: [], accessTargets: [], unplacedFacilities: [], optionalAccessIds: [], optionalProgrammes: [] }
  const boundary = (p: Point) => p.x >= 10 && p.y >= 10 && p.x <= input.width - 10 && p.y <= input.height - 10
  const waters = input.terrain.areas.filter(area => area.kind === 'water')
  const existingPaths: PolygonRegion[] = repair ? result.roads.flatMap(road => road.points.slice(1).flatMap((b, i) => distance(road.points[i]!, b) > .01 ? [{ polygon: corridorPolygon(road.points[i]!, b, road.width / 2 + .25) }] : [])) : []
  const repairRoads = repair?.roads.filter(road => !isHospital(road.id)) ?? []
  const railMasks: PolygonRegion[] = repair?.railways.filter(railway => railway.mode !== 'subway').flatMap(railway => railway.points.slice(1).flatMap((b, i) => distance(railway.points[i]!, b) > .01 ? [{ polygon: corridorPolygon(railway.points[i]!, b, 10.5) }] : [])) ?? []
  const transportBins = new Map<string, { region: PolygonRegion; bounds: ReturnType<typeof boundsOf> }[]>()
  const fixedGround = [...railMasks, ...repair?.protectedGround ?? []]
  for (const region of [...repairRoads.flatMap(road => road.points.slice(1).flatMap((b, i) => distance(road.points[i]!, b) > .01 ? [{ polygon: corridorPolygon(road.points[i]!, b, road.width / 2 + .75) }] : [])), ...fixedGround]) {
    const bounds = boundsOf(region.polygon), item = { region, bounds }
    for (let x = Math.floor(bounds.minX / 100); x <= Math.floor(bounds.maxX / 100); x++) for (let y = Math.floor(bounds.minY / 100); y <= Math.floor(bounds.maxY / 100); y++) { const key = `${x}:${y}`, bucket = transportBins.get(key) ?? []; bucket.push(item); transportBins.set(key, bucket) }
  }
  const transportClear = (polygon: Point[]) => {
    if (!transportBins.size) return true
    const bounds = boundsOf(polygon), found = new Set<{ region: PolygonRegion; bounds: ReturnType<typeof boundsOf> }>()
    for (let x = Math.floor(bounds.minX / 100); x <= Math.floor(bounds.maxX / 100); x++) for (let y = Math.floor(bounds.minY / 100); y <= Math.floor(bounds.maxY / 100); y++) for (const item of transportBins.get(`${x}:${y}`) ?? []) found.add(item)
    return ![...found].some(item => overlaps(bounds, item.bounds) && polygonOverlapsRegion(polygon, item.region))
  }
  function ground(polygon: Point[], maxSlope = .24) {
    if (waters.some(water => polygonOverlapsRegion(polygon, water))) return false
    const samples: Point[] = [...polygon]
    for (const [i, p] of polygon.entries()) { const q = polygon[(i + 1) % polygon.length]!, count = Math.ceil(distance(p, q) / 12); for (let j = 1; j < count; j++) samples.push({ x: p.x + (q.x - p.x) * j / count, y: p.y + (q.y - p.y) * j / count }) }
    const minX = Math.min(...polygon.map(p => p.x)), maxX = Math.max(...polygon.map(p => p.x)), minY = Math.min(...polygon.map(p => p.y)), maxY = Math.max(...polygon.map(p => p.y))
    for (let y = minY + 10; y < maxY; y += 20) for (let x = minX + 10; x < maxX; x += 20) if (pointInPolygon({ x, y }, polygon)) samples.push({ x, y })
    return samples.every(p => boundary(p) && !input.terrain.waterAt(p) && Number.isFinite(input.terrain.elevation(p)) && Number.isFinite(input.terrain.slope(p)) && input.terrain.slope(p) <= maxSlope)
  }
  const clear = (polygon: Point[]) => transportClear(polygon) && ![...result.reserves, ...existingPaths].some(region => polygonOverlapsRegion(polygon, region))
  const preferredZones = input.zones.filter(zone => zone.kind !== 'industrial' && zone.kind !== 'rural').sort((a, b) => distance(a.center, input.center) - distance(b.center, input.center))
  const candidates = (kind: FacilityKind) => {
    const random = seededRandom(`${input.config.seed}:civic-spatial:${kind}`), phase = random() * Math.PI * 2
    const points: Point[] = []
    if (kind === 'castle') points.push(input.center)
    for (const [i, zone] of preferredZones.entries()) {
      const radius = Math.min(zone.radius * .55, kind === 'university' ? 800 : 550), angle = phase + i * 2.4
      points.push({ x: zone.center.x + Math.cos(angle) * radius, y: zone.center.y + Math.sin(angle) * radius })
      if (points.length >= 8) break
    }
    const step = Math.max(180, Math.min(input.width, input.height) * .12)
    for (const radius of [step, step * 1.8, step * 2.7, step * 3.5]) for (let i = 0; i < 8; i++) points.push({ x: input.center.x + Math.cos(phase + i * Math.PI / 4) * radius, y: input.center.y + Math.sin(phase + i * Math.PI / 4) * radius })
    return points.filter(boundary).slice(0, kind === 'castle' ? 7 : 36)
  }
  const append = (kind: FacilityKind, center: Point, proposal: LocalPattern, angle: number, identity?: { suffix: string; name: string }) => {
    const suffix = identity?.suffix ?? ''
    const name = identity?.name ?? (kind === 'school' || kind === 'university' ? `${input.config.name.replace(/[市町村]$/, '')}${kind === 'school' ? '第一小学校' : '大学'}` : names[kind])
    const c = Math.cos(angle), s = Math.sin(angle), tr = (p: Point) => ({ x: center.x + c * p.x - s * p.y, y: center.y + s * p.x + c * p.y })
    const campus = rectangle(-proposal.width / 2, -proposal.depth / 2, proposal.width, proposal.depth).map(tr)
    if (!transportClear(campus)) return reject('campus-transport')
    if (!clear(campus)) return reject('campus-civic')
    if (!ground(campus, kind === 'park' || kind === 'university' ? .28 : .20)) return reject('campus-ground')
    const gate = tr({ x: 0, y: -proposal.depth / 2 - 6 })
    if (!boundary(gate) || input.terrain.waterAt(gate) || input.terrain.slope(gate) > .13 || result.reserves.some(region => pointInRegion(gate, region) || region.polygon.some((p, i) => distanceToSegment(gate, p, region.polygon[(i + 1) % region.polygon.length]!) < 6))) return reject('gate')
    const buildings: Building[] = []
    for (const [i, shape] of proposal.buildings.entries()) {
      const polygon = shape.polygon.map(tr), center = polygon.reduce((sum, p) => ({ x: sum.x + p.x / polygon.length, y: sum.y + p.y / polygon.length }), { x: 0, y: 0 })
      if (!ground(polygon, .16)) return reject('building-ground')
      const formation = surveyDevelopmentSite(input.terrain, center, polygon)
      if (!formation.viable) return reject('building-formation')
      buildings.push({ id: `facility-building-${kind}${suffix}-${i}`, polygon, kind: shape.lodging ? 'commercial' : kind === 'port' ? 'industrial' : 'public', height: Math.min(shape.floors, formation.maximumFloors), builtYear: openings[kind] + i % 3 * 5,
        name: shape.lodging ? shape.label : `${name} ${shape.label}`, ...(shape.lodging ? { use: 'lodging' as const, lodgingType: 'ryokan' as const, guestRooms: Math.round(shape.polygon.length * shape.floors * 2 + i * 3) } : {}) })
    }
    const paths = proposal.paths.map(path => path.map(tr)), masks = paths.flatMap(path => path.slice(1).map((b, i) => ({ polygon: corridorPolygon(path[i]!, b, 1.65) })))
    if (masks.some(mask => !ground(mask.polygon, .20) || !clear(mask.polygon) || buildings.some(building => polygonOverlapsRegion(building.polygon, mask)))) return reject('internal-path')
    for (const path of paths) for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!, count = Math.ceil(distance(a, b) / 5)
      for (let j = 1; j <= count; j++) { const p = { x: a.x + (b.x - a.x) * (j - 1) / count, y: a.y + (b.y - a.y) * (j - 1) / count }, q = { x: a.x + (b.x - a.x) * j / count, y: a.y + (b.y - a.y) * j / count }; if (Math.abs(input.terrain.elevation(p) - input.terrain.elevation(q)) > distance(p, q) * .14 + 1e-7) return reject('internal-grade') }
    }
    result.facilities.push({ id: `facility-${kind}${suffix}`, point: center, kind, name })
    result.reserves.push({ polygon: campus }); existingPaths.push(...masks)
    result.buildings.push(...buildings)
    const grounds: Area = { id: `facility-lot-${kind}${suffix}`, polygon: campus, kind: kind === 'park' || kind === 'shrine' ? 'park' : 'field', ...(kind !== 'park' && kind !== 'shrine' ? { landUse: 'vacant' as const } : {}), name }
    result.areas.push(grounds, ...proposal.areas.filter(area => !(area.polygon.length === 4 && area.park && (kind === 'park' || kind === 'shrine'))).map((area, i): Area => ({ id: `facility-lot-${kind}${suffix}-${i}`, polygon: area.polygon.map(tr), kind: area.park ? 'park' : 'field', ...(!area.park ? { landUse: 'vacant' as const } : {}), ...(area.label ? { name: area.label } : {}) })))
    result.roads.push(...paths.map((points, i): Road => ({ id: `facility-access-${kind}${suffix}-${i}`, points, kind: 'local', width: 2.8, role: 'access', builtYear: openings[kind], reason: `${name}の公道側の入口と構内を結ぶ通路` })))
    result.accessTargets.push({ id: `facility-access-${kind}${suffix}`, point: gate, builtYear: openings[kind] })
    return true
  }
  if (repair) {
    const normalized = materializeRoadJunctions(repairRoads.map(road => ({ ...road, points: road.points.flatMap((a, i) => {
      const b = road.points[i + 1]
      if (!b) return [a]
      const count = Math.max(1, Math.ceil(distance(a, b) / 60))
      return Array.from({ length: count }, (_, j) => ({ x: a.x + (b.x - a.x) * j / count, y: a.y + (b.y - a.y) * j / count }))
    }) }))), opening = openings.hospital
    type Anchor = { id: string; point: Point; tangent: Point; width: number; score: number }
    const anchors: Anchor[] = [], oldCenter = repair.previous.facilities.find(facility => facility.kind === 'hospital')?.point ?? input.center
    for (const road of normalized) {
      if (controlledRoad(road) || (road.level ?? 0) !== 0 || road.bridge || road.role === 'farm' || road.role === 'bridge' || (road.builtYear ?? 1650) > opening) continue
      let nextSample = 0, along = 0
      for (let i = 1; i + 1 < road.points.length; i++) {
        along += distance(road.points[i - 1]!, road.points[i]!)
        if (along < nextSample) continue
        nextSample = along + 60
        const point = road.points[i]!, span = distance(road.points[i - 1]!, road.points[i + 1]!)
        if (!boundary(point) || span < .01) continue
        anchors.push({ id: `hospital-repair-anchor-${anchors.length}`, point, tangent: { x: (road.points[i + 1]!.x - road.points[i - 1]!.x) / span, y: (road.points[i + 1]!.y - road.points[i - 1]!.y) / span }, width: road.width, score: distance(point, input.center) + distance(point, oldCenter) * .2 })
      }
    }
    const certificate = certifyLayoutAccess({ width: input.width, height: input.height, roads: normalized, targets: anchors.map(anchor => ({ id: anchor.id, point: anchor.point, builtYear: opening })) })
    const rejected = new Set(certificate.unserved), sorted = anchors.filter(anchor => !rejected.has(anchor.id)).sort((a, b) => a.score - b.score || a.point.x - b.point.x || a.point.y - b.point.y)
    repairReport.anchors = anchors.length; repairReport.connectedAnchors = sorted.length
    const proposal = pattern('hospital')
    type Site = { anchor: Anchor; normal: Point; approachLength: number; gate: Point; center: Point; angle: number; approach: PolygonRegion }
    const selected: Site[] = []
    // A dense street grid cannot contain a 130 m campus. Test the known road,
    // institution and water masks before spending the bounded physical survey
    // budget; the nearest twenty centre-street anchors can all be impossible.
    siteSelection: for (const anchor of sorted) for (const side of [1, -1]) {
      const normal = { x: -anchor.tangent.y * side, y: anchor.tangent.x * side }, approachLength = anchor.width / 2 + 24
      const gate = { x: anchor.point.x + normal.x * approachLength, y: anchor.point.y + normal.y * approachLength }
      const center = { x: gate.x + normal.x * 61, y: gate.y + normal.y * 61 }, approach = { polygon: corridorPolygon(anchor.point, gate, 3.25) }
      const angle = Math.atan2(normal.y, normal.x) - Math.PI / 2, c = Math.cos(angle), s = Math.sin(angle)
      const campus = rectangle(-proposal.width / 2, -proposal.depth / 2, proposal.width, proposal.depth)
        .map(p => ({ x: center.x + c * p.x - s * p.y, y: center.y + s * p.x + c * p.y }))
      candidatePoint = center; repairReport.examinedSites++
      if (!campus.every(boundary)) { reject('prefilter-campus-bounds'); continue }
      if (!transportClear(campus)) { reject('prefilter-campus-transport'); continue }
      if ([...result.reserves, ...existingPaths].some(region => polygonOverlapsRegion(campus, region))) { reject('prefilter-campus-civic'); continue }
      if (waters.some(water => polygonOverlapsRegion(campus, water) || polygonOverlapsRegion(approach.polygon, water))) { reject('prefilter-water'); continue }
      if ([...result.reserves, ...fixedGround].some(region => polygonOverlapsRegion(approach.polygon, region))) { reject('prefilter-approach-protected'); continue }
      if (selected.some(site => distance(site.center, center) < 65)) continue
      selected.push({ anchor, normal, approachLength, gate, center, angle, approach })
      if (selected.length >= 40) break siteSelection
    }
    repairReport.selectedAnchors = new Set(selected.map(site => site.anchor.id)).size
    for (const { anchor, normal, approachLength, gate, center, angle, approach } of selected.slice(0, 40)) {
      candidatePoint = center; repairReport.attemptedSites++
      // Public paving may join its source road, but never cut through another
      // protected institution, water or railway to reach the new reservation.
      if (!ground(approach.polygon, .16)) { reject('approach-ground'); continue }
      if ([...result.reserves, ...fixedGround].some(region => polygonOverlapsRegion(approach.polygon, region))) { reject('approach-protected'); continue }
      let viable = true
      for (let j = 1, count = Math.ceil(approachLength / 4); j <= count; j++) {
        const a = { x: anchor.point.x + normal.x * approachLength * (j - 1) / count, y: anchor.point.y + normal.y * approachLength * (j - 1) / count }, b = { x: anchor.point.x + normal.x * approachLength * j / count, y: anchor.point.y + normal.y * approachLength * j / count }
        if (Math.abs(input.terrain.elevation(a) - input.terrain.elevation(b)) > distance(a, b) * .13 + 1e-7) { viable = false; break }
      }
      if (!viable) { reject('approach-grade'); continue }
      if (!append('hospital', center, proposal, angle)) continue
      result.roads.push({ id: 'facility-access-hospital-public', points: [anchor.point, gate], width: 5, role: 'access', kind: 'local', builtYear: opening, reason: '実際に開通している公道に接続する病院用地の進入路' })
      repairReport.adopted = center; hospitalRepairs.set(result, repairReport)
      return result
    }
    hospitalRepairs.set(repair.previous, repairReport)
    return repair.previous
  }
  const order: FacilityKind[] = ['castle', 'university', 'school', 'hospital', 'park', 'onsen', 'shrine', 'police', 'port']
  for (const kind of order.filter(kind => input.config.facilities.includes(kind))) {
    let placed = false
    if (kind === 'castle') {
      for (const point of candidates(kind)) {
        // Avoid an expensive compound survey at an obviously flooded location.
        if (!ground(rectangle(point.x - 100, point.y - 100, 200, 200), .20)) continue
        const castle = surveyCastleLayout(point, input.config.seed, { width: input.width, height: input.height, terrain: input.terrain, waterAreas: waters, riverTangent: input.terrain.channelAt?.(point)?.tangent })
        if (!castle || !clear(castle.core)) continue
        const castleGround = [{ polygon: castle.core }, ...castle.areas, ...castle.grounds]
        if (castleGround.some(region => !clear(region.polygon))) continue
        // The compound's connecting outline can omit a detached outer ditch
        // reach. Reserve every actual moat, court and wall too; later housing
        // must not rely on one largest outline to protect these monuments.
        result.reserves.push(...castleGround); result.areas.push(...castle.areas, ...castle.grounds); result.buildings.push(...castle.structures); result.roads.push(...castle.paths)
        existingPaths.push(...castle.paths.flatMap(path => path.points.slice(1).map((b, i) => ({ polygon: corridorPolygon(path.points[i]!, b, path.width / 2 + .25) }))))
        result.facilities.push({ id: 'facility-castle', point: castle.point, kind, name: `${input.config.name.replace(/[市町村]$/, '')}城跡` })
        // The generated outer gate includes a short dry approach. Public roads
        // meet its outside endpoint, rather than tunnelling through the core.
        result.accessTargets.push({ id: 'facility-access-castle', point: castle.gate.outside, builtYear: 1650 })
        result.roads.push({ id: 'facility-access-castle', points: [castle.gate.outside, castle.gate.inside], kind: 'local', role: 'access', width: 3, builtYear: 1650, reason: '城郭の大手口と城内通路の接続' })
        placed = true; break
      }
    } else if (kind === 'port') {
      // Use existing low, dry shoreline ground. A selected checkbox cannot
      // manufacture reclamation, or put a warehouse on a painted water mask.
      const coast = waters.filter(area => area.id.startsWith('sea'))
      const shoreline: { center: Point; angle: number; score: number }[] = []
      for (const area of coast) for (let i = 0; i < area.polygon.length; i++) {
        const a = area.polygon[i]!, b = area.polygon[(i + 1) % area.polygon.length]!, span = distance(a, b)
        if (span < .1) continue
        // Long straight shore segments need real candidate coverage as well;
        // the starting vertex/order of a contour has no geographical meaning.
        const divisions = Math.max(1, Math.ceil(span / 80))
        for (let division = 0; division < divisions; division++) for (const side of [1, -1]) {
          const normal = { x: -(b.y - a.y) / span * side, y: (b.x - a.x) / span * side }, t = (division + .5) / divisions
          const shore = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
          const center = { x: shore.x - normal.x * 48, y: shore.y - normal.y * 48 }, wet = { x: shore.x + normal.x * 6, y: shore.y + normal.y * 6 }
          if (!boundary(center) || !input.terrain.waterAt(wet) || input.terrain.waterAt(center) || input.terrain.elevation(shore) > 4 || input.terrain.elevation(center) > 6) continue
          const near = Math.min(distance(center, input.center), ...preferredZones.map(zone => Math.max(0, distance(center, zone.center) - zone.radius * .6)))
          const gate = { x: center.x - normal.x * 51, y: center.y - normal.y * 51 }
          let wetApproach = 0
          for (let j = 1; j < 12; j++) if (input.terrain.waterAt({ x: input.center.x + (gate.x - input.center.x) * j / 12, y: input.center.y + (gate.y - input.center.y) * j / 12 })) wetApproach++
          shoreline.push({ center, angle: Math.atan2(normal.y, normal.x) - Math.PI / 2, score: near + distance(center, input.center) * .35 + wetApproach * 250 })
        }
      }
      shoreline.sort((a, b) => a.score - b.score || a.center.x - b.center.x || a.center.y - b.center.y)
      const distinct: typeof shoreline = []
      for (const candidate of shoreline) {
        if (distinct.every(previous => distance(previous.center, candidate.center) >= 35)) distinct.push(candidate)
        if (distinct.length >= 48) break
      }
      for (const site of distinct) if (append(kind, site.center, pattern(kind), site.angle)) { placed = true; break }
    } else {
      outer: for (const point of candidates(kind)) {
        const gx = input.terrain.elevation({ x: point.x + 8, y: point.y }) - input.terrain.elevation({ x: point.x - 8, y: point.y }), gy = input.terrain.elevation({ x: point.x, y: point.y + 8 }) - input.terrain.elevation({ x: point.x, y: point.y - 8 })
        const alongContour = Math.hypot(gx, gy) > .04 ? Math.atan2(gx, -gy) : input.zones[0]?.angle ?? 0
        for (const compact of kind === 'university' ? [false, true] : [false]) {
          const proposal = pattern(kind, compact)
          const angles = kind === 'hospital' ? [0, 1, 2, 3].map(turn => alongContour + turn * Math.PI / 2) : [alongContour, alongContour + Math.PI / 2]
          if (kind === 'hospital') {
            // Opposite headings share a contour axis but put the entrance on
            // different sides of a campus. Both must be surveyed. Prefer an
            // approach toward an already established town/station district,
            // rather than leaving the gate against the uphill wilderness.
            const established = preferredZones.filter(zone => zone.builtYear <= openings[kind])
              .sort((a, b) => distance(a.center, point) - distance(b.center, point))
            const toward = established[0]?.center ?? input.center, reach = proposal.depth / 2 + 6
            const approach = (angle: number) => distance({ x: point.x + Math.sin(angle) * reach, y: point.y - Math.cos(angle) * reach }, toward)
            angles.sort((a, b) => approach(a) - approach(b))
          }
          for (const angle of angles) if (append(kind, point, proposal, angle)) { placed = true; break outer }
        }
      }
    }
    if (!placed) result.unplacedFacilities.push({ kind, reason: kind === 'port' ? '低く乾いた岸辺に荷捌き場と市場を確保できませんでした。' : '予約した建物・広場と入口の全体が、水域や急斜面を避けて収まる用地を確保できませんでした。' })
  }
  // Major programmes and the original city park keep their previous sites.
  // Small neighbourhood greens are a separate, bounded final reservation pass
  // inside the actual urban brief, never scattered over the surrounding wilds.
  const settlement = input.config.settlement ?? 'regional-city'
  if (result.facilities.some(facility => facility.id === 'facility-park') && (settlement === 'regional-city' || settlement === 'metropolis')) {
    const factor = input.config.mapSize === 'large' ? 3 : input.config.mapSize === 'medium' ? 2 : 1
    const wanted = Math.min(8, (settlement === 'metropolis' ? 4 + Math.round(input.config.density / 50) : 3) * factor)
    const parks = () => result.facilities.filter(facility => facility.kind === 'park')
    const width = settlement === 'metropolis' ? 64 : 56, depth = settlement === 'metropolis' ? 54 : 48
    const small: LocalPattern = { width, depth, buildings: [], areas: [], paths: [line([0, -depth / 2 - 6], [0, -depth * .3]), line([0, -depth * .3], [-width * .3, -depth * .23], [-width * .3, depth * .25], [width * .3, depth * .25], [width * .3, -depth * .23], [0, -depth * .3])] }
    const labels = ['さくら公園', 'けやき公園', 'あけぼの公園', 'みどり公園', 'つばき公園', 'ひだまり公園', '若葉公園']
    const zones = input.zones.filter(zone => zone.kind !== 'rural' && zone.kind !== 'industrial').slice().sort((a, b) => a.builtYear - b.builtYear || distance(a.center, input.center) - distance(b.center, input.center))
    for (const zone of zones.slice(0, 12)) {
      if (parks().length >= wanted) break
      const angle = zone.angle ?? 0, offset = Math.min(70, zone.radius * .18)
      for (const displacement of [0, offset, -offset]) {
        const point = { x: zone.center.x - Math.sin(angle) * displacement, y: zone.center.y + Math.cos(angle) * displacement }
        if (!pointInRegion(point, zone) || parks().some(park => distance(park.point, point) < 300)) continue
        const count = parks().length, before = { areas: result.areas.length, roads: result.roads.length, reserves: result.reserves.length }
        if (!append('park', point, small, angle, { suffix: `-${count + 1}`, name: labels[(count - 1) % labels.length]! })) continue
        const accessId = `facility-access-park-${count + 1}`
        result.optionalAccessIds.push(accessId)
        result.optionalProgrammes.push({ accessId, facilityId: `facility-park-${count + 1}`, areaIds: result.areas.slice(before.areas).map(area => area.id), roadIds: result.roads.slice(before.roads).map(road => road.id), reserves: result.reserves.slice(before.reserves) })
        break
      }
    }
  }
  return result
}
