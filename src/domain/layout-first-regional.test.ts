import { describe, expect, it } from 'vitest'
import type { CityConfig } from './types'
import { PlanarRoadGraph } from './road-graph'
import { augmentLayoutFirstRegional } from './layout-first-regional'

const config: CityConfig = { name: '広域試験', seed: 'regional', type: 'post', terrain: 'plain', density: 85, forest: 0, railway: false, stations: 0, arterial: true, facilities: [], settlement: 'metropolis', expressway: true }
const flat = { elevation: () => 0, slope: () => 0, waterAt: () => false }
function fixture() {
  const graph = new PlanarRoadGraph()
  graph.add([{ x: -324, y: 650 }, { x: 850, y: 650 }, { x: 850, y: 2650 }, { x: 4324, y: 2650 }], { id: 'old', builtYear: 1650, phase: 'regional', role: 'highway', reason: 'existing regional detour', width: 13, kind: 'arterial', constructionCost: 10000, boundaryContinuation: true }, false)
  return { config, width: 4000, height: 3000, terrain: { ...flat, bridgeSites: [], continuationTerrain: flat }, areas: [], transport: { graph, roads: graph.roads, zones: [] } }
}
describe('layout-first optional regional engineering', () => {
  it('adds an actual controlled mainline and two complete interchanges within finite funds', () => {
    const input = fixture(), old = input.transport.graph.roads[0]!.points.map(p => ({ ...p }))
    const result = augmentLayoutFirstRegional(input)
    expect(result.diagnostics.completed).toEqual(['expressway'])
    expect(result.diagnostics.spent).toBeGreaterThan(0)
    expect(result.diagnostics.spent).toBeLessThanOrEqual(result.diagnostics.initialFunds)
    expect(result.roads.filter(road => road.role === 'ramp')).toHaveLength(4)
    expect(result.roads.filter(road => road.controlledAccess)).toHaveLength(5)
    expect(old.every(p => result.roads.find(road => road.id === 'old')!.points.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 1e-7))).toBe(true)
    expect(result.roads.find(road => road.role === 'expressway')!.points.some(p => p.x < 0 || p.x > 4000)).toBe(true)
  })

  it('leaves the old graph alone when no modern corridor is requested', () => {
    const input = fixture(), before = JSON.stringify(input.transport.graph.roads)
    const result = augmentLayoutFirstRegional({ ...input, config: { ...config, expressway: false } })
    expect(JSON.stringify(result.roads)).toBe(before)
    expect(result.diagnostics.spent).toBe(0)
  })

  it('honours a separately requested surface bypass', () => {
    const result = augmentLayoutFirstRegional({ ...fixture(), config: { ...config, expressway: false, bypass: true } })
    expect(result.diagnostics.completed).toEqual(['bypass'])
    const road = result.roads.find(road => road.id === 'layout-bypass-mainline')!
    expect(road.controlledAccess).toBeUndefined()
    expect(road.boundaryContinuation).toBe(true)
    expect(road.width).toBe(16)
    expect(road.builtYear).toBe(1975)
  })
})
