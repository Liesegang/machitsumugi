import { describe, expect, it } from 'vitest'
import { civicRepairReport, hospitalRepairReport, reserveLayoutFirstCivics, resurveyLayoutFirstCivic, resurveyLayoutFirstHospital } from './layout-first-civic'
import type { LayoutFirstCivicInput } from './layout-first-civic'
import { corridorPolygon, distance, distanceToSegment, pointInPolygon, pointInRegion, polygonOverlapsRegion, rectangle, subtractRegions } from './geometry'
import type { Railway, Road } from './types'
import { materializeRoadJunctions } from './road-graph'
import { certifyLayoutAccess } from './layout-first-access'

function fixture(): LayoutFirstCivicInput {
  return { config: { name: '試験市', seed: 'layout-civic-fixture', type: 'post', terrain: 'plain', density: 65, forest: 100, railway: false, stations: 1, arterial: true, facilities: ['university', 'school', 'hospital', 'police', 'park', 'shrine', 'onsen', 'shop'] },
    width: 4000, height: 3000, center: { x: 2000, y: 1500 },
    zones: [{ id: 'old-town', kind: 'historic', center: { x: 2000, y: 1500 }, radius: 1100, polygon: rectangle(800, 400, 2400, 2200), builtYear: 1750, density: .8, maximumFloors: 3 }],
    terrain: { areas: [{ id: 'forest', kind: 'forest', polygon: rectangle(0, 0, 4000, 3000) }], elevation: () => 20, slope: () => 0, waterAt: () => false } }
}

