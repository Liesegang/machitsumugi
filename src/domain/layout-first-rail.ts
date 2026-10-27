import type { Area, CityConfig, Point, Railway, Road, Station } from './types'
import type { PolygonRegion } from './geometry'
import type { LayoutFirstZone } from './layout-first-types'
import type { TerrainModel } from './terrain'
import { corridorPolygon, distance, distanceToSegment, pointInRegion, polygonOverlapsRegion, segmentsCross } from './geometry'
import { planRailway } from './railway-planner'
import type { RailwayPlan } from './railway-planner'
import { stationFootprint } from './station-footprint'
import { projectOnRoadSegment } from './road-graph'

type RailTerrain = Pick<TerrainModel, 'areas' | 'elevation' | 'slope' | 'waterAt'> & Partial<Pick<TerrainModel, 'channelAt'>>
export interface LayoutFirstRailInput {
  config: CityConfig
  width: number
  height: number
  terrain: RailTerrain
  center: Point
  zones: readonly LayoutFirstZone[]
  reserves: readonly PolygonRegion[]
  roads?: Road[]
}
export interface LayoutFirstRailResult {
  railways: Railway[]
  stations: Station[]
  /** Reserve these complete forecourts before assigning residential parcels. */
  stationGrounds: Area[]
  /** Public roads stop outside reserved grounds; these paths reach the doors. */
  accessTargets: { id: string; point: Point; builtYear: number; endHeading?: number }[]
  stationPaths: Road[]
  diagnostics: {
    requestedStations: number
    placedStations: number
    reason?: string
    alignment?: RailwayPlan['diagnostics']
  }
}

interface StationCandidate {
  point: Point
  along: number
  tangent: Point
  score: number
  building: Point[]
  forecourt: Point[]
  entrance: Point
  gate: Point
  platforms: Point[][]
  trackGround: Point[]
  main: boolean
}
const MINIMUM_SPACING = 650
const nearestDistance = (point: Point, points: Point[]) => Math.min(...points.slice(1).map((b, i) => distanceToSegment(point, points[i]!, b)))

export interface StationAccessRepairReport { accessId: string; candidates: number; attempted: number; adopted?: Point; reason?: string }
const stationAccessRepairs=new WeakMap<LayoutFirstRailResult,StationAccessRepairReport>()
export const stationAccessRepairReport=(result:LayoutFirstRailResult)=>stationAccessRepairs.get(result)

/** Reacquire one station on its existing regional line before household land
 * is allocated. Other stations, names, dates and the railway alignment survive.
 * The caller must certify an actual public approach before a site is adopted. */
