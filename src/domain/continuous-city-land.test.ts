import { describe, expect, it } from 'vitest'
import { developContinuousCityLand } from './continuous-city-land'
import type { ContinuousCityLandInput } from './continuous-city-types'
import type { CityConfig, Road } from './types'
import { boundsOf, corridorPolygon, distanceToSegment, intersectRegions, pointInPolygon, polygonArea, polygonOverlapsRegion, polygonsOverlap, rectangle, regionArea, subtractRegions } from './geometry'
import { buildingServiceYears } from './building-lifecycle'
import { extractStreetBlocks, materializeRoadJunctions } from './road-graph'
import { shoppingStreetHistory } from './commercial-history'

const config: CityConfig = { name: '接道試験市', seed: 'whole-block-cadastre', type: 'post', terrain: 'plain', density: 90, forest: 0, railway: false, stations: 1, arterial: true, facilities: [], targetYear: 2025, settlement: 'metropolis' }
const loop = (width = 120, height = 60): Road[] => [
  { id: 'north', points: [{ x: 20, y: 20 }, { x: 20 + width, y: 20 }], kind: 'local', width: 6, builtYear: 1770 },
  { id: 'east', points: [{ x: 20 + width, y: 20 }, { x: 20 + width, y: 20 + height }], kind: 'local', width: 6, builtYear: 1770 },
  { id: 'south', points: [{ x: 20 + width, y: 20 + height }, { x: 20, y: 20 + height }], kind: 'local', width: 6, builtYear: 1770 },
  { id: 'west', points: [{ x: 20, y: 20 + height }, { x: 20, y: 20 }], kind: 'local', width: 6, builtYear: 1770 },
]
const run = (overrides: Partial<ContinuousCityLandInput> = {}) => {
  const input: ContinuousCityLandInput = { config, width: 500, height: 400, roads: loop(), blocks: [{ id: 'block', polygon: rectangle(20, 20, 120, 60) }], stations: [], reserves: [], terrain: { areas: [], elevation: () => 10, slope: () => 0, waterAt: () => false }, demand: { center: { x: 80, y: 50 }, regions: [{ polygon: rectangle(0, 0, 500, 400) }], at: () => .6, costAt: () => 1, openingAt: () => 1770, metrics: { cellSize: 25, reachableLandArea: 200000, targetUrbanArea: 200000, selectedUrbanArea: 200000 } }, ...overrides }
  return { input, result: developContinuousCityLand(input) }
}
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!
const overlapArea = (a: { polygon: { x: number; y: number }[] }, b: { polygon: { x: number; y: number }[] }) => intersectRegions(a, b).reduce((sum, region) => sum + regionArea(region), 0)
const frontageAcquisition = (input: ContinuousCityLandInput, parcels: ReturnType<typeof developContinuousCityLand>['parcels'], accessRoads: Road[] = [], step = 10) => {
  const bins = new Map<string, typeof parcels>(), size = 40
  for (const parcel of parcels) { const b = boundsOf(parcel.polygon); for (let x = Math.floor(b.minX / size); x <= Math.floor(b.maxX / size); x++) for (let y = Math.floor(b.minY / size); y <= Math.floor(b.maxY / size); y++) { const key = `${x}:${y}`, list = bins.get(key) ?? []; list.push(parcel); bins.set(key, list) } }
  const b = boundsOf(input.blocks[0]!.polygon), local = input.roads.filter(road => road.role === 'lane')
  let eligible = 0, acquired = 0
  for (let x = b.minX + step / 2; x < b.maxX; x += step) for (let y = b.minY + step / 2; y < b.maxY; y += step) {
    const p = { x, y }
    if (input.terrain.waterAt(p) || input.reserves.some(region => pointInPolygon(p, region.polygon))) continue
    if ([...input.roads, ...accessRoads].some(road => road.points.slice(1).some((to, i) => distanceToSegment(p, road.points[i]!, to) <= road.width / 2 + .26))) continue
    const distance = Math.min(...local.flatMap(road => road.points.slice(1).map((to, i) => distanceToSegment(p, road.points[i]!, to))))
    if (distance < 7 || distance > 18) continue
    eligible++
    if ((bins.get(`${Math.floor(x / size)}:${Math.floor(y / size)}`) ?? []).some(parcel => pointInPolygon(p, parcel.polygon))) acquired++
  }
  return { eligible, acquired, ratio: acquired / Math.max(1, eligible) }
}

