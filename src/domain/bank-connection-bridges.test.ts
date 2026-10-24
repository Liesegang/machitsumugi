import { describe, expect, it } from 'vitest'
import { bankBridgePolicy, bankConnectionProjects, investInBankConnections, surveyBankConnections } from './bank-connection-bridges'
import { PlanarRoadGraph } from './road-graph'
import { RoadPlanner } from './road-planner'
import { rectangle } from './geometry'
import type { Point } from './types'

function fixture(span = 240, connected = true, setback = 130) {
  const left = 600 - span / 2, right = 600 + span / 2, a = { x: left - setback, y: 500 }, b = { x: right + setback, y: 500 }
  const graph = new PlanarRoadGraph(), metadata = { role: 'lane' as const, kind: 'local' as const, width: 5, builtYear: 1800, phase: 'oldtown', reason: '既存の両岸市街地', constructionCost: 1000 }
  graph.add([{ x: a.x, y: 100 }, { x: a.x, y: 1100 }], { ...metadata, id: 'west-bank' }, false)
  graph.add([{ x: b.x, y: 100 }, { x: b.x, y: 1100 }], { ...metadata, id: 'east-bank' }, false)
  if (connected) graph.add([{ x: a.x, y: 1100 }, { x: b.x, y: 1100 }], { ...metadata, id: 'old-long-detour' })
  const waterAt = (p: Point) => p.x >= left && p.x <= right && p.y <= 1000
  const terrain = { elevation: () => 10, slope: () => 0, waterAt, seaAt: () => false, bridgeSites: [], bridgeCandidates: [] }
  const planner = new RoadPlanner({ width: 1600, height: 1300, areas: [{ id: 'river', kind: 'water', polygon: rectangle(left, 0, span, 1000) }], core: null, terrain })
  // All existing capacity is occupied. Neither unmet housing demand nor vacant
  // supply is an input to the resident-funded bridge programme.
  const cells = [a, b].map(point => ({ point, households: 600, capacity: 600, area: 100_000, frontageDepth: 20 }))
  return { graph, planner, cells, year: 1960, settlement: 'regional-city', cache: new Map(), availableFunds: () => 20_000, a, b }
}

