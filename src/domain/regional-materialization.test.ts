import { describe, expect, it, vi } from 'vitest'
import { erodeTerrainJs } from './hydrology'
import { getRegionalTerrain, materializeRegionalTerrain, prepareRegionalTerrain, regionalOceanMask, regionalTerrainKey, REGIONAL_PHYSICS_VERSION } from './regional-terrain'
import type { RegionalBase } from './regional-terrain'
import type { MarineReworkingResult } from '../compute/webgpu-marine-sediment'

// Cache/dispatch tests replace only the expensive geological duration. The
// small-grid mass/geometry fixtures below still use the real reference kernel.
vi.mock('./hydrology.ts', async importOriginal => {
  const original = await importOriginal<typeof import('./hydrology.ts')>()
  return { ...original, erodeTerrain: vi.fn((raw: Float32Array, columns: number, rows: number, cellSize: number) => original.erodeTerrainJs(raw, columns, rows, cellSize, 0)) }
})
vi.mock('../compute/webgpu-marine-sediment', () => {
  const identity = (input: { elevation: Float32Array; alluvium: Float64Array; cellSize: number }, backend: string) => {
    const volume = input.alluvium.reduce((sum, thickness) => sum + thickness * input.cellSize ** 2, 0)
    return { elevation: input.elevation.slice(), alluvium: input.alluvium.slice(), suspended: new Float64Array(input.elevation.length), delta: new Float64Array(input.elevation.length),
      budget: { bedrockErodedVolume: 0, reentrainedVolume: 0, depositedVolume: 0, exportedVolume: 0, initialLooseVolume: volume, finalLooseVolume: volume, suspendedVolume: 0, roundingResidualVolume: 0, massBalanceError: 0, renderRoundingVolume: 0 }, backend, metrics: {} }
  }
  return { MARINE_PHYSICS_VERSION: 'test-marine-v1', reworkMarineCPU: vi.fn(input => identity(input, 'cpu')), prepareMarineReworking: vi.fn(async input => identity(input, 'webgpu')) }
})

function fixture(): RegionalBase {
  const columns = 7, rows = 7, resolution = 10, raw = new Float32Array(columns * rows).fill(4)
  for (let y = 0; y < rows; y++) { raw[y * columns] = -5; raw[y * columns + 1] = -1 }
  raw[4 * columns + 4] = -3 // enclosed negative basin, not sea
  const eroded = erodeTerrainJs(raw, columns, rows, resolution, 0)
  eroded.alluvium64[3 * columns + 1] = .300000012345
  eroded.alluvium64[4 * columns + 1] = .02
  eroded.alluvium = Float32Array.from(eroded.alluvium64)
  const stored = eroded.alluvium64.reduce((sum, thickness) => sum + thickness * resolution ** 2, 0)
  eroded.sediment.storedVolume = stored; eroded.sediment.erodedSourceVolume = stored
  return { columns, rows, resolution, extent: 60, seed: 1, seaLevel: 0, eroded }
}
function movedSediment(base: RegionalBase): MarineReworkingResult {
  const source = 3 * base.columns + 1, target = 4 * base.columns + 1, area = base.resolution ** 2
  const elevation = base.eroded.rawDEM.slice(), alluvium = base.eroded.alluvium64.slice(), suspended = new Float64Array(elevation.length), delta = new Float64Array(elevation.length)
  delta[source] = -.07; delta[target] = .04
  elevation[source] += delta[source]!; elevation[target] += delta[target]!
  alluvium[source] -= .05; alluvium[target] += .04; suspended[source] = .02
  const initialLooseVolume = base.eroded.sediment.storedVolume, finalLooseVolume = alluvium.reduce((sum, thickness) => sum + thickness * area, 0)
  const renderRoundingVolume = elevation.reduce((sum, z, i) => sum + (z - base.eroded.rawDEM[i]! - delta[i]!) * area, 0)
  return { elevation, alluvium, suspended, delta, backend: 'cpu', metrics: {}, budget: { bedrockErodedVolume: 2, reentrainedVolume: 5, depositedVolume: 4, exportedVolume: 1, initialLooseVolume, finalLooseVolume, suspendedVolume: 2, roundingResidualVolume: 0, massBalanceError: 0, renderRoundingVolume } } as unknown as MarineReworkingResult
}

