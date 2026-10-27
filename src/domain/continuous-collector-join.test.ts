import { describe, expect, it } from 'vitest'
import type { Point } from './types'
import { alignmentDiagnostics, resampleAlignment } from './road-alignment'
import { continuousCollectorJoinCandidates } from './continuous-collector-join'

describe('continuous collector leg joins', () => {
  it('joins 12m sampled right-angle legs with real turning distance and retains their outer surveyed vertices', () => {
    const first = resampleAlignment([{ x: -900, y: 0 }, { x: 0, y: 0 }], 12)
    const last = resampleAlignment([{ x: 0, y: 0 }, { x: 0, y: 840 }], 12)
    for (const point of [...first, ...last]) Object.freeze(point)
    Object.freeze(first); Object.freeze(last)
    const original = JSON.stringify([first, last]), candidates = continuousCollectorJoinCandidates(first, last)
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.length).toBeLessThanOrEqual(12)
    for (const points of candidates) {
      expect(points[0]).toEqual(first[0]); expect(points.at(-1)).toEqual(last.at(-1))
      expect(alignmentDiagnostics(points, 5).minimumRadius).toBeGreaterThanOrEqual(50 - 1e-6)
      expect(points.slice(0, 20)).toEqual(first.slice(0, 20))
      expect(points.slice(-20)).toEqual(last.slice(-20))
    }
    expect(JSON.stringify([first, last])).toBe(original)
    candidates[0]![0]!.x = -901
    expect(first[0]!.x).toBe(-900)
  })

  it('makes the same physical joins for coarse and dense samples of the same legs', () => {
    const first = [{ x: -800, y: 0 }, { x: 0, y: 0 }], last = [{ x: 0, y: 0 }, { x: 0, y: 800 }]
    const coarse = continuousCollectorJoinCandidates(first, last), dense = continuousCollectorJoinCandidates(resampleAlignment(first, 12), resampleAlignment(last, 12))
    expect(coarse.length).toBeGreaterThan(0)
    expect(dense).toHaveLength(coarse.length)
    for (const [i, path] of coarse.entries()) {
      const a = resampleAlignment(path, 5), b = resampleAlignment(dense[i]!, 5)
      expect(b).toHaveLength(a.length)
      expect(Math.max(...a.map((point, j) => Math.hypot(point.x - b[j]!.x, point.y - b[j]!.y)))).toBeLessThan(1e-6)
    }
  })

  it('retains an already gentle surveyed join without replacing its route', () => {
    const first = [{ x: -200, y: 0 }, { x: -100, y: 0 }, { x: 0, y: 0 }], last = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }]
    expect(continuousCollectorJoinCandidates(first, last)).toEqual([[...first, ...last.slice(1)]])
  })

  it('rejects short impossible, reversing, nonmeeting and nonfinite legs', () => {
    const origin = { x: 0, y: 0 }
    expect(continuousCollectorJoinCandidates([{ x: -24, y: 0 }, origin], [origin, { x: 0, y: 24 }])).toEqual([])
    expect(continuousCollectorJoinCandidates([{ x: -800, y: 0 }, origin], [origin, { x: -800, y: 0 }])).toEqual([])
    expect(continuousCollectorJoinCandidates([{ x: -800, y: 0 }, origin], [{ x: 0, y: 800 }, origin])).toEqual([])
    expect(continuousCollectorJoinCandidates([{ x: NaN, y: 0 }, origin], [origin, { x: 0, y: 800 }])).toEqual([])
    expect(continuousCollectorJoinCandidates([] as Point[], [origin, { x: 0, y: 800 }])).toEqual([])
  })
})