export function resurveyLayoutFirstStation(input:LayoutFirstRailInput,previous:LayoutFirstRailResult,accessId:string,certify:(candidate:LayoutFirstRailResult)=>boolean):LayoutFirstRailResult {
  const report:StationAccessRepairReport={accessId,candidates:0,attempted:0},index=Number(/^station-access-(\d+)$/.exec(accessId)?.[1]??-1),old=previous.stations[index]
  const fail=(reason:string)=>{report.reason=reason;stationAccessRepairs.set(previous,report);return previous}
  if(!old)return fail('station-not-found')
  const railway=previous.railways.find(line=>line.id===old.railwayId&&line.mode!=='subway')
  if(!railway||railway.points.length<2)return fail('existing-line-not-found')
  const chain=[0];for(let i=1;i<railway.points.length;i++)chain.push(chain[i-1]!+distance(railway.points[i-1]!,railway.points[i]!))
  const along=(p:Point)=>{
    let nearest=Infinity,at=0
    for(let i=1;i<railway.points.length;i++){const hit=projectOnRoadSegment(p,railway.points[i-1]!,railway.points[i]!),d=distance(p,hit.point);if(d<nearest){nearest=d;at=chain[i-1]!+distance(railway.points[i-1]!,hit.point)}}
    return at
  }
  const origin=along(old.point),otherStations=previous.stations.filter((_,i)=>i!==index).map(station=>along(station.point)),ownGround=(id:string)=>id===`station-forecourt-${index}`||id===`station-trackground-${index}`
  const remainingGrounds=previous.stationGrounds.filter(area=>!ownGround(area.id)),reserves=[...input.reserves,...remainingGrounds]
  const roads=(input.roads??[]).filter(road=>road.id!==accessId),main=old.name===`${input.config.name.replace(/[市町村]$/,'')}駅`
  const bounded=(p:Point)=>p.x>=4&&p.y>=4&&p.x<=input.width-4&&p.y<=input.height-4
  const waters=input.terrain.areas.filter(area=>area.kind==='water'),candidates:{along:number;score:number;footprint:NonNullable<ReturnType<typeof stationFootprint>>}[]=[]
  for(const offset of [0,-80,80,-160,160,-280,280,-420,420]){
    const at=origin+offset
    if(at<160||at>chain.at(-1)!-160||otherStations.some(other=>Math.abs(other-at)<MINIMUM_SPACING))continue
    for(const side of [-1,1]){
      const footprint=stationFootprint({points:railway.points,chain,along:at,side,config:input.config,main})
      if(!footprint)continue
      const {building,forecourt,gate,publicGatePad,platforms,trackGround,entrance,gateDistance}=footprint,acquired=[forecourt,publicGatePad,trackGround]
      const samples=[...acquired.flat(),...building,...platforms.flat(),gate,entrance]
      if(acquired.some(polygon=>reserves.some(region=>polygonOverlapsRegion(polygon,region)))||samples.some(p=>!bounded(p)||input.terrain.waterAt(p)||input.terrain.slope(p)>.12)||waters.some(water=>acquired.some(polygon=>polygonOverlapsRegion(polygon,water))))continue
      if(roads.some(road=>road.points.slice(1).some((b,i)=>acquired.some(polygon=>polygonOverlapsRegion(polygon,{polygon:corridorPolygon(road.points[i]!,b,road.width/2+.5)})))))continue
      const levels=samples.map(input.terrain.elevation)
      if(!levels.every(Number.isFinite)||Math.max(...levels)-Math.min(...levels)>2)continue
      let segment=0;while(segment+1<chain.length&&chain[segment+1]!<at)segment++
      const fraction=(at-chain[segment]!)/(chain[segment+1]!-chain[segment]!),level=railway.elevations?railway.elevations[segment]!+(railway.elevations[segment+1]!-railway.elevations[segment]!)*fraction:input.terrain.elevation(old.point)
      if(!Number.isFinite(level)||Math.abs(level-input.terrain.elevation(footprint.point))>2.5)continue
      if(forecourt.some(p=>nearestDistance(p,railway.points)<8.5)||polygonOverlapsRegion(forecourt,{polygon:trackGround}))continue
      const outward={x:(gate.x-footprint.point.x)/gateDistance,y:(gate.y-footprint.point.y)/gateDistance}
      if(!surveyLayoutStationApproaches({gate,outward,railPoints:railway.points,terrain:input.terrain,reserves,width:input.width,height:input.height}).length)continue
      const oldRoads=roads.filter(road=>(road.builtYear??1650)<=(old.builtYear??1900)&&!road.controlledAccess&&road.role!=='farm'&&(road.level??0)===0),roadDistance=oldRoads.length?Math.min(...oldRoads.map(road=>nearestDistance(gate,road.points))):Infinity
      candidates.push({along:at,score:Math.abs(offset)*.3+roadDistance,footprint})
    }
  }
  report.candidates=candidates.length
  for(const {footprint} of candidates.sort((a,b)=>a.score-b.score||a.along-b.along).slice(0,6)){
    report.attempted++
    const {point,entrance,building,platforms,forecourt,trackGround,gate}=footprint
    const candidate:LayoutFirstRailResult={...previous,stations:previous.stations.map((station,i)=>i===index?{...station,point,entrance,buildingPolygon:building,platformPolygons:platforms}:station),stationGrounds:[...remainingGrounds,{id:`station-forecourt-${index}`,kind:'field',landUse:'vacant',polygon:forecourt,name:`${old.name}前広場`},{id:`station-trackground-${index}`,kind:'field',landUse:'vacant',polygon:trackGround}],accessTargets:previous.accessTargets.map(target=>target.id===accessId?{...target,point:gate,endHeading:Math.atan2(entrance.y-gate.y,entrance.x-gate.x)}:target),stationPaths:previous.stationPaths.map(road=>road.id===accessId?{...road,points:[gate,entrance]}:road)}
    if(!certify(candidate))continue
    report.adopted=point;stationAccessRepairs.set(candidate,report);return candidate
  }
  return fail('no-surveyed-site-with-dated-public-approach')
}