describe('continuous city whole-block cadastre', () => {
  it('retains already acquired roofs and titles if a later physical survey fails', () => {
    let calls=0
    const terrain={areas:[],elevation:()=>10,slope:()=>0,waterAt:()=>{calls++;return false}}
    const complete=run({terrain}).result,stop=Math.floor(calls*.8)
    let replay=0,checkpoint: Parameters<NonNullable<ContinuousCityLandInput['onCheckpoint']>>[0]|undefined
    expect(()=>run({terrain:{...terrain,waterAt:()=>{if(++replay===stop)throw Error('late physical survey failure');return false}},onCheckpoint:stock=>{checkpoint=structuredClone(stock)}})).toThrow('late physical survey failure')
    expect(checkpoint?.buildings.length).toBeGreaterThan(0)
    expect(checkpoint!.buildings.length).toBeLessThan(complete.buildings.length)
    expect(checkpoint!.parcels.length).toBe(checkpoint!.buildings.length)
    for(const building of checkpoint!.buildings)expect(complete.buildings).toContainEqual(building)
  })
  it('partitions the whole ordinary block into varied urban titles with real frontage and contained rectangles', () => {
    const { input, result } = run()
    expect(result.parcels.length).toBeGreaterThan(12)
    expect(result.metrics.partitionAreaError).toBeLessThan(.05)
    expect(result.metrics.openSpaceArea / result.metrics.buildableArea).toBeLessThan(.08)
    expect(median(result.parcels.map(parcel => polygonArea(parcel.polygon)))).toBeGreaterThan(130)
    expect(median(result.parcels.map(parcel => polygonArea(parcel.polygon)))).toBeLessThan(400)
    expect(new Set(result.parcels.map(parcel => Math.round(polygonArea(parcel.polygon)))).size).toBeGreaterThan(10)
    expect(result.metrics.parcelArea + result.metrics.accessArea + result.metrics.openSpaceArea + result.metrics.unassignedArea).toBeCloseTo(result.metrics.buildableArea, 1)
    for (const parcel of result.parcels) {
      const road = input.roads.find(road => road.id === parcel.roadId)!
      expect(Math.min(...road.points.slice(1).map((b, i) => distanceToSegment(parcel.access![0]!, road.points[i]!, b)))).toBeLessThan(.001)
      for (const other of result.parcels) if (other !== parcel) expect(overlapArea(parcel, other)).toBeLessThan(.001)
      for (const other of result.parcels) if (other !== parcel) expect(overlapArea({ polygon: corridorPolygon(parcel.access![0]!, parcel.access![1]!, 1.1) }, other)).toBeLessThan(.001)
    }
    for (const building of result.buildings) {
      const parcel = result.parcels.find(parcel => parcel.id === building.parcelId)!
      expect(building.polygon).toHaveLength(4)
      expect(building.polygon.every(point => pointInPolygon(point, parcel.polygon))).toBe(true)
      expect(polygonArea(building.polygon) / polygonArea(parcel.polygon)).toBeGreaterThan(.28)
    }
  })

  it('uses a compact partition under stronger demand without globally enlarging houses', () => {
    const normal = run(), dense = run({ demand: { ...normal.input.demand, at: () => .9 } })
    expect(dense.result.parcels.length).toBeGreaterThan(normal.result.parcels.length)
    const areas = dense.result.parcels.map(parcel => polygonArea(parcel.polygon))
    expect(median(areas)).toBeGreaterThan(80)
    expect(median(areas)).toBeLessThan(median(normal.result.parcels.map(parcel => polygonArea(parcel.polygon))))
    // Stronger demand still reduces the median roof size. Wider acquisitions
    // can now exceed the former universal144m² roof ceiling.
    expect(median(dense.result.buildings.map(building => polygonArea(building.polygon)))).toBeLessThan(median(normal.result.buildings.map(building => polygonArea(building.polygon))))
    expect(dense.result.metrics.partitionAreaError).toBeLessThan(.05)
  })

  it('conserves an oblique convex cadastre and certifies every short entrance against actual acquired ground', () => {
    const angle = .31, rotate = (p: { x: number; y: number }) => ({ x: 80 + (p.x - 80) * Math.cos(angle) - (p.y - 50) * Math.sin(angle), y: 50 + (p.x - 80) * Math.sin(angle) + (p.y - 50) * Math.cos(angle) })
    const source = run().input, roads = loop().map(road => ({ ...road, points: road.points.map(rotate) })), block = { id: 'oblique', polygon: rectangle(20, 20, 120, 60).map(rotate) }
    const { result } = run({ roads, blocks: [block], demand: { ...source.demand, center: rotate(source.demand.center) } })
    expect(result.parcels.length).toBeGreaterThan(12)
    expect(result.metrics.partitionAreaError).toBeLessThan(.05)
    const actualRoads = [...roads, ...result.accessRoads], row = actualRoads.flatMap(road => road.points.slice(1).map((b, i) => ({ polygon: corridorPolygon(road.points[i]!, b, road.width / 2 + .25) })))
    for (const parcel of result.parcels) {
      expect(regionArea({ polygon: parcel.polygon }) - overlapArea(parcel, block)).toBeLessThan(.005)
      expect(row.reduce((sum, strip) => sum + overlapArea(parcel, strip), 0)).toBeLessThan(.005)
      const road = actualRoads.find(road => road.id === parcel.roadId)!, acquired = road.points.slice(1).map((b, i) => ({ polygon: corridorPolygon(road.points[i]!, b, road.width / 2 + .25) }))
      const entrance = { polygon: corridorPolygon(parcel.access![0]!, parcel.access![1]!, 1.1) }
      expect(subtractRegions(entrance, [parcel, ...acquired]).reduce((sum, part) => sum + regionArea(part), 0)).toBeLessThan(.01)
      for (const other of result.parcels) if (other !== parcel) expect(overlapArea(parcel, other)).toBeLessThan(.005)
    }
    for (const building of result.buildings) expect(subtractRegions(building, [result.parcels.find(parcel => parcel.id === building.parcelId)!]).reduce((sum, part) => sum + regionArea(part), 0)).toBeLessThan(.005)
  })

  it('acquires contiguous mixed corners and small apartments on a narrow collector without painting every title commercial', () => {
    const source = run().input, roads = source.roads.map(road => road.id === 'north' ? { ...road, width: 7.5, kind: 'arterial' as const, role: 'collector' as const } : { ...road, width: 4.8, role: 'lane' as const })
    const core = run({ roads, demand: { ...source.demand, center: { x: 80, y: 20 }, at: () => .9 } }).result
    expect(core.metrics.stock.mixed!.count).toBeGreaterThan(0)
    expect(core.metrics.stock.walkup!.count).toBeGreaterThan(0)
    expect(core.metrics.stock.compact!.count).toBeGreaterThan(0)
    const north = core.parcels.filter(parcel => parcel.roadId === 'north')
    expect(north.some(parcel => parcel.use === 'commercial')).toBe(true)
    expect(north.some(parcel => parcel.use === 'residential')).toBe(true)
    const small = core.metrics.stock.compact!, apartments = core.metrics.stock.walkup!
    expect(apartments.parcelArea / apartments.count).toBeGreaterThan(small.parcelArea / small.count)
    expect(apartments.roofArea / apartments.count).toBeGreaterThan(small.roofArea / small.count)
    expect(core.buildings.some(building => building.kind === 'residential' && building.height >= 3 && polygonArea(building.polygon) > 140)).toBe(true)
    expect(core.metrics.partitionAreaError).toBeLessThan(.05)
    expect(core.metrics.openSpaceArea / core.metrics.buildableArea).toBeLessThan(.08)
    for (const building of core.buildings) {
      expect(building.polygon).toHaveLength(4)
      const title=core.parcels.find(parcel=>parcel.id===building.parcelId)!
      expect(polygonArea(building.polygon)/polygonArea(title.polygon)).toBeLessThan(.72)
    }
  })

  it('gives outer housing titled garden and actual parking space while dense streets retain compact titles', () => {
    const source = run().input
    const outer = run({ demand: { ...source.demand, at: () => .25 } }).result, dense = run({ demand: { ...source.demand, at: () => .9 } }).result
    expect(median(outer.parcels.map(parcel => polygonArea(parcel.polygon)))).toBeGreaterThan(median(dense.parcels.map(parcel => polygonArea(parcel.polygon))) * 1.5)
    expect(outer.metrics.stock.garden!.parking).toBeGreaterThan(outer.metrics.stock.garden!.count * .6)
    expect(outer.metrics.stock.mixed).toBeUndefined()
    expect(outer.metrics.openSpaceArea / outer.metrics.buildableArea).toBeLessThan(.08)
    expect(outer.metrics.partitionAreaError).toBeLessThan(.05)
    expect(new Set([...outer.buildings, ...dense.buildings].map(building => Math.round(polygonArea(building.polygon)))).size).toBeGreaterThan(8)
  })

  it('varies real acquisitions and roof sizes along the same street without moving roads or breaking access', () => {
    const source=run().input,roads=loop(320,90).map(road=>road.id==='north'?{...road,width:7,role:'collector' as const}:road)
    const original=JSON.stringify(roads),demand={...source.demand,center:{x:40,y:20},at:()=>.82}
    const first=run({roads,blocks:[{id:'long-front',polygon:rectangle(20,20,320,90)}],demand}).result
    const repeated=run({roads,blocks:[{id:'long-front',polygon:rectangle(20,20,320,90)}],demand}).result
    expect(repeated).toEqual(first)
    expect(JSON.stringify(roads)).toBe(original)
    const titles=new Map(first.parcels.map(parcel=>[parcel.id,parcel])),roofs=first.buildings.filter(building=>{const parcel=titles.get(building.parcelId!)!;return parcel.roadId==='north'&&parcel.use==='residential'})
    expect(roofs.length).toBeGreaterThan(8)
    const quantile=(values:number[],fraction:number)=>values.sort((a,b)=>a-b)[Math.floor((values.length-1)*fraction)]!
    const widths=roofs.map(roof=>Math.hypot(roof.polygon[1]!.x-roof.polygon[0]!.x,roof.polygon[1]!.y-roof.polygon[0]!.y)),areas=roofs.map(roof=>polygonArea(roof.polygon))
    expect(quantile(widths,.9)/quantile(widths,.1)).toBeGreaterThan(1.35)
    expect(quantile(areas,.9)/quantile(areas,.1)).toBeGreaterThan(1.8)
    const setbacks=roofs.map(roof=>Math.min(...roof.polygon.map(p=>p.y))-20-roads[0]!.width/2)
    expect(quantile(setbacks,.9)-quantile(setbacks,.1)).toBeGreaterThan(.8)
    expect(first.metrics.openSpaceArea/first.metrics.buildableArea).toBeLessThan(.08)
    expect(first.metrics.partitionAreaError).toBeLessThan(.05)
    for(const roof of first.buildings){
      const title=titles.get(roof.parcelId!)!,road=[...roads,...first.accessRoads].find(road=>road.id===title.roadId)!
      expect(subtractRegions(roof,[title]).reduce((sum,part)=>sum+regionArea(part),0)).toBeLessThan(.005)
      expect(title.createdYear).toBeGreaterThanOrEqual(road.builtYear??1650)
      expect(Math.min(...road.points.slice(1).map((b,i)=>distanceToSegment(title.access![0]!,road.points[i]!,b)))).toBeLessThan(.001)
    }
  })

  it('retains fine inherited frontages while later neighbourhoods acquire deeper garden sites and coherent house plans', () => {
    const source=run().input,block={id:'neighbourhood-form',polygon:rectangle(20,20,320,84)}
    const form=(year:number)=>run({roads:loop(320,84).map(road=>({...road,builtYear:year})),blocks:[block],demand:{...source.demand,center:{x:40,y:20},at:()=>.48,openingAt:()=>year}}).result
    const inherited=form(1870),planned=form(1975)
    const depth=(result:typeof inherited)=>result.parcels.filter(parcel=>parcel.roadId==='north').map(parcel=>{const b=boundsOf(parcel.polygon);return b.maxY-b.minY})
    expect(median(depth(planned))).toBeGreaterThan(median(depth(inherited))*1.1)
    expect(median(planned.parcels.map(parcel=>polygonArea(parcel.polygon)))).toBeGreaterThan(median(inherited.parcels.map(parcel=>polygonArea(parcel.polygon))))
    expect(inherited.buildings.every(building=>building.polygon.length===4)).toBe(true)
    expect(planned.buildings.some(building=>building.polygon.length===6)).toBe(true)
    expect(planned.buildings.some(building=>building.polygon.length===4)).toBe(true)
    expect(planned.metrics.openSpaceArea/planned.metrics.buildableArea).toBeLessThan(inherited.metrics.openSpaceArea/inherited.metrics.buildableArea)
    for(const result of [inherited,planned]){
      expect(result.metrics.partitionAreaError).toBeLessThan(.1)
      expect(result.metrics.openSpaceArea/result.metrics.buildableArea).toBeLessThan(.1)
      for(const building of result.buildings){
        const title=result.parcels.find(parcel=>parcel.id===building.parcelId)!
        expect(subtractRegions(building,[title]).reduce((sum,part)=>sum+regionArea(part),0)).toBeLessThan(.005)
      }
    }
    expect(planned.parcels.every(parcel=>parcel.createdYear>=1975)).toBe(true)
  })

  it('acquires grouped apartment courts on a real later approach without filling reserved ground or turning every house into a block', () => {
    const source=run().input,roads=loop(420,120).map(road=>({...road,width:5.6,role:'lane' as const,builtYear:1975})),water={id:'court-pond',kind:'water' as const,polygon:rectangle(300,65,30,24)},reserve={polygon:rectangle(180,72,34,24)}
    const input={width:600,height:350,roads,blocks:[{id:'court-neighbourhood',polygon:rectangle(20,20,420,120)}],reserves:[reserve],terrain:{...source.terrain,areas:[water],waterAt:(p:{x:number;y:number})=>pointInPolygon(p,water.polygon)},demand:{...source.demand,center:{x:40,y:20},at:()=>.76,openingAt:()=>1975}}
    const result=run(input).result,titles=new Map(result.parcels.map(parcel=>[parcel.id,parcel]))
    const courts=result.buildings.filter(building=>building.kind==='residential'&&building.height>=3&&building.polygon.length===6&&polygonArea(building.polygon)>200)
    expect(courts.length).toBeGreaterThan(1)
    expect(result.metrics.courtyardLots).toBeGreaterThan(1)
    expect(result.buildings.some(building=>building.kind==='residential'&&building.height<=2&&polygonArea(building.polygon)<180)).toBe(true)
    for(const court of courts){
      const title=titles.get(court.parcelId!)!
      expect(polygonArea(title.polygon)).toBeGreaterThan(600)
      expect(polygonArea(court.polygon)/polygonArea(title.polygon)).toBeLessThan(.5)
      expect(court.builtYear!).toBeGreaterThanOrEqual(1975)
    }
    const pavement=roads.flatMap(road=>road.points.slice(1).map((b,i)=>({polygon:corridorPolygon(road.points[i]!,b,road.width/2+.25)})))
    for(const building of result.buildings){
      const title=titles.get(building.parcelId!)!
      expect(subtractRegions(building,[title]).reduce((sum,part)=>sum+regionArea(part),0)).toBeLessThan(.005)
      expect(polygonOverlapsRegion(building.polygon,water)).toBe(false)
      expect(polygonOverlapsRegion(building.polygon,reserve)).toBe(false)
      expect(pavement.every(row=>overlapArea(building,row)<.005)).toBe(true)
    }
    expect(result.metrics.partitionAreaError).toBeLessThan(.2)
    // A marker on a separate public component grants no station quarter.
    const remote=run({...input,demand:{...input.demand,center:{x:550,y:300}},roads:[...roads,{id:'separate-station',points:[{x:20,y:0},{x:440,y:0}],kind:'local' as const,width:6,builtYear:1975}],stations:[{id:'unconnected-court-station',point:{x:50,y:0},name:'別路線',builtYear:1975}]}).result
    expect(remote.buildings.some(building=>building.height>=3&&building.polygon.length===6&&polygonArea(building.polygon)>200)).toBe(false)
  })

  it('reoffers a shallow apartment acquisition to ordinary ownership once instead of repeating the rejected court proposal', () => {
    const source=run().input,roads=loop(420,24).map(road=>({...road,width:5.6,role:'lane' as const,builtYear:1975}))
    const result=run({roads,blocks:[{id:'shallow-court',polygon:rectangle(20,20,420,24)}],demand:{...source.demand,center:{x:40,y:20},at:()=>.76,openingAt:()=>1975}}).result
    expect(result.parcels.length).toBeGreaterThan(20)
    expect(result.metrics.courtyardLots).toBe(0)
    expect(result.metrics.partitionAreaError).toBeLessThan(.1)
    expect(result.buildings.every(building=>building.polygon.every(point=>pointInPolygon(point,result.parcels.find(parcel=>parcel.id===building.parcelId)!.polygon)))).toBe(true)
  }, 2000)

  it.each(['mixed-court-0','mixed-court-2','mixed-court-11'])('keeps three surviving shop frontages when apartment acquisitions compete for the same approach (%s)', seed => {
    const source=run().input,roads=loop(420,120).map(road=>({...road,width:road.id==='north'?6.8:5.6,role:road.id==='north'?'collector' as const:'lane' as const,builtYear:1975}))
    const result=run({config:{...config,seed,facilities:['shop']},width:600,height:350,roads,blocks:[{id:'mixed-court-neighbourhood',polygon:rectangle(20,20,420,120)}],demand:{...source.demand,center:{x:40,y:20},at:()=>.76,openingAt:()=>1975}}).result
    const history=shoppingStreetHistory({buildings:result.history.buildings,parcels:result.history.parcels,roads:roads.map(value=>({from:1975,value})),name:'商店街',throughYear:2025})
    expect(history.some(version=>version.to===undefined)).toBe(true)
    const titles=new Map(result.parcels.map(parcel=>[parcel.id,parcel])),shops=result.buildings.filter(building=>building.kind==='commercial'&&titles.get(building.parcelId!)?.roadId==='north')
    expect(shops.length).toBeGreaterThanOrEqual(3)
    expect(result.metrics.courtyardLots).toBeGreaterThan(0)
    for(const building of result.buildings)expect(subtractRegions(building,[titles.get(building.parcelId!)!]).reduce((sum,part)=>sum+regionArea(part),0)).toBeLessThan(.005)
    expect(result.metrics.partitionAreaError).toBeLessThan(.2)
  })

  it('uses actual public-network station access and its opening date, not a nearby disconnected railway landmark', () => {
    const source = run().input, roads = source.roads.map(road => road.id === 'north' ? { ...road, width: 9 } : road)
    const demand = { ...source.demand, center: { x: 350, y: 300 }, at: () => .9 }
    const connected = run({ roads, demand, stations: [{ id: 'station', point: { x: 80, y: 20 }, entrance: { x: 80, y: 20 }, name: '駅', builtYear: 1985 }] }).result
    expect(connected.parcels.some(parcel => parcel.use === 'commercial')).toBe(true)
    expect(connected.parcels.filter(parcel => parcel.use === 'commercial').every(parcel => parcel.createdYear >= 1985)).toBe(true)
    const disconnected = run({ roads: [...roads, { id: 'station-road', points: [{ x: 20, y: 0 }, { x: 140, y: 0 }], width: 6, kind: 'local', builtYear: 1900 }], demand, stations: [{ id: 'station', point: { x: 80, y: 0 }, name: '駅', builtYear: 1900 }] }).result
    expect(disconnected.metrics.stock.mixed).toBeUndefined()
    expect(disconnected.metrics.stock.walkup).toBeUndefined()
    expect(disconnected.parcels.every(parcel => parcel.use === 'residential')).toBe(true)
    const stream = { id: 'gate-stream', kind: 'water' as const, polygon: rectangle(60, 12, 40, 4) }
    const wetGate = run({ roads, demand, stations: [{ id: 'station', point: { x: 80, y: 10 }, name: '駅', builtYear: 1900 }], terrain: { ...source.terrain, areas: [stream], waterAt: p => pointInPolygon(p, stream.polygon) } }).result
    expect(wetGate.metrics.stock.mixed).toBeUndefined()
    expect(wetGate.metrics.stock.walkup).toBeUndefined()
  })

  it('acquires larger office and retail holdings along real connected major streets while retaining ordinary homes', () => {
    const source=run().input,roads=materializeRoadJunctions([...loop(420,180).map(road=>road.id==='north'?{...road,width:10.2,role:'collector' as const}:road),{id:'business-local',points:[{x:20,y:100},{x:440,y:100}],width:5.5,kind:'local' as const,role:'lane' as const,builtYear:1955}])
    const demand={...source.demand,center:{x:80,y:20},at:()=>.9},input={width:600,height:400,roads,blocks:extractStreetBlocks(roads).map((polygon,i)=>({id:`business-face-${i}`,polygon})),demand}
    const result=run(input).result
    expect(result.metrics.stock.office!.count).toBeGreaterThan(0)
    expect(result.metrics.stock.retail!.count).toBeGreaterThan(0)
    const large=result.buildings.filter(building=>building.kind==='commercial'&&polygonArea(building.polygon)>600)
    expect(large.length).toBeGreaterThan(1)
    expect(Math.max(...large.map(building=>polygonArea(building.polygon)))).toBeGreaterThan(900)
    expect(large.some(building=>building.height>=6)).toBe(true)
    expect(result.buildings.some(building=>building.kind==='residential'&&polygonArea(building.polygon)<150)).toBe(true)
    const titles=new Map(result.parcels.map(parcel=>[parcel.id,parcel]))
    for(const building of result.buildings){
      const parcel=titles.get(building.parcelId!)!,road=[...roads,...result.accessRoads].find(road=>road.id===parcel.roadId)!
      expect(subtractRegions(building,[parcel]).reduce((sum,part)=>sum+regionArea(part),0)).toBeLessThan(.005)
      expect(Math.min(...road.points.slice(1).map((b,i)=>distanceToSegment(parcel.access![0]!,road.points[i]!,b)))).toBeLessThan(.001)
      expect(parcel.createdYear).toBeGreaterThanOrEqual(road.builtYear??1650)
      if(building.height>=6)expect(building.builtYear!).toBeGreaterThanOrEqual(1955)
      if(polygonArea(building.polygon)>900)expect(parcel.createdYear).toBeGreaterThanOrEqual(1955)
    }
    expect(result.metrics.partitionAreaError).toBeLessThan(.1)
    expect(result.metrics.openSpaceArea/result.metrics.buildableArea).toBeLessThan(.08)
    const remote=run({...input,demand:{...demand,center:{x:550,y:350}},stations:[{id:'unconnected-marker',point:{x:100,y:0},name:'別路線',builtYear:1985}],roads:[...roads,{id:'unconnected-station-road',points:[{x:20,y:0},{x:440,y:0}],width:8,kind:'local' as const,builtYear:1985}]}).result
    expect(remote.metrics.stock.office).toBeUndefined()
    expect(remote.metrics.stock.retail).toBeUndefined()
    expect(remote.buildings.every(building=>building.kind==='residential')).toBe(true)
  })

  it('keeps large commercial roofs out of water and reserved ground and waits for their real station approach', () => {
    const source=run().input,roads=materializeRoadJunctions([...loop(420,180).map(road=>road.id==='north'?{...road,width:10.2,role:'collector' as const}:road),{id:'business-local',points:[{x:20,y:100},{x:440,y:100}],width:5.5,kind:'local' as const,role:'lane' as const,builtYear:1955}]),water={id:'business-pond',kind:'water' as const,polygon:rectangle(190,62,35,25)},reserve={polygon:rectangle(325,60,40,25)}
    const result=run({width:600,height:400,roads,blocks:extractStreetBlocks(roads).map((polygon,i)=>({id:`business-face-${i}`,polygon})),reserves:[reserve],terrain:{...source.terrain,areas:[water],waterAt:p=>pointInPolygon(p,water.polygon)},demand:{...source.demand,center:{x:550,y:350},at:()=>.9},stations:[{id:'business-station',point:{x:80,y:20},entrance:{x:80,y:20},name:'新駅',builtYear:1985}]}).result
    expect(result.metrics.stock.office!.count+result.metrics.stock.retail!.count).toBeGreaterThan(0)
    for(const building of result.buildings){
      expect(polygonOverlapsRegion(building.polygon,water)).toBe(false)
      expect(polygonOverlapsRegion(building.polygon,reserve)).toBe(false)
    }
    const commerce=new Set(result.parcels.filter(parcel=>parcel.use==='commercial').map(parcel=>parcel.id))
    expect(commerce.size).toBeGreaterThan(0)
    expect(result.history.buildings.filter(version=>commerce.has(version.value.parcelId!)).every(version=>version.from>=1985&&version.value.builtYear===version.from)).toBe(true)
  })

  it('retains an older qualifying trade route while later shortcut mass waits for a physical renewal', () => {
    const source = run().input, roads: Road[] = [...source.roads.map(road => road.id === 'east' ? { ...road, width: 9, role: 'collector' as const } : road),
      { id: 'old-approach', points: [{ x: 20, y: 200 }, { x: 5, y: 200 }, { x: 5, y: 20 }, { x: 20, y: 20 }], kind: 'local', width: 6, builtYear: 1770 },
      { id: 'future-shortcut', points: [{ x: 20, y: 200 }, { x: 140, y: 80 }], kind: 'local', width: 6, builtYear: 1955 }]
    const result = run({ roads, demand: { ...source.demand, center: { x: 20, y: 200 }, at: () => .9 } }).result
    const shops = result.parcels.filter(parcel => parcel.use === 'commercial' && parcel.roadId === 'east' && parcel.createdYear<1955)
    expect(shops.length).toBeGreaterThan(0)
    expect(shops.every(parcel => parcel.createdYear === 1770)).toBe(true)
    const ids = new Set(shops.map(parcel => parcel.id))
    expect(result.history.buildings.filter(version => ids.has(version.value.parcelId!) && version.from < 1955).every(version => version.value.height <= 2)).toBe(true)
    expect(result.history.buildings.some(version => ids.has(version.value.parcelId!) && version.from >= 1955 && version.value.height >= 3)).toBe(true)
  })

  it('uses a surveyed old civic public gate instead of inventing a walk through its reserved core', () => {
    const source = run().input, roads = source.roads.map(road => road.id === 'north' ? { ...road, width: 9, role: 'collector' as const } : road)
    const demand = { ...source.demand, at: () => .9 }, reserve = { polygon: rectangle(50, 34, 40, 25) }
    const withoutGate = run({ roads, demand, reserves: [reserve] }).result
    expect(withoutGate.metrics.stock.mixed).toBeUndefined()
    const gate = run({ roads, demand, reserves: [reserve], centerAccess: { point: { x: 80, y: 20 }, builtYear: 1770 } }).result
    expect(gate.metrics.stock.mixed!.count).toBeGreaterThan(0)
    const historicShops=gate.parcels.filter(parcel => parcel.use === 'commercial'&&parcel.createdYear<1955)
    expect(historicShops.length).toBeGreaterThan(0)
    expect(historicShops.every(parcel => parcel.createdYear === 1770)).toBe(true)
    expect(gate.buildings.every(building => !polygonOverlapsRegion(building.polygon, reserve))).toBe(true)
  })

  it('owns usable curved frontage across short road samples without accepting skinny residual strips', () => {
    const source = run().input, curve = Array.from({ length: 41 }, (_, i) => ({ x: 20 + i * 3, y: 20 + Math.sin(i / 40 * Math.PI) * 2 }))
    const roads = source.roads.map(road => road.id === 'north' ? { ...road, points: curve } : road)
    const result = run({ roads, blocks: [{ id: 'curved', polygon: [...curve, { x: 140, y: 80 }, { x: 20, y: 80 }] }] }).result
    expect(result.parcels.length).toBeGreaterThan(12)
    expect(result.parcels.filter(parcel => parcel.roadId === 'north').length).toBeGreaterThan(4)
    expect(result.metrics.openSpaceArea / result.metrics.buildableArea).toBeLessThan(.1)
    expect(result.metrics.partitionAreaError).toBeLessThan(.1)
    for (const building of result.buildings) expect(building.polygon.every(p => pointInPolygon(p, result.parcels.find(parcel => parcel.id === building.parcelId)!.polygon))).toBe(true)
  })

  it('subdivides a deep face using physically surveyed shared streets instead of invisible rear access', () => {
    const roads: Road[] = materializeRoadJunctions([...loop(240, 180),
      { id: 'north-local-tree', points: [{ x: 85, y: 20 }, { x: 85, y: 95 }, { x: 100, y: 110 }], width: 5, kind: 'local', role: 'lane', builtYear: 1955 },
      { id: 'north-local-branch', points: [{ x: 85, y: 95 }, { x: 133, y: 98 }], width: 4, kind: 'local', role: 'lane', builtYear: 1955 },
      { id: 'south-local-tree', points: [{ x: 200, y: 200 }, { x: 194, y: 128 }, { x: 180, y: 118 }], width: 4.5, kind: 'local', role: 'lane', builtYear: 1975 },
      { id: 'east-local-tree', points: [{ x: 260, y: 70 }, { x: 196, y: 70 }, { x: 173, y: 78 }], width: 4.5, kind: 'local', role: 'lane', builtYear: 1975 },
      { id: 'west-local-tree', points: [{ x: 20, y: 145 }, { x: 70, y: 148 }, { x: 120, y: 157 }], width: 4, kind: 'local', role: 'lane', builtYear: 1975 },
    ])
    const { input, result } = run({ roads, blocks: [{ id: 'deep', polygon: rectangle(20, 20, 240, 180) }] })
    expect(result.accessRoads.length).toBeLessThanOrEqual(4)
    expect(result.metrics.partitionAreaError).toBeLessThan(.2)
    expect(result.parcels.some(parcel => parcel.roadId === 'north-local-tree' || parcel.roadId === 'south-local-tree')).toBe(true)
    for (const lane of result.accessRoads) {
      expect(lane.width).toBe(4)
      expect(lane.points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - lane.points[i]!.x, p.y - lane.points[i]!.y), 0)).toBeLessThanOrEqual(110)
      const anchors = lane.points.length === 3 ? [lane.points[0]!, lane.points.at(-1)!] : [lane.points[0]!]
      for (const point of anchors) expect(Math.min(...[...input.roads, ...result.accessRoads.filter(road => road !== lane)].flatMap(road => road.points.slice(1).map((b, i) => distanceToSegment(point, road.points[i]!, b))))).toBeLessThan(.001)
      for (const parcel of result.parcels) for (let i = 1; i < lane.points.length; i++) expect(polygonsOverlap(parcel.polygon, corridorPolygon(lane.points[i - 1]!, lane.points[i]!, lane.width / 2))).toBe(false)
    }
    expect(median(result.parcels.map(parcel => polygonArea(parcel.polygon)))).toBeLessThan(400)
    expect(result.metrics.parcelArea/result.parcels.length).toBeLessThan(500)
  })

  it('surveys a bounded turning head for a deep single-frontage block instead of one giant backyard title', () => {
    const roads = [loop(120, 160)[0]!]
    const { result } = run({ roads, blocks: [{ id: 'rear', polygon: rectangle(20, 20, 120, 160) }] })
    expect(result.accessRoads.some(road => road.points.length === 4)).toBe(true)
    expect(result.parcels.length).toBeGreaterThan(25)
    expect(result.metrics.partitionAreaError).toBeLessThan(.2)
    expect(Math.max(...result.parcels.filter(parcel=>parcel.use==='residential').map(parcel => polygonArea(parcel.polygon)))).toBeLessThan(1600)
    for(const parcel of result.parcels.filter(parcel=>parcel.use==='commercial')){
      expect(polygonArea(parcel.polygon)).toBeLessThan(4500)
      const building=result.buildings.find(building=>building.parcelId===parcel.id)!
      if(polygonArea(parcel.polygon)>1600)expect(polygonArea(building.polygon)).toBeGreaterThan(200)
    }
    for (const road of result.accessRoads.filter(road => road.points.length === 4)) {
      const length = road.points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - road.points[i]!.x, p.y - road.points[i]!.y), 0)
      expect(length).toBeLessThanOrEqual(110)
      expect(Math.min(...roads.flatMap(street => street.points.slice(1).map((b, i) => distanceToSegment(road.points[0]!, street.points[i]!, b))), ...result.accessRoads.filter(other => other !== road).flatMap(street => street.points.slice(1).map((b, i) => distanceToSegment(road.points[0]!, street.points[i]!, b))))).toBeLessThan(.001)
    }
  })

  it('acquires a1km closed coarse face along unequal real local trees without regridding it', () => {
    const outer = loop(1000, 1000).map(road => ({ ...road, width: road.id === 'north' ? 10 : 8, kind: 'arterial' as const, role: 'collector' as const }))
    const roads: Road[] = [...outer]
    const grow = (name: string, points: [number, number][], arms: [number, number, number][]) => {
      for (let i = 1; i < points.length; i++) roads.push({ id: `${name}-stem-${i}`, points: [points[i - 1]!, points[i]!].map(([x, y]) => ({ x, y })), kind: 'local', role: 'lane', width: i % 2 ? 5 : 4.5, builtYear: 1955 })
      for (const [i, x, y] of arms) roads.push({ id: `${name}-arm-${i}`, points: [{ x: points[i]![0], y: points[i]![1] }, { x, y }], kind: 'local', role: 'lane', width: 4.5, builtYear: 1975 })
    }
    grow('nw', [[240, 20], [250, 105], [225, 185], [245, 270], [212, 350], [240, 430], [220, 500]], [[1, 330, 115], [2, 140, 195], [3, 335, 280], [4, 125, 360], [5, 325, 440]])
    grow('ne', [[760, 20], [775, 110], [748, 200], [780, 285], [755, 375], [782, 465], [765, 535]], [[1, 860, 120], [2, 665, 215], [3, 870, 300], [4, 670, 385], [5, 875, 470], [6, 675, 540]])
    grow('sw', [[250, 1020], [260, 940], [235, 855], [270, 770], [250, 690], [282, 615], [260, 550]], [[1, 170, 935], [2, 320, 850], [3, 180, 755], [4, 335, 690], [5, 200, 610]])
    grow('se', [[780, 1020], [765, 930], [795, 845], [770, 755], [800, 675], [775, 600]], [[1, 855, 920], [2, 705, 835], [3, 855, 750], [4, 710, 665], [5, 860, 590]])
    grow('west', [[20, 525], [110, 530], [195, 520], [280, 535], [365, 520], [450, 540], [535, 525]], [[4, 370, 435], [5, 445, 620], [6, 540, 445]])
    grow('east', [[1020, 560], [930, 565], [845, 555], [760, 570], [675, 555], [590, 570], [505, 555]], [[4, 660, 470], [5, 600, 650]])
    const actualRoads = materializeRoadJunctions(roads), faces = extractStreetBlocks(actualRoads)
    expect(faces).toHaveLength(1)
    expect(polygonArea(faces[0]!)).toBeCloseTo(1_000_000, 1)
    const source = run().input, water = { id: 'pond', kind: 'water' as const, polygon: rectangle(475, 300, 40, 30) }, rail = { polygon: rectangle(580, 800, 14, 70) }
    const { input, result } = run({ width: 1060, height: 1060, roads: actualRoads, blocks: [{ id: 'network-face', polygon: faces[0]! }], reserves: [rail], terrain: { ...source.terrain, areas: [water], waterAt: p => pointInPolygon(p, water.polygon) }, demand: { ...source.demand, regions: [{ polygon: rectangle(0, 0, 1060, 1060) }], center: { x: 240, y: 20 }, at: () => .85, openingAt: () => 1955 } })
    const coverage = frontageAcquisition(input, result.parcels, result.accessRoads, 12)
    expect(coverage.eligible).toBeGreaterThan(400)
    expect(coverage.ratio).toBeGreaterThan(.8)
    expect(result.parcels.length).toBeGreaterThan(700)
    expect(result.accessRoads.length).toBeLessThanOrEqual(4)
    expect(result.accessRoads.filter(road => road.points.length === 3).length).toBeLessThanOrEqual(1)
    expect(extractStreetBlocks(materializeRoadJunctions([...actualRoads, ...result.accessRoads])).length).toBeLessThanOrEqual(2)
    expect(result.metrics.partitionAreaError).toBeLessThan(2)
    expect(Math.max(...result.parcels.filter(parcel=>parcel.use==='residential').map(parcel => polygonArea(parcel.polygon)))).toBeLessThan(1600)
    for(const parcel of result.parcels.filter(parcel=>parcel.use==='commercial')){
      expect(polygonArea(parcel.polygon)).toBeLessThan(4500)
      const building=result.buildings.find(building=>building.parcelId===parcel.id)!
      if(polygonArea(parcel.polygon)>1600)expect(polygonArea(building.polygon)).toBeGreaterThan(200)
    }
    for (const road of result.accessRoads) {
      expect(road.width).toBe(4)
      expect(road.points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - road.points[i]!.x, p.y - road.points[i]!.y), 0)).toBeLessThanOrEqual(110)
      for (let i = 1; i < road.points.length; i++) for (const mask of [water, rail]) expect(polygonOverlapsRegion(corridorPolygon(road.points[i - 1]!, road.points[i]!, 2.25), mask)).toBe(false)
    }
    const byId = new Map(result.parcels.map(parcel => [parcel.id, parcel]))
    for (const building of result.buildings) {
      expect(building.polygon.every(p => pointInPolygon(p, byId.get(building.parcelId!)!.polygon))).toBe(true)
      for (const mask of [water, rail]) expect(polygonOverlapsRegion(building.polygon, mask)).toBe(false)
    }
    const roadById = new Map([...actualRoads, ...result.accessRoads].map(road => [road.id, road]))
    expect(result.parcels.every(parcel => { const road = roadById.get(parcel.roadId); return road && parcel.createdYear >= (road.builtYear ?? 1650) })).toBe(true)
  })

  it('does not change cadastre or manufacture skinny lanes when one road has many collinear samples', () => {
    const simple = run()
    const roads = simple.input.roads.map(road => ({ ...road, points: Array.from({ length: 61 }, (_, i) => ({ x: road.points[0]!.x + (road.points[1]!.x - road.points[0]!.x) * i / 60, y: road.points[0]!.y + (road.points[1]!.y - road.points[0]!.y) * i / 60 })) }))
    const sampled = run({ roads })
    expect(sampled.result.parcels.map(parcel => ({ id: parcel.id, polygon: parcel.polygon }))).toEqual(simple.result.parcels.map(parcel => ({ id: parcel.id, polygon: parcel.polygon })))
    expect(sampled.result.buildings.map(building => building.polygon)).toEqual(simple.result.buildings.map(building => building.polygon))
    expect(sampled.result.accessRoads).toEqual([])
  })

  it('retains exact water and reserved holes while conserving all remaining buildable ground', () => {
    const water = { polygon: rectangle(68, 38, 18, 24) }, reserve = { polygon: rectangle(32, 30, 16, 13) }
    const { input, result } = run({ reserves: [reserve], terrain: { areas: [{ ...water, id: 'stream', kind: 'water' }], waterAt: point => pointInPolygon(point, water.polygon), slope: () => 0, elevation: () => 10 } })
    const roadRegions = input.roads.flatMap(road => road.points.slice(1).map((b, i) => ({ polygon: corridorPolygon(road.points[i]!, b, road.width / 2 + .25) })))
    const expected = subtractRegions(input.blocks[0]!, [...roadRegions, water, reserve]).reduce((sum, region) => sum + regionArea(region), 0)
    expect(result.metrics.buildableArea).toBeCloseTo(expected, 2)
    expect(result.metrics.partitionAreaError).toBeLessThan(.1)
    for (const parcel of result.parcels) {
      expect(overlapArea(parcel, water)).toBeLessThan(.001)
      expect(overlapArea(parcel, reserve)).toBeLessThan(.001)
    }
    for (const building of result.buildings) {
      expect(polygonOverlapsRegion(building.polygon, water)).toBe(false)
      expect(polygonOverlapsRegion(building.polygon, reserve)).toBe(false)
    }
  })

  it('reports an inaccessible interior explicitly and never invents a parcel road reference', () => {
    const { result } = run({ blocks: [{ id: 'isolated', polygon: rectangle(300, 200, 100, 80) }] })
    expect(result.parcels).toEqual([])
    expect(result.buildings).toEqual([])
    expect(result.openSpaces).toHaveLength(1)
    expect(result.openSpaces[0]!.name).toBeUndefined()
    expect(result.metrics.openReasons['実接道を確保できない街区内地']!.area).toBe(8000)
    expect(result.metrics.openSpaceArea).toBe(8000)
    expect(result.metrics.partitionAreaError).toBe(0)
  })

  it('serializes urban open areas as geometry only and leaves demand-free ground to natural cover', () => {
    const original = run(), outside = { id: 'outside-demand', polygon: rectangle(300, 200, 100, 80), holes: [rectangle(325, 225, 10, 10)] }
    const { result } = run({ blocks: [...original.input.blocks, outside], terrain: { ...original.input.terrain, slope: () => .3 }, demand: { ...original.input.demand, regions: [{ polygon: rectangle(0, 0, 250, 400) }], at: point => point.x > 250 ? 0 : .6 } })
    expect(result.openSpaces.length).toBeGreaterThan(0)
    expect(result.unassignedGround).toHaveLength(1)
    expect(regionArea(result.unassignedGround[0]!)).toBe(7900)
    expect(result.unassignedGround[0]!.holes![0]!.map(point => `${point.x}:${point.y}`).sort()).toEqual(outside.holes[0]!.map(point => `${point.x}:${point.y}`).sort())
    expect(result.metrics.unassignedArea).toBe(7900)
    expect(result.metrics.openReasons['都市需要外の連続地']).toBeUndefined()
    expect(result.metrics.partitionAreaError).toBeLessThan(.05)
    expect(result.metrics.parcelArea + result.metrics.accessArea + result.metrics.openSpaceArea + result.metrics.unassignedArea).toBeCloseTo(result.metrics.buildableArea, 1)
    const text = JSON.stringify({ areas: result.openSpaces, unassigned: result.unassignedGround })
    expect(text).not.toMatch(/frontages|segment|bounds|builtYear|points/)
    for (const area of JSON.parse(text).areas) expect(Object.keys(area).every(key => ['polygon', 'holes', 'id', 'kind', 'landUse'].includes(key))).toBe(true)
    for (const region of JSON.parse(text).unassigned) expect(Object.keys(region).every(key => ['polygon', 'holes'].includes(key))).toBe(true)
    expect(result.openSpaces.every(area => boundsOf(area.polygon).maxX < 250)).toBe(true)
    expect(text.length).toBeLessThan(20000)
  })

  it('preserves positive sub-lattice ownership fragments and holes as unassigned ground before crop', () => {
    const triangle = { id: 'continuous-fringe-micro', polygon: [{ x: 200.00001, y: 150.00001 }, { x: 200.00002, y: 150.00001 }, { x: 200.00001, y: 150.00002 }] }
    const holed = { id: 'continuous-fringe-small-hole', polygon: rectangle(220, 160, .01, .01), holes: [rectangle(220.003, 160.003, .002, .003)] }
    const source = JSON.stringify([triangle, holed]), { result } = run({ blocks: [triangle, holed] })
    expect(result.parcels).toEqual([])
    expect(result.buildings).toEqual([])
    expect(result.accessRoads).toEqual([])
    expect(result.openSpaces).toEqual([])
    expect(result.unassignedGround).toEqual([{ polygon: triangle.polygon }, { polygon: holed.polygon, holes: holed.holes }])
    expect(result.unassignedGround[0]!.polygon).toBe(triangle.polygon)
    expect(result.unassignedGround[1]!.holes).toBe(holed.holes)
    expect(result.metrics.unassignedArea).toBeGreaterThan(.000094)
    expect(result.metrics.unassignedArea).toBeCloseTo(.000094 + .00001 * .00001 / 2, 12)
    expect(result.metrics.buildableArea).toBe(result.metrics.unassignedArea)
    expect(result.metrics.partitionAreaError).toBe(0)
    expect(JSON.stringify([triangle, holed])).toBe(source)
  })

  it('acquires the demanded edge of a closed face even when its original representative point has no demand', () => {
    const original = run().input, roads = loop(200, 100), block = { id: 'straddling-face', polygon: rectangle(20, 20, 200, 100) }, support = { polygon: rectangle(20, 20, 60, 100) }
    const demand = { ...original.demand, regions: [support], at: (p: { x: number; y: number }) => pointInPolygon(p, support.polygon) ? .7 : 0 }
    expect(demand.at({ x: 120, y: 70 })).toBe(0)
    const source = JSON.stringify({ block, roads, support }), { result } = run({ roads, blocks: [block], demand })
    expect(result.parcels.length).toBeGreaterThan(8)
    expect(result.parcels.every(parcel => parcel.polygon.every(p => p.x <= 80.0001))).toBe(true)
    expect(result.buildings.every(building => building.polygon.every(p => p.x < 80))).toBe(true)
    const roadGround = roads.flatMap(road => road.points.slice(1).map((b, i) => ({ polygon: corridorPolygon(road.points[i]!, b, road.width / 2 + .25) })))
    const physical = subtractRegions(block, roadGround), outside = physical.flatMap(part => subtractRegions(part, [support]))
    expect(result.metrics.unassignedArea).toBeCloseTo(outside.reduce((sum, part) => sum + regionArea(part), 0), 2)
    expect(result.metrics.parcelArea + result.metrics.accessArea + result.metrics.openSpaceArea + result.metrics.unassignedArea).toBeCloseTo(result.metrics.buildableArea, 1)
    expect(result.metrics.partitionAreaError).toBeLessThan(.1)
    for (const ground of result.unassignedGround) for (const parcel of result.parcels) expect(overlapArea(ground, parcel)).toBeLessThan(.001)
    expect(JSON.stringify({ block, roads, support })).toBe(source)
  })

  it('dates frontage and repeated physical frames coherently without mutating earlier geometry', () => {
    const roads = loop().map(road => road.id === 'north' ? { ...road, kind: 'arterial' as const, role: 'collector' as const, width: 9 } : road)
    const source = run().input.demand, demand = { ...source, center: { x: 80, y: 20 } }
    const first = run({ roads, demand }), repeat = run({ roads, demand }), past = run({ roads, demand, config: { ...config, targetYear: 1850 } })
    expect(first.result).toEqual(repeat.result)
    expect(past.result.parcels).toEqual(first.result.parcels.filter(parcel => parcel.createdYear <= 1850))
    expect(past.result.history.buildings.map(version => version.value)).toEqual(first.result.history.buildings.filter(version => version.from <= 1850).map(version => version.value))
    expect(first.result.buildings.some(building => building.kind === 'commercial')).toBe(true)
    expect(first.result.history.buildings.some(version => version.from === 1770 && version.value.kind === 'commercial' && version.to! < 1900)).toBe(true)
    expect(new Set(first.result.history.buildings.map(version => version.value.id)).size).toBe(first.result.history.buildings.length)
    for (const building of first.result.buildings) expect(2025 - building.builtYear!).toBeLessThan(buildingServiceYears(config.seed, building))
    expect(first.result.history.buildingStates).toEqual([])
    expect(first.result.parcels.every(parcel => /^cf-p-\d+$/.test(parcel.id))).toBe(true)
    for (const version of first.result.history.buildings) {
      expect(version.value.id).toMatch(/^cf-b-\d+-\d+-\d+$/)
      expect(version.value.occupancy).toBe('occupied')
      expect(version.value.occupiedHouseholds).toBeGreaterThanOrEqual(0)
      for (const point of version.value.polygon) { expect(point.x * 10000).toBeCloseTo(Math.round(point.x * 10000), 5); expect(point.y * 10000).toBeCloseTo(Math.round(point.y * 10000), 5) }
    }
    expect(first.result.history.buildings.filter(version => version.from < 1955).every(version => version.value.height <= 2)).toBe(true)
    const later = run({ roads: roads.map(road => ({ ...road, builtYear: 1975 })), demand: { ...first.input.demand, openingAt: () => 1900 } })
    expect(later.result.parcels.every(parcel => parcel.createdYear >= 1975)).toBe(true)
    for (const parcel of later.result.parcels) expect(boundsOf(parcel.polygon).minX).toBeGreaterThan(20)
    const phased = run({ demand: { ...first.input.demand, openingAt: point => point.x > 80 ? 1975 : 1770 } })
    for (const building of phased.result.buildings) if (building.polygon.some(point => point.x > 80)) expect(phased.result.parcels.find(parcel => parcel.id === building.parcelId)!.createdYear).toBeGreaterThanOrEqual(1975)
  })
})
