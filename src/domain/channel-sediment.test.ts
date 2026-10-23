import { describe, expect, it } from 'vitest'
import { reworkChannelBed } from './channel-sediment'
import { evolveChannel } from './river-evolution'
describe('local bank sediment budget', () => {
  const section = (x: number) => ({ points: [{ x, y: 20 }, { x, y: 280 }], widths: [40, 40], levels: [10, 10] })
  const grid = { ground: new Float32Array(31 * 31).fill(12), columns: 31, rows: 31, resolution: 10, origin: { x: 0, y: 0 } }
  it('excavates the new bank and deposits only the supplied volume into the abandoned inner bed', () => {
    const result = reworkChannelBed({ ...grid, initial: [section(100)], current: [section(130)], abandoned: [] })
    expect(result.budget.erodedVolume).toBeGreaterThan(0)
    expect(result.budget.depositedVolume).toBeGreaterThan(0)
    expect(Math.abs(result.budget.massBalanceError)).toBeLessThan(1e-6)
    expect(result.budget.erodedVolume).toBeCloseTo(result.budget.depositedVolume + result.budget.exportedVolume, 5)
    const delta = result.bed.reduce((sum, z, i) => sum + (z - result.initialBed[i]!) * 100, 0)
    expect(delta).toBeCloseTo(-result.budget.exportedVolume, 4)
    const fromRegionalGround = result.bed.reduce((sum, z, i) => sum + (z - grid.ground[i]!) * 100, 0)
    expect(fromRegionalGround).toBeCloseTo(-result.budget.totalExportedVolume, 4)
    expect(result.budget.totalExcavationVolume).toBeCloseTo(result.budget.depositedVolume + result.budget.totalExportedVolume, 5)
    expect(Math.abs(result.budget.totalMassBalanceError)).toBeLessThan(1e-6)
    expect(result.bed[15 * 31 + 13]).toBeLessThan(result.initialBed[15 * 31 + 13]!)
    expect(result.bed[15 * 31 + 10]).toBeGreaterThan(result.initialBed[15 * 31 + 10]!)
  })
  it('does not manufacture sediment or bed change when the river does not migrate', () => {
    const result = reworkChannelBed({ ...grid, initial: [section(100)], current: [section(100)], abandoned: [] })
    expect(result.budget.erodedVolume).toBe(0)
    expect(result.budget.depositedVolume).toBe(0)
    expect(result.budget.exportedVolume).toBe(0)
    expect(result.bed).toEqual(result.initialBed)
    expect(result.budget.initialExcavationVolume).toBeGreaterThan(0)
    expect(result.budget.initialExportedVolume).toBe(result.budget.initialExcavationVolume)
  })
  it('supplies the plugs of an emergent cutoff from its actual mobile-bank excavation', () => {
    const points = [{ x: -500, y: 0 }, { x: -100, y: 0 }, { x: 0, y: 0 }, { x: 20, y: 30 }, { x: 50, y: 80 }, { x: 120, y: 120 }, { x: 200, y: 100 }, { x: 240, y: 30 }, { x: 220, y: -40 }, { x: 140, y: -90 }, { x: 60, y: -60 }, { x: 20, y: -70 }, { x: 0, y: -70 }, { x: -100, y: -70 }, { x: -500, y: -70 }]
    const evolved = evolveChannel({ points, widths: points.map(() => 30), pinned: [0, points.length - 1], valleyElevation: () => 10, alluvium: () => 8, steps: 300 })
    const result = reworkChannelBed({ ground: new Float32Array(91 * 61).fill(12), columns: 91, rows: 61, resolution: 10, origin: { x: -550, y: -300 },
      initial: [{ points: evolved.initialPoints, widths: evolved.initialWidths, levels: evolved.initialPoints.map(() => 10) }], current: [{ points: evolved.points, widths: evolved.points.map(() => 30), levels: evolved.points.map(() => 10) }],
      abandoned: evolved.abandoned.map(lake => ({ points: lake.points, widths: lake.widths, levels: lake.points.map(() => 10), lake: true })) })
    expect(evolved.abandoned).toHaveLength(1)
    expect(result.budget.plugRequiredVolume).toBeGreaterThan(0)
    expect(result.budget.plugsClosed).toBe(true)
    expect(result.budget.depositedVolume).toBeLessThanOrEqual(result.budget.erodedVolume)
    expect(result.budget.massBalanceError).toBe(0)
  })
})
