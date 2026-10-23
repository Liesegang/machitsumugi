import { describe, expect, it } from 'vitest'
import { RegionalRoadPlanner } from './regional-road-planner'
import type { Point } from './types'

describe('roads continuing beyond the displayed map', () => {
  const flat = { elevation: () => 0, slope: () => 0, waterAt: () => false }
  it('retains a physically checked regional alignment outside the crop instead of a terminal 28m inside it', () => {
    const planner = new RegionalRoadPlanner({ width: 1000, height: 800, areas: [], core: null, terrain: { ...flat, bridgeSites: [], continuationTerrain: flat } })
    const route = planner.toBoundary({ x: 700, y: 400 }, { x: 28, y: 400 }, { role: 'highway', width: 13 })
    expect(route).not.toBeNull()
    expect(route!.boundaryContinuation).toBe(true)
    expect(route!.points.at(-1)!.x).toBeLessThan(-300)
    expect(planner.validate(route!.points, 13)).toBe(true)
    expect(route!.points.some(p => p.x >= 0 && p.x < 15)).toBe(true)
  })
  it('rejects a dry-looking crop edge when the actual outside corridor crosses unsurveyed water', () => {
    const continuation = { ...flat, waterAt: (p: Point) => p.x < -80 && p.x > -180 }
    const planner = new RegionalRoadPlanner({ width: 1000, height: 800, areas: [], core: null, terrain: { ...flat, bridgeSites: [], continuationTerrain: continuation } })
    expect(planner.toBoundary({ x: 700, y: 400 }, { x: 28, y: 400 }, { role: 'collector', width: 9, allowBridge: true })).toBeNull()
    expect(planner.waterAt({ x: -120, y: 400 })).toBe(true)
  })
})
