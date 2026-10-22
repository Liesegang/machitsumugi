import { describe, expect, it } from 'vitest'
import { RoadPlanner } from './road-planner'
import type { Area, Point } from './types'

const water: Area = { id: 'river', kind: 'water', polygon: [{ x: 480, y: 0 }, { x: 520, y: 0 }, { x: 520, y: 800 }, { x: 480, y: 800 }] }
const river = (p: Point) => p.x >= 480 && p.x <= 520

describe('terrain route planning', () => {
  it('rejects a cross-river road without a designated bridge project', () => {
    const planner = new RoadPlanner({ width: 1000, height: 800, areas: [water], core: null })
    expect(planner.plan({ x: 100, y: 400 }, { x: 900, y: 400 }, { role: 'collector', width: 9 })).toBeNull()
  })

  it('crosses only the surveyed bridge corridor and reports its distinct cost', () => {
    const planner = new RoadPlanner({ width: 1000, height: 800, areas: [water], core: null, terrain: { elevation: () => 0, slope: () => 0, waterAt: river, bridgeSites: [{ x: 500, y: 400 }], bridgeCandidates: [{ point: { x: 500, y: 400 }, bankA: { x: 455, y: 400 }, bankB: { x: 545, y: 400 }, width: 40, cost: 100 }] } })
    const route = planner.plan({ x: 100, y: 250 }, { x: 900, y: 520 }, { role: 'collector', width: 9, allowBridge: true })
    expect(route).not.toBeNull()
    expect(route!.method).toBe('bridge-project')
    expect(route!.bridgeLength).toBeGreaterThan(30)
    expect(route!.cost).toBeGreaterThan(route!.length * 1.35)
    for (const p of route!.points.filter(river)) expect(Math.abs(p.y - 400)).toBeLessThan(1)
  })

  it('routes around an inaccessible historic enclosure instead of cutting its corners', () => {
    const core = [{ x: 350, y: 220 }, { x: 650, y: 220 }, { x: 650, y: 580 }, { x: 350, y: 580 }]
    const planner = new RoadPlanner({ width: 1000, height: 800, areas: [], core })
    const route = planner.plan({ x: 90, y: 400 }, { x: 910, y: 400 }, { role: 'collector', width: 9 })
    expect(route).not.toBeNull()
    expect(planner.validate(route!.points, 9)).toBe(true)
    expect(route!.length).toBeGreaterThan(820)
    expect(route!.points.some(p => p.y < 215 || p.y > 585)).toBe(true)
  })
})
