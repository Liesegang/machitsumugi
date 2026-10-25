import { expect, it } from 'vitest'
import { layoutMainCivilGuides, surveyLayoutMainCivilCrossings } from './layout-first-main-civil-bridges'
import type { LayoutMainCivilSurveyInput } from './layout-first-main-civil-bridges'
import type { Point } from './types'
import { distance, pointInRegion, rectangle } from './geometry'
import { RoadPlanner } from './road-planner'
import { alignmentDiagnostics } from './road-alignment'
import { surveyLayoutMainCorridors } from './layout-first-main-corridors'

const creek = { polygon: [{ x: 195, y: 0 }, { x: 205, y: 0 }, { x: 1205, y: 1000 }, { x: 1195, y: 1000 }] }
const channelAt = (p: Point) => { const x = (p.x + p.y + 200) / 2; return { point: { x, y: x - 200 }, tangent: { x: Math.SQRT1_2, y: Math.SQRT1_2 }, width: 10 / Math.SQRT2, bankDistance: Math.abs(p.y - p.x + 200) / Math.SQRT2 - 5 / Math.SQRT2, surfaceElevation: 10, riverId: 'tiny-creek' } }
const fixture = (): LayoutMainCivilSurveyInput => ({ guides: [[{ x: 50, y: 500 }, { x: 1550, y: 500 }]], width: 12, waterRegions: [creek], terrain: { elevation: () => 10, waterAt: p => pointInRegion(p, creek), seaAt: () => false, channelAt }, rowAllows: () => true, railwayAllows: () => true, bridgeAllows: () => true })

it('surveys the desired highway bearing across a skew tiny creek and measures its whole wet width', () => {
  const input = fixture(), candidates = surveyLayoutMainCivilCrossings(input), candidate = candidates[0]!
  expect(candidates).toHaveLength(1)
  expect(candidate.riverId).toBe('tiny-creek')
  expect(candidate.carriagewayWidth).toBe(12)
  expect(candidate.width).toBeCloseTo(10 / Math.SQRT2)
  expect(candidate.bankA.y).toBe(500); expect(candidate.bankB.y).toBe(500)
  expect(candidate.wetLength).toBeGreaterThan(20)
  expect(distance(candidate.bankA, candidate.bankB)).toBeLessThan(100)
  // The new exact bank pair permits a straight physical highway. A forced
  // river-normal pair would instead impose diagonal departure tangents.
  const normal = { ...candidate, id: 'old-normal', bankA: { x: candidate.point.x - 50 * Math.SQRT1_2, y: candidate.point.y + 50 * Math.SQRT1_2 }, bankB: { x: candidate.point.x + 50 * Math.SQRT1_2, y: candidate.point.y - 50 * Math.SQRT1_2 } }
  const terrain = { ...input.terrain, slope: () => 0, bridgeSites: [candidate.point], bridgeCandidates: [normal, candidate] }
  const planner = new RoadPlanner({ width: 1600, height: 1000, core: null, areas: [], terrain })
  const route = planner.plan(input.guides[0]![0]!, input.guides[0]![1]!, { role: 'highway', width: 12, alignment: 'planned', allowBridge: true, maximumGrade: .09 })!
  expect(route).not.toBeNull()
  expect(route.points.every(point => Math.abs(point.y - 500) < 1e-7)).toBe(true)
  expect(route.surveyedBridgeSpans?.[0]?.candidateId).toBe(candidate.id)
  expect(alignmentDiagnostics(route.points).minimumRadius).toBeGreaterThanOrEqual(85)
  expect(planner.validate(route.points, 12, true)).toBe(true)
})

it('retains a narrow water strip at arbitrary sub-sample position', () => {
  const tiny = { polygon: rectangle(700.13, 0, .4, 1000) }, input = fixture()
  input.waterRegions = [tiny]; input.terrain = { ...input.terrain, waterAt: p => pointInRegion(p, tiny), channelAt: p => ({ ...channelAt(p), riverId: 'submetre', bankDistance: Math.abs(p.x - 700.33) - .2 }) }
  expect(surveyLayoutMainCivilCrossings(input)[0]!.wetLength).toBeCloseTo(.4, 3)
})

