import { describe, expect, it } from 'vitest'
import { RoadPlanner } from './road-planner'
import type { Area, Point } from './types'
import { alignmentDiagnostics } from './road-alignment'
import { PlanarRoadGraph } from './road-graph'
import { surveyedRoadGradeAllowed } from './surveyed-road-profile'

const water: Area = { id: 'river', kind: 'water', polygon: [{ x: 480, y: 0 }, { x: 520, y: 0 }, { x: 520, y: 800 }, { x: 480, y: 800 }] }
const river = (p: Point) => p.x >= 480 && p.x <= 520

describe('terrain route planning', () => {
  it('keeps field cache cells distinct across rows and outside the planning frame', () => {
    const planner = new RoadPlanner({ width: 120, height: 120, areas: [], core: null,
      terrain: { elevation: p => Math.max(0, p.x * 2 + p.y), slope: () => 0, waterAt: () => false, bridgeSites: [] },
    })
    const costAt = (p: Point) => planner.cost([p, { x: p.x + .1, y: p.y }], 'lane').cost
    const outside = { x: -6, y: 6 }, rowEnd = { x: 132, y: 0 }
    const a = costAt(outside), b = costAt(rowEnd)
    expect(a).not.toBe(b)
    expect(costAt(outside)).toBe(a)
    expect(costAt(rowEnd)).toBe(b)
    // These cells would alias if the 24m cache encoded negative x without fallback.
    const earthOutside = costAt({ x: -24, y: 24 }), earthRowEnd = costAt({ x: 168, y: 0 })
    expect(earthOutside).not.toBe(earthRowEnd)
    expect(costAt({ x: -24, y: 24 })).toBe(earthOutside)
  })

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
    expect(alignmentDiagnostics(route!.points).minimumRadius).toBeGreaterThan(49)
    const entry = route!.points.findIndex(p => Math.hypot(p.x - 455, p.y - 400) < 1e-6)
    expect(entry).toBeGreaterThan(0)
    const a = route!.points[entry - 1]!, b = route!.points[entry]!, c = route!.points[entry + 1]!
    const difference = Math.atan2(b.y - a.y, b.x - a.x) - Math.atan2(c.y - b.y, c.x - b.x)
    expect(Math.abs(Math.atan2(Math.sin(difference), Math.cos(difference)))).toBeLessThan(.035)
  })

  it('routes around an inaccessible historic enclosure instead of cutting its corners', () => {
    const core = [{ x: 350, y: 220 }, { x: 650, y: 220 }, { x: 650, y: 580 }, { x: 350, y: 580 }]
    const planner = new RoadPlanner({ width: 1000, height: 800, areas: [], core })
    const route = planner.plan({ x: 90, y: 400 }, { x: 910, y: 400 }, { role: 'collector', width: 9 })
    expect(route).not.toBeNull()
    expect(planner.validate(route!.points, 9)).toBe(true)
    expect(route!.length).toBeGreaterThan(820)
    expect(route!.points.some(p => p.y < 215 || p.y > 585)).toBe(true)
    expect(alignmentDiagnostics(route!.points).minimumRadius).toBeGreaterThan(49)
  })

  it('connects opposite lowlands across a trunk and a tributary using two surveyed bridges', () => {
    const waterAt = (p: Point) => (p.x >= 480 && p.x <= 520) || (p.x >= 960 && p.x <= 1000)
    const bridgeCandidates = [{ point: { x: 500, y: 500 }, bankA: { x: 455, y: 500 }, bankB: { x: 545, y: 500 }, width: 40, cost: 100 }, { point: { x: 980, y: 500 }, bankA: { x: 935, y: 500 }, bankB: { x: 1025, y: 500 }, width: 40, cost: 100 }]
    const environment = { width: 1600, height: 1000, areas: [], core: null, terrain: { elevation: () => 0, slope: () => 0, waterAt, bridgeSites: [bridgeCandidates[0]!.point], bridgeCandidates } }
    const planner = new RoadPlanner(environment)
    const route = planner.plan({ x: 100, y: 400 }, { x: 1500, y: 600 }, { role: 'collector', width: 9.5, allowBridge: true })
    expect(route).not.toBeNull()
    expect(route!.method).toBe('bridge-project')
    expect(route!.bridgeLength).toBeGreaterThan(70)
    for (const p of route!.points.filter(waterAt)) expect(Math.abs(p.y - 500)).toBeLessThan(1e-6)
    expect(alignmentDiagnostics(route!.points).minimumRadius).toBeGreaterThan(49)
    expect(route!.cost - planner.cost(route!.points, 'collector', true).cost).toBeGreaterThan(419)
    const incompleteSurvey = new RoadPlanner({ ...environment, terrain: { ...environment.terrain, bridgeCandidates: bridgeCandidates.slice(0, 1) } })
    expect(incompleteSurvey.plan({ x: 100, y: 400 }, { x: 1500, y: 600 }, { role: 'collector', width: 9.5, allowBridge: true })).toBeNull()
  })

  it('records even a narrow tributary as a surveyed bridge rather than missing it between cost samples', () => {
    const waterAt = (p: Point) => p.x > 500.1 && p.x < 501.7
    const terrain = { elevation: () => 0, slope: () => 0, waterAt, bridgeSites: [{ x: 500.9, y: 400 }], bridgeCandidates: [{ point: { x: 500.9, y: 400 }, bankA: { x: 465, y: 400 }, bankB: { x: 537, y: 400 }, width: 1.6, cost: 10 }] }
    const planner = new RoadPlanner({ width: 1000, height: 800, areas: [], core: null, terrain })
    const route = planner.plan({ x: 100, y: 400 }, { x: 900, y: 400 }, { role: 'collector', width: 9, allowBridge: true })
    expect(route).not.toBeNull()
    expect(route!.bridgeLength).toBeCloseTo(1.6, 2)
    expect(route!.method).toBe('bridge-project')
    const unsurveyed = new RoadPlanner({ width: 1000, height: 800, areas: [], core: null, terrain: { ...terrain, bridgeSites: [], bridgeCandidates: [] } })
    expect(unsurveyed.plan({ x: 100, y: 400 }, { x: 900, y: 400 }, { role: 'collector', width: 9, allowBridge: true })).toBeNull()
  })

  it('distinguishes a surveyed straight estate street from a terrain and acquisition led collector', () => {
    const planner = new RoadPlanner({ width: 800, height: 650, areas: [], core: null, landCost: p => p.x > 220 && p.x < 420 && p.y > 200 && p.y < 450 ? 8 : 0 })
    const start = { x: 80, y: 320 }, goal = { x: 680, y: 320 }
    const natural = planner.plan(start, goal, { role: 'collector', width: 9 })
    const surveyed = planner.plan(start, goal, { role: 'lane', width: 6.5, alignment: 'planned' })
    expect(natural).not.toBeNull()
    expect(surveyed).not.toBeNull()
    expect(alignmentDiagnostics(natural!.points).minimumRadius).toBeGreaterThan(49)
    expect(natural!.points.some(p => Math.abs(p.y - 320) > 70)).toBe(true)
    expect(surveyed!.points.every(p => Math.abs(p.y - 320) < 1e-7)).toBe(true)
    expect(natural!.cost).toBeLessThan(planner.cost([start, goal], 'collector').cost)
  })

  it('carries an inherited through-road tangent into a new regional extension', () => {
    const planner = new RoadPlanner({ width: 1400, height: 1000, areas: [], core: null })
    const route = planner.plan({ x: 400, y: 300 }, { x: 1200, y: 800 }, { role: 'highway', width: 13, startHeading: 0 })
    expect(route).not.toBeNull()
    const first = route!.points[0]!, second = route!.points[1]!
    expect(Math.abs(Math.atan2(second.y - first.y, second.x - first.x))).toBeLessThan(.02)
    const joined = [{ x: 100, y: 300 }, ...route!.points]
    expect(alignmentDiagnostics(joined).minimumRadius).toBeGreaterThan(84)
  })

  it('replaces the castle-south needle Y with a physical perpendicular collector approach', () => {
    // The reported city junction coordinates, isolated from changing DEM seeds.
    const hub = { x: 1855, y: 1727 }, market = { x: 1269.95, y: 2315.81 }, graph = new PlanarRoadGraph()
    const metadata = { id: 'old-main', phase: 'regional', builtYear: 1650, role: 'highway' as const, kind: 'arterial' as const, width: 13, reason: 'old east-west road', constructionCost: 1000 }
    graph.add([{ x: 1000, y: 1680 }, hub, { x: 2450, y: 1760 }], metadata, false)
    graph.add([{ x: 1000, y: 1680 }, { x: 950, y: 2450 }, market], { ...metadata, id: 'old-farm', role: 'farm', width: 3.5, kind: 'local' })
    const startHeading = graph.junctionHeading(hub, market)!, endHeading = graph.junctionHeading(market, hub)! + Math.PI
    const planner = new RoadPlanner({ width: 4000, height: 3000, areas: [], core: null })
    const route = planner.plan(hub, market, { role: 'collector', width: 9.5, startHeading, endHeading })
    expect(route).not.toBeNull()
    expect(planner.validate(route!.points, 9.5)).toBe(true)
    const initial = Math.atan2(route!.points[1]!.y - hub.y, route!.points[1]!.x - hub.x)
    const old = Math.atan2(33, 595)
    expect(Math.acos(Math.abs(Math.cos(initial - old))) * 180 / Math.PI).toBeGreaterThan(70)
    expect(alignmentDiagnostics(route!.points).minimumRadius).toBeGreaterThan(49)
    expect(graph.hasAcuteMajorCrossing(route!.points)).toBe(false)
  })

  it('allows a real island road while treating secondary sea polygons as unbridgeable water', () => {
    const sea: Area = { id: 'sea-secondary', kind: 'water', polygon: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 800 }, { x: 0, y: 800 }], holes: [[{ x: 300, y: 200 }, { x: 700, y: 200 }, { x: 700, y: 600 }, { x: 300, y: 600 }]] }
    const planner = new RoadPlanner({ width: 1000, height: 800, areas: [sea], core: null })
    expect(planner.waterAt({ x: 500, y: 400 })).toBe(false)
    expect(planner.waterAt({ x: 850, y: 400 })).toBe(true)
    const road = planner.plan({ x: 360, y: 400 }, { x: 640, y: 400 }, { role: 'lane', width: 6, alignment: 'planned' })
    expect(road).not.toBeNull()
    expect(planner.validate(road!.points, 6)).toBe(true)
    expect(planner.validate([{ x: 500, y: 400 }, { x: 850, y: 400 }], 6, true)).toBe(false)
  })

  it('does not reuse a failed strict-grade bridge approach for a feasible gentler policy', () => {
    const terrain = { elevation: (p: Point) => river(p) ? 0 : p.y * .08, slope: () => .08, waterAt: river, bridgeSites: [{ x: 500, y: 400 }], bridgeCandidates: [{ point: { x: 500, y: 400 }, bankA: { x: 455, y: 400 }, bankB: { x: 545, y: 400 }, width: 40, cost: 100 }] }
    const planner = new RoadPlanner({ width: 1000, height: 800, areas: [water], core: null, terrain })
    const start = { x: 100, y: 100 }, goal = { x: 900, y: 700 }
    expect(planner.plan(start, goal, { role: 'collector', width: 9, allowBridge: true, maximumGrade: .01 })).toBeNull()
    const route = planner.plan(start, goal, { role: 'collector', width: 9, allowBridge: true, maximumGrade: .10 })
    expect(route).not.toBeNull()
    expect(route!.surveyedBridgeSpans).toHaveLength(1)
    expect(surveyedRoadGradeAllowed(route!, .10, terrain.elevation)).toBe(true)
    // A second strict request must still reject the gentler policy's route.
    expect(planner.plan(start, goal, { role: 'collector', width: 9, allowBridge: true, maximumGrade: .01 })).toBeNull()
  })

  it('measures an explicit grade limit on a surveyed bridge deck rather than the river bed', () => {
    const terrain = { elevation: (p: Point) => river(p) ? -40 : 100, slope: () => 0, waterAt: river, bridgeSites: [{ x: 500, y: 400 }], bridgeCandidates: [{ point: { x: 500, y: 400 }, bankA: { x: 455, y: 400 }, bankB: { x: 545, y: 400 }, width: 40, cost: 100 }] }
    const planner = new RoadPlanner({ width: 1000, height: 800, areas: [water], core: null, terrain })
    const route = planner.plan({ x: 100, y: 400 }, { x: 900, y: 400 }, { role: 'highway', width: 8.5, allowBridge: true, maximumGrade: .10 })
    expect(route).not.toBeNull()
    expect(surveyedRoadGradeAllowed(route!, .10, terrain.elevation)).toBe(true)
    expect(route!.surveyedBridgeSpans).toHaveLength(1)
  })
})
