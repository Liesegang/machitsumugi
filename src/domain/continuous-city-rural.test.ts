import { describe, expect, it } from 'vitest'
import { continuousRuralFringeAllowed, planContinuousCityRuralAccess } from './continuous-city-rural'
import type { ContinuousCityRuralInput } from './continuous-city-rural'
import type { ContinuousCityDemand } from './continuous-city-types'
import { corridorPolygon, distanceToSegment, intersectRegions, pointInRegion, polygonOverlapsRegion, rectangle, regionArea } from './geometry'
import { PlanarRoadGraph, materializeRoadJunctions } from './road-graph'
import { resampleAlignment } from './road-alignment'

const demand: ContinuousCityDemand = { center: { x: 500, y: 500 }, regions: [], at: () => 0, costAt: () => 0, openingAt: () => 1955, metrics: { cellSize: 60, reachableLandArea: 4800000, targetUrbanArea: 0, selectedUrbanArea: 0 } }
const fixture = (): ContinuousCityRuralInput => ({ config: { name: '農村市', seed: 'connected-farm-frontage', type: 'post', terrain: 'plain', density: 50, forest: 0, railway: false, stations: 1, arterial: true, facilities: [] }, width: 2400, height: 2000, terrain: { areas: [], elevation: () => 10, slope: () => 0, waterAt: () => false, cultivable: () => true }, roads: [{ id: 'public', kind: 'local', role: 'collector', width: 8, builtYear: 1965, boundaryContinuation: true, points: [{ x: 200, y: -50 }, { x: 200, y: 2050 }] }], railways: [], reserves: [], demand })

