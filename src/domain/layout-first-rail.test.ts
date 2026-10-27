import { describe, expect, it } from 'vitest'
import { distance, distanceToSegment, pointInPolygon, polygonOverlapsRegion, rectangle, regionArea, subtractRegions } from './geometry'
import { surveyLayoutFirstRail, surveyLayoutStationApproaches, resurveyLayoutFirstStation, stationAccessRepairReport } from './layout-first-rail'
import type { LayoutFirstRailInput, LayoutFirstRailResult } from './layout-first-rail'
import { stationFootprint } from './station-footprint'
import { repairContinuousCityAccess } from './continuous-city-access-repair'
import { surveyContinuousCityAccess } from './continuous-city-roads'
import type { Road } from './types'

function fixture(): LayoutFirstRailInput {
  return { config: { name: '試験市', seed: 'layout-rail-fixture', type: 'post', terrain: 'plain', density: 65, forest: 0, railway: true, stations: 2, arterial: true, facilities: [] },
    width: 2400, height: 1800, center: { x: 1200, y: 900 }, reserves: [],
    zones: [{ id: 'old-town', kind: 'historic', center: { x: 1200, y: 900 }, radius: 1100, polygon: rectangle(100, 100, 2200, 1600), builtYear: 1750, density: .8, maximumFloors: 3 }],
    terrain: { areas: [], elevation: () => 20, waterAt: () => false, slope: () => 0 } }
}

function stationRepairFixture(){
  const input=fixture();input.width=2000;input.height=1000;input.config={...input.config,stations:1};input.center={x:1000,y:500}
  const water={id:'trapped-south',kind:'water' as const,polygon:rectangle(-10,600,2020,20)}
  input.terrain={...input.terrain,areas:[water],waterAt:point=>pointInPolygon(point,water.polygon)}
  const points=[{x:100,y:500},{x:1900,y:500}],footprint=stationFootprint({points,chain:[0,1800],along:900,side:1,config:input.config,main:true})!
  const station={id:'station-0',name:'試験駅',point:footprint.point,entrance:footprint.entrance,buildingPolygon:footprint.building,platformPolygons:footprint.platforms,railwayId:'main',builtYear:1900}
  const previous:LayoutFirstRailResult={railways:[{id:'main',name:'本線',points,elevations:[20,20],builtYear:1900}],stations:[station],stationGrounds:[{id:'station-forecourt-0',kind:'field',landUse:'vacant',polygon:footprint.forecourt},{id:'station-trackground-0',kind:'field',landUse:'vacant',polygon:footprint.trackGround}],accessTargets:[{id:'station-access-0',point:footprint.gate,builtYear:1900,endHeading:-Math.PI/2}],stationPaths:[{id:'station-access-0',points:[footprint.gate,footprint.entrance],width:3,role:'access',kind:'local',builtYear:1900}],diagnostics:{requestedStations:1,placedStations:1}}
  const publicRoad:Road={id:'old-north-road',points:[{x:-50,y:250},{x:1000,y:250},{x:2050,y:250}],width:8,kind:'arterial',role:'collector',builtYear:1650,boundaryContinuation:true}
  input.roads=[publicRoad,...previous.stationPaths]
  const acquire=(candidate:LayoutFirstRailResult)=>repairContinuousCityAccess({config:input.config,center:input.center,environment:{width:input.width,height:input.height,core:null,areas:input.terrain.areas,terrain:{...input.terrain,bridgeSites:[]},bridgeSites:[]},reservedRegions:candidate.stationGrounds,railways:candidate.railways,initialRoads:[publicRoad,...candidate.stationPaths],accessTargets:candidate.accessTargets,demand:{center:input.center,regions:[],at:()=>.7,costAt:()=>1,openingAt:()=>1900,metrics:{cellSize:25,reachableLandArea:2000000,targetUrbanArea:1000000,selectedUrbanArea:1000000}}},surveyContinuousCityAccess)
  return {input,previous,publicRoad,acquire}
}

