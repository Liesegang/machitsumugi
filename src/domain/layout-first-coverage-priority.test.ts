import { describe, expect, it } from 'vitest'
import type { Road } from './types'
import { rectangle } from './geometry'
import { createLayoutCoverageMask, proposeLayoutCoverageBlocks } from './layout-first-coverage-blocks'
import { buildLayoutCoveragePriority } from './layout-first-coverage-priority'
import { runLayoutCoveragePass } from './layout-first-coverage-pass'

const road = (id: string, x: number, width: number): Road => ({ id, points: [{ x, y: 100 }, { x: x + width, y: 100 }], kind: 'local', role: 'collector', width: 8, builtYear: 1650 })
const regions = [{ polygon: rectangle(100, 100, 1000, 800) }, { polygon: rectangle(2500, 100, 1800, 1500) }]
const input = () => ({ roads: [road('station-public', 100, 1000), road('remote-public', 2500, 1800)], faces: [], mask: createLayoutCoverageMask({ demandRegions: regions, suitableRegions: regions, excludedRegions: [] }), builtYear: 1955, canAnchor: () => true, maximumProposals: 4 })

describe('bounded priority from real acquired public sites', () => {
  it('tries the smaller underserved station gap before a larger remote void, while keeping a fringe candidate', () => {
    const before = proposeLayoutCoverageBlocks(input())
    expect(before.proposals[0]!.through.x).toBeGreaterThan(2500)
    const prioritized = proposeLayoutCoverageBlocks({ ...input(), prioritySites: [{ id: 'real-station-gate', point: { x: 600, y: 100 }, builtYear: 1900 }] })
    expect(prioritized.diagnostics.activePrioritySites).toBe(1)
    expect(prioritized.proposals[0]!.through.x).toBeLessThan(1200)
    expect(prioritized.proposals.some(proposal => proposal.through.x > 2500)).toBe(true)
    for (const proposal of prioritized.proposals) for (const anchor of [proposal.from, proposal.to]) expect(input().roads.some(road => road.id === anchor.roadId && anchor.point.y === 100)).toBe(true)
    expect(prioritized.proposals.length).toBeLessThanOrEqual(4)
    const observed: number[] = [], initial = input()
    runLayoutCoveragePass({ ...initial, phase: 'after-fallback', maximumAttempts: 4, cellSize: 100,
      prioritySites: [{ id: 'real-station-gate', point: { x: 600, y: 100 }, builtYear: 1900 }],
      readNetwork: () => ({ roads: initial.roads, faces: [] }), tryAdoptWithFaceGain: proposal => { observed.push(proposal.through.x); return false },
    })
    expect(observed[0]).toBeLessThan(1200)
    expect(observed.some(x => x > 2500)).toBe(true)
  })

  it('gives no priority to a future station or a theoretical zone point without actual public acquisition', () => {
    const baseline = proposeLayoutCoverageBlocks(input()).proposals
    expect(proposeLayoutCoverageBlocks({ ...input(), prioritySites: [{ id: 'future-station', point: { x: 600, y: 100 }, builtYear: 1995 }] }).proposals).toEqual(baseline)
    expect(proposeLayoutCoverageBlocks({ ...input(), prioritySites: [{ id: 'unacquired-zone', point: { x: 600, y: 300 }, builtYear: 1900 }] }).proposals).toEqual(baseline)
    expect(baseline[0]!.through.x).toBeGreaterThan(2500)
  })

  it('uses same-era network distance and rejects a last leg through a real water/rail exclusion', () => {
    const roads = [road('source-road', 0, 100), road('unconnected-road', 300, 700)]
    const priority = buildLayoutCoveragePriority({ roads, sites: [{ id: 'gate', point: { x: 0, y: 100 }, builtYear: 1900 }], builtYear: 1955, excluded: [{ polygon: rectangle(180, 0, 20, 1000) }] })
    expect(priority.sites).toHaveLength(1)
    expect(priority.distanceAt({ x: 50, y: 300 })).toBeCloseTo(250)
    expect(priority.distanceAt({ x: 600, y: 300 })).toBe(Infinity)
    const futureOnly = buildLayoutCoveragePriority({ roads: roads.map(road => ({ ...road, builtYear: 1995 })), sites: [{ id: 'gate', point: { x: 0, y: 100 }, builtYear: 1900 }], builtYear: 1955, excluded: [] })
    expect(futureOnly.sites).toHaveLength(0)
  })
})
