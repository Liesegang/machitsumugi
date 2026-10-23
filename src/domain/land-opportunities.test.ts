import { describe, expect, it } from 'vitest'
import { diverseOpportunityBatches } from './land-opportunities'

describe('land project search scheduling', () => {
  it('retains every candidate beyond the first infeasible scheduling window', () => {
    const candidates = Array.from({ length: 25 }, (_, id) => ({ id, cell: { point: { x: id * 120, y: 0 } } }))
    const order = [...diverseOpportunityBatches(candidates)].flat()
    const firstFeasible = order.find(candidate => candidate.id >= 8)
    expect(firstFeasible?.id).toBe(8)
    expect(order).toHaveLength(candidates.length)
    expect(new Set(order)).toHaveLength(candidates.length)
  })
  it('postpones nearby proposals without silently discarding their land', () => {
    const candidates = [0, 20, 40, 200, 400, 600, 800, 1000, 1200, 1400, 1600].map((x, id) => ({ id, cell: { point: { x, y: 0 } } }))
    const order = [...diverseOpportunityBatches(candidates)].flat()
    expect(order.slice(0, 8).map(c => c.id)).toEqual([0, 3, 4, 5, 6, 7, 8, 9])
    expect(order.map(c => c.id).sort((a, b) => a - b)).toEqual(candidates.map(c => c.id))
    expect([...diverseOpportunityBatches(candidates)].flat()).toEqual(order)
  })
})