describe('station approach reacquisition',()=>{
  it('moves a trapped forecourt to the dry accessible side of the same railway and certifies its actual opening-date approach',()=>{
    const {input,previous,acquire}=stationRepairFixture(),saved=JSON.stringify(previous)
    let connected:ReturnType<typeof acquire>|undefined
    const next=resurveyLayoutFirstStation(input,previous,'station-access-0',candidate=>{const result=acquire(candidate);if(result.access.unserved.length)return false;connected=result;return true})
    expect(next).not.toBe(previous)
    expect(next.railways).toBe(previous.railways)
    expect(next.stations[0]!.point).toEqual(previous.stations[0]!.point)
    expect(next.stations[0]!.entrance!.y).toBeLessThan(500)
    expect(next.stations[0]!.name).toBe(previous.stations[0]!.name)
    expect(next.stations[0]!.builtYear).toBe(1900)
    expect(next.accessTargets[0]!.builtYear).toBe(1900)
    expect(next.stationPaths[0]!.points).toEqual([next.accessTargets[0]!.point,next.stations[0]!.entrance])
    expect(connected!.access.unserved).toEqual([])
    expect(next.stationGrounds.every(ground=>!input.terrain.areas.some(water=>water.kind==='water'&&polygonOverlapsRegion(ground.polygon,water)))).toBe(true)
    expect(JSON.stringify(previous)).toBe(saved)
  })

  it('keeps the original station unchanged when its only external street opens after the station',()=>{
    const {input,previous,publicRoad,acquire}=stationRepairFixture(),saved=JSON.stringify(previous)
    publicRoad.builtYear=1995
    const next=resurveyLayoutFirstStation(input,previous,'station-access-0',candidate=>acquire(candidate).access.unserved.length===0)
    expect(next).toBe(previous)
    expect(stationAccessRepairReport(next)!.attempted).toBeLessThanOrEqual(6)
    expect(stationAccessRepairReport(next)!.adopted).toBeUndefined()
    expect(JSON.stringify(previous)).toBe(saved)
    expect(publicRoad.builtYear).toBe(1995)
  })
})

