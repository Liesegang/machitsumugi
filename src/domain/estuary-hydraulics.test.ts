import { describe, expect, it } from 'vitest'
import { estuarineWidthPriors } from './estuary-hydraulics'
import { surveyChannelWidths } from './channel-hydraulic-geometry'
import { reworkChannelBed } from './channel-sediment'

const points = Array.from({ length: 61 }, (_, i) => ({ x: i * 50, y: 250 }))
const referenceWidths = points.map(() => 36), surfaceElevation = points.map(p => Math.max(0, (2500 - p.x) * .002))
const input = { points, referenceWidths, surfaceElevation, oceanAt: (p: { x: number; y: number }) => p.x >= 2500, coastType: 'bay' as const }

describe('surveyed tidal river-mouth hydraulic prior', () => {
  it('flares a connected low-gradient mouth while preserving inland and source conditions', () => {
    const original = structuredClone({ points, referenceWidths, surfaceElevation }), widths = estuarineWidthPriors(input)
    expect(widths[50]).toBeGreaterThan(widths[30]! * 2)
    expect(widths[50]).toBeGreaterThan(150)
    expect(widths[0]).toBe(referenceWidths[0])
    expect(estuarineWidthPriors({ ...input, referenceWidths: [0, ...referenceWidths.slice(1)] })[0]).toBe(0)
    expect({ points, referenceWidths, surfaceElevation }).toEqual(original)
    expect(estuarineWidthPriors({ ...input, oceanAt: () => false })).toEqual(referenceWidths)
    expect(estuarineWidthPriors({ ...input, coastType: 'delta' })[50]).toBeLessThan(widths[50]!)
  })
  it('retains actual resistant bank confinement and accounts the excavated bed volume', () => {
    const prior = estuarineWidthPriors(input), flat = surveyChannelWidths({ ...input, referenceWidths: prior, groundElevation: () => 1 })
    const confined = surveyChannelWidths({ ...input, referenceWidths: prior, groundElevation: p => Math.abs(p.y - 250) > 25 ? 30 : 1 })
    expect(flat[50]).toBeGreaterThan(confined[50]! * 2)
    expect(confined[50]).toBeLessThanOrEqual(50)
    const columns = 301, rows = 51, ground = new Float32Array(columns * rows).fill(1)
    const bed = reworkChannelBed({ ground, columns, rows, resolution: 10, origin: { x: 0, y: 0 }, initial: [{ points, widths: flat, levels: surfaceElevation }], current: [{ points, widths: flat, levels: surfaceElevation }], abandoned: [] })
    expect(bed.budget.initialExcavationVolume).toBeGreaterThan(0)
    expect(bed.budget.totalMassBalanceError).toBe(0)
    expect(bed.budget.initialExportedVolume).toBe(bed.budget.initialExcavationVolume)
    expect(bed.bed[25 * columns + 250]).toBeLessThan(0)
  })
})
