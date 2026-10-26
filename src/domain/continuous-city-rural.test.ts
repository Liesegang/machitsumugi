import { describe, expect, it } from 'vitest'
import { planContinuousCityRuralAccess } from './continuous-city-rural'
import type { ContinuousCityRuralInput } from './continuous-city-rural'
import type { ContinuousCityDemand } from './continuous-city-types'
import { corridorPolygon, distanceToSegment, pointInRegion, polygonOverlapsRegion, rectangle } from './geometry'
import { PlanarRoadGraph, materializeRoadJunctions } from './road-graph'
import { resampleAlignment } from './road-alignment'

const demand: ContinuousCityDemand = { center: { x: 500, y: 500 }, regions: [], at: () => 0, costAt: () => 0, openingAt: () => 1955, metrics: { cellSize: 60, reachableLandArea: 4800000, targetUrbanArea: 0, selectedUrbanArea: 0 } }
const fixture = (): ContinuousCityRuralInput => ({ config: { name: '農村市', seed: 'connected-farm-frontage', type: 'post', terrain: 'plain', density: 50, forest: 0, railway: false, stations: 1, arterial: true, facilities: [] }, width: 2400, height: 2000, terrain: { areas: [], elevation: () => 10, slope: () => 0, waterAt: () => false, cultivable: () => true }, roads: [{ id: 'public', kind: 'local', role: 'collector', width: 8, builtYear: 1965, points: [{ x: 200, y: 50 }, { x: 200, y: 1950 }] }], railways: [], reserves: [], demand })

describe('continuous city real rural access', () => {
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
