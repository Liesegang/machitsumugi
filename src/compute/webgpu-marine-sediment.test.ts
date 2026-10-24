import { describe, expect, it } from 'vitest'
import { reworkMarineCPU } from './webgpu-marine-sediment'
import type { MarineReworkingInput } from './webgpu-marine-sediment'

function coast(columns = 17, rows = 15): MarineReworkingInput {
  const count = columns * rows, elevation = new Float32Array(count), alluvium = new Float64Array(count), ocean = new Uint8Array(count)
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const i = y * columns + x
    elevation[i] = 4 - x * .8 - y * .01
    alluvium[i] = .0400234 + (i * 113 % 97) / 10000
    ocean[i] = Number(elevation[i]! < 0)
  }
  // An inland depression is deliberately not connected to the sea.
  elevation[columns + 1] = -3; ocean[columns + 1] = 0
  return { columns, rows, elevation, alluvium, ocean, cellSize: 100, seaLevel: 0 }
}

describe('conservative marine erosion and sediment transport', () => {
  it('resuspends, moves and deposits actual sediment without touching inland/lake cells or inputs', () => {
    const input = coast(), original = new Float32Array(input.elevation), originalLoose = new Float64Array(input.alluvium), frames: number[] = []
    const result = reworkMarineCPU(input, { steps: 96, openBoundary: false, onStep: state => frames.push(state.iteration) })
    expect(result.budget.reentrainedVolume).toBeGreaterThan(0)
    expect(result.budget.depositedVolume).toBeGreaterThan(0)
    expect(result.delta.some(value => value !== 0)).toBe(true)
    expect(result.budget.integerMassBalanceErrorUnits).toBe(0)
    expect(Math.abs(result.budget.massBalanceError)).toBeLessThan(1e-6)
    expect(Math.abs(result.budget.terrainBalanceError)).toBeLessThan(1e-6)
    expect(result.budget.exportedVolume).toBe(0)
    expect(Array.from(result.alluvium).every(value => value >= 0)).toBe(true)
    expect(Array.from(result.suspended).every(value => value >= 0)).toBe(true)
    expect(result.elevation[input.columns + 1]).toBe(-3)
    expect(result.alluvium[input.columns + 1]).toBe(input.alluvium[input.columns + 1])
    expect(input.elevation).toEqual(original); expect(input.alluvium).toEqual(originalLoose)
    expect(frames).toEqual([0, 32, 64, 96])
  })

  it('cannot manufacture resuspended sediment and respects the total rock-erosion cap', () => {
    const input = coast(); input.alluvium.fill(0)
    const result = reworkMarineCPU(input, { steps: 96, waveHeightMetres: 3, rockErosionLimitMetres: .0001, openBoundary: false })
    expect(result.budget.bedrockErodedVolume).toBeGreaterThan(0)
    expect(result.budget.bedrockErodedVolume).toBeLessThanOrEqual(result.budget.activeOceanCells * .0001 * input.cellSize ** 2 + 1e-8)
    expect(result.budget.reentrainedVolume).toBeLessThanOrEqual(result.budget.depositedVolume)
    expect(result.budget.integerMassBalanceErrorUnits).toBe(0)
    expect(result.budget.finalLooseVolume + result.budget.suspendedVolume).toBeCloseTo(result.budget.bedrockErodedVolume, 7)
  })

  it('records open-boundary loss rather than deleting it, while a closed boundary conserves all suspended stock', () => {
    const input = coast(); input.alluvium.fill(0); input.suspended = new Float64Array(input.elevation.length)
    input.suspended[input.columns * 4 - 1] = .5
    const options = { steps: 12, waveHeightMetres: 0, settlingVelocityMetresPerSecond: 0, currentMetresPerSecond: { x: .05, y: 0 } }
    const open = reworkMarineCPU(input, { ...options, openBoundary: true }), closed = reworkMarineCPU(input, { ...options, openBoundary: false })
    expect(open.budget.exportedVolume).toBeGreaterThan(0)
    expect(closed.budget.exportedVolume).toBe(0)
    expect(open.budget.integerMassBalanceErrorUnits).toBe(0)
    expect(closed.budget.integerMassBalanceErrorUnits).toBe(0)
    expect(open.budget.suspendedVolume + open.budget.exportedVolume).toBeCloseTo(5000, 7)
    expect(closed.budget.suspendedVolume).toBeCloseTo(5000, 7)
  })

  it('keeps sub-quantum sediment in place and does not quantize an unchanged seabed', () => {
    const input = coast(), result = reworkMarineCPU(input, { steps: 64, waveHeightMetres: 0 })
    expect(result.elevation).toEqual(input.elevation)
    expect(result.alluvium).toEqual(input.alluvium)
    expect(result.budget.roundingResidualVolume).toBeGreaterThan(0)
    expect(result.budget.renderRoundingVolume).toBe(0)
    expect(result.budget.bedrockErodedVolume).toBe(0)
  })

  it('leaves deep bulk sediment in a separate f64 inventory instead of overflowing or exposing bedrock', () => {
    const input = coast(31, 31)
    input.alluvium.fill(1000.0000234)
    const result = reworkMarineCPU(input, { steps: 96, openBoundary: false })
    expect(result.budget.quantumMetres).toBe(.0001)
    expect(result.budget.immobileLooseVolume).toBeGreaterThan(1e9)
    expect(result.budget.roundingResidualVolume).toBeLessThan(input.elevation.length * .0001 * input.cellSize ** 2)
    expect(result.budget.bedrockErodedVolume).toBe(0)
    expect(result.budget.integerMassBalanceErrorUnits).toBe(0)
    expect(Math.abs(result.budget.massBalanceError)).toBeLessThan(1e-3)
    expect(result.alluvium.every(value => value > 999)).toBe(true)
  })

  it('rejects an unstable flux timestep and handles explicit cancellation', () => {
    expect(() => reworkMarineCPU(coast(), { currentMetresPerSecond: { x: 100, y: 0 } })).toThrow('CFL')
    const controller = new AbortController(); controller.abort()
    expect(() => reworkMarineCPU(coast(), { signal: controller.signal })).toThrow('cancelled')
  })
})
