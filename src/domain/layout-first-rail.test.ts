import { describe, expect, it } from 'vitest'
import { distance, distanceToSegment, pointInPolygon, polygonOverlapsRegion, rectangle } from './geometry'
import { surveyLayoutFirstRail, surveyLayoutStationApproaches } from './layout-first-rail'
import type { LayoutFirstRailInput } from './layout-first-rail'
import { planLayoutFirstStationZones, planLayoutFirstZones } from './layout-first-zones'
import { reserveLayoutFirstCivics } from './layout-first-civic'
import { buildLayoutFirstRoads } from './layout-first-roads'
import { materializeRoadJunctions } from './road-graph'
import { certifyLayoutAccess } from './layout-first-access'

function fixture(): LayoutFirstRailInput {
  return { config: { name: '試験市', seed: 'layout-rail-fixture', type: 'post', terrain: 'plain', density: 65, forest: 0, railway: true, stations: 2, arterial: true, facilities: [] },
    width: 2400, height: 1800, center: { x: 1200, y: 900 }, reserves: [],
    zones: [{ id: 'old-town', kind: 'historic', center: { x: 1200, y: 900 }, radius: 1100, polygon: rectangle(100, 100, 2200, 1600), builtYear: 1750, density: .8, maximumFloors: 3 }],
    terrain: { areas: [], elevation: () => 20, waterAt: () => false, slope: () => 0 } }
}

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
      expect(pointInPolygon(station.entrance!, station.buildingPolygon!)).toBe(false)
      expect(pointInPolygon(station.entrance!, result.stationGrounds[index]!.polygon)).toBe(true)
      expect(pointInPolygon(result.accessTargets[index]!.point, result.stationGrounds[index]!.polygon)).toBe(false)
      expect(result.stationPaths[index]!.points).toEqual([result.accessTargets[index]!.point, station.entrance!])
      expect(station.buildingPolygon!.every(p => pointInPolygon(p, result.stationGrounds[index]!.polygon))).toBe(true)
      expect(result.stationGrounds[index]!.polygon.every(p => !input.terrain.waterAt(p) && input.terrain.slope(p) <= .12)).toBe(true)
    }
    expect(result.stations[0]!.name).not.toBe(result.stations[1]!.name)
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

  it('connects coastal station public gates exactly to the dated external street network', () => {
    const base = fixture(), width = 4000, height = 3000
    const config = { ...base.config, seed: 'layout-coastal-civics-physical', type: 'port' as const, terrain: 'coast' as const, density: 70, forest: 60, settlement: 'regional-city' as const, facilities: ['port', 'school', 'hospital', 'shrine', 'park', 'shop'] as const }
    const waterAt = (p: { x: number; y: number }) => p.y >= 2350
    const elevation = (p: { x: number; y: number }) => waterAt(p) ? 0 : 2, slope = () => 0
    const terrain = { areas: [{ id: 'sea', kind: 'water' as const, polygon: rectangle(0, 2350, width, 650) }], elevation, slope, waterAt, channelAt: () => null, bridgeSites: [], cityOrigin: { x: 2000, y: 1200 },
      continuationTerrain: { bounds: { minX: -500, minY: -500, maxX: 4500, maxY: 3500 }, contains: (p: { x: number; y: number }) => p.x >= -500 && p.y >= -500 && p.x <= 4500 && p.y <= 3500, elevation, slope, waterAt, seaAt: waterAt } }
    const input = { config: { ...config, facilities: [...config.facilities] }, width, height, terrain }
    const brief = planLayoutFirstZones(input), civic = reserveLayoutFirstCivics({ ...input, ...brief })
    const planningAreas = [...terrain.areas, ...civic.areas], planningTerrain = { ...terrain, areas: planningAreas }
    const rail = surveyLayoutFirstRail({ ...input, terrain: planningTerrain, ...brief, reserves: civic.reserves })
    expect(rail.stations).toHaveLength(2)
    for (const station of rail.stations) expect((station.entrance!.x - station.point.x) * (brief.center.x - station.point.x) + (station.entrance!.y - station.point.y) * (brief.center.y - station.point.y)).toBeGreaterThan(0)
    const reserves = [...civic.reserves, ...rail.stationGrounds]
    const stationZones = planLayoutFirstStationZones({ ...input, ...brief, stations: rail.stations, gates: rail.accessTargets })
    const transport = buildLayoutFirstRoads({ seed: config.seed, center: brief.center, settlement: config.settlement, density: config.density, arterial: true, zones: [...brief.zones, ...stationZones], railways: rail.railways, reservedRegions: reserves, accessTargets: [...civic.accessTargets, ...rail.accessTargets],
      environment: { width, height, core: null, areas: planningAreas, terrain: planningTerrain, bridgeSites: [], exactLandCost: true, landCost: p => reserves.some(region => pointInPolygon(p, region.polygon)) ? Infinity : 0 } })
    const roads = materializeRoadJunctions([...transport.roads, ...rail.stationPaths])
    const access = certifyLayoutAccess({ width, height, roads, targets: rail.accessTargets })
    expect(access.unserved).toEqual([])
  }, 20_000)
})
