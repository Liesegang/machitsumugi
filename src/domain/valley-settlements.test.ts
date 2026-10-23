import { describe, expect, it } from 'vitest'
import { valleySettlementCandidates } from './valley-settlements'

describe('neighbouring settlements in a turning valley', () => {
  it('follows upstream/downstream river chainage and preserves the settlement bank', () => {
    const river = [{ x: 500, y: 0 }, { x: 500, y: 600 }, { x: 1000, y: 1100 }, { x: 1500, y: 1100 }]
    const origin = { x: 350, y: 600 }
    const upstream = { x: 350, y: 200 }, downstream = { x: 860, y: 1170 }, oppositeBank = { x: 1100, y: 950 }, steep = { x: 420, y: 270 }
    const result = valleySettlementCandidates({ river, origin, candidates: [oppositeBank, steep, downstream, upstream], slope: p => p === steep ? .18 : .04 })
    expect(result[0]).toEqual([upstream])
    expect(result[1]).toEqual([downstream])
  })
  it('leaves an unsuitable or absent neighbouring terrace unavailable', () => {
    expect(valleySettlementCandidates({ river: [], origin: { x: 0, y: 0 }, candidates: [{ x: 10, y: 10 }], slope: () => 0 })).toEqual([])
    expect(valleySettlementCandidates({ river: [{ x: 0, y: 0 }, { x: 0, y: 2000 }], origin: { x: 150, y: 1000 }, candidates: [{ x: 20, y: 1400 }, { x: 600, y: 1400 }], slope: () => 0 })).toEqual([[], []])
  })
})