describe('bridges connecting already inhabited banks', () => {
  it('surveys and funds a wide river connection without vacant pads or housing demand', () => {
    const input = fixture(), survey = surveyBankConnections(input)[0]!
    expect(survey).toBeDefined(); expect(survey.waterSpan).toBeCloseTo(240, 1)
    expect(input.planner.environment.terrain!.bridgeCandidates).toEqual([])
    const project = [...bankConnectionProjects(input)][0]!
    expect(project).toBeDefined(); expect(project.width).toBe(9.5)
    expect(project.route.bridgeLength).toBeCloseTo(240, 1)
    expect(project.route.surveyedBridgeSpans).toHaveLength(1)
    expect(project.disconnected).toBe(false); expect(project.benefit).toBeGreaterThan(project.route.cost)
    expect(input.planner.validate(project.route.points, project.width, true)).toBe(true)
    expect(input.graph.roads).toHaveLength(3)
  })

  it('uses finite connection benefit for separated road components', () => {
    const input = fixture(240, false), project = [...bankConnectionProjects(input)][0]!
    expect(input.graph.travelTime(input.a, input.b)).toBe(Infinity)
    expect(project).toBeDefined(); expect(project.disconnected).toBe(true)
    expect(Number.isFinite(project.minutesSaved)).toBe(true)
    expect(Number.isFinite(project.benefit)).toBe(true)
    expect(project.minutesSaved).toBeLessThan(15)
  })

  it('charges only an atomic successful project, archives it and reuses its crossing in later rounds', () => {
    const input = fixture(), before = input.graph.travelTime(input.a, input.b), original = JSON.stringify(input.graph.roadHistory)
    expect(investInBankConnections({ ...input, funds: 20_000, commit: () => false })).toEqual({ spent: 0, completed: 0 })
    expect(JSON.stringify(input.graph.roadHistory)).toBe(original)
    const result = investInBankConnections({ ...input, funds: 20_000, commit: project => {
      const span = project.route.surveyedBridgeSpans![0]!, metadata = { role: 'collector' as const, kind: 'local' as const, width: project.width, builtYear: 1960, phase: 'suburban', reason: '両岸連絡橋事業', constructionCost: project.route.cost, preserveEndpoint: true }
      return !!input.graph.addBatch([
        { points: [input.a, span.bankA], metadata: { ...metadata, id: 'paid-approach' } },
        { points: [span.bankA, span.bankB], metadata: { ...metadata, id: 'paid-deck', role: 'bridge', bridge: true } },
        { points: [span.bankB, input.b], metadata: { ...metadata, id: 'paid-exit' } },
      ])
    } })
    expect(result.completed).toBe(1); expect(result.spent).toBeGreaterThan(0); expect(result.spent).toBeLessThanOrEqual(20_000)
    expect(input.graph.travelTime(input.a, input.b)).toBeLessThan(before)
    expect(input.graph.roadHistory.filter(version => version.from === 1960)).toHaveLength(3)
    expect(investInBankConnections({ ...input, year: 1970, funds: 20_000, commit: () => { throw new Error('A duplicate bridge must not be committed') } })).toEqual({ spent: 0, completed: 0 })
  })

  it('keeps class, period, funds, occupied-bank and sea limits', () => {
    const input = fixture()
    expect(bankBridgePolicy(1850, 'metropolis')).toBeNull()
    expect(bankBridgePolicy(1960, 'village')).toBeNull()
    expect([...bankConnectionProjects({ ...input, year: 1930 })]).toEqual([])
    expect([...bankConnectionProjects({ ...input, availableFunds: () => 500 })]).toEqual([])
    expect([...bankConnectionProjects({ ...input, cells: input.cells.map((c, i) => i ? { ...c, households: 0 } : c) })]).toEqual([])
    expect([...bankConnectionProjects({ ...input, cells: [] })]).toEqual([])
    expect(investInBankConnections({ ...input, year: 1965, funds: 20_000, commit: () => { throw new Error('Only ten-year rounds construct bridges') } })).toEqual({ spent: 0, completed: 0 })
    for (const patch of [{ seaAt: () => true }, { slope: () => .25 }]) {
      const changed = fixture(); changed.planner.environment.terrain = { ...changed.planner.environment.terrain!, ...patch }
      expect([...bankConnectionProjects(changed)]).toEqual([])
    }
    const wide = fixture(400)
    expect([...bankConnectionProjects(wide)]).toEqual([])
    expect(surveyBankConnections({ ...wide, settlement: 'metropolis' })[0]!.waterSpan).toBeCloseTo(400, 1)
    expect([...bankConnectionProjects({ ...wide, settlement: 'metropolis', cells: wide.cells.map(c => ({ ...c, households: 1200, capacity: 1200 })) })]).toHaveLength(1)
    expect([...bankConnectionProjects({ ...fixture(80), year: 1930 })]).toHaveLength(1)
    expect([...bankConnectionProjects({ ...fixture(500), settlement: 'metropolis' })]).toEqual([])
    const ocean = fixture(); ocean.planner.environment.areas[0]!.id = 'sea'
    expect(surveyBankConnections(ocean)).toEqual([])
  })

  it('resurveys railway constraints and cannot add a nearby new level crossing on a bank approach', () => {
    const input = fixture(), first = [...bankConnectionProjects(input)][0]!
    expect(first).toBeDefined()
    const x = input.a.x + 40
    input.planner.setRailwayCorridors([{ id: 'surface-rail', points: [{ x, y: 0 }, { x, y: 1300 }] }])
    input.planner.setRailwayRoadNetwork([{ id: 'old-gate', kind: 'local', width: 6, points: [{ x: x - 30, y: 490 }, { x: x + 30, y: 490 }] }])
    expect([...bankConnectionProjects(input)]).toEqual([])
    input.planner.setRailwayCorridors([{ id: 'subway', mode: 'subway', points: [{ x, y: 0 }, { x, y: 1300 }] }])
    expect([...bankConnectionProjects(input)]).toHaveLength(1)
  })

  it('bounds surveys and merges nearby occupied OD pairs instead of increasing bridges with every house', () => {
    const input = fixture(), cells = Array.from({ length: 200 }, (_, i) => ({ point: { x: i % 2 ? input.a.x : input.b.x, y: 300 + Math.floor(i / 2) * 4 }, households: 12, area: 9500, frontageDepth: 20 }))
    const surveys = surveyBankConnections({ ...input, cells })
    expect(surveys.length).toBeGreaterThan(0); expect(surveys.length).toBeLessThanOrEqual(3)
    for (const [i, survey] of surveys.entries()) for (const other of surveys.slice(i + 1)) expect(Math.hypot(survey.middle.x - other.middle.x, survey.middle.y - other.middle.y)).toBeGreaterThanOrEqual(240)
  })

  it('retains far-bank demand when additional occupied sites lie along the denser bank', () => {
    const graph = new PlanarRoadGraph(), metadata = { role: 'lane' as const, kind: 'local' as const, width: 5, builtYear: 1800, phase: 'oldtown', reason: '既存岸道', constructionCost: 1000 }
    for (const [id, x] of [['west', 350], ['east', 650]] as const) graph.add([{ x, y: 50 }, { x, y: 8900 }], { ...metadata, id }, false)
    const waterAt = (p: Point) => p.x >= 400 && p.x <= 600 && p.y <= 8800
    const planner = new RoadPlanner({ width: 1200, height: 9000, areas: [{ id: 'river', kind: 'water', polygon: rectangle(400, 0, 200, 8800) }], core: null, terrain: { elevation: () => 10, slope: () => 0, waterAt, seaAt: () => false, bridgeSites: [] } })
    const west = Array.from({ length: 128 }, (_, i) => ({ point: { x: 350, y: 500 + i * 65 }, households: 40, frontageDepth: 20 }))
    const east = { point: { x: 650, y: 500 }, households: 25, frontageDepth: 20 }
    const survey = (count: number) => surveyBankConnections({ graph, planner, cells: [...west.slice(0, count), east], year: 1960, settlement: 'regional-city' })
    expect(survey(127).length).toBeGreaterThan(0)
    const crowded = survey(128)
    expect(crowded.length).toBeGreaterThan(0)
    expect(crowded.every(s => (s.a.x < 400 && s.b.x > 600) || (s.b.x < 400 && s.a.x > 600))).toBe(true)
    expect(crowded.length).toBeLessThanOrEqual(48)
  })

  it('does not merge opposite banks of a narrow river into one nearby street anchor', () => {
    const input = fixture(10, false, 15)
    expect(Math.hypot(input.a.x - input.b.x, input.a.y - input.b.y)).toBeLessThan(65)
    expect(surveyBankConnections(input)[0]?.waterSpan).toBeCloseTo(10, 1)
  })

  it('does not mistake a nearby pond bridge for a crossing of the surveyed river', () => {
    const input = fixture(), terrain = input.planner.environment.terrain!
    const areas = [{ id: 'river', kind: 'water' as const, polygon: rectangle(480, 0, 240, 600) }, { id: 'pond', kind: 'water' as const, polygon: rectangle(560, 650, 80, 100) }]
    const waterAt = (p: Point) => (p.x >= 480 && p.x <= 720 && p.y <= 600) || (p.x >= 560 && p.x <= 640 && p.y >= 650 && p.y <= 750)
    input.planner = new RoadPlanner({ ...input.planner.environment, areas, terrain: { ...terrain, waterAt } })
    expect(surveyBankConnections(input)).toHaveLength(1)
    input.graph.add([{ x: 550, y: 700 }, { x: 650, y: 700 }], { id: 'pond-deck', role: 'bridge', bridge: true, kind: 'local', width: 6, builtYear: 1900, phase: 'railway', reason: '別の池の橋', constructionCost: 1000 }, false)
    expect(surveyBankConnections(input)).toHaveLength(1)
    expect([...bankConnectionProjects(input)]).toHaveLength(1)
  })

  it('allows a surveyed freshwater lake crossing and reuses a genuine crossing of that lake', () => {
    const input = fixture(); input.planner.environment.areas[0]!.id = 'lake'
    expect(surveyBankConnections(input)[0]?.waterId).toBe('lake')
    input.graph.add([{ x: input.a.x, y: 700 }, { x: input.b.x, y: 700 }], { id: 'lake-deck', role: 'bridge', bridge: true, kind: 'local', width: 6, builtYear: 1900, phase: 'railway', reason: '同じ湖の既存橋', constructionCost: 1000 }, false)
    expect(surveyBankConnections(input)).toEqual([])
  })
})
