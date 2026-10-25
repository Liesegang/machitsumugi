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
  it('surveys a farther dry outlet when all five local edge goals lie in sea', () => {
    const continuation = { ...flat, waterAt: (p: Point) => p.x < -80 && p.y < 900 }
    const planner = new RegionalRoadPlanner({ width: 1200, height: 2000, areas: [], core: null, terrain: { ...flat, bridgeSites: [], continuationTerrain: continuation } })
    const route = planner.toBoundary({ x: 700, y: 1200 }, { x: 28, y: 400 }, { role: 'collector', width: 9, allowBridge: false, maxNodes: 4000 })
    expect(route).not.toBeNull()
    expect(route!.points.at(-1)!.x).toBeLessThan(-300)
    expect(route!.points.at(-1)!.y).toBeGreaterThan(900)
    expect(planner.validate(route!.points, 9)).toBe(true)
  })
  it('offers bounded real land passes independent of an interior river source', () => {
    const planner = new RegionalRoadPlanner({ width: 2000, height: 1600, areas: [], core: null, terrain: { ...flat, bridgeSites: [], continuationTerrain: flat } })
    const origin = { x: 1100, y: 1000 }
    const portals = planner.boundaryPortals(origin, { width: 8.5, direction: { x: 0, y: -1 }, maxCandidates: 4 })
    expect(portals.length).toBeGreaterThan(0)
    expect(portals.length).toBeLessThanOrEqual(4)
    expect(portals.every(point => point.y < origin.y && (point.x < 0 || point.x > 2000 || point.y < 0 || point.y > 1600))).toBe(true)
    const route = planner.plan(origin, portals[0]!, { role: 'highway', width: 8.5, allowBridge: false, maxNodes: 4000 })
    expect(route).not.toBeNull()
    expect(planner.validate(route!.points, 8.5)).toBe(true)
  })
  it('does not offer dry-looking portals through an outside water belt or beyond the requested direction', () => {
    const continuation = { ...flat, waterAt: (p: Point) => p.x < -80 && p.x > -180 }
    const planner = new RegionalRoadPlanner({ width: 1000, height: 800, areas: [], core: null, terrain: { ...flat, bridgeSites: [], continuationTerrain: continuation } })
    expect(planner.boundaryPortals({ x: 700, y: 400 }, { width: 9, preferred: { x: 28, y: 400 } })).toEqual([])
    expect(planner.boundaryPortals({ x: 700, y: 400 }, { width: 9, direction: { x: 0, y: 1 } }).every(point => point.y > 400)).toBe(true)
  })
  it('keeps an exact campus boundary exact when translating the regional frame', () => {
    const planner = new RegionalRoadPlanner({ width: 1000, height: 800, areas: [], core: null, exactLandCost: true,
      landCost: p => p.x >= 350 && p.x < 511 && p.y > 300 && p.y < 500 ? Infinity : 0,
      terrain: { ...flat, bridgeSites: [], continuationTerrain: flat } })
    // This3m route is dry and wholly outside the campus. Rounding its ownership
    // sample to the translated24m earthwork grid wrongly samples x=510 inside.
    const route = planner.plan({ x: 513, y: 400 }, { x: 950, y: 400 }, { role: 'access', width: 3, alignment: 'planned' })
    expect(route).not.toBeNull()
    expect(route!.points.every(p => p.x >= 513)).toBe(true)
    expect(planner.validate(route!.points, 3)).toBe(true)
  })
})
