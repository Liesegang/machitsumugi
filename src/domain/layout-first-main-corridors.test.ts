import { expect, it, vi } from 'vitest'
import { layoutMainCorridorBearings, selectLayoutMainBridgeCandidates, surveyLayoutMainCorridors } from './layout-first-main-corridors'
import type { LayoutFirstZone } from './layout-first-types'
import { rectangle } from './geometry'
import { RoadPlanner } from './road-planner'
import type { PlanningOptions } from './road-planner'
import type { Point } from './types'

const zones: LayoutFirstZone[] = [400, 900, 1400].map((x, index) => ({ id: `z${index}`, center: { x, y: 700 }, radius: 400, kind: 'residential', builtYear: 1955, density: 1, maximumFloors: 4, angle: 1.2, polygon: rectangle(x - 200, 500, 400, 400) }))
it('derives a regional direction from the whole demand region without imposing its local street angle', () => {
  const bearings = layoutMainCorridorBearings(zones, { x: 900, y: 700 })
  expect(bearings[0]).toBeCloseTo(0)
  expect(layoutMainCorridorBearings(zones.map(zone => ({ ...zone, angle: -.7 })), { x: 900, y: 700 })).toEqual(bearings)
})

it('keeps close bridges over different rivers while removing a duplicate over the same river', () => {
  const main = { point: { x: 1000, y: 20 }, riverId: 'main' }, tributary = { point: { x: 1050, y: 30 }, riverId: 'tributary' }, duplicate = { point: { x: 1100, y: 40 }, riverId: 'main' }
  expect(selectLayoutMainBridgeCandidates([main, tributary, duplicate], { x: 0, y: 0 }, { x: 2000, y: 0 }, 500)).toEqual([main, tributary])
})

it('bounds a requested main-corridor search by distance while retaining the short-leg allowance', () => {
  const planner = new RoadPlanner({ width: 200, height: 200, areas: [], core: null }), budgets: number[] = []
  const spy = vi.spyOn(planner as unknown as { planGeometry: (a: Point, b: Point, options: PlanningOptions) => null }, 'planGeometry').mockImplementation((_a, _b, options) => { budgets.push(options.maxNodes!); return null })
  for (const length of [700, 7000, 12000]) planner.plan({ x: 0, y: 0 }, { x: length, y: 0 }, { role: 'highway', width: 12, maxNodes: 16000, maxNodesPerKm: 1800 })
  expect(budgets).toEqual([4200, 12600, 16000])
  spy.mockRestore()
})

it('surveys complete outside-to-outside alignments through the town before any local mesh exists', () => {
  const waterAt = () => false, elevation = () => 20, slope = () => 0
  const terrain = { waterAt, elevation, slope, bridgeSites: [], continuationTerrain: { waterAt, seaAt: waterAt, elevation, slope, contains: () => true, bounds: { minX: -600, minY: -600, maxX: 2400, maxY: 2000 } } }
  const proposals = surveyLayoutMainCorridors({ environment: { width: 1800, height: 1400, core: null, areas: [], terrain }, center: { x: 900, y: 700 }, zones, railways: [] }, () => true)
  expect(proposals.length).toBeGreaterThan(0)
  expect(proposals.length).toBeLessThanOrEqual(2)
  for (const proposal of proposals) {
    expect(proposal.width).toBe(12)
    expect(proposal.route.points.some(point => Math.hypot(point.x - 900, point.y - 700) < 1e-7)).toBe(true)
    for (const point of [proposal.route.points[0]!, proposal.route.points.at(-1)!]) expect(point.x < 0 || point.x > 1800 || point.y < 0 || point.y > 1400).toBe(true)
  }
})
