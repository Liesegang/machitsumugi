import { describe, expect, it } from 'vitest'
import { RoadPlanner } from './road-planner'
import type { PlannedRoute, PlanningOptions } from './road-planner'
import type { Point, Road } from './types'
import { distance, distanceToSegment, rectangle } from './geometry'
import { alignmentDiagnostics } from './road-alignment'
import { PlanarRoadGraph, extractStreetBlocks, roadLength } from './road-graph'
import { createLayoutCoverageMask, measureLayoutCoverageGain } from './layout-first-coverage-blocks'
import { surveyLayoutCoverageAlignment } from './layout-first-coverage-survey'

const oldRoad: Road = { id: 'old-public', kind: 'local', role: 'collector', width: 9, builtYear: 1650, points: [{ x: 0, y: 200 }, { x: 1600, y: 200 }] }
const from = { point: { x: 500, y: 200 }, roadId: oldRoad.id, builtYear: 1650 }
const to = { point: { x: 1100, y: 200 }, roadId: oldRoad.id, builtYear: 1650 }
const through = { x: 800, y: 1100 }
const contact = (anchor: typeof from, year: number) => anchor.roadId === oldRoad.id && oldRoad.builtYear! <= year && distanceToSegment(anchor.point, oldRoad.points[0]!, oldRoad.points[1]!) < 1e-7
const base = () => ({ from, to, through, builtYear: 1955, width: 8, startHeading: Math.PI / 2, endHeading: -Math.PI / 2, isPublicContact: contact, elevation: () => 0, rowAllows: () => true })

