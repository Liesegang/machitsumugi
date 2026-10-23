import { describe, expect, it } from 'vitest'
import { alignmentDiagnostics, resampleAlignment, splineAlignment } from './road-alignment'
import { sampleLandOpportunities } from './land-opportunities'

const randomFrom = (seed: number) => () => { seed = Math.imul(seed, 1664525) + 1013904223; return (seed >>> 0) / 4294967296 }

describe('canonical alignment and land integration', () => {
  it('measures curvature independently of newly inserted junction samples', () => {
    const original = splineAlignment([{ x: 0, y: 0 }, { x: 150, y: 0 }, { x: 300, y: 110 }, { x: 500, y: 140 }])
    const split = original.flatMap((p, i) => i ? [{ x: (original[i - 1]!.x + p.x) / 2, y: (original[i - 1]!.y + p.y) / 2 }, p] : [p])
    const a = alignmentDiagnostics(original), b = alignmentDiagnostics(split)
    expect(b.minimumRadius).toBeCloseTo(a.minimumRadius, 5)
    expect(b.curvedLength).toBeCloseTo(a.curvedLength, 5)
    expect(resampleAlignment(split, 10)).toHaveLength(resampleAlignment(original, 10).length)
  })

  it('uses irregular sites with finer historic-core integration and coarser rural land', () => {
    const center = { x: 900, y: 700 }, sites = sampleLandOpportunities(1800, 1400, center, randomFrom(19))
    const near = sites.filter(s => Math.hypot(s.point.x - center.x, s.point.y - center.y) < 250), far = sites.filter(s => Math.hypot(s.point.x - center.x, s.point.y - center.y) > 900)
    expect(near.length).toBeGreaterThan(0)
    expect(far.length).toBeGreaterThan(0)
    expect(Math.min(...far.map(s => s.spacing))).toBeGreaterThan(Math.max(...near.map(s => s.spacing)))
    for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) {
      const a = sites[i]!, b = sites[j]!
      expect(Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y) + 1e-7).toBeGreaterThanOrEqual((a.spacing + b.spacing) / 2)
    }
    expect(sites).toEqual(sampleLandOpportunities(1800, 1400, center, randomFrom(19)))
    expect(sites).not.toEqual(sampleLandOpportunities(1800, 1400, center, randomFrom(20)))
  })
})