/** A dry platform/forecourt pad is insufficient when a parallel creek traps
 * the public gate against its own railway. Survey complete street-width exits
 * on the acquired side, including all intervening water/reserved geometry.
 * These are qualification corridors; the road stage must still connect the
 * selected real gate to an existing public network and certify that access. */
export function surveyLayoutStationApproaches(input: { gate: Point; outward: Point; railPoints: Point[]; terrain: RailTerrain; reserves: readonly PolygonRegion[]; width: number; height: number }): Point[][] {
  const bearing = Math.atan2(input.outward.y, input.outward.x), result: Point[][] = [], streetWidth = 6, reach = 180
  for (const degrees of [-60, -30, 0, 30, 60]) {
    const angle = bearing + degrees * Math.PI / 180, along = { x: Math.cos(angle), y: Math.sin(angle) }, across = { x: -along.y, y: along.x }
    const end = { x: input.gate.x + along.x * reach, y: input.gate.y + along.y * reach }, polygon = corridorPolygon(input.gate, end, streetWidth / 2)
    if (input.reserves.some(region => polygonOverlapsRegion(polygon, region)) || input.terrain.areas.some(area => area.kind === 'water' && polygonOverlapsRegion(polygon, area))) continue
    let valid = true, previousLevel: number | undefined
    for (let step = 0; step <= reach && valid; step += 5) {
      const center = { x: input.gate.x + along.x * step, y: input.gate.y + along.y * step }, level = input.terrain.elevation(center)
      if (previousLevel !== undefined && Math.abs(level - previousLevel) / 5 > .13) { valid = false; break }
      previousLevel = level
      for (const offset of [-streetWidth / 2, 0, streetWidth / 2]) {
        const point = { x: center.x + across.x * offset, y: center.y + across.y * offset }
        if (point.x < 4 || point.y < 4 || point.x > input.width - 4 || point.y > input.height - 4 || input.terrain.waterAt(point) || input.terrain.slope(point) > .13 || nearestDistance(point, input.railPoints) < 7) { valid = false; break }
      }
    }
    if (valid) result.push([input.gate, end])
  }
  return result
}

/** One physically surveyed regional line. Stations have dry, reserved land and
 * a street-facing entrance; their road approaches are constructed by the next
 * layout stage. This does not manufacture short, one-station branch lines. */