describe('layout-first regional railway', () => {
  it('rejects a forecourt trapped between its railway and parallel creek while surveying the open opposite side', () => {
    const input = fixture(), water = { id: 'parallel-creek', kind: 'water' as const, polygon: rectangle(100, 870, 2200, 20) }
    const terrain = { ...input.terrain, areas: [water], waterAt: (p: { y: number }) => p.y >= 870 && p.y <= 890 }
    const common = { terrain, railPoints: [{ x: 100, y: 1000 }, { x: 2300, y: 1000 }], reserves: [], width: input.width, height: input.height }
    expect(surveyLayoutStationApproaches({ ...common, gate: { x: 1200, y: 953 }, outward: { x: 0, y: -1 } })).toEqual([])
    const openSide = surveyLayoutStationApproaches({ ...common, gate: { x: 1200, y: 1047 }, outward: { x: 0, y: 1 } })
    expect(openSide).toHaveLength(5)
    expect(openSide.every(path => distance(path[0]!, path[1]!) >= 179.99)).toBe(true)
  })

  it('checks complete approach width rather than only its dry centreline', () => {
    const input = fixture(), water = { id: 'road-shoulder-water', kind: 'water' as const, polygon: rectangle(1202, 700, 4, 300) }
    const paths = surveyLayoutStationApproaches({ gate: { x: 1200, y: 953 }, outward: { x: 0, y: -1 }, terrain: { ...input.terrain, areas: [water], waterAt: (p: { x: number }) => p.x >= 1202 && p.x <= 1206 }, railPoints: [{ x: 100, y: 1000 }, { x: 2300, y: 1000 }], reserves: [], width: input.width, height: input.height })
    expect(paths.some(path => Math.abs(path[1]!.x - 1200) < 1e-7)).toBe(false)
  })
  it('honours the rail toggle without surveying land', () => {
    const input = fixture(); input.config.railway = false
    input.terrain.elevation = () => { throw new Error('unrequested terrain query') }
    expect(surveyLayoutFirstRail(input)).toEqual({ railways: [], stations: [], stationGrounds: [], accessTargets: [], stationPaths: [], diagnostics: { requestedStations: 0, placedStations: 0 } })
  })

  it('creates one continuous engineered line, reserving usable station buildings and street-facing forecourts', () => {
    const input = fixture(), result = surveyLayoutFirstRail(input)
    expect(result.diagnostics.reason).toBeUndefined()
    expect(result.railways).toHaveLength(1)
    expect(result.stations).toHaveLength(2)
    const line = result.railways[0]!
    expect(line.junction).toBeUndefined()
    expect(result.diagnostics.alignment!.maxTrackGrade).toBeLessThanOrEqual(.035 + 1e-6)
    expect(result.diagnostics.alignment!.minCurveRadius).toBeGreaterThanOrEqual(150)
    for (let i = 1; i < line.points.length; i++) expect(Math.abs(line.elevations![i]! - line.elevations![i - 1]!) / distance(line.points[i]!, line.points[i - 1]!)).toBeLessThanOrEqual(.035 + 1e-6)
    for (const [index, station] of result.stations.entries()) {
      expect(station.railwayId).toBe(line.id)
      expect(Math.min(...line.points.slice(1).map((b, i) => distanceToSegment(station.point, line.points[i]!, b)))).toBeLessThan(1e-7)
      expect(station.buildingPolygon).toHaveLength(4)
      expect(station.platformPolygons).toHaveLength(2)
      const acquired = result.stationGrounds.find(ground => ground.id === `station-trackground-${index}`)!
      for (const polygon of station.platformPolygons!) expect(subtractRegions({ polygon }, [acquired]).reduce((sum, region) => sum + regionArea(region), 0)).toBeLessThan(.01)
      expect(pointInPolygon(station.entrance!, station.buildingPolygon!)).toBe(false)
      expect(pointInPolygon(station.entrance!, result.stationGrounds[index]!.polygon)).toBe(true)
      expect(pointInPolygon(result.accessTargets[index]!.point, result.stationGrounds[index]!.polygon)).toBe(false)
      expect(result.stationPaths[index]!.points).toEqual([result.accessTargets[index]!.point, station.entrance!])
      expect(result.accessTargets[index]!.builtYear).toBe(station.builtYear)
      expect(result.accessTargets[index]!.endHeading).toBeCloseTo(Math.atan2(station.entrance!.y - result.accessTargets[index]!.point.y, station.entrance!.x - result.accessTargets[index]!.point.x), 12)
      expect(station.buildingPolygon!.every(p => pointInPolygon(p, result.stationGrounds[index]!.polygon))).toBe(true)
      expect(result.stationGrounds[index]!.polygon.every(p => !input.terrain.waterAt(p) && input.terrain.slope(p) <= .12)).toBe(true)
    }
    expect(result.stations[0]!.name).not.toBe(result.stations[1]!.name)
  }, 15_000)

  it('acquires different real main and neighbourhood station scales and does not occupy a small off-track water patch', () => {
    const input = fixture(); input.config.settlement = 'metropolis'
    const first = surveyLayoutFirstRail(input), main = first.stations.find(station => station.name === '試験駅')!, local = first.stations.find(station => station !== main)!
    const edges = (polygon: { x: number; y: number }[]) => polygon.map((p, i) => distance(p, polygon[(i + 1) % polygon.length]!))
    expect(Math.max(...edges(main.buildingPolygon!))).toBeCloseTo(84)
    expect(Math.min(...edges(main.buildingPolygon!))).toBeCloseTo(24)
    expect(Math.max(...edges(local.buildingPolygon!))).toBeCloseTo(42)
    const edgeLength = (polygon: { x: number; y: number }[]) => polygon.slice(1, polygon.length / 2).reduce((n, p, i) => n + distance(p, polygon[i]!), 0)
    expect(edgeLength(main.platformPolygons![0]!)).toBeGreaterThan(208)
    expect(edgeLength(local.platformPolygons![0]!)).toBeGreaterThan(150)
    const platform = main.platformPolygons![0]!, p = platform[3]!, q = platform[4]!, far = platform.at(-4)!
    const wet = { id: 'narrow-off-track-water', kind: 'water' as const, polygon: rectangle((p.x + q.x + far.x) / 3 - .5, (p.y + q.y + far.y) / 3 - .5, 1, 1) }
    input.terrain = { ...input.terrain, areas: [wet], waterAt: point => pointInPolygon(point, wet.polygon) }
    const revised = surveyLayoutFirstRail(input)
    expect(revised.stations).toHaveLength(2)
    expect(revised.stations.every(station => station.platformPolygons!.every(polygon => !polygonOverlapsRegion(polygon, wet)))).toBe(true)
    expect(revised.stationGrounds.every(ground => !polygonOverlapsRegion(ground.polygon, wet))).toBe(true)
  }, 15_000)

  it('keeps reserved civic land clear and never disguises an impossible all-water region as a railway', () => {
    const input = fixture(); input.config.stations = 1
    input.reserves = [{ polygon: rectangle(700, 600, 200, 400) }]
    const result = surveyLayoutFirstRail(input)
    expect(result.railways).toHaveLength(1)
    expect(result.stations).toHaveLength(1)
    expect(result.stationGrounds.every(area => !polygonOverlapsRegion(area.polygon, input.reserves[0]!))).toBe(true)
    for (const point of result.railways[0]!.points) expect(pointInPolygon(point, input.reserves[0]!.polygon)).toBe(false)
    input.terrain.areas = [{ id: 'sea', kind: 'water', polygon: rectangle(0, 0, input.width, input.height) }]
    input.terrain.waterAt = () => true
    const rejected = surveyLayoutFirstRail(input)
    expect(rejected.railways).toEqual([])
    expect(rejected.stations).toEqual([])
    expect(rejected.diagnostics.reason).toBeTruthy()
  }, 15_000)

  it('retains the surveyed bridge profile when a confined valley must cross a river', () => {
    const input = fixture(); input.config.stations = 1
    input.center = { x: 1200, y: 600 }; input.zones = [{ ...input.zones[0]!, center: input.center }]
    input.terrain.areas = [
      { id: 'sea-west', kind: 'water', polygon: rectangle(0, 0, 500, 1800) },
      { id: 'sea-east', kind: 'water', polygon: rectangle(1900, 0, 500, 1800) },
      { id: 'river', kind: 'water', polygon: rectangle(500, 860, 1400, 80) },
    ]
    input.terrain.waterAt = p => p.x < 500 || p.x > 1900 || p.y > 860 && p.y < 940
    input.terrain.elevation = p => input.terrain.waterAt(p) ? 15 : 20
    const result = surveyLayoutFirstRail(input)
    expect(result.railways).toHaveLength(1)
    const line = result.railways[0]!, bridge = line.structures!.find(s => s.kind === 'bridge')!
    expect(bridge).toBeDefined()
    expect(input.terrain.waterAt(bridge.from)).toBe(false)
    expect(input.terrain.waterAt(bridge.to)).toBe(false)
    expect(bridge.length).toBeLessThanOrEqual(180)
    for (const [i, point] of line.points.entries()) if (input.terrain.waterAt(point)) expect(line.elevations![i]!).toBeGreaterThanOrEqual(18)
    expect(result.stationGrounds.every(ground => ground.polygon.every(p => !input.terrain.waterAt(p)))).toBe(true)
  }, 15_000)

  // Coastal station facing/exact dated public-gate checks share the existing
  // full coastal city fixture in layout-first-generator.test.ts. Rail-only
  // engineering/forecourt/water/bridge assertions above remain independent.
})
