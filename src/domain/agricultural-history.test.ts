import { describe, expect, it } from 'vitest'
import { agriculturalHistory } from './agricultural-history'
import { rectangle, regionArea } from './geometry'

describe('dated farmland acquisitions', () => {
  it('keeps the original title before a real road acquisition and stores only changed geometry', () => {
    const history = agriculturalHistory([{ id: 'old-title', regions: [{ polygon: rectangle(0, 0, 100, 80) }], landUse: 'paddy' }], [
      { year: 1960, polygon: rectangle(40, -20, 10, 120) },
      { year: 1980, polygon: rectangle(40, -20, 10, 120) },
      { year: 1990, polygon: rectangle(0, 0, 40, 80) },
    ], 2025, () => () => true)
    const at = (year: number) => history.filter(v => v.from <= year && (v.to === undefined || year < v.to)).reduce((sum, v) => sum + regionArea(v.value), 0)
    expect(at(1959)).toBe(8000)
    expect(at(1960)).toBe(7200)
    expect(at(1985)).toBe(7200)
    expect(at(1990)).toBe(4000)
    expect(history.some(v => v.from === 1980)).toBe(false)
    expect(history.every(v => v.to === undefined || v.to > v.from)).toBe(true)
  })
})
