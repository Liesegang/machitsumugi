import { expect, it } from 'vitest'
import { layoutCoverageHasPhysicalGain, runLayoutCoveragePass } from './layout-first-coverage-pass'
import { surveyLayoutCoverageAlignment } from './layout-first-coverage-survey'
import { PlanarRoadGraph, extractStreetBlocks, roadLength } from './road-graph'
import { RoadPlanner } from './road-planner'
import { distance, distanceToSegment, polygonArea, rectangle } from './geometry'
import { createLayoutCoverageMask, measureLayoutCoverageGain } from './layout-first-coverage-blocks'
import type { Point } from './types'
import type { LayoutCoverageProposal } from './layout-first-coverage-blocks'

const metadata = { kind: 'local' as const, role: 'collector' as const, width: 9, builtYear: 1650, phase: 'test', reason: 'real public frontage', constructionCost: 100 }

it('uses NEW real fallback pavement for a second closure pass and measures the adopted dry face', () => {
  const graph = new PlanarRoadGraph(), planner = new RoadPlanner({ width: 1400, height: 1400, areas: [], core: null })
  graph.add([{ x: 0, y: 200 }, { x: 1200, y: 200 }], { ...metadata, id: 'old-street' }, false)
  const region = { polygon: rectangle(100, 200, 650, 900) }, mask = createLayoutCoverageMask({ demandRegions: [region], suitableRegions: [region], excludedRegions: [] })
  const readNetwork = () => ({ roads: graph.roads.filter(road => road.builtYear <= 1955), faces: extractStreetBlocks(graph.roads.filter(road => road.builtYear <= 1955)) })
  const early = runLayoutCoveragePass({ mask, builtYear: 1955, phase: 'before-fallback', maximumAttempts: 2, cellSize: 100, readNetwork, canAnchor: () => true, tryAdoptWithFaceGain: () => false })
  expect(early.accepted).toBe(0); expect(early.attempted).toBe(2)
  // This connected public reach is genuine accepted fallback pavement; it
  // leaves a new 1955 frontage contact, but it does not close a face itself.
  graph.add([{ x: 0, y: 200 }, { x: 0, y: 1000 }, { x: 1200, y: 1000 }], { ...metadata, id: 'fallback-frontage', builtYear: 1955 })
  expect(readNetwork().faces).toHaveLength(0)
  const accepted: LayoutCoverageProposal[] = []
  const diagnostic: unknown[] = []
  const contact = (anchor: LayoutCoverageProposal['from'], year: number) => graph.roads.some(road => road.id === anchor.roadId && road.builtYear <= year && road.width >= 4.6 && !road.controlledAccess && road.points.slice(1).some((point, index) => distanceToSegment(anchor.point, road.points[index]!, point) < 1e-7))
  const tryAdoptWithFaceGain = (proposal: LayoutCoverageProposal, beforeFaces: readonly Point[][]) => {
    // Use actual new frontage contacts: no imaginary point on a demand edge.
    if (![proposal.from, proposal.to].some(anchor => anchor.roadId === 'fallback-frontage')) { diagnostic.push({ proposal, reason: 'no fallback contact' }); return false }
    const startHeading = graph.junctionHeading(proposal.from.point, proposal.through), endHeading = graph.junctionHeading(proposal.to.point, proposal.through)
    const survey = surveyLayoutCoverageAlignment({ ...proposal, planner, isPublicContact: contact, elevation: () => 0, rowAllows: () => true,
      ...(startHeading !== null ? { startHeading } : {}), ...(endHeading !== null ? { endHeading: endHeading + Math.PI } : {}) })
    if (!survey.route) { diagnostic.push({ proposal, attempts: survey.attempts, rejectedInput: survey.rejectedInput }); return false }
    const staged = graph.fork(), route = survey.route, id = `coverage-${accepted.length}`
    if (!staged.add(route.points, { ...metadata, id, builtYear: 1955, width: 8 })) return false
    const gain = measureLayoutCoverageGain({ beforeFaces, afterFaces: extractStreetBlocks(staged.roads), mask, streetLength: roadLength(route.points) })
    if (!layoutCoverageHasPhysicalGain(gain)) { diagnostic.push({ proposal, gain }); return false }
    if (!graph.add(route.points, { ...metadata, id, builtYear: 1955, width: 8 })) return false
    accepted.push(proposal); return true
  }
  const late = runLayoutCoveragePass({ mask, builtYear: 1955, phase: 'after-fallback', maximumAttempts: 4, cellSize: 100, readNetwork, canAnchor: () => true, tryAdoptWithFaceGain })
  expect(late.accepted, JSON.stringify({ late, diagnostic })).toBeGreaterThan(0)
  expect(late.coveredGain).toBeGreaterThan(10000)
  expect(late.after - late.before).toBeCloseTo(late.coveredGain, 4)
  expect(late.attempted).toBeLessThanOrEqual(4)
  expect(late.proposalRounds).toBeLessThanOrEqual(late.accepted + 1)
  expect(accepted.every(proposal => [proposal.from, proposal.to].some(anchor => anchor.roadId === 'fallback-frontage'))).toBe(true)
  for (const proposal of accepted) for (const anchor of [proposal.from, proposal.to]) {
    expect(contact(anchor, 1955)).toBe(true)
    expect(graph.roads.some(road => road.id === anchor.roadId && road.points.some(point => distance(point, anchor.point) < 1e-7))).toBe(true)
  }
})

