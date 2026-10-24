import { describe, expect, it } from 'vitest'
import { RoadPlanner } from './road-planner'
import type { Railway, Road } from './types'

const rail: Railway = { id: 'rail', name: 'rail', mode: 'surface', points: [{ x: 100, y: 500 }, { x: 1100, y: 500 }] }
const parallel = [{ x: 200, y: 505 }, { x: 800, y: 505 }]
function planner(corridor: Railway = rail) {
  const result = new RoadPlanner({ width: 1200, height: 1000, areas: [], core: null, terrain: { elevation: () => 0, slope: () => 0, waterAt: () => false, bridgeSites: [] } })
  result.setRailwayCorridors([corridor])
  return result
}
describe('running-track clearance during inherited-road widening', () => {
  it('rejects a wider parallel carriageway even when its unchanged centreline passes the old rail cost check', () => {
    const result = planner()
    expect(result.validate(parallel, 13)).toBe(true)
    expect(Number.isFinite(result.cost(parallel, 'collector').cost)).toBe(true)
    expect(result.railwayWidthAllows(parallel, 4, 13, 'collector')).toBe(false)
    expect(result.railwayWidthAllows(parallel, 4, 4, 'lane')).toBe(true)
    const clear = parallel.map(point => ({ ...point, y: 510 }))
    expect(result.railwayWidthAllows(clear, 4, 13, 'collector')).toBe(true)
  })
  it('preserves the same inherited perpendicular crossing without allowing an adjacent parallel track occupation', () => {
    const result = planner(), points = [{ x: 500, y: 200 }, { x: 500, y: 800 }]
    const old: Road = { id: 'old-crossing', kind: 'local', role: 'lane', width: 4, points }
    result.setRailwayRoadNetwork([old])
    expect(result.railwayWidthAllows(points, 4, 13, 'collector')).toBe(true)
    // The legal crossing aperture does not license the later parallel branch.
    const bend = [{ x: 500, y: 200 }, { x: 500, y: 505 }, { x: 800, y: 505 }]
    expect(result.railwayWidthAllows(bend, 4, 13, 'collector')).toBe(false)
  })
  it('requires both a real bridge span and a measured vertical profile before widening beneath rail', () => {
    const structures: Railway['structures'] = [{ kind: 'bridge', from: rail.points[0]!, to: rail.points[1]!, maxHeight: 6 }]
    expect(planner({ ...rail, structures, elevations: [6, 6] }).railwayWidthAllows(parallel, 4, 13, 'collector')).toBe(true)
    expect(planner({ ...rail, structures, elevations: [6, 3] }).railwayWidthAllows(parallel, 4, 13, 'collector')).toBe(false)
    expect(planner({ ...rail, structures }).railwayWidthAllows(parallel, 4, 13, 'collector')).toBe(false)
    expect(planner({ ...rail, elevations: [6, 6], structures: [{ ...structures[0]!, kind: 'embankment' }] }).railwayWidthAllows(parallel, 4, 13, 'collector')).toBe(false)
  })
  it('ignores subway corridors and refreshes the physical index when a surface route changes', () => {
    const result = planner({ ...rail, mode: 'subway' })
    expect(result.railwayWidthAllows(parallel, 4, 13, 'collector')).toBe(true)
    result.setRailwayCorridors([rail])
    expect(result.railwayWidthAllows(parallel, 4, 13, 'collector')).toBe(false)
    result.setRailwayCorridors([])
    expect(result.railwayWidthAllows(parallel, 4, 13, 'collector')).toBe(true)
  })
})
