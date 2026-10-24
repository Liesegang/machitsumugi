import { describe, expect, it } from 'vitest'
import { surveyChannelWidths } from './channel-hydraulic-geometry'

const points = Array.from({ length: 81 }, (_, i) => ({ x: i * 25, y: 0 }))
const section = (grade: number) => ({ points, referenceWidths: points.map(() => 40), surfaceElevation: points.map(p => 100 - p.x * grade), groundElevation: (p: { x: number; y: number }) => 100 - p.x * grade })

describe('surveyed reach hydraulic geometry', () => {
  it('gives different sections at equal runoff when the longitudinal grade differs', () => {
    const gentle = surveyChannelWidths(section(.001)), steep = surveyChannelWidths(section(.016))
    expect(gentle[40]).toBeCloseTo(40, 8)
    expect(steep[40]).toBeLessThan(gentle[40]! * .7)
    expect(surveyChannelWidths(section(.016))).toEqual(steep)
  })
  it('narrows at actual resistant valley walls and permits erosion of surveyed soft bank material', () => {
    const input = { ...section(.001), groundElevation: (p: { x: number; y: number }) => 100 - p.x * .001 + Math.max(0, Math.abs(p.y) - 6) * .8 }
    const rock = surveyChannelWidths(input), alluvial = surveyChannelWidths({ ...input, alluvium: () => 5 })
    expect(rock[40]).toBeCloseTo(18.5, 1)
    expect(alluvial[40]).toBeGreaterThan(rock[40]! + 5)
    expect(alluvial[40]).toBeLessThan(40)
  })
  it('detects an intervening resistant bank instead of jumping to a neighbouring low valley', () => {
    const widths = surveyChannelWidths({ ...section(.001), groundElevation: p => 100 - p.x * .001 + (Math.abs(p.y) >= 7 && Math.abs(p.y) <= 15 ? 12 : 0) })
    expect(widths[40]).toBeGreaterThan(13)
    expect(widths[40]).toBeLessThan(14.1)
  })
  it('keeps a true zero-width runoff source and does not mutate flow attributes or the centreline', () => {
    const input = section(.001); input.referenceWidths = input.referenceWidths.map((w, i) => w * Math.min(1, i / 12))
    const original = structuredClone(input.points), levels = [...input.surfaceElevation], prior = [...input.referenceWidths], widths = surveyChannelWidths(input)
    expect(widths[0]).toBe(0)
    expect(widths.every((width, i) => Number.isFinite(width) && width >= 0 && width <= prior[i]! * 1.55)).toBe(true)
    expect(input.points).toEqual(original); expect(input.surfaceElevation).toEqual(levels); expect(input.referenceWidths).toEqual(prior)
  })
  it('keeps an exactly uniform surveyed reach uniform instead of adding decorative variation', () => {
    expect(surveyChannelWidths(section(.001)).every(width => Math.abs(width - 40) < 1e-8)).toBe(true)
  })
  it('transitions into a narrow section without a single-vertex bank notch', () => {
    const input = { ...section(.001), groundElevation: (p: { x: number; y: number }) => 100 - p.x * .001 + (Math.abs(p.x - 1000) < 20 ? Math.max(0, Math.abs(p.y) - 4) * 2 : 0) }
    const widths = surveyChannelWidths(input)
    expect(widths[40]).toBeLessThan(11)
    expect(widths[0]).toBeCloseTo(40, 8)
    for (let i = 1; i < widths.length; i++) expect(Math.abs(widths[i]! - widths[i - 1]!)).toBeLessThanOrEqual(25 * .12 + 1e-8)
  })
  it('rejects inconsistent channel attributes', () => {
    expect(() => surveyChannelWidths({ ...section(.001), referenceWidths: [] })).toThrow('match')
    expect(() => surveyChannelWidths({ ...section(.001), referenceWidths: points.map(() => NaN) })).toThrow('finite')
  })
})