describe('continuous city real rural access', () => {
  it('surveys a later peripheral public frontage before the first wide road exhausts the agricultural seed and family budgets', () => {
    const base = fixture(), original = { ...base.roads[0]!, id: 'old-wide-trunk', width: 12, builtYear: 1650, points: [{ x: 400, y: -50 }, { x: 400, y: 3050 }] }
    const connector = { ...base.roads[0]!, id: 'later-east-connection', boundaryContinuation: false, builtYear: 1975, points: [{ x: 400, y: 2600 }, { x: 3500, y: 2600 }] }
    const peripheral = { ...connector, id: 'later-peripheral-lane', role: 'lane' as const, width: 5.6, points: [{ x: 3500, y: 1300 }, { x: 3500, y: 2900 }] }
    const input = { ...base, width: 4000, height: 3000, roads: [original, connector, peripheral], demand: { ...demand, at: (p: { x: number }) => p.x < 1000 || p.x > 3000 ? 0 : 1 } }
    const before = JSON.stringify(input), result = planContinuousCityRuralAccess(input)
    const east = result.diagnostics.projects.filter(p => p.to.x > 3200), west = result.diagnostics.projects.filter(p => p.to.x < 1000)
    expect(east.length).toBeGreaterThan(0)
    expect(west.length).toBeGreaterThan(0)
    expect(east.every(p => p.builtYear === 1975)).toBe(true)
    expect(result.diagnostics.maximumNetworkDistance).toBeLessThanOrEqual(1200.000001)
    expect(JSON.stringify(input)).toBe(before)
  })

  it('serves a200m countryside belt from the actual urban-edge pavement without a400m frontier leap', () => {
    const base = fixture(), road = { ...base.roads[0]!, id: 'urban-edge', points: [{ x: -40, y: 600 }, { x: 1040, y: 600 }], builtYear: 1970 }
    const input = { ...base, width: 1000, height: 800, roads: [road], demand: { ...demand, at: (p: { y: number }) => p.y <= 600 ? 1 : 0 } }
    const result = planContinuousCityRuralAccess(input)
    expect(result.diagnostics.seeds).toBeGreaterThan(0)
    expect(result.roads.length).toBeGreaterThan(1)
    for (const project of result.diagnostics.projects) { expect(project.length).toBeGreaterThanOrEqual(80 - 1e-7); expect(project.length).toBeLessThanOrEqual(200 + 1e-7); expect(project.builtYear).toBe(1970) }
    for (const road of result.roads) for (const point of resampleAlignment(road.points, 2)) {
      expect(point.y > 600 || distanceToSegment(point, input.roads[0]!.points[0]!, input.roads[0]!.points[1]!) <= input.roads[0]!.width / 2 + .011).toBe(true)
    }
    expect(planContinuousCityRuralAccess({ ...input, demand: { ...input.demand, at: p => p.y <= 650 ? 1 : 0 } }).roads).toEqual([])
    const thin = planContinuousCityRuralAccess({ ...input, demand: { ...input.demand, at: p => p.y <= 600 ? 1 : p.y < 618 ? .1 : 0 } })
    expect(thin.roads.length).toBeGreaterThan(0)
    expect(thin.roads.every(road => road.builtYear === 1970)).toBe(true)
    expect(planContinuousCityRuralAccess({ ...input, demand: { ...input.demand, at: p => p.y <= 600 ? 1 : p.y < 650 ? .1 : 0 } }).roads).toEqual([])
  })
  it('counts full-width acquisition once per interval and keeps the original root chainage on bends and descendants', () => {
    const input = { points: [{ x: 0, y: 0 }, { x: 80, y: 0 }], root: { x: 0, y: 0 }, travelled: 0, bounded: () => true, oldPavement: (p: { x: number; y: number }) => p.x <= 4 && Math.abs(p.y) <= 2, intensity: (p: { x: number }) => p.x < 20 ? .1 : 0 }
    expect(continuousRuralFringeAllowed(input)).toBe(true)
    expect(continuousRuralFringeAllowed({ ...input, intensity: p => p.x < 21 ? .1 : 0 })).toBe(false)
    expect(continuousRuralFringeAllowed({ ...input, intensity: p => p.x < 20 && p.y > 1 ? .1 : 0 })).toBe(true)
    expect(continuousRuralFringeAllowed({ ...input, intensity: p => p.x < 20 && p.y > 1 ? .3 : 0 })).toBe(false)
    expect(continuousRuralFringeAllowed({ ...input, travelled: 80 })).toBe(false)
    expect(continuousRuralFringeAllowed({ ...input, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 20 }, { x: 100, y: 20 }], intensity: p => p.x < 8 && p.y > 15 ? .1 : 0 })).toBe(false)
  })
  it('uses the year of actual external connectivity and rejects an isolated apparent public street', () => {
    const input = fixture(), road = { ...input.roads[0]!, boundaryContinuation: false, builtYear: 1650, points: [{ x: 200, y: 100 }, { x: 200, y: 1900 }] }
    expect(planContinuousCityRuralAccess({ ...input, roads: [road] }).roads).toEqual([])
    const connector = { ...input.roads[0]!, id: 'late-regional-connection', builtYear: 1995, points: [{ x: -50, y: 100 }, { x: 200, y: 100 }] }
    const result = planContinuousCityRuralAccess({ ...input, roads: [road, connector] })
    expect(result.roads.length).toBeGreaterThan(0)
    expect(result.roads.every(road => road.builtYear === 1995)).toBe(true)
  })
  it('builds sparse connected branches, retaining actual opening dates and a1.2km new-network bound', () => {
    const input = fixture(), before = JSON.stringify(input), result = planContinuousCityRuralAccess(input)
    expect(result.roads.length).toBeGreaterThan(1)
    expect(result.roads.length).toBeLessThanOrEqual(4)
    expect(result.diagnostics.maximumNetworkDistance).toBeGreaterThan(700)
    expect(result.diagnostics.maximumNetworkDistance).toBeLessThanOrEqual(1200.000001)
    const graph = new PlanarRoadGraph()
    for (const road of materializeRoadJunctions([...input.roads, ...result.roads])) graph.add(road.points, { ...road, role: road.role ?? 'lane', builtYear: road.builtYear ?? 1650, phase: 'test', reason: 'test', constructionCost: 0 }, false)
    const reachable = graph.accessibilityFrom(input.roads[0]!.points[0]!)
    for (const road of result.roads) {
      expect(road.role).toBe('farm'); expect(road.kind).toBe('local'); expect(road.builtYear).toBe(1965)
      expect(Number.isFinite(reachable(road.points.at(-1)!))).toBe(true)
      expect(road.bridge).toBeUndefined(); expect(road.throughRouteId).toBeUndefined()
    }
    expect(result.diagnostics.projects.some(p => p.parentRoadId.startsWith('continuous-farm-'))).toBe(true)
    for (const project of result.diagnostics.projects) {
      expect(regionArea(project.workingField)).toBeCloseTo(1024, 4)
      for (const road of [...input.roads, ...result.roads]) for (let i = 1; i < road.points.length; i++) {
        const pavement = { polygon: corridorPolygon(road.points[i - 1]!, road.points[i]!, road.width / 2 + .4) }
        expect(intersectRegions(project.workingField, pavement).reduce((sum, part) => sum + regionArea(part), 0)).toBeLessThan(.001)
      }
    }
    expect(JSON.stringify(input)).toBe(before)
    expect(planContinuousCityRuralAccess(input)).toEqual(result)
  })
  it('does not turn missing urban supply into farmland access, and needs a real public road', () => {
    const input = fixture()
    expect(planContinuousCityRuralAccess({ ...input, roads: [] }).roads).toEqual([])
    expect(planContinuousCityRuralAccess({ ...input, demand: { ...demand, at: () => 1 } }).roads).toEqual([])
    expect(planContinuousCityRuralAccess({ ...input, roads: input.roads.map(r => ({ ...r, controlledAccess: true, role: 'expressway' })) }).roads).toEqual([])
    expect(planContinuousCityRuralAccess({ ...input, terrain: { ...input.terrain, slope: () => .25 } }).roads).toEqual([])
  })
  it('retains exact water and dry islands without buying a bridge across a full-height channel', () => {
    const input = fixture(), water = { id: 'river', kind: 'water' as const, polygon: rectangle(900, 0, 40, 2000) }
    const result = planContinuousCityRuralAccess({ ...input, terrain: { ...input.terrain, areas: [water], waterAt: p => pointInRegion(p, water) } })
    expect(result.roads.length).toBeGreaterThan(0)
    for (const road of result.roads) for (let i = 1; i < road.points.length; i++) {
      expect(polygonOverlapsRegion(corridorPolygon(road.points[i - 1]!, road.points[i]!, road.width / 2), water)).toBe(false)
      expect(road.points[i]!.x).toBeLessThan(900)
    }
  })
  it('preserves full civic ROW and surface-track land instead of opening agricultural crossings', () => {
    const input = fixture(), reserve = { polygon: rectangle(700, 0, 100, 2000) }, track = [{ x: 1100, y: 0 }, { x: 1100, y: 2000 }]
    for (const changes of [{ reserves: [reserve] }, { railways: [{ id: 'surface', name: '本線', points: track, builtYear: 1900 }] }]) {
      const result = planContinuousCityRuralAccess({ ...input, ...changes })
      expect(result.roads.length).toBeGreaterThan(0)
      for (const road of result.roads) for (let i = 1; i < road.points.length; i++) {
        if ('reserves' in changes) expect(polygonOverlapsRegion(corridorPolygon(road.points[i - 1]!, road.points[i]!, road.width / 2 + .4), reserve)).toBe(false)
        else for (const p of resampleAlignment([road.points[i - 1]!, road.points[i]!], 4)) expect(distanceToSegment(p, track[0]!, track[1]!)).toBeGreaterThanOrEqual(9.399)
      }
    }
  })
  it('rejects a steep intervening ridge even when its rural endpoints are flat', () => {
    const input = fixture(), ridge = (p: { x: number }) => Math.max(0, 20 - Math.abs(p.x - 700) * 2)
    const result = planContinuousCityRuralAccess({ ...input, terrain: { ...input.terrain, elevation: p => 10 + ridge(p) } })
    expect(result.roads.length).toBeGreaterThan(0)
    for (const road of result.roads) expect(road.points.every(p => p.x < 690)).toBe(true)
  })
})
