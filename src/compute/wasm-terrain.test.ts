/// <reference types="node" />
import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { routeDrainageJs, erodeTerrainJs } from '../domain/hydrology'
import type { LandscapeOptions } from '../domain/hydrology'
import { prepareTerrainWasm, terrainWasmStatus, wasmErodeTerrain, wasmRouteDrainage } from './wasm-terrain'

const binary = () => readFile(new URL('../../public/compute/terrain.wasm', import.meta.url))
beforeAll(async () => { expect(await prepareTerrainWasm({ bytes: await binary() })).toBe(true) })

function grid(columns: number, rows: number, seed = 1) {
  let state = seed >>> 0
  return Float32Array.from({ length: columns * rows }, (_, i) => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    return (rows - Math.floor(i / columns)) * 3 + (state >>> 0) / 0x100000000 * 70 - 30
  })
}

describe('deterministic terrain WASM', () => {
  it('matches every drainage output bit for D8/LTD slopes, pits, equal-height flats and single-row edges', () => {
    const fixtures = [[1, 1], [1, 18], [19, 1], [3, 3], [13, 17], [32, 24], [65, 65]] as const
    for (const [columns, rows] of fixtures) for (const seed of [1, 77, 1024]) {
      const raw = grid(columns, rows, seed)
      for (const method of ['d8', 'd8-ltd'] as const) expect(wasmRouteDrainage(raw, columns, rows, 37.5, method)).toEqual(routeDrainageJs(raw, columns, rows, 37.5, method))
      raw.fill(3)
      expect(wasmRouteDrainage(raw, columns, rows, 100)).toEqual(routeDrainageJs(raw, columns, rows, 100))
    }
  })

  it('matches full erosion, mass budgets, routing and alluvium without reducing iteration count', () => {
    const columns = 23, rows = 19, raw = grid(columns, rows, 945)
    const uplift = Float32Array.from(raw, (_, i) => (i % 9) * .0001), erodibility = Float32Array.from(raw, (_, i) => .00002 + (i % 7) * .000005)
    const options: LandscapeOptions[] = [
      { passes: 0 }, { passes: 7 }, { passes: 8, sediment: true, uplift, erodibility },
      { passes: 13, sediment: true, uplift, erodibility, timeStepYears: 4000, diffusivity: .15, seaLevel: (i, n) => -40 * (1 - Math.max(0, Math.min(1, (i - n + 16) / 16))) },
    ]
    for (const settings of options) expect(wasmErodeTerrain(raw, columns, rows, 100, settings)).toEqual(erodeTerrainJs(raw, columns, rows, 100, settings))
  })

  it('retains the initial and four-pass preview sequence and evaluates sea level on every pass', () => {
    const raw = grid(17, 15, 12), expected: unknown[] = [], actual: unknown[] = [], levelsJs: number[] = [], levelsWasm: number[] = []
    const capture = (target: unknown[]): NonNullable<LandscapeOptions['onStep']> => value => target.push({ ...value, elevation: value.elevation.slice(), alluvium: value.alluvium.slice() })
    const reference = erodeTerrainJs(raw, 17, 15, 100, { passes: 9, sediment: true, onStep: capture(expected), seaLevel: i => { levelsJs.push(i); return i - 7 } })
    const accelerated = wasmErodeTerrain(raw, 17, 15, 100, { passes: 9, sediment: true, onStep: capture(actual), seaLevel: i => { levelsWasm.push(i); return i - 7 } })
    expect(levelsWasm).toEqual(levelsJs)
    expect(levelsWasm).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(actual).toEqual(expected)
    expect(accelerated).toEqual(reference)
  })
  it('matches shallow coastal filling and preserves actual supplied sediment across the marine capacity transition', () => {
    const columns = 23, rows = 25
    const raw = Float32Array.from({ length: columns * rows }, (_, i) => {
      const x = i % columns, y = Math.floor(i / columns)
      return y < 9 ? 1 + (9 - y) * 2 + Math.abs(x - 11) * 2 : -.05 - (y - 9) * .001
    })
    const options = { passes: 8, timeStepYears: 4000, sediment: true, diffusivity: 0 }
    const actual = wasmErodeTerrain(raw, columns, rows, 50, options)!, reference = erodeTerrainJs(raw, columns, rows, 50, options)
    expect(actual).toEqual(reference)
    expect(actual.sediment.marineDepositedVolume).toBeGreaterThan(0)
    expect(actual.sediment.exportedVolume).toBeGreaterThan(0)
    expect(Math.abs(actual.sediment.massBalanceError) / actual.sediment.erodedSourceVolume).toBeLessThan(1e-12)
  })

  it('matches uplift on every perimeter cell, including underwater and single-row/column domains', () => {
    for (const [columns, rows] of [[1, 1], [1, 7], [8, 1], [7, 9]]) {
      const raw = new Float32Array(columns! * rows!).fill(-10), uplift = new Float32Array(raw.length).fill(.001)
      const settings = { passes: 5, timeStepYears: 100, uplift, diffusivity: 0 }
      const actual = wasmErodeTerrain(raw, columns!, rows!, 50, settings)!, reference = erodeTerrainJs(raw, columns!, rows!, 50, settings)
      expect(actual).toEqual(reference)
      for (const z of actual.rawDEM) expect(z).toBeCloseTo(-9.5, 5)
      expect(actual.erosion.upliftVolume).toBeCloseTo(raw.length * .5 * 2500, 2)
      expect(actual.erosion.erodedVolume).toBe(0)
      expect(actual.erosion.terrainBalanceError).toBeCloseTo(0, 0)
    }
  })
  it('matches conservative perimeter-to-interior hillslope faces instead of trapping uplifted boundary walls', () => {
    for (const [columns, rows] of [[1, 3], [3, 1], [7, 9]]) {
      const raw = new Float32Array(columns! * rows!), uplift = new Float32Array(raw.length).fill(.001)
      raw[0] = 10
      const settings = { passes: 8, timeStepYears: 100, uplift, diffusivity: 2.5, erodibility: new Float32Array(raw.length), sediment: true }
      const actual = wasmErodeTerrain(raw, columns!, rows!, 50, settings)!, reference = erodeTerrainJs(raw, columns!, rows!, 50, settings)
      expect(actual).toEqual(reference)
      expect(actual.rawDEM[0]).toBeLessThan(raw[0]!)
      expect(actual.rawDEM[1]).toBeGreaterThan(raw[1]!)
      expect(actual.sediment.hillslopeTransferredVolume).toBeGreaterThan(0)
      expect(Math.abs(actual.sediment.massBalanceError)).toBeLessThan(1e-7)
    }
  })

  it('owns returned arrays and does not mutate source fields or retained previews', () => {
    const raw = grid(13, 11, 5), source = raw.slice(), first = wasmRouteDrainage(raw, 13, 11, 100)!
    const retained = first.hydroDEM.slice(), previews: Float32Array[] = []
    wasmErodeTerrain(raw, 13, 11, 100, { passes: 8, onStep: step => previews.push(step.elevation) })
    expect(raw).toEqual(source)
    expect(first.hydroDEM).toEqual(retained)
    expect(previews[0]).toEqual(source)
    expect(previews[0]).not.toBe(previews[1])
    expect(previews[1]).not.toBe(previews[2])
  })

  it('retains reference semantics when a preview adjusts its current elevation/alluvium snapshot', () => {
    const raw = grid(11, 13, 92)
    const onStep: NonNullable<LandscapeOptions['onStep']> = step => { step.elevation[25] += .125; step.alluvium[25] += .01 }
    const settings = { passes: 8, sediment: true, onStep }
    expect(wasmErodeTerrain(raw, 11, 13, 100, settings)).toEqual(erodeTerrainJs(raw, 11, 13, 100, settings))
  })

  it('uses safe JS fallback for nested calls and rejects malformed dimensions/fields', () => {
    const raw = grid(9, 9, 54)
    expect(wasmRouteDrainage(raw, 8, 9, 100)).toBeNull()
    expect(wasmRouteDrainage(raw, 9, 9, 0)).toBeNull()
    expect(wasmRouteDrainage(new Float32Array(1_048_577), 1_048_577, 1, 100)).toBeNull()
    expect(wasmErodeTerrain(raw, 9, 9, 100, { passes: 1.5 })).toBeNull()
    expect(wasmErodeTerrain(raw, 9, 9, 100, { uplift: new Float32Array(2) })).toBeNull()
    const invalid = raw.slice(); invalid[7] = NaN
    expect(wasmRouteDrainage(invalid, 9, 9, 100)).toBeNull()
    let nested = 0
    expect(wasmErodeTerrain(raw, 9, 9, 100, { passes: 4, onStep: () => { expect(wasmRouteDrainage(raw, 9, 9, 100)).toBeNull(); nested++ } })).not.toBeNull()
    expect(nested).toBe(2)
    expect(terrainWasmStatus().state).toBe('ready')
    expect(wasmRouteDrainage(raw, 9, 9, 100)).toEqual(routeDrainageJs(raw, 9, 9, 100))
    expect(() => wasmErodeTerrain(raw, 9, 9, 100, { passes: 4, onStep: () => { throw new Error('preview stopped') } })).toThrow('preview stopped')
    expect(wasmRouteDrainage(raw, 9, 9, 100)).toEqual(routeDrainageJs(raw, 9, 9, 100))
  })

  it('rejects a mismatched binary before exposing its exports', async () => {
    vi.resetModules()
    const isolated = await import('./wasm-terrain')
    expect(isolated.wasmRouteDrainage(grid(3, 3), 3, 3, 100)).toBeNull()
    expect(await isolated.prepareTerrainWasm({ bytes: new Uint8Array([0, 97, 115, 109]) })).toBe(false)
    expect(isolated.terrainWasmStatus()).toEqual({ state: 'unavailable', reason: 'Terrain WASM binary/source version mismatch' })
    expect(isolated.wasmRouteDrainage(grid(3, 3), 3, 3, 100)).toBeNull()
  })

  it('bounds network loading and leaves JS fallback available after a timeout', async () => {
    vi.resetModules()
    const isolated = await import('./wasm-terrain')
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      expect(milliseconds).toBe(5000)
      return AbortSignal.abort(new DOMException('request timed out', 'TimeoutError'))
    })
    vi.stubGlobal('fetch', vi.fn((_url: unknown, options: RequestInit) => Promise.reject(options.signal!.reason)))
    try {
      expect(await isolated.prepareTerrainWasm({ url: 'https://example.invalid/terrain.wasm' })).toBe(false)
      expect(isolated.terrainWasmStatus()).toEqual({ state: 'unavailable', reason: 'request timed out' })
      expect(isolated.wasmRouteDrainage(grid(3, 3), 3, 3, 100)).toBeNull()
    } finally { timeout.mockRestore(); vi.unstubAllGlobals() }
  })
})