export function surveyLayoutFirstRail(input: LayoutFirstRailInput): LayoutFirstRailResult {
  const requested = input.config.railway ? Math.max(1, Math.min(5, Math.round(input.config.stations))) : 0
  const empty = (reason?: string): LayoutFirstRailResult => ({ railways: [], stations: [], stationGrounds: [], accessTargets: [], stationPaths: [], diagnostics: { requestedStations: requested, placedStations: 0, ...(reason ? { reason } : {}) } })
  if (!requested) return empty()
  const zones = input.zones.filter(zone => zone.kind !== 'rural' && zone.kind !== 'industrial')
  const hub = [...zones].sort((a, b) => (b.kind === 'historic' ? 1 : 0) - (a.kind === 'historic' ? 1 : 0) || b.density * b.radius ** 2 - a.density * a.radius ** 2)[0]
  // Existing engineering code recognizes this private planning tag. These
  // regions never enter the map's entity table, where IDs must be unique.
  const planningAreas: Area[] = [...input.terrain.areas, ...input.reserves.map(region => ({ ...region, id: 'historic-core', kind: 'park' as const }))]
  const plan = planRailway({ width: input.width, height: input.height, seed: input.config.seed, origin: hub?.center ?? input.center,
    terrain: { ...input.terrain, areas: planningAreas }, inheritedRoads: input.roads,
    settlements: zones.length ? zones.map(zone => ({ point: zone.center, demand: Math.max(.1, zone.density) * zone.radius ** 2 })) : undefined,
    allowTerminus: input.config.terrain === 'coast' || input.config.type === 'port' || input.config.type === 'onsen' })
  if (!plan) return empty('地形と曲線・勾配の条件を満たす地域鉄道の経路を確保できませんでした。')
  // Validate actual corridor shoulders against every reserved civic compound,
  // including narrow encounters between the engineering planner's samples.
  for (let i = 1; i < plan.points.length; i++) {
    const a = plan.points[i - 1]!, b = plan.points[i]!
    if (input.reserves.some(region => pointInRegion(a, region) || pointInRegion(b, region) || region.polygon.some((p, j) => {
      const q = region.polygon[(j + 1) % region.polygon.length]!
      return segmentsCross(a, b, p, q) || distanceToSegment(p, a, b) < 7.5 || distanceToSegment(a, p, q) < 7.5 || distanceToSegment(b, p, q) < 7.5
    }))) return empty('鉄道の有効幅が予約済みの公共用地に接するため、この経路は採用できませんでした。')
  }
  const chain = [0]
  for (let i = 1; i < plan.points.length; i++) chain.push(chain[i - 1]! + distance(plan.points[i - 1]!, plan.points[i]!))
  const length = chain.at(-1)!, candidates: StationCandidate[] = []
  const bounded = (p: Point) => p.x >= 4 && p.y >= 4 && p.x <= input.width - 4 && p.y <= input.height - 4
  const reserved = (polygon: Point[]) => input.reserves.some(region => polygonOverlapsRegion(polygon, region))
  for (let i = 1; i + 1 < plan.points.length; i++) {
    if (chain[i]! < 160 || length - chain[i]! < (plan.terminus ? 0 : 160) || i % 3 !== 0) continue
    const point = plan.points[i]!, previous = plan.points[i - 1]!, next = plan.points[i + 1]!
    if (input.terrain.waterAt(point) || input.terrain.slope(point) > .10 || Math.abs(plan.elevations[i]! - input.terrain.elevation(point)) > 2.5) continue
    if (zones.length && !zones.some(zone => distance(zone.center, point) <= zone.radius + 350)) continue
    const span = distance(previous, next), tangent = { x: (next.x - previous.x) / span, y: (next.y - previous.y) / span }
    if (!Number.isFinite(tangent.x + tangent.y)) continue
    for (const main of [true, false]) for (const side of [1, -1]) {
      const footprint = stationFootprint({ points: plan.points, chain, along: chain[i]!, side, config: input.config, main })
      if (!footprint) continue
      const { building, forecourt, gate, publicGatePad, platforms, trackGround, entrance, gateDistance } = footprint
      const acquired = [forecourt, publicGatePad, trackGround]
      const samples = [...acquired.flat(), ...building, gate, entrance, ...forecourt.map((p, n) => ({ x: (p.x + forecourt[(n + 1) % forecourt.length]!.x) / 2, y: (p.y + forecourt[(n + 1) % forecourt.length]!.y) / 2 }))]
      if (acquired.some(reserved) || samples.some(p => !bounded(p) || input.terrain.waterAt(p) || input.terrain.slope(p) > .12)) continue
      if (input.terrain.areas.some(area => area.kind === 'water' && acquired.some(polygon => polygonOverlapsRegion(polygon, area)))) continue
      if (input.roads?.some(road => road.points.slice(1).some((b, j) => acquired.some(polygon => polygonOverlapsRegion(polygon, { polygon: corridorPolygon(road.points[j]!, b, road.width / 2 + .5) }))))) continue
      const levels = samples.map(input.terrain.elevation)
      if (!levels.every(Number.isFinite) || Math.max(...levels) - Math.min(...levels) > 2) continue
      // A forecourt must not sit across another bend of its own railway.
      if (forecourt.some(p => nearestDistance(p, plan.points) < 8.5) || polygonOverlapsRegion(forecourt, { polygon: trackGround })) continue
      const targetDistance = Math.min(distance(point, input.center), ...zones.map(zone => distance(point, zone.center)))
      const roadDistance = input.roads?.length ? Math.min(...input.roads.filter(road => !road.controlledAccess).map(road => nearestDistance(entrance, road.points))) : 0
      // The two banks of the railway are distinct acquisition choices. A tie
      // on the platform point previously always selected the first normal,
      // sometimes leaving the entrance across the track from every old street.
      // Prefer the town-facing forecourt before any new crossing is proposed.
      const townApproach = distance(gate, input.center)
      const approaches = surveyLayoutStationApproaches({ gate, outward: { x: (gate.x - point.x) / gateDistance, y: (gate.y - point.y) / gateDistance }, railPoints: plan.points, terrain: input.terrain, reserves: input.reserves, width: input.width, height: input.height })
      // Prefer a broad usable side without banning a confined mountain or
      // valley station whose single narrower access can still be certified by
      // the road stage. The acquired pad/ROW checks above remain mandatory.
      const confinement = (5 - approaches.length) * 180
      candidates.push({ point, along: chain[i]!, tangent, building, forecourt, entrance, gate, platforms, trackGround, main, score: targetDistance + townApproach * .5 + confinement + Math.min(1500, roadDistance) * .4 + input.terrain.slope(point) * 2000 })
    }
  }
  const count = Math.min(requested, Math.max(1, Math.floor((length - 320) / MINIMUM_SPACING) + 1))
  const selected: StationCandidate[] = []
  const targets = Array.from({ length: count }, (_, i) => length * (i + 1) / (count + 1))
  // Serve the main existing/proposed centre first, then separated portions of
  // the same line. Fixed sort ties and IDs make independent reruns reproducible.
  const mainCandidates = candidates.filter(site => site.main)
  const central = [...(mainCandidates.length ? mainCandidates : candidates)].sort((a, b) => a.score - b.score || a.along - b.along)[0]
  if (central) selected.push(central)
  for (const target of targets.sort((a, b) => Math.abs(b - (central?.along ?? length / 2)) - Math.abs(a - (central?.along ?? length / 2)))) {
    if (selected.length >= count) break
    const candidate = candidates.filter(c => !c.main && selected.every(s => Math.abs(s.along - c.along) >= MINIMUM_SPACING && !polygonOverlapsRegion(c.forecourt, { polygon: s.forecourt })))
      .sort((a, b) => Math.abs(a.along - target) + a.score * .25 - Math.abs(b.along - target) - b.score * .25 || a.along - b.along)[0]
    if (candidate) selected.push(candidate)
  }
  if (!selected.length) return empty('鉄道沿いに駅舎と駅前広場を置ける乾燥地盤を確保できませんでした。')
  selected.sort((a, b) => a.along - b.along)
  const base = input.config.name.replace(/[市町村]$/, ''), centralIndex = selected.indexOf(central!)
  const stations: Station[] = selected.map((site, index) => {
    const dx = site.point.x - central!.point.x, dy = site.point.y - central!.point.y
    const direction = Math.abs(dx) > Math.abs(dy) ? dx < 0 ? '西' : '東' : dy < 0 ? '北' : '南'
    return { id: `station-${index}`, name: index === centralIndex ? `${base}駅` : `${direction}${base}${selected.length > 3 ? index + 1 : ''}駅`, point: site.point, railwayId: 'railway-main', builtYear: 1900, entrance: site.entrance, buildingPolygon: site.building, platformPolygons: site.platforms }
  })
  return { railways: [{ id: 'railway-main', name: `${base}線`, points: plan.points, elevations: plan.elevations, structures: plan.structures, builtYear: 1900 }], stations,
    stationGrounds: [...selected.map((site, i): Area => ({ id: `station-forecourt-${i}`, kind: 'field', landUse: 'vacant', polygon: site.forecourt, name: `${stations[i]!.name}前広場` })), ...selected.map((site, i): Area => ({ id: `station-trackground-${i}`, kind: 'field', landUse: 'vacant', polygon: site.trackGround }))],
    accessTargets: selected.map((site, i) => ({ id: `station-access-${i}`, point: site.gate, builtYear: 1900, endHeading: Math.atan2(site.entrance.y - site.gate.y, site.entrance.x - site.gate.x) })),
    stationPaths: selected.map((site, i) => ({ id: `station-access-${i}`, points: [site.gate, site.entrance], width: 3, role: 'access', kind: 'local', builtYear: 1900, reason: '駅前の公道から駅舎の入口に至る歩行者動線' })),
    diagnostics: { requestedStations: requested, placedStations: stations.length, alignment: plan.diagnostics, ...(stations.length < requested ? { reason: '駅間隔と駅舎・駅前広場の地盤条件を満たす地点に駅を絞りました。' } : {}) } }
}