describe('regional coastal-stage materialization', () => {
  it('keeps suspended and sub-f32 soil in the conserved inventory without inventing source/export', () => {
    const base = fixture(), before = base.eroded.rawDEM.slice(), initialLoose = base.eroded.alluvium64.slice(), marine = movedSediment(base)
    const world = materializeRegionalTerrain(base, marine)
    expect(base.eroded.rawDEM).toEqual(before)
    expect(base.eroded.alluvium64).toEqual(initialLoose)
    expect(world.sediment.erodedSourceVolume).toBe(base.eroded.sediment.erodedSourceVolume + 2)
    expect(world.sediment.exportedVolume).toBe(1)
    expect(world.sediment.storedVolume).toBeCloseTo(base.eroded.sediment.storedVolume + 1, 10)
    expect(Math.abs(world.sediment.massBalanceError)).toBeLessThan(1e-10)
    expect(world.erosion.erodedVolume).toBe(7)
    expect(world.sediment.depositedVolume).toBe(4)
    expect(world.erosion.terrainBalanceError).toBeCloseTo(marine.budget.renderRoundingVolume, 8)
    expect(world.fluvial!.sediment).toEqual(base.eroded.sediment)
    expect(world.fluvial!.erosion).toEqual(base.eroded.erosion)
    expect(world.marine).toBe(marine)
    expect(world.rawDEM).toBe(marine.elevation)
    expect(world.alluvium64).toBe(marine.alluvium)
  })

  it('re-routes the modified DEM and keeps disconnected submerged lakes out of the ocean', () => {
    const base = fixture(), marine = movedSediment(base), world = materializeRegionalTerrain(base, marine)
    const expected = erodeTerrainJs(marine.elevation, base.columns, base.rows, base.resolution, 0)
    expect(world.flowTo).toEqual(expected.flowTo)
    expect(world.hydroDEM).toEqual(expected.hydroDEM)
    expect(world.accumulatedArea).toEqual(expected.accumulatedArea)
    expect(world.ocean[3 * base.columns + 1]).toBe(1)
    expect(world.ocean[4 * base.columns + 4]).toBe(0)
    const mask = regionalOceanMask(new Float32Array([-1, 4, 4, 4, -2, 4, 4, 4, 4]), 3, 3, 0)
    expect([...mask]).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(regionalOceanMask(new Float32Array(9).fill(-3), 3, 3, -4).some(Boolean)).toBe(false)
  })

  it('combines the actual integer marine solver with the f64 landscape ledger on a small coast', async () => {
    const actual = await vi.importActual<typeof import('../compute/webgpu-marine-sediment')>('../compute/webgpu-marine-sediment')
    const base = fixture(), ocean = regionalOceanMask(base.eroded.rawDEM, base.columns, base.rows, base.seaLevel)
    const marine = actual.reworkMarineCPU({ elevation: base.eroded.rawDEM, alluvium: base.eroded.alluvium64, ocean, columns: base.columns, rows: base.rows, cellSize: base.resolution, seaLevel: base.seaLevel }, { steps: 8, timeStepSeconds: 100, diffusivityM2PerSecond: .01 })
    const world = materializeRegionalTerrain(base, marine)
    expect(marine.budget.reentrainedVolume).toBeGreaterThan(0)
    expect(marine.budget.depositedVolume).toBeGreaterThan(0)
    expect(marine.budget.integerMassBalanceErrorUnits).toBe(0)
    expect(Math.abs(world.sediment.massBalanceError - base.eroded.sediment.massBalanceError)).toBeLessThan(1e-9)
    expect(world.erosion.terrainBalanceError - base.eroded.erosion.terrainBalanceError).toBeCloseTo(marine.budget.renderRoundingVolume, 8)
    for (let i = 0; i < ocean.length; i++) if (!ocean[i]) expect(marine.delta[i]).toBe(0)
  })

  it('versions physical results while treating defaults identically and retaining relief/ria differences', () => {
    expect(regionalTerrainKey({ seed: 'same' })).toBe(regionalTerrainKey({ seed: 'same', coastType: 'bay', relief: 'hills' }))
    expect(regionalTerrainKey({ seed: 'same' })).toContain(REGIONAL_PHYSICS_VERSION)
    expect(regionalTerrainKey({ seed: 'same', relief: 'mountains' })).not.toBe(regionalTerrainKey({ seed: 'same' }))
    expect(regionalTerrainKey({ seed: 'same', coastType: 'ria' })).not.toBe(regionalTerrainKey({ seed: 'same' }))
  })

  it('rejects malformed coastal outputs before routing or installing a cache entry', () => {
    const base = fixture(), marine = movedSediment(base)
    marine.elevation[10] = NaN
    expect(() => materializeRegionalTerrain(base, marine)).toThrow('不正な値')
    marine.elevation[10] = 4; marine.suspended[10] = -1
    expect(() => materializeRegionalTerrain(base, marine)).toThrow('不正な値')
  })

  it('installs only a completed async region, reuses its exact geometry synchronously and deduplicates preparation', async () => {
    const marine = await import('../compute/webgpu-marine-sediment'), input = { seed: 'async-regional-cache', coastType: 'ria' as const, relief: 'lowland' as const }
    const before = vi.mocked(marine.prepareMarineReworking).mock.calls.length
    const [a, b] = await Promise.all([prepareRegionalTerrain(input), prepareRegionalTerrain(input, { mode: 'cpu' })])
    expect(a).toBe(b)
    expect(vi.mocked(marine.prepareMarineReworking).mock.calls.length - before).toBe(1)
    expect(getRegionalTerrain(input.seed, input.coastType, undefined, input.relief)).toBe(a)
    const cached: { cached?: boolean }[] = []
    expect(await prepareRegionalTerrain(input, {}, value => cached.push(value))).toBe(a)
    expect(cached).toHaveLength(1); expect(cached[0]!.cached).toBe(true)
  })
})
