import { describe, expect, it } from 'vitest'
import { civicWoodlandHistory } from './civic-woodland'
import { pointInRegion, rectangle, regionArea } from './geometry'
import type { Area } from './types'

describe('wooded civic grounds retain their actual forest', () => {
  it('clears only a small building and path in its construction year, preserving most of the woodland', () => {
    const area: Area = { id: 'forest', kind: 'forest', polygon: rectangle(0, 0, 400, 300), name: '丘の林' }
    const history = civicWoodlandHistory([{ from: 1650, value: area }], [{ year: 1965, polygon: rectangle(100, 100, 30, 12) }, { year: 1965, polygon: rectangle(80, 110, 23, 3) }], 2025)
    const before = history.filter(version => version.from <= 1955 && (version.to === undefined || 1955 < version.to)), after = history.filter(version => version.from <= 2025 && (version.to === undefined || 2025 < version.to))
    expect(before).toHaveLength(1); expect(before[0]!.value).toEqual(area)
    expect(after.reduce((sum, version) => sum + regionArea(version.value), 0)).toBeGreaterThan(119000)
    expect(after.some(version => pointInRegion({ x: 112, y: 105 }, version.value))).toBe(false)
    expect(after.some(version => pointInRegion({ x: 200, y: 200 }, version.value))).toBe(true)
  })
  it('combines dated civic clearing with an earlier harbour change without rewriting either history', () => {
    const history = civicWoodlandHistory([{ from: 1650, to: 1920, value: { id: 'forest', kind: 'forest', polygon: rectangle(0, 0, 100, 100) } }, { from: 1920, value: { id: 'forest', kind: 'forest', polygon: rectangle(0, 0, 70, 100) } }], [{ year: 1965, polygon: rectangle(20, 20, 10, 10) }], 2025)
    expect(history.map(version => [version.from, version.to])).toEqual([[1650, 1920], [1920, 1965], [1965, undefined]])
    expect(history.map(version => regionArea(version.value))).toEqual([10000, 7000, 6900])
  })
})