it('integrates civil crossings into a direct portal highway without replacing the native fallback pair', () => {
  const input = fixture(), old = { id: 'old-normal', point: { x: 700, y: 500 }, bankA: { x: 650, y: 550 }, bankB: { x: 750, y: 450 }, riverId: 'tiny-creek', width: 10 / Math.SQRT2, cost: 100 }
  const terrain = { ...input.terrain, slope: () => 0, bridgeSites: [old.point], bridgeCandidates: [old], continuationTerrain: { ...input.terrain, slope: () => 0 } }
  const environment = { width: 1600, height: 1000, core: null, areas: [{ ...creek, id: 'tiny-creek', kind: 'water' as const }], terrain }
  const planner = new RoadPlanner(environment), result = surveyLayoutMainCorridors({ environment, center: { x: 800, y: 500 }, zones: [400, 1200].map((x, i) => ({ id: `z${i}`, center: { x, y: 500 }, polygon: rectangle(x - 150, 350, 300, 300), radius: 150, kind: 'residential' as const, builtYear: 1955, density: 1, maximumFloors: 6 })), railways: [], civilSurvey: { rowAllows: () => true, railwayAllows: () => true, bridgeAllows: (points, width) => planner.validate(points, width, true) } }, () => true)
  const main = result.find(proposal => proposal.id === 'layout-main-corridor-1')!
  expect(main).toBeDefined()
  expect(main.route.points.every(point => Math.abs(point.y - 500) < 1e-7)).toBe(true)
  expect(main.route.surveyedBridgeSpans![0]!.candidateId).toMatch(/^main-civil-/)
  expect(terrain.bridgeCandidates).toEqual([old])
})

it('rejects sea, protected ground, rail conflicts and failed full-width civil validation', () => {
  for (const policy of ['sea', 'row', 'rail', 'width'] as const) {
    const input = fixture()
    if (policy === 'sea') input.terrain.seaAt = () => true
    if (policy === 'row') input.rowAllows = () => false
    if (policy === 'rail') input.railwayAllows = () => false
    if (policy === 'width') input.bridgeAllows = () => false
    expect(surveyLayoutMainCivilCrossings(input)).toEqual([])
  }
})

it('rejects an excessive longitudinal bank grade and a short hidden abutment slope', () => {
  const steep = fixture(); steep.terrain.elevation = p => p.x * .2
  expect(surveyLayoutMainCivilCrossings(steep)).toEqual([])
  const rippled = fixture(); rippled.terrain.elevation = p => 10 + Math.sin(p.x * Math.PI / 4) * 5
  expect(surveyLayoutMainCivilCrossings(rippled)).toEqual([])
})

it('keeps water holes and disconnected nearby water bodies out of false bridge surveys', () => {
  const input = fixture(), holed = { polygon: rectangle(500, 0, 400, 1000), holes: [rectangle(450, 450, 500, 100)] }
  input.waterRegions = [holed]; input.terrain.waterAt = p => pointInRegion(p, holed)
  expect(surveyLayoutMainCivilCrossings(input)).toEqual([])
  const near = fixture(); near.waterRegions = [creek, { polygon: rectangle(650, 400, 15, 200) }]; near.terrain.waterAt = p => near.waterRegions.some(region => pointInRegion(p, region))
  expect(surveyLayoutMainCivilCrossings(near)).toEqual([])
})

it('uses finite geographic guide families and deterministic bounded candidates', () => {
  const input = fixture(); input.guides = layoutMainCivilGuides({ x: 50, y: 500 }, { x: 1550, y: 500 }); input.maximumCandidates = 2
  expect(input.guides).toHaveLength(5)
  const first = surveyLayoutMainCivilCrossings(input)
  expect(first.length).toBeLessThanOrEqual(2)
  expect(surveyLayoutMainCivilCrossings(input)).toEqual(first)
  expect(first[0]!.bearing).toBe(0)
})