it('never counts a claimed adoption without an actual closed dry face, and bounds failed attempts', () => {
  const graph = new PlanarRoadGraph()
  graph.add([{ x: 0, y: 200 }, { x: 1200, y: 200 }], { ...metadata, id: 'old' }, false)
  const region = { polygon: rectangle(0, 200, 1200, 1000) }, mask = createLayoutCoverageMask({ demandRegions: [region], suitableRegions: [region], excludedRegions: [] })
  let reads = 0, attempts = 0
  const input = { mask, builtYear: 1955, phase: 'after-fallback' as const, maximumAttempts: 3, cellSize: 100, readNetwork: () => { reads++; return { roads: graph.roads, faces: extractStreetBlocks(graph.roads) } }, canAnchor: () => true, tryAdoptWithFaceGain: () => { attempts++; return false } }
  const record = runLayoutCoveragePass(input)
  expect(record.accepted).toBe(0); expect(record.coveredGain).toBe(0)
  expect(attempts).toBeLessThanOrEqual(3); expect(reads).toBe(1); expect(record.proposalRounds).toBe(1)
  expect(() => runLayoutCoveragePass({ ...input, tryAdoptWithFaceGain: () => true })).toThrow('Coverage adoption changed no physical dry street face')
})

it('tries one real anchor pair in each dry gap before a second pair consumes the budget', () => {
  const graph = new PlanarRoadGraph()
  graph.add([{ x: 0, y: 200 }, { x: 3200, y: 200 }], { ...metadata, id: 'old' }, false)
  const regions = [0, 800, 1600, 2400].map(x => ({ polygon: rectangle(x, 200, 600, 900) }))
  const mask = createLayoutCoverageMask({ demandRegions: regions, suitableRegions: regions, excludedRegions: [] }), gaps = new Set<number>()
  const record = runLayoutCoveragePass({ builtYear: 1955, mask, phase: 'after-fallback', maximumAttempts: 4, cellSize: 100,
    readNetwork: () => ({ roads: graph.roads, faces: [] }), canAnchor: () => true,
    tryAdoptWithFaceGain: proposal => { gaps.add(Math.floor(proposal.through.x / 800)); return false },
  })
  expect(record.attempted).toBe(4)
  expect(gaps.size).toBe(4)
  expect(record.accepted).toBe(0)
})

it('adopts a newly enclosed >60ha dry major block, but gives no credit to the unchanged oversized face', () => {
  const graph = new PlanarRoadGraph(), planner = new RoadPlanner({ width: 1800, height: 1800, areas: [], core: null })
  graph.add([{ x: 100, y: 200 }, { x: 100, y: 1500 }], { ...metadata, id: 'west' }, false)
  graph.add([{ x: 100, y: 1500 }, { x: 1500, y: 1500 }], { ...metadata, id: 'south' })
  graph.add([{ x: 1500, y: 1500 }, { x: 1500, y: 200 }], { ...metadata, id: 'east' })
  const region = { polygon: rectangle(200, 200, 1200, 1300) }, mask = createLayoutCoverageMask({ demandRegions: [region], suitableRegions: [region], excludedRegions: [] })
  const readNetwork = () => ({ roads: graph.roads, faces: extractStreetBlocks(graph.roads) })
  expect(readNetwork().faces).toHaveLength(0)
  const input = { builtYear: 1955, mask, phase: 'after-fallback' as const, maximumAttempts: 1, cellSize: 100, readNetwork, canAnchor: () => true }
  const diagnostic: unknown[] = []
  const pass = runLayoutCoveragePass({ ...input, tryAdoptWithFaceGain: (proposal, beforeFaces) => {
    const isPublicContact = (anchor: LayoutCoverageProposal['from'], year: number) => graph.roads.some(road => road.id === anchor.roadId && road.builtYear <= year && road.points.slice(1).some((point, i) => distanceToSegment(anchor.point, road.points[i]!, point) < 1e-7))
    const startHeading = graph.junctionHeading(proposal.from.point, proposal.through), endHeading = graph.junctionHeading(proposal.to.point, proposal.through)
    const surveyed = surveyLayoutCoverageAlignment({ ...proposal, planner, isPublicContact, elevation: () => 0, rowAllows: () => true,
      ...(startHeading !== null ? { startHeading } : {}), ...(endHeading !== null ? { endHeading: endHeading + Math.PI } : {}) })
    if (!surveyed.route) { diagnostic.push({ proposal, attempts: surveyed.attempts, rejectedInput: surveyed.rejectedInput }); return false }
    const staged = graph.fork(), route = surveyed.route
    if (!staged.add(route.points, { ...metadata, id: 'new-coarse-closure', builtYear: 1955, width: 8 })) return false
    const gain = measureLayoutCoverageGain({ beforeFaces, afterFaces: extractStreetBlocks(staged.roads), mask, streetLength: roadLength(route.points) })
    expect(gain.coveredGain).toBe(0)
    expect(gain.enclosedGain).toBeGreaterThan(1000000)
    if (!layoutCoverageHasPhysicalGain(gain)) return false
    return !!graph.add(route.points, { ...metadata, id: 'new-coarse-closure', builtYear: 1955, width: 8 })
  } })
  expect(pass.accepted, JSON.stringify({ pass, diagnostic })).toBe(1)
  expect(pass.coveredGain).toBe(0)
  expect(pass.enclosedGain).toBeGreaterThan(1000000)
  expect(readNetwork().faces.some(face => polygonArea(face) > 600000)).toBe(true)
  expect(() => runLayoutCoveragePass({ ...input, tryAdoptWithFaceGain: () => true })).toThrow('Coverage adoption changed no physical dry street face')
})
