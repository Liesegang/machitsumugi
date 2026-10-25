import { describe, expect, it } from 'vitest'
import type { Road } from './types'
import { distanceToSegment, pointInRegion, rectangle } from './geometry'
import { createLayoutCoverageMask, measureLayoutCoverageGain, measureLayoutStreetCoverage, proposeLayoutCoverageBlocks } from './layout-first-coverage-blocks'

const frame = { polygon: rectangle(0, 0, 1200, 1000) }
const oldRoad: Road = { id: 'old-regional-road', kind: 'local', role: 'collector', width: 9, builtYear: 1650, points: [{ x: 0, y: 0 }, { x: 1200, y: 0 }] }
const flatMask = () => createLayoutCoverageMask({ demandRegions: [frame], suitableRegions: [frame], excludedRegions: [] })

describe('dry demand coverage by actual street faces', () => {
  it('counts only the suitable intersection once and preserves water/reserved holes', () => {
    const mask = createLayoutCoverageMask({ demandRegions: [{ polygon: rectangle(0, 0, 1000, 1000) }, { polygon: rectangle(500, 0, 1000, 1000) }], suitableRegions: [frame],
      excludedRegions: [{ polygon: rectangle(200, 200, 100, 100) }, { polygon: rectangle(700, 400, 200, 100) }] })
    expect(mask.area).toBe(1170000)
    expect(mask.regions.reduce((sum, region) => sum + (region.holes?.length ?? 0), 0)).toBe(2)
    expect(mask.regions.some(region => pointInRegion({ x: 250, y: 250 }, region))).toBe(false)
    expect(mask.regions.some(region => pointInRegion({ x: 750, y: 450 }, region))).toBe(false)
    const measured = measureLayoutStreetCoverage({ faces: [frame.polygon, frame.polygon], mask, maximumFaceArea: 2000000 })
    expect(measured.coveredArea).toBe(1170000)
    expect(measured.uncoveredArea).toBe(0)
  })

  it('does not reward proposals, and counts a real subdivision of an oversized face', () => {
    const polygon = rectangle(0, 0, 1000, 1000), mask = createLayoutCoverageMask({ demandRegions: [{ polygon }], suitableRegions: [{ polygon }], excludedRegions: [{ polygon: rectangle(450, 450, 100, 100) }] })
    const before = measureLayoutStreetCoverage({ faces: [polygon], mask })
    expect(before.enclosedArea).toBe(990000)
    expect(before.coveredArea).toBe(0)
    expect(measureLayoutCoverageGain({ beforeFaces: [polygon], afterFaces: [polygon], mask, streetLength: 1000 }).coveredGain).toBe(0)
    const afterFaces = [rectangle(0, 0, 500, 1000), rectangle(500, 0, 500, 1000)]
    expect(measureLayoutCoverageGain({ beforeFaces: [polygon], afterFaces, mask, streetLength: 1000 })).toEqual({ enclosedGain: 0, coveredGain: 990000, areaPerMeter: 990 })
  })
})

describe('finite major-block coverage proposals', () => {
  it('can return to two separated points on ONE actual old road through unserved demand', () => {
    const mask = flatMask(), input = { roads: [oldRoad], faces: [], mask, builtYear: 1955, canAnchor: () => true }, before = JSON.stringify(input)
    const result = proposeLayoutCoverageBlocks(input)
    expect(result.proposals.length).toBeGreaterThan(0)
    for (const proposal of result.proposals) {
      expect(proposal.from.roadId).toBe(oldRoad.id); expect(proposal.to.roadId).toBe(oldRoad.id)
      expect(distanceToSegment(proposal.from.point, oldRoad.points[0]!, oldRoad.points[1]!)).toBeLessThan(1e-8)
      expect(distanceToSegment(proposal.to.point, oldRoad.points[0]!, oldRoad.points[1]!)).toBeLessThan(1e-8)
      expect(mask.regions.some(region => pointInRegion(proposal.through, region))).toBe(true)
      expect(proposal.through.y).toBeGreaterThan(120)
      expect(proposal.builtYear).toBe(1955)
    }
    expect(JSON.stringify(input)).toBe(before)
    expect(proposeLayoutCoverageBlocks(input)).toEqual(result)
    expect(measureLayoutStreetCoverage({ faces: [], mask }).coveredArea).toBe(0)
  })

  it('respects excluded rail-side components and does not use the rail/mask edge as pavement', () => {
    const mask = createLayoutCoverageMask({ demandRegions: [frame], suitableRegions: [frame], excludedRegions: [{ polygon: rectangle(590, -10, 20, 1020) }] })
    expect(mask.regions).toHaveLength(2)
    const result = proposeLayoutCoverageBlocks({ roads: [oldRoad], faces: [], mask, builtYear: 1955, canAnchor: p => p.x < 590 || p.x > 610 })
    expect(result.proposals.length).toBeGreaterThan(0)
    for (const proposal of result.proposals) {
      const xs = [proposal.from.point.x, proposal.to.point.x, proposal.through.x]
      expect(xs.every(x => x < 590) || xs.every(x => x > 610)).toBe(true)
      expect(proposal.from.point.y).toBe(0); expect(proposal.to.point.y).toBe(0)
    }
  })

  it('bounds the field/candidate work and excludes future or controlled anchors', () => {
    const mask = flatMask(), result = proposeLayoutCoverageBlocks({ roads: [{ ...oldRoad, bridge: true }], faces: [], mask, builtYear: 1955, canAnchor: () => true, maximumFieldCells: 32, maximumProposals: 1 })
    expect(result.diagnostics.fieldCells).toBeLessThanOrEqual(32)
    expect(result.proposals.length).toBeLessThanOrEqual(1)
    expect(result.diagnostics.candidatePairs).toBeLessThanOrEqual(1128 * 4)
    expect(proposeLayoutCoverageBlocks({ roads: [{ ...oldRoad, builtYear: 1995 }], faces: [], mask, builtYear: 1955, canAnchor: () => true }).proposals).toEqual([])
    expect(proposeLayoutCoverageBlocks({ roads: [{ ...oldRoad, controlledAccess: true }], faces: [], mask, builtYear: 1955, canAnchor: () => true }).proposals).toEqual([])
  })
})
