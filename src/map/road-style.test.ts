import { describe, expect, it } from 'vitest'
import { roadStrokeWidths } from './road-style'

describe('street hierarchy at map scale', () => {
  it('keeps collectors distinct from narrow streets in a12km overview', () => {
    const scale = 1800 / 12000
    const local = roadStrokeWidths({ width: 6, kind: 'local', role: 'lane' }, scale)
    const collector = roadStrokeWidths({ width: 11, kind: 'local', role: 'collector' }, scale)
    const main = roadStrokeWidths({ width: 12, kind: 'arterial', role: 'highway' }, scale)
    expect(collector.width).toBeGreaterThan(local.width * 1.5)
    expect(main.width).toBeGreaterThan(collector.width * 1.5)
    expect(collector.outlinedWidth).toBeGreaterThan(local.outlinedWidth)
    expect(local.width * scale).toBeLessThan(1)
  })
  it('shows the actual pavement width in close views without changing the road', () => {
    for (const role of ['lane', 'collector', 'access', 'farm'] as const) {
      const road = Object.freeze({ width: 6, kind: 'local' as const, role })
      expect(roadStrokeWidths(road, 2).width).toBe(6)
      expect(roadStrokeWidths(road, 2).outlinedWidth).toBeGreaterThan(6)
      expect(road.width).toBe(6)
    }
  })
})