describe('layout-first civic reservations', () => {
  it('reserves the whole selected programme in woodland, with real campus buildings and public gates', () => {
    const input = fixture(), result = reserveLayoutFirstCivics(input)
    expect(result.unplacedFacilities).toEqual([])
    expect([...new Set(result.facilities.map(f => f.kind))].sort()).toEqual(input.config.facilities.filter(kind => kind !== 'shop').sort())
    expect(result.facilities.some(f => f.kind === 'shop')).toBe(false)
    expect(result.buildings.filter(b => b.id.startsWith('facility-building-university-'))).toHaveLength(7)
    expect(result.buildings.filter(b => b.use === 'lodging')).toHaveLength(4)
    expect(result.buildings.some(b => b.id.startsWith('facility-building-school-') && b.polygon.length > 4)).toBe(true)
    expect(result.buildings.some(b => b.id.startsWith('facility-building-hospital-') && b.polygon.length > 4)).toBe(true)
    for (const [i, reserve] of result.reserves.entries()) expect(result.reserves.slice(i + 1).some(other => polygonOverlapsRegion(reserve.polygon, other))).toBe(false)
    for (const target of result.accessTargets) expect(result.reserves.some(reserve => pointInRegion(target.point, reserve))).toBe(false)
    for (const building of result.buildings) expect(result.reserves.some(reserve => building.polygon.every(p => pointInPolygon(p, reserve.polygon)))).toBe(true)
    expect(result.roads.every(road => road.points.length >= 2 && road.builtYear !== undefined)).toBe(true)
  })

  it('does not create facilities or paths on a flooded region and leaves unselected castles absent', () => {
    const input = fixture(); input.config.facilities = ['school', 'university', 'park']
    input.terrain.waterAt = () => true
    input.terrain.areas = [{ id: 'sea', kind: 'water', polygon: rectangle(0, 0, input.width, input.height) }]
    const result = reserveLayoutFirstCivics(input)
    expect(result.facilities).toEqual([])
    expect(result.buildings).toEqual([])
    expect(result.roads).toEqual([])
    expect(result.unplacedFacilities.map(item => item.kind).sort()).toEqual(input.config.facilities.sort())
    expect(result.areas.some(area => area.id.startsWith('castle-'))).toBe(false)
  })

  it('uses the existing multi-compound irregular castle with a separate dry outer-gate approach', () => {
    const input = fixture(); input.config.facilities = ['castle']
    const result = reserveLayoutFirstCivics(input)
    expect(result.unplacedFacilities).toEqual([])
    expect(result.facilities).toHaveLength(1)
    expect(result.reserves[0]!.polygon.length).toBeGreaterThan(12)
    expect(result.areas.filter(area => ['castle-courtyard-honmaru', 'castle-courtyard-ninomaru', 'castle-courtyard-sannomaru'].includes(area.id))).toHaveLength(3)
    expect(result.areas.some(area => area.id.startsWith('castle-courtyard-connecting-'))).toBe(true)
    expect(result.buildings.some(b => b.id === 'castle-keep')).toBe(true)
    expect(pointInRegion(result.accessTargets[0]!.point, result.reserves[0]!)).toBe(false)
    for (const region of result.areas) expect(subtractRegions(region, result.reserves)).toEqual([])
  }, 5000)

  it('accepts an existing low dry shore without manufacturing reclaimed water or seabed buildings', () => {
    const input = fixture(); input.config.facilities = ['port']; input.config.terrain = 'coast'
    input.terrain.areas = [{ id: 'sea', kind: 'water', polygon: rectangle(0, 2300, 4000, 700) }]
    input.terrain.waterAt = p => p.y > 2300
    input.terrain.elevation = p => p.y > 2300 ? -3 : 2
    const result = reserveLayoutFirstCivics(input)
    expect(result.unplacedFacilities).toEqual([])
    expect(result.facilities[0]!.kind).toBe('port')
    expect(result.buildings).toHaveLength(2)
    expect(result.reserves.every(reserve => reserve.polygon.every(p => !input.terrain.waterAt(p)))).toBe(true)
    expect(result.areas.some(area => area.kind === 'water')).toBe(false)
  })

  it('chooses a nearby shore independently of a coastline contour’s starting vertex and winding', () => {
    const input = fixture(); input.config.facilities = ['port']; input.config.terrain = 'coast'
    input.center = { x: 480, y: 1800 }; input.zones = [{ ...input.zones[0]!, center: input.center, radius: 700 }]
    const sea = rectangle(0, 2300, 4000, 700)
    input.terrain.areas = [{ id: 'sea', kind: 'water', polygon: [...sea.slice(2), ...sea.slice(0, 2)] }]
    input.terrain.waterAt = p => p.y > 2300
    input.terrain.elevation = p => p.y > 2300 ? -3 : 2
    const first = reserveLayoutFirstCivics(input)
    expect(first.unplacedFacilities).toEqual([])
    expect(distance(first.facilities[0]!.point, input.center)).toBeLessThan(600)
    input.terrain.areas[0]!.polygon = sea.toReversed()
    const reversed = reserveLayoutFirstCivics(input)
    expect(distance(first.facilities[0]!.point, reversed.facilities[0]!.point)).toBeLessThan(1e-7)
  })

  it('distributes a bounded park programme inside urban zones and records optional sites for safe access rejection', () => {
    const input = fixture(); input.config.facilities = ['park']; input.config.settlement = 'metropolis'; input.config.density = 100
    input.zones = [1000, 1800, 2600].flatMap((x, ix) => [900, 1800].map((y, iy) => ({ ...input.zones[0]!, id: `urban-${ix}-${iy}`, center: { x, y }, radius: 350, polygon: rectangle(x - 350, y - 350, 700, 700), kind: 'residential' as const, builtYear: 1955 + ix * 20 })))
    const result = reserveLayoutFirstCivics(input), parks = result.facilities.filter(facility => facility.kind === 'park')
    expect(result.unplacedFacilities).toEqual([])
    expect(parks.length).toBeGreaterThanOrEqual(4)
    expect(parks.length).toBeLessThanOrEqual(6)
    expect(result.buildings).toEqual([])
    expect(result.optionalProgrammes).toHaveLength(parks.length - 1)
    expect(result.optionalAccessIds).toEqual(result.optionalProgrammes.map(programme => programme.accessId))
    for (const programme of result.optionalProgrammes) {
      const park = result.facilities.find(facility => facility.id === programme.facilityId)!
      expect(input.zones.some(zone => pointInRegion(park.point, zone))).toBe(true)
      expect(result.accessTargets.find(target => target.id === programme.accessId)!.builtYear).toBe(1955)
      expect(programme.areaIds.every(id => result.areas.some(area => area.id === id && area.kind === 'park'))).toBe(true)
      expect(programme.roadIds).toHaveLength(2)
      expect(programme.roadIds.every(id => result.roads.some(road => road.id === id))).toBe(true)
      expect(programme.reserves.every(region => result.reserves.includes(region))).toBe(true)
    }
    const single = reserveLayoutFirstCivics({ ...input, config: { ...input.config, settlement: 'village' } })
    expect(single.facilities.filter(facility => facility.kind === 'park')).toHaveLength(1)
    expect(single.facilities[0]).toEqual(parks[0])
    expect(single.optionalProgrammes).toEqual([])
  })

  it('surveys opposite hospital entrances and faces the established town rather than a future remote district', () => {
    const input = fixture(); input.config.facilities = ['hospital']
    const first = reserveLayoutFirstCivics(input), hospital = first.facilities[0]!, gate = first.accessTargets[0]!
    expect(first.unplacedFacilities).toEqual([])
    expect((gate.point.x - hospital.point.x) * (input.center.x - hospital.point.x) + (gate.point.y - hospital.point.y) * (input.center.y - hospital.point.y)).toBeGreaterThan(0)
    // A later residential brief cannot lend its future approach to a1920 hospital.
    input.zones = [...input.zones, { ...input.zones[0]!, id: 'future', builtYear: 1995, center: { x: hospital.point.x + (hospital.point.x - input.center.x) * .05, y: hospital.point.y + (hospital.point.y - input.center.y) * .05 } }]
    const withFuture = reserveLayoutFirstCivics(input)
    expect(withFuture.facilities[0]!.point).toEqual(hospital.point)
    expect(withFuture.accessTargets[0]!.point).toEqual(gate.point)
  })

  it('repairs only the hospital beside an actually open public road, preserving other adopted programmes and all transport ground', () => {
    const input = fixture(); input.config.facilities = ['hospital', 'shrine', 'park']
    const previous = reserveLayoutFirstCivics(input), unchanged = JSON.stringify(previous)
    const roads: Road[] = [
      { id: 'historic-regional-road', points: [{ x: -100, y: 1500 }, { x: 4100, y: 1500 }], width: 12, kind: 'arterial', builtYear: 1650, boundaryContinuation: true },
      { id: 'future-road', points: [{ x: 1650, y: 0 }, { x: 1650, y: 3000 }], width: 20, kind: 'local', builtYear: 1995 },
    ]
    const railways: Railway[] = [{ id: 'rail', name: '本線', points: [{ x: 2150, y: 0 }, { x: 2150, y: 3000 }] }]
    const result = resurveyLayoutFirstHospital(input, previous, roads, railways)
    expect(result).not.toBe(previous)
    expect(JSON.stringify(previous)).toBe(unchanged)
    for (const facility of previous.facilities.filter(facility => facility.kind !== 'hospital')) expect(result.facilities.find(current => current.id === facility.id)).toBe(facility)
    for (const area of previous.areas.filter(area => !area.id.startsWith('facility-lot-hospital'))) expect(result.areas.find(current => current.id === area.id)).toBe(area)
    const hospital = result.facilities.find(facility => facility.kind === 'hospital')!
    expect(hospital.point).not.toEqual(previous.facilities.find(facility => facility.kind === 'hospital')!.point)
    const hospitalGround = result.areas.find(area => area.id === 'facility-lot-hospital')!
    for (const road of roads) expect(polygonOverlapsRegion(hospitalGround.polygon, { polygon: corridorPolygon(road.points[0]!, road.points[1]!, road.width / 2 + .75) })).toBe(false)
    expect(polygonOverlapsRegion(hospitalGround.polygon, { polygon: corridorPolygon(railways[0]!.points[0]!, railways[0]!.points[1]!, 10.5) })).toBe(false)
    const approach = result.roads.find(road => road.id === 'facility-access-hospital-public')!
    expect(approach.builtYear).toBe(1920)
    expect(distance(approach.points[0]!, approach.points[1]!)).toBeLessThanOrEqual(30 + 1e-6)
    expect(distanceToSegment(approach.points[0]!, roads[0]!.points[0]!, roads[0]!.points[1]!)).toBeLessThan(1e-7)
    const certificate = certifyLayoutAccess({ width: input.width, height: input.height, roads: materializeRoadJunctions([...roads, ...result.roads]), targets: result.accessTargets.filter(target => target.id === 'facility-access-hospital') })
    expect(certificate.unserved).toEqual([])
    expect(result.buildings.find(building => building.id === 'facility-building-hospital-0')!.polygon.length).toBeGreaterThan(4)
    const stationGround = { polygon: hospitalGround.polygon }, awayFromStation = resurveyLayoutFirstHospital(input, previous, roads, railways, [stationGround])
    expect(awayFromStation).not.toBe(previous)
    expect(polygonOverlapsRegion(awayFromStation.areas.find(area => area.id === 'facility-lot-hospital')!.polygon, stationGround)).toBe(false)
  })

  it('cannot borrow an isolated or future road for a1920 hospital repair', () => {
    const input = fixture(); input.config.facilities = ['hospital']
    const previous = reserveLayoutFirstCivics(input)
    const isolated: Road = { id: 'isolated', points: [{ x: 100, y: 1500 }, { x: 3900, y: 1500 }], width: 8, kind: 'local', builtYear: 1650 }
    const future: Road = { ...isolated, id: 'future-external', points: [{ x: -100, y: 1800 }, { x: 4100, y: 1800 }], builtYear: 1955, boundaryContinuation: true }
    expect(resurveyLayoutFirstHospital(input, previous, [isolated, future])).toBe(previous)
  })

  it('discards a dense centre grid before spending the bounded hospital site-survey budget', () => {
    const input = fixture(); input.config.facilities = ['hospital']
    const previous = reserveLayoutFirstCivics(input)
    const xs = Array.from({ length: 26 }, (_, i) => 1000 + i * 80), ys = [...Array.from({ length: 16 }, (_, i) => 900 + i * 80), 1500].sort((a, b) => a - b)
    const roads: Road[] = [{ id: 'external', points: [-100, ...xs, 4100].map(x => ({ x, y: 1500 })), width: 12, kind: 'arterial', builtYear: 1650, boundaryContinuation: true }]
    for (const x of xs) roads.push({ id: `north-south-${x}`, points: ys.map(y => ({ x, y })), width: 6, kind: 'local', builtYear: 1750 })
    for (const y of ys) if (y !== 1500) roads.push({ id: `east-west-${y}`, points: xs.map(x => ({ x, y })), width: 6, kind: 'local', builtYear: 1750 })
    const result = resurveyLayoutFirstHospital(input, previous, roads), report = hospitalRepairReport(result)!
    expect(result).not.toBe(previous)
    expect(report.examinedSites).toBeGreaterThan(40)
    expect(report.rejected['prefilter-campus-transport']).toBeGreaterThan(40)
    expect(report.attemptedSites).toBeLessThanOrEqual(40)
    const campus = result.areas.find(area => area.id === 'facility-lot-hospital')!
    for (const road of roads) expect(polygonOverlapsRegion(campus.polygon, { polygon: corridorPolygon(road.points[0]!, road.points.at(-1)!, road.width / 2 + .75) })).toBe(false)
    const certificate = certifyLayoutAccess({ width: input.width, height: input.height, roads: materializeRoadJunctions([...roads, ...result.roads]), targets: result.accessTargets })
    expect(certificate.unserved).toEqual([])
  })

  it.each(['school', 'university', 'police', 'shrine', 'onsen'] as const)('reacquires a complete same-era %s beside a certified public road without changing other civics', kind => {
    const input = fixture(); input.config.facilities = [kind, 'hospital']
    const previous = reserveLayoutFirstCivics(input), before = JSON.stringify(previous)
    const roads: Road[] = [{ id: 'open-regional', points: [{ x: -100, y: 1500 }, { x: 4100, y: 1500 }], width: 12, kind: 'arterial', builtYear: 1650, boundaryContinuation: true }]
    const roadBefore = JSON.stringify(roads), targetId = `facility-access-${kind}`, opening = previous.accessTargets.find(target => target.id === targetId)!.builtYear
    const result = resurveyLayoutFirstCivic(input, previous, roads, targetId)
    expect(result).not.toBe(previous)
    expect(JSON.stringify(previous)).toBe(before)
    expect(JSON.stringify(roads)).toBe(roadBefore)
    for (const facility of previous.facilities.filter(facility => facility.kind !== kind)) expect(result.facilities.find(current => current.id === facility.id)).toBe(facility)
    for (const area of previous.areas.filter(area => !area.id.startsWith(`facility-lot-${kind}`))) expect(result.areas.find(current => current.id === area.id)).toBe(area)
    const target = result.accessTargets.find(target => target.id === targetId)!, approach = result.roads.find(road => road.id === `${targetId}-public`)!, campus = result.areas.find(area => area.id === `facility-lot-${kind}`)!
    expect(target.builtYear).toBe(opening)
    expect(approach.builtYear).toBe(opening)
    expect(approach.points.at(-1)).toEqual(target.point)
    expect(distanceToSegment(approach.points[0]!, roads[0]!.points[0]!, roads[0]!.points[1]!)).toBeLessThan(1e-7)
    expect(polygonOverlapsRegion(campus.polygon, { polygon: corridorPolygon(roads[0]!.points[0]!, roads[0]!.points[1]!, 6.75) })).toBe(false)
    for (const building of result.buildings.filter(building => building.id.startsWith(`facility-building-${kind}-`))) expect(building.polygon.every(p => pointInRegion(p, campus))).toBe(true)
    expect(certifyLayoutAccess({ width: input.width, height: input.height, roads: materializeRoadJunctions([...roads, ...result.roads]), targets: [target] }).unserved).toEqual([])
    expect(civicRepairReport(result, targetId)!.attemptedSites).toBeLessThanOrEqual(40)
    expect(civicRepairReport(result, targetId)!.adopted).toEqual(result.facilities.find(facility => facility.kind === kind)!.point)
    if (kind === 'university') expect(result.buildings.filter(building => building.id.startsWith('facility-building-university-')).length).toBeGreaterThanOrEqual(4)
    if (kind === 'onsen') expect(result.buildings.filter(building => building.use === 'lodging')).toHaveLength(4)
  })

  it.each(['park', 'facility-access-park-2'])('reacquires only %s and preserves every other primary/satellite park', selector => {
    const input = fixture(); input.config.facilities = ['park']; input.config.settlement = 'metropolis'; input.config.density = 100
    input.zones = [1000, 1800, 2600].flatMap((x, ix) => [900, 1800].map((y, iy) => ({ ...input.zones[0]!, id: `urban-${ix}-${iy}`, center: { x, y }, radius: 350, polygon: rectangle(x - 350, y - 350, 700, 700), kind: 'residential' as const, builtYear: 1955 + ix * 20 })))
    const previous = reserveLayoutFirstCivics(input), before = JSON.stringify(previous), accessId = selector === 'park' ? 'facility-access-park' : selector, facilityId = accessId.replace('facility-access-', 'facility-')
    expect(previous.facilities.some(facility => facility.id === facilityId)).toBe(true)
    const roads: Road[] = [{ id: 'open-regional', points: [{ x: -100, y: 1500 }, { x: 4100, y: 1500 }], width: 12, kind: 'arterial', builtYear: 1650, boundaryContinuation: true }]
    const result = resurveyLayoutFirstCivic(input, previous, roads, selector)
    expect(result).not.toBe(previous)
    expect(JSON.stringify(previous)).toBe(before)
    expect(result.facilities).toHaveLength(previous.facilities.length)
    for (const facility of previous.facilities.filter(facility => facility.id !== facilityId)) expect(result.facilities.find(current => current.id === facility.id)).toBe(facility)
    for (const programme of previous.optionalProgrammes.filter(programme => programme.accessId !== accessId)) {
      expect(result.optionalProgrammes.find(current => current.accessId === programme.accessId)).toBe(programme)
      for (const id of programme.areaIds) expect(result.areas.find(area => area.id === id)).toBe(previous.areas.find(area => area.id === id))
      for (const reserve of programme.reserves) expect(result.reserves).toContain(reserve)
    }
    const target = result.accessTargets.find(target => target.id === accessId)!
    expect(certifyLayoutAccess({ width: input.width, height: input.height, roads: materializeRoadJunctions([...roads, ...result.roads]), targets: [target] }).unserved).toEqual([])
    if (selector !== 'park') {
      const programme = result.optionalProgrammes.find(programme => programme.accessId === accessId)!
      expect(programme.roadIds).toContain(`${accessId}-public`)
      const bounds = programme.reserves[0]!.polygon
      expect(distance(bounds[0]!, bounds[1]!)).toBeLessThanOrEqual(64)
      expect(distance(bounds[1]!, bounds[2]!)).toBeLessThanOrEqual(54)
    }
  })

  it('uses dry ground on a bridge-bearing public road without placing a new institution or approach on its actual span', () => {
    const input = fixture(); input.config.facilities = ['school']
    const river = { id: 'river', kind: 'water' as const, polygon: rectangle(480, 0, 40, 3000) }
    input.terrain.areas = [river]; input.terrain.waterAt = p => pointInRegion(p, river)
    const previous = reserveLayoutFirstCivics(input), roads: Road[] = [{ id: 'bridged-regional', points: [{ x: -100, y: 1500 }, { x: 448, y: 1500 }, { x: 552, y: 1500 }, { x: 4100, y: 1500 }], width: 12, kind: 'arterial', builtYear: 1650, boundaryContinuation: true, bridge: true, surveyedBridgeSpans: [{ bankA: { x: 448, y: 1500 }, bankB: { x: 552, y: 1500 }, riverId: 'river' }] }]
    const result = resurveyLayoutFirstCivic(input, previous, roads, 'school')
    expect(result).not.toBe(previous)
    for (const reserve of result.reserves) expect(polygonOverlapsRegion(reserve.polygon, river)).toBe(false)
    for (const road of result.roads) for (let i = 1; i < road.points.length; i++) expect(polygonOverlapsRegion(corridorPolygon(road.points[i - 1]!, road.points[i]!, road.width / 2), river)).toBe(false)
    expect(certifyLayoutAccess({ width: input.width, height: input.height, roads: materializeRoadJunctions([...roads, ...result.roads]), targets: result.accessTargets }).unserved).toEqual([])
  })

  it('leaves the old programme intact when same-era outside access or unprotected ground cannot be acquired', () => {
    const input = fixture(); input.config.facilities = ['school', 'shrine']
    const previous = reserveLayoutFirstCivics(input), before = JSON.stringify(previous), isolated: Road = { id: 'old-isolated', points: [{ x: 100, y: 1500 }, { x: 3900, y: 1500 }], width: 8, kind: 'local', builtYear: 1650 }
    const future: Road = { ...isolated, id: 'future-external', points: [{ x: -100, y: 1800 }, { x: 4100, y: 1800 }], builtYear: 1995, boundaryContinuation: true }
    expect(resurveyLayoutFirstCivic(input, previous, [isolated, future], 'school')).toBe(previous)
    expect(civicRepairReport(previous, 'school')!.connectedAnchors).toBe(0)
    const publicRoad = { ...future, builtYear: 1650 }
    expect(resurveyLayoutFirstCivic(input, previous, [publicRoad], 'shrine', [], [{ polygon: rectangle(0, 0, 4000, 3000) }])).toBe(previous)
    expect(civicRepairReport(previous, 'shrine')!.adopted).toBeUndefined()
    expect(JSON.stringify(previous)).toBe(before)
  })

  it('does not replace a historical castle with an ordinary civic template', () => {
    const input = fixture(); input.config.facilities = ['castle']
    const previous = reserveLayoutFirstCivics(input), before = JSON.stringify(previous)
    expect(resurveyLayoutFirstCivic(input, previous, [], 'castle')).toBe(previous)
    expect(JSON.stringify(previous)).toBe(before)
    expect(civicRepairReport(previous, 'castle')!.reason).toBeTruthy()
  })

  it('reacquires a port on the real low shoreline with its market, quayside and same-era dry public approach', () => {
    const input = fixture(); input.config.facilities = ['port', 'school']; input.config.terrain = 'coast'
    input.terrain.areas = [{ id: 'sea', kind: 'water', polygon: rectangle(0, 2300, 4000, 700) }]
    input.terrain.waterAt = p => p.y > 2300; input.terrain.elevation = p => p.y > 2300 ? -3 : 2
    const previous = reserveLayoutFirstCivics(input), unchanged = JSON.stringify(previous), waterBefore = JSON.stringify(input.terrain.areas)
    const roads: Road[] = [{ id: 'old-coastal-road', points: [{ x: -100, y: 2100 }, { x: 4100, y: 2100 }], width: 12, kind: 'arterial', builtYear: 1650, boundaryContinuation: true }]
    const oldRoads = JSON.stringify(roads), result = resurveyLayoutFirstCivic(input, previous, roads, 'port')
    expect(result).not.toBe(previous)
    expect(JSON.stringify(previous)).toBe(unchanged)
    expect(JSON.stringify(roads)).toBe(oldRoads)
    expect(JSON.stringify(input.terrain.areas)).toBe(waterBefore)
    expect(result.facilities.find(facility => facility.kind === 'school')).toBe(previous.facilities.find(facility => facility.kind === 'school'))
    const port = result.facilities.find(facility => facility.kind === 'port')!, target = result.accessTargets.find(target => target.id === 'facility-access-port')!, approach = result.roads.find(road => road.id === 'facility-access-port-public')!
    expect(port.point.y).toBeCloseTo(2252)
    expect(result.buildings.filter(building => building.id.startsWith('facility-building-port-'))).toHaveLength(2)
    expect(result.areas.some(area => area.name === '岸壁荷捌き場')).toBe(true)
    expect(result.areas.some(area => area.kind === 'water')).toBe(false)
    expect(target.builtYear).toBe(1920)
    expect(approach.builtYear).toBe(1920)
    expect(distance(approach.points[0]!, approach.points.at(-1)!)).toBeLessThanOrEqual(400)
    for (const road of result.roads.filter(road => road.id.startsWith('facility-access-port'))) for (let i = 1; i < road.points.length; i++) expect(polygonOverlapsRegion(corridorPolygon(road.points[i - 1]!, road.points[i]!, road.width / 2), input.terrain.areas[0]!)).toBe(false)
    for (const building of result.buildings.filter(building => building.id.startsWith('facility-building-port'))) expect(polygonOverlapsRegion(building.polygon, input.terrain.areas[0]!)).toBe(false)
    expect(certifyLayoutAccess({ width: input.width, height: input.height, roads: materializeRoadJunctions([...roads, ...result.roads]), targets: [target] }).unserved).toEqual([])
    expect(civicRepairReport(result, 'port')!.attemptedSites).toBeLessThanOrEqual(40)
  })

  it('does not borrow a future coastal road or manufacture a low shore when a real port cannot be reacquired', () => {
    const input = fixture(); input.config.facilities = ['port']; input.config.terrain = 'coast'
    input.terrain.areas = [{ id: 'sea', kind: 'water', polygon: rectangle(0, 2300, 4000, 700) }]
    input.terrain.waterAt = p => p.y > 2300; input.terrain.elevation = p => p.y > 2300 ? -3 : 2
    const previous = reserveLayoutFirstCivics(input), unchanged = JSON.stringify(previous), road: Road = { id: 'future-coastal-road', points: [{ x: -100, y: 2100 }, { x: 4100, y: 2100 }], width: 12, kind: 'arterial', builtYear: 1995, boundaryContinuation: true }
    expect(resurveyLayoutFirstCivic(input, previous, [road], 'port')).toBe(previous)
    expect(civicRepairReport(previous, 'port')!.connectedAnchors).toBe(0)
    const oldRoad = { ...road, builtYear: 1650 }
    expect(resurveyLayoutFirstCivic(input, previous, [oldRoad], 'port', [], [{ polygon: rectangle(0, 2000, 4000, 300) }])).toBe(previous)
    input.terrain.elevation = p => p.y > 2300 ? -3 : 100
    expect(resurveyLayoutFirstCivic(input, previous, [oldRoad], 'port')).toBe(previous)
    expect(JSON.stringify(previous)).toBe(unchanged)
    expect(road.builtYear).toBe(1995)
  })
})
