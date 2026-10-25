import { expect, it, vi } from 'vitest'
import { layoutMainCorridorBearings, layoutMainCorridorTangents, planLayoutMainCorridorAlignment, selectLayoutMainBridgeCandidates, surveyLayoutMainCorridors } from './layout-first-main-corridors'
import type { LayoutFirstZone } from './layout-first-types'
import { rectangle } from './geometry'
import { RoadPlanner } from './road-planner'
import type { PlanningOptions } from './road-planner'
import type { Point } from './types'
import { alignmentDiagnostics } from './road-alignment'
import { surveyedRoadGradeAllowed } from './surveyed-road-profile'

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

it('chooses a shared regional tangent before either approach instead of inheriting the first greedy arrival', () => {
  const start = { x: 0, y: 0 }, center = { x: 1000, y: 0 }, goal = { x: 2000, y: 0 }, requests: PlanningOptions[] = []
  const bridge = { bankA: { x: 200, y: 0 }, bankB: { x: 240, y: 0 } }
  const route = planLayoutMainCorridorAlignment({
    plan: (a, b, options) => {
      requests.push(options)
      // Without a jointly chosen arrival, the left local optimum would arrive
      // northbound and leave no physical eastward continuation.
      if (options.through || (b === center ? options.endHeading : options.startHeading) !== 0) return null
      return { points: [a, b], length: 1000, cost: a === start ? 110 : 170, bridgeLength: a === start ? 40 : 0, method: 'heading-search', ...(a === start ? { surveyedBridgeSpans: [bridge] } : {}) }
    },
    validate: () => true,
  }, start, center, goal, 12)
  expect(route).not.toBeNull()
  expect(requests).toHaveLength(2)
  expect(requests[0]!.endHeading).toBe(requests[1]!.startHeading)
  expect(route!.points).toEqual([start, center, goal])
  expect(route!.cost).toBe(280)
  expect(route!.surveyedBridgeSpans).toEqual([bridge])
})

it('keeps a common tangent when the regional direction crosses the angle wrap', () => {
  const tangents = layoutMainCorridorTangents({ x: 1000, y: -10 }, { x: 0, y: 0 }, { x: -1000, y: -10 })
  expect(Math.abs(Math.abs(tangents[0]!) - Math.PI)).toBeLessThan(.02)
  expect(tangents).toHaveLength(3)
})

it('rejects a kink in assembled pavement even if both separately surveyed legs were accepted', () => {
  const start = { x: 0, y: 0 }, center = { x: 1000, y: 0 }, goal = { x: 2000, y: 0 }
  const route = planLayoutMainCorridorAlignment({
    plan: (a, b) => ({ points: a === start ? [a, { x: 999, y: -1 }, b] : [a, { x: 1001, y: -1 }, b], length: 1001, cost: 2000, bridgeLength: 0, method: 'heading-search' }),
    validate: () => true,
  }, start, center, goal, 12)
  expect(route).toBeNull()
})

it('joins two physical bridge approaches while keeping both surveyed decks and the centre tangent', () => {
  const waterAt = (p: Point) => p.x >= 480 && p.x <= 520 || p.x >= 960 && p.x <= 1000, elevation = (p: Point) => waterAt(p) ? -40 : 100
  const bridgeCandidates = [{ point: { x: 500, y: 500 }, bankA: { x: 455, y: 500 }, bankB: { x: 545, y: 500 }, width: 40, cost: 100 }, { point: { x: 980, y: 500 }, bankA: { x: 935, y: 500 }, bankB: { x: 1025, y: 500 }, width: 40, cost: 100 }]
  const planner = new RoadPlanner({ width: 1600, height: 1000, areas: [], core: null, terrain: { elevation, slope: () => 0, waterAt, bridgeSites: bridgeCandidates.map(site => site.point), bridgeCandidates } })
  const route = planLayoutMainCorridorAlignment(planner, { x: 100, y: 400 }, { x: 800, y: 500 }, { x: 1500, y: 600 }, 12)
  expect(route).not.toBeNull()
  expect(route!.surveyedBridgeSpans).toHaveLength(2)
  expect(alignmentDiagnostics(route!.points).minimumRadius).toBeGreaterThanOrEqual(85)
  expect(surveyedRoadGradeAllowed(route!, .09, elevation)).toBe(true)
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
    expect(alignmentDiagnostics(proposal.route.points).minimumRadius).toBeGreaterThanOrEqual(85)
    for (const point of [proposal.route.points[0]!, proposal.route.points.at(-1)!]) expect(point.x < 0 || point.x > 1800 || point.y < 0 || point.y > 1400).toBe(true)
  }
})