describe('dedicated two-leg coverage survey', () => {
  it('closes a deep demand area from two exact contacts on the SAME old public road', () => {
    const planner = new RoadPlanner({ width: 1600, height: 1500, areas: [], core: null })
    const input = { ...base(), planner }, result = surveyLayoutCoverageAlignment(input)
    expect(result.route, JSON.stringify(result.attempts)).not.toBeNull()
    const route = result.route!
    // A 600m endpoint shortcut is not the programme: this collector must
    // reach the 900m-deep dry demand before returning to the old road.
    expect(route.length / distance(from.point, to.point)).toBeGreaterThan(2.3)
    expect(route.length).toBeLessThanOrEqual((distance(from.point, through) + distance(through, to.point)) * 1.6)
    expect(route.points[0]).toEqual(from.point); expect(route.points.at(-1)).toEqual(to.point)
    expect(route.points.some(point => distance(point, through) < 1e-7)).toBe(true)
    expect(alignmentDiagnostics(route.points).minimumRadius).toBeGreaterThanOrEqual(50 - 1e-6)
    expect(planner.validate(route.points, 8)).toBe(true)
    const graph = new PlanarRoadGraph(), metadata = { id: oldRoad.id, kind: oldRoad.kind, role: 'collector' as const, width: 9, builtYear: 1650, phase: 'test', reason: 'old public road', constructionCost: 100 }
    graph.add(oldRoad.points, metadata, false)
    const before = extractStreetBlocks(graph.roads)
    expect(graph.add(route.points, { ...metadata, id: 'coverage', width: 8, builtYear: 1955, constructionCost: route.cost })).toBeTruthy()
    const mask = createLayoutCoverageMask({ demandRegions: [{ polygon: rectangle(200, 200, 1200, 1100) }], suitableRegions: [{ polygon: rectangle(200, 200, 1200, 1100) }], excludedRegions: [] })
    const gain = measureLayoutCoverageGain({ beforeFaces: before, afterFaces: extractStreetBlocks(graph.roads), mask, streetLength: roadLength(route.points) })
    expect(gain.coveredGain).toBeGreaterThan(100000)
    for (const anchor of [from, to]) expect(graph.roads.filter(road => road.builtYear <= 1955).some(road => road.id === oldRoad.id && road.points.some(point => distance(point, anchor.point) < 1e-7))).toBe(true)
  })

  it('keeps a closure on its real railway side, without inventing a new crossing', () => {
    const planner = new RoadPlanner({ width: 1600, height: 1600, areas: [], core: null })
    planner.setRailwayCorridors([{ id: 'surface-track', mode: 'surface', builtYear: 1900, points: [{ x: 0, y: 1400 }, { x: 1600, y: 1400 }] }])
    planner.setRailwayRoadNetwork([oldRoad])
    const result = surveyLayoutCoverageAlignment({ ...base(), planner })
    expect(result.route, JSON.stringify(result.attempts)).not.toBeNull()
    expect(result.route!.points.every(point => point.y < 1393)).toBe(true)
    expect(planner.railwayWidthAllows(result.route!.points, .01, 8, 'collector')).toBe(true)
    expect(planner.railwayAllows(result.route!.points, 'collector')).toBe(true)
  })

  it('rejects future, nonpublic, or geometrically inexact contacts before spending route search', () => {
    let calls = 0
    const planner = { plan: () => { calls++; return null }, validate: () => true, railwayWidthAllows: () => true }
    expect(surveyLayoutCoverageAlignment({ ...base(), planner, to: { ...to, builtYear: 1995 } }).rejectedInput).toBe('era')
    expect(surveyLayoutCoverageAlignment({ ...base(), planner, isPublicContact: () => false }).rejectedInput).toBe('contact')
    expect(surveyLayoutCoverageAlignment({ ...base(), planner, from: { ...from, point: { x: 500, y: 200.01 } } }).rejectedInput).toBe('contact')
    expect(calls).toBe(0)
  })

  it('chooses both leg headings before planning and caps work at three independent pairs', () => {
    const calls: { a: Point; b: Point; options: PlanningOptions }[] = []
    const planner = { plan: (a: Point, b: Point, options: PlanningOptions): PlannedRoute | null => {
      calls.push({ a, b, options })
      if (a === through) return null
      return { points: [a, b], length: distance(a, b), cost: 1, bridgeLength: 0, method: 'direct' }
    }, validate: () => true, railwayWidthAllows: () => true }
    const result = surveyLayoutCoverageAlignment({ ...base(), planner })
    expect(result.route).toBeNull(); expect(calls).toHaveLength(6); expect(result.attempts).toHaveLength(3)
    for (let i = 0; i < calls.length; i += 2) {
      expect(calls[i]!.options.endHeading).toBe(calls[i + 1]!.options.startHeading)
      expect(calls[i]!.options.startHeading).toBe(Math.PI / 2)
      expect(calls[i + 1]!.options.endHeading).toBe(-Math.PI / 2)
    }
    expect(calls.every(call => call.options.maxNodes === 1800 && call.options.allowBridge === false && call.options.maximumGrade === .13 && call.options.through === undefined)).toBe(true)
  })

  it('repeats full width, acquisition, rail and grade checks on the joined alignment', () => {
    for (const blocked of ['width', 'ROW', 'rail', 'grade'] as const) {
      const real = new RoadPlanner({ width: 1600, height: 1500, areas: [], core: null })
      const result = surveyLayoutCoverageAlignment({ ...base(),
        planner: { plan: real.plan.bind(real), validate: () => blocked !== 'width', railwayWidthAllows: () => blocked !== 'rail' },
        rowAllows: () => blocked !== 'ROW', elevation: blocked === 'grade' ? point => point.y * .2 : () => 0,
      })
      expect(result.route).toBeNull()
      expect(result.attempts.some(attempt => attempt.reason === blocked), JSON.stringify(result.attempts)).toBe(true)
      expect(result.attempts).toHaveLength(3)
    }
  })

  it('does not grant a station-side closure permission to occupy the surface running track', () => {
    const planner = new RoadPlanner({ width: 1600, height: 1500, areas: [], core: null })
    planner.setRailwayCorridors([{ id: 'surface-track', mode: 'surface', builtYear: 1900, points: [{ x: 0, y: through.y }, { x: 1600, y: through.y }] }])
    planner.setRailwayRoadNetwork([oldRoad])
    const result = surveyLayoutCoverageAlignment({ ...base(), planner })
    expect(result.route).toBeNull()
  })
})
