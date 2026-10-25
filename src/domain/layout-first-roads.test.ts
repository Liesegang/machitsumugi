import { describe, expect, it } from 'vitest'
import { buildLayoutFirstRoads, layoutNearEdgeExitAnchors } from './layout-first-roads'
import type { Road } from './types'
import type { LayoutFirstZone } from './layout-first-types'
import type { PlanningEnvironment } from './road-planner'
import { corridorPolygon, distanceToSegment, polygonArea, pointInPolygon, polygonOverlapsRegion, rectangle } from './geometry'
import { roadLength } from './road-graph'
import { RailwayRoadConstraints } from './railway-road-constraints'

function flatEnvironment(width = 1800, height = 1400): PlanningEnvironment {
  const terrain = { elevation: () => 12, slope: () => 0, waterAt: () => false, seaAt: () => false }
  return { width, height, areas: [], core: null, terrain: { ...terrain, bridgeSites: [], continuationTerrain: terrain } }
}
function zone(center = { x: 900, y: 700 }, radius = 480): LayoutFirstZone {
  return { id: 'town', center, radius, kind: 'residential', builtYear: 1920, density: .8, maximumFloors: 4, angle: .12, polygon: rectangle(center.x - radius, center.y - radius, radius * 2, radius * 2) }
}

describe('layout-first public street design', () => {
  it('connects surveyed external roads and closes residential blocks without a growth loop', () => {
    const result = buildLayoutFirstRoads({ environment: flatEnvironment(), seed: 'same-spatial-brief', center: { x: 900, y: 700 }, zones: [zone()] })
    expect(result.diagnostics.boundaryConnections).toBe(4)
    expect(result.roads.filter(r => r.boundaryContinuation).every(r => r.points.some(p => p.x < 0 || p.x > 1800 || p.y < 0 || p.y > 1400))).toBe(true)
    expect(result.roads.length).toBeGreaterThan(80)
    expect(result.blocks.length).toBeGreaterThan(30)
    const livingBlocks = result.blocks.filter(p => polygonArea(p) < 25000 && polygonArea(p) > 2500)
    expect(livingBlocks.length).toBeGreaterThan(25)
    expect(result.diagnostics.unservedZoneIds).toEqual([])
    expect(result.roads.every(road => Number.isFinite(result.graph.accessibilityFrom(result.center)(road.points.at(-1)!)))).toBe(true)
    expect(result.diagnostics.attempted).toBeLessThan(350)
  })

  it('reserves full civic grounds and connects their outside gate before building parcels', () => {
    const environment = flatEnvironment(), campus = { polygon: rectangle(1050, 610, 170, 160) }, gate = { x: 1040, y: 690 }
    const result = buildLayoutFirstRoads({ environment, seed: 'campus-first', center: { x: 800, y: 700 }, zones: [zone()], reservedRegions: [campus], accessTargets: [{ id: 'university', point: gate, builtYear: 1960 }] })
    expect(result.diagnostics.unservedAccessIds).toEqual([])
    expect(result.graph.nearest(gate, 3)).not.toBeNull()
    expect(result.roads.every(road => road.points.every(point => !pointInPolygon(point, campus.polygon)))).toBe(true)
  })

  it('surveys both shoulders around a rotated compound before accepting its public approach', () => {
    const environment = flatEnvironment(1800, 1400)
    const campus = { polygon: [{ x: 818, y: 441 }, { x: 898, y: 381 }, { x: 964, y: 469 }, { x: 885, y: 529 }] }
    environment.exactLandCost = true
    environment.landCost = p => pointInPolygon(p, campus.polygon) ? Infinity : 0
    const gate = { x: 854.5, y: 406.3 }
    const result = buildLayoutFirstRoads({ environment, seed: 'rotated-civic-right-of-way', center: { x: 1091, y: 950 }, zones: [zone({ x: 1091, y: 950 }, 250)], reservedRegions: [campus], accessTargets: [{ id: 'shrine', point: gate, builtYear: 1650 }] })
    expect(result.diagnostics.unservedAccessIds).toEqual([])
    const approaches = result.roads.filter(road => road.role === 'access')
    expect(approaches.length).toBeGreaterThan(0)
    for (const road of approaches) for (let i = 1; i < road.points.length; i++) {
      expect(polygonOverlapsRegion(corridorPolygon(road.points[i - 1]!, road.points[i]!, road.width / 2 + .75), campus)).toBe(false)
    }
  })

  it('serves opposite-bank districts only through the actual surveyed bridge', () => {
    const environment = flatEnvironment(1600, 1200)
    const waterAt = (p: { x: number }) => p.x >= 780 && p.x <= 820
    const bridge = { point: { x: 800, y: 600 }, bankA: { x: 752, y: 600 }, bankB: { x: 848, y: 600 }, width: 40, cost: 100 }
    environment.terrain = { ...environment.terrain!, waterAt, bridgeSites: [bridge.point], bridgeCandidates: [bridge], continuationTerrain: { ...environment.terrain!.continuationTerrain!, waterAt } }
    environment.areas = [{ id: 'river', kind: 'water', polygon: rectangle(780, 0, 40, 1200) }]
    const left = zone({ x: 500, y: 600 }, 250), right = { ...zone({ x: 1100, y: 600 }, 250), id: 'right-bank' }
    const result = buildLayoutFirstRoads({ environment, seed: 'bridge-first', center: left.center, zones: [left, right] })
    expect(result.diagnostics.bridges).toBeGreaterThan(0)
    expect(result.diagnostics.unservedZoneIds).toEqual([])
    expect(result.graph.nearest(right.center, 20)).not.toBeNull()
    for (const road of result.roads) for (const point of road.points.filter(waterAt)) {
      expect(road.bridge).toBe(true)
      expect(Math.abs(point.y - 600)).toBeLessThan(1e-6)
    }
    expect(Number.isFinite(result.graph.accessibilityFrom(left.center)(right.center))).toBe(true)
  })

  it('uses reproducible spatial phases and reports the real street length', () => {
    const input = { environment: flatEnvironment(900, 800), seed: 'phase', center: { x: 450, y: 400 }, zones: [zone({ x: 450, y: 400 }, 230)] }
    const first = buildLayoutFirstRoads(input), second = buildLayoutFirstRoads(input)
    expect(first.roads).toEqual(second.roads)
    expect(first.roads.every(r => [1650, 1920].includes(r.builtYear))).toBe(true)
    expect(first.diagnostics.streetLength).toBeCloseTo(first.roads.reduce((sum, r) => sum + roadLength(r.points), 0), 6)
  })

  it('consolidates surface-rail crossings instead of opening a gate at every block', () => {
    const railway = { id: 'main', name: '本線', points: [{ x: 940, y: 0 }, { x: 940, y: 1400 }] }
    const result = buildLayoutFirstRoads({ environment: flatEnvironment(), seed: 'few-crossing-gates', center: { x: 900, y: 700 }, zones: [zone()], railways: [railway] })
    const survey = new RailwayRoadConstraints([railway]), crossings = result.roads.flatMap(road => survey.crossings(road.points))
    const sites = crossings.filter((hit, i) => !crossings.slice(0, i).some(other => Math.hypot(other.point.x - hit.point.x, other.point.y - hit.point.y) < 2))
    expect(sites.length).toBeGreaterThan(0)
    expect(sites.length).toBeLessThan(5)
    for (let i = 0; i < sites.length; i++) for (let j = 0; j < i; j++) expect(Math.abs(sites[i]!.chainage - sites[j]!.chainage)).toBeGreaterThanOrEqual(319.9)
    expect(result.blocks.length).toBeGreaterThan(15)
  })

  it('opens civic public access against the old backbone before modern housing roads', () => {
    const gate = { x: 1160, y: 925 }, modernZone = { ...zone(), builtYear: 1995 }
    const result = buildLayoutFirstRoads({ environment: flatEnvironment(), seed: 'old-school-modern-suburb', center: { x: 900, y: 700 }, zones: [modernZone], accessTargets: [{ id: 'school', point: gate, builtYear: 1875 }] })
    expect(result.diagnostics.unservedAccessIds).toEqual([])
    const schoolRoad = result.roads.find(road => road.reason === '施設の敷地入口への公道接続')!
    expect(schoolRoad.builtYear).toBe(1875)
    const historic = result.roads.filter(road => road.builtYear <= 1875)
    const keys = new Set(historic.filter(road => road.boundaryContinuation).flatMap(road => road.points.map(p => `${p.x.toFixed(4)}:${p.y.toFixed(4)}`)))
    expect(keys.has(`${schoolRoad.points[0]!.x.toFixed(4)}:${schoolRoad.points[0]!.y.toFixed(4)}`)).toBe(true)
    expect(result.roads.some(road => road.builtYear === 1995)).toBe(true)
  })
  it('moves the primary junction off an already reserved running track', () => {
    const railway = { id: 'through-center', name: '本線', points: [{ x: 900, y: 0 }, { x: 900, y: 1400 }] }
    const result = buildLayoutFirstRoads({ environment: flatEnvironment(), seed: 'station-before-streets', center: { x: 900, y: 700 }, zones: [zone()], railways: [railway] })
    expect(Math.abs(result.center.x - 900)).toBeGreaterThanOrEqual(16.5)
    expect(result.diagnostics.boundaryConnections).toBeGreaterThanOrEqual(2)
  })

  it('keeps the historic neighbourhood on same-era streets around a reserved central compound', () => {
    const environment = flatEnvironment(), campus = { polygon: rectangle(680, 480, 440, 440) }
    environment.exactLandCost = true
    environment.landCost = p => pointInPolygon(p, campus.polygon) ? Infinity : 0
    const historic = { ...zone(), kind: 'historic' as const, builtYear: 1650 }
    const result = buildLayoutFirstRoads({ environment, seed: 'castle-surrounded-by-old-town', center: historic.center, zones: [historic], reservedRegions: [campus] })
    expect(result.diagnostics.unservedZoneIds).toEqual([])
    const neighbourhood = result.roads.filter(road => !road.boundaryContinuation)
    expect(neighbourhood.length).toBeGreaterThan(12)
    expect(neighbourhood.every(road => road.builtYear === 1650)).toBe(true)
    expect(neighbourhood.every(road => road.points.every(p => !pointInPolygon(p, campus.polygon)))).toBe(true)
  })

  it('refuses a new gate that would expose an invalid short grade in an older sampled road', () => {
    const environment = flatEnvironment(900, 800), input = { environment, seed: 'exact-junction-profile', center: { x: 450, y: 400 }, zones: [] }
    const baseline = buildLayoutFirstRoads(input), oldStreet = baseline.roads[0]!
    const i = oldStreet.points.findIndex((p, n) => n > 0 && Math.hypot(p.x - oldStreet.points[n - 1]!.x, p.y - oldStreet.points[n - 1]!.y) > 8)
    const a = oldStreet.points[i - 1]!, b = oldStreet.points[i]!, peak = { x: a.x * .97 + b.x * .03, y: a.y * .97 + b.y * .03 }
    environment.terrain = { ...environment.terrain!, elevation: p => 12 + Math.max(0, 1 - Math.hypot(p.x - peak.x, p.y - peak.y) / .05) * .25 }
    const result = buildLayoutFirstRoads({ ...input, accessTargets: [{ id: 'steep-gate', point: peak, builtYear: 1650 }] })
    expect(result.diagnostics.unservedAccessIds).toEqual(['steep-gate'])
    expect(result.roads[0]!.points.some(p => Math.hypot(p.x - peak.x, p.y - peak.y) < 1e-7)).toBe(false)
  })

  it('closes most of the urban envelope and terminates every subdivision on real perimeter streets', () => {
    const result = buildLayoutFirstRoads({ environment: flatEnvironment(), seed: 'whole-envelope', center: { x: 900, y: 700 }, zones: [zone()] })
    const area = result.blocks.reduce((sum, block) => sum + polygonArea(block), 0)
    expect(area).toBeGreaterThan(960 ** 2 * .72)
    const subdivisions = result.roads.filter(road => road.reason === '実在する周囲の道路を結んで街区を分割する生活道路')
    expect(subdivisions.length).toBeGreaterThan(30)
    for (const road of subdivisions) for (const endpoint of [road.points[0]!, road.points.at(-1)!]) {
      expect(result.roads.some(other => other !== road && other.points.slice(1).some((b, i) => distanceToSegment(endpoint, other.points[i]!, b) < 1e-6))).toBe(true)
    }
  })

  it('continues one coarse network across adjoining planning territories', () => {
    const left = { ...zone({ x: 600, y: 700 }, 400), id: 'old-bank', kind: 'historic' as const, builtYear: 1650, polygon: rectangle(200, 300, 800, 800) }
    const right = { ...zone({ x: 1300, y: 700 }, 400), id: 'postwar-bank', builtYear: 1975, polygon: rectangle(1000, 300, 700, 800) }
    const result = buildLayoutFirstRoads({ environment: flatEnvironment(2000, 1400), seed: 'one-city-many-briefs', center: left.center, zones: [left, right] })
    const crossing = result.roads.filter(road => road.reason.includes('市域') && road.points.some(p => p.x < 1000) && road.points.some(p => p.x > 1000))
    expect(crossing.length).toBeGreaterThan(1)
    expect(result.blocks.filter(block => block.some(p => p.x < 1000) && block.some(p => p.x > 1000)).length).toBeGreaterThan(2)
    expect(result.diagnostics.unservedZoneIds).toEqual([])
    expect(result.roads.every(road => Number.isFinite(result.graph.accessibilityFrom(result.center)(road.points.at(-1)!)))).toBe(true)
  })

  it('uses four-neighbour corridor families and continuous wider centre axes', () => {
    const result = buildLayoutFirstRoads({ environment: flatEnvironment(), seed: 'shared-corridor-frame', center: { x: 900, y: 700 }, zones: [zone()] })
    const corridors = result.roads.filter(road => road.reason === '市域を連続して結ぶ生活幹線' || road.reason === '市域を連続して通り抜ける広幅員の都市幹線')
    expect(corridors.length).toBeGreaterThan(12)
    for (const road of corridors) {
      const a = road.points[0]!, b = road.points.at(-1)!, angle = Math.atan2(b.y - a.y, b.x - a.x)
      // Shared rows/columns may bend slightly; diagonal triangulation cannot
      // pass this topology requirement even if it creates many closed faces.
      expect(Math.abs(Math.sin(2 * (angle - .12)))).toBeLessThan(.16)
    }
    const main = corridors.filter(road => road.role === 'highway')
    expect(main.length).toBeGreaterThan(4)
    expect(main.every(road => road.width === 14 && road.kind === 'arterial')).toBe(true)
    expect(main.reduce((sum, road) => sum + roadLength(road.points), 0)).toBeGreaterThan(1600)
    expect(corridors.some(road => road.width === 8.5 && road.role === 'collector')).toBe(true)
  })

  it('subdivides adopted enclosed urban gaps rather than leaving their whole coarse faces empty', () => {
    const left = { ...zone({ x: 450, y: 650 }, 300), id: 'west-neighbourhood', polygon: rectangle(250, 400, 400, 500) }
    const right = { ...zone({ x: 1250, y: 650 }, 300), id: 'east-neighbourhood', polygon: rectangle(1050, 400, 400, 500) }
    const zones = [left, right], original = JSON.stringify(zones)
    const result = buildLayoutFirstRoads({ environment: flatEnvironment(), seed: 'enclosed-urban-gap', center: left.center, zones, settlement: 'metropolis', density: 85 })
    const infill = result.zones.filter(zone => zone.id.startsWith('layout-infill-face-'))
    expect(infill.some(zone => zone.center.x > 650 && zone.center.x < 1050)).toBe(true)
    expect(result.blocks.filter(block => polygonArea(block) < 25000 && block.every(p => p.x > 650 && p.x < 1050)).length).toBeGreaterThan(2)
    expect(result.roads.some(road => road.role === 'lane' && road.points.every(p => p.x > 650 && p.x < 1050))).toBe(true)
    expect(JSON.stringify(zones)).toBe(original)
    expect(result.zones).not.toBe(zones)
  })

  it('selects actual near-edge public anchors for late outside surveys instead of restarting at the centre', () => {
    const roads: Road[] = [
      { id: 'old-centre', kind: 'local', width: 9, points: [{ x: 900, y: 650 }, { x: 950, y: 650 }] },
      { id: 'new-east', kind: 'local', width: 8.5, points: [{ x: 1450, y: 650 }, { x: 1740, y: 650 }] },
      { id: 'new-west', kind: 'local', width: 8.5, points: [{ x: 40, y: 600 }, { x: 400, y: 600 }] },
      { id: 'elevated', kind: 'arterial', width: 22, controlledAccess: true, points: [{ x: 1790, y: 650 }, { x: 1795, y: 900 }] },
      { id: 'door-path', kind: 'local', width: 3, points: [{ x: 1792, y: 700 }, { x: 1797, y: 700 }] },
    ]
    expect(layoutNearEdgeExitAnchors(roads, 'east', 1800, 1400)[0]).toMatchObject({ point: { x: 1740, y: 650 }, road: { id: 'new-east' } })
    expect(layoutNearEdgeExitAnchors(roads, 'west', 1800, 1400)[0]).toMatchObject({ point: { x: 40, y: 600 }, road: { id: 'new-west' } })
  })
})
