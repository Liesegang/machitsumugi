import { describe, expect, it } from 'vitest'
import riverFixture from './fixtures/castle-gate-river.json'
import { foundingMarketGates } from './founding-market'
import { RoadPlanner } from './road-planner'
import { simulateUrbanGrowth } from './urban-growth'
import type { Area, Point } from './types'

describe('founding castle market gate survey', () => {
  it('recovers a reachable gate in the actual river/core regression geometry', () => {
    const { width, height, core, center } = riverFixture, areas = riverFixture.areas as Area[]
    const planner = new RoadPlanner({ width, height, core, areas })
    const terminals = [{ x: 28, y: 1405.2319111861289 }, { x: 1539.7633629105985, y: 28 }, { x: 3972, y: 1584.353985786438 }, { x: 2054.7735683247447, y: 2972 }]
    const oldHub = { x: center.x + 40, y: Math.max(...core.map(p => p.y)) + 72 }
    expect(planner.suitable(oldHub, 13)).toBe(true)
    const gates = foundingMarketGates({ core, center, terminals, planner, role: 'highway', width: 13 })
    expect(gates.length).toBeGreaterThan(0)
    expect(gates.some(gate => planner.hasDryCorridor(gate, terminals[0]!, 'highway', 13))).toBe(true)
    const growth = simulateUrbanGrowth({ width, height, core, center, areas, type: 'castle', seed: 'minato-2026', arterial: true, railway: false, stationPoints: [], untilYear: 1650 })
    expect(growth.roads.length).toBeGreaterThan(0)
    expect(growth.roads.every(road => planner.validate(road.points, road.width))).toBe(true)
  }, 30000)

  it('surveys an oriented enclosure instead of moving the river or bridging without a survey', () => {
    const angle = Math.PI / 4, center = { x: 550, y: 450 }
    const transform = (x: number, y: number): Point => ({ x: center.x + x * Math.cos(angle) - y * Math.sin(angle), y: center.y + x * Math.sin(angle) + y * Math.cos(angle) })
    const core = [[-150, -100], [150, -100], [150, 100], [-150, 100]].map(([x, y]) => transform(x!, y!))
    const areas: Area[] = [{ id: 'tributary', kind: 'water', polygon: [{ x: 0, y: 650 }, { x: 1200, y: 650 }, { x: 1200, y: 685 }, { x: 0, y: 685 }] }]
    const planner = new RoadPlanner({ width: 1200, height: 1100, core, areas }), terminals = [{ x: 28, y: 400 }]
    const oldHub = { x: center.x + 40, y: Math.max(...core.map(p => p.y)) + 72 }
    expect(planner.hasDryCorridor(oldHub, terminals[0]!, 'collector', 9)).toBe(false)
    const gates = foundingMarketGates({ core, center, terminals, planner, role: 'collector', width: 9 })
    expect(gates.length).toBeGreaterThan(0)
    const route = planner.plan(gates[0]!, terminals[0]!, { role: 'collector', width: 9, allowBridge: false })
    expect(route).not.toBeNull()
    expect(planner.validate(route!.points, 9)).toBe(true)
    expect(areas[0]!.polygon[0]).toEqual({ x: 0, y: 650 })
    expect(foundingMarketGates({ core: core.slice().reverse(), center, terminals, planner, role: 'collector', width: 9 })).toEqual(gates)
  })
})
