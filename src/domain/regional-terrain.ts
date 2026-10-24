import { erodeTerrain, routeDrainage } from './hydrology.ts'
import { initialLandscape } from './initial-landscape.ts'
import { coastalSeaLevel } from './coastal-landform.ts'
import type { ErosionDiagnostics, LandscapeOptions, SedimentDiagnostics } from './hydrology.ts'
import type { CityConfig, TerrainSurface } from './types'
import { MARINE_PHYSICS_VERSION, prepareMarineReworking, reworkMarineCPU } from '../compute/webgpu-marine-sediment'
import type { MarineReworkingInput, MarineReworkingOptions, MarineReworkingResult } from '../compute/webgpu-marine-sediment'
export interface RegionalPreview { surface: TerrainSurface; iteration: number; iterations: number; cached?: boolean; seaLevel: number; process?: 'fluvial' | 'marine' }
export interface RegionalRequest { seed: string; coastType?: CityConfig['coastType']; relief?: CityConfig['relief'] }
export type RegionalComputeOptions = Pick<MarineReworkingOptions, 'mode' | 'signal' | 'timeoutMs'> & {
  /** Diagnostic observer of the actual erosion grid, before preview decimation. */
  onFluvialStep?: LandscapeOptions['onStep']
}
export const REGIONAL_PHYSICS_VERSION = `landscape-v12:481x481:50m:256x4000y:marine-washload-v1:${MARINE_PHYSICS_VERSION}`

export interface RegionalTerrain {
  extent: number
  columns: number
  rows: number
  resolution: number
  seed: number
  initialDEM: Float32Array
  rawDEM: Float32Array
  hydroDEM: Float32Array
  flowTo: Int32Array
  accumulatedArea: Float64Array
  ocean: Uint8Array
  order: Int32Array
  processedCells: number
  outletArea: number
  fillVolume: number
  /** Final terrain/volume totals include marine work. Iterations, elapsedYears,
   * rmsHistory, finalStepRms and maxCumulativeIncision describe the fluvial
   * geological sequence; the storm's separate history/budget is in marine. */
  erosion: ErosionDiagnostics
  alluvium: Float32Array
  /** Exact inventory for subsequent physical stages; f32 is the query field. */
  alluvium64?: Float64Array
  sediment: SedimentDiagnostics
  /** Preserve the original river/uplift history separately from coastal work. */
  fluvial?: { erosion: ErosionDiagnostics; sediment: SedimentDiagnostics }
  marine?: MarineReworkingResult
}
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v))
const fade = (t: number) => t * t * (3 - 2 * t)
export function terrainSeed(seed: string) { let n = 2166136261; for (const c of seed) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return n >>> 0 }
export function terrainNoise(seed: number, x: number, y: number) {
  const hash = (i: number, j: number) => { let n = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ seed; n = Math.imul(n ^ n >>> 13, 1274126177); return ((n ^ n >>> 16) >>> 0) / 4294967295 }
  const i = Math.floor(x), j = Math.floor(y), u = fade(x - i), v = fade(y - j)
  return (hash(i, j) * (1 - u) + hash(i + 1, j) * u) * (1 - v) + (hash(i, j + 1) * (1 - u) + hash(i + 1, j + 1) * u) * v
}
export function sampleRegional(world: RegionalTerrain, field: Float32Array | Float64Array, x: number, y: number) {
  const gx = clamp(x / world.resolution, 0, world.columns - 1.001), gy = clamp(y / world.resolution, 0, world.rows - 1.001)
  const ix = Math.floor(gx), iy = Math.floor(gy), u = gx - ix, v = gy - iy, i = iy * world.columns + ix
  return (field[i]! * (1 - u) + field[i + 1]! * u) * (1 - v) + (field[i + world.columns]! * (1 - u) + field[i + world.columns + 1]! * u) * v
}
const cache = new Map<string, RegionalTerrain>()

/** Separable uniform-grid PCHIP reconstruction. Harmonic-mean tangents retain
 * C1 continuity and the cell-corner elevation range; an offshore cliff must not
 * create a new positive hill on a flat coast through Catmull-Rom overshoot.
 * Fritsch–Butland monotone piecewise cubic interpolation (1984).
 */
export function sampleRegionalCubic(world: RegionalTerrain, field: Float32Array, x: number, y: number) {
  const gx = clamp(x / world.resolution, 1, world.columns - 2.001), gy = clamp(y / world.resolution, 1, world.rows - 2.001), ix = Math.floor(gx), iy = Math.floor(gy)
  const cubic = (a: number, b: number, c: number, d: number, t: number) => {
    const left = b - a, middle = c - b, right = d - c
    const first = left * middle > 0 ? 2 * left * middle / (left + middle) : 0
    const last = middle * right > 0 ? 2 * middle * right / (middle + right) : 0
    const square = t * t, cube = square * t
    return (2 * cube - 3 * square + 1) * b + (cube - 2 * square + t) * first + (-2 * cube + 3 * square) * c + (cube - square) * last
  }
  const values: number[] = []
  for (let j = -1; j <= 2; j++) { const row = (iy + j) * world.columns + ix; values.push(cubic(field[row - 1]!, field[row]!, field[row + 1]!, field[row + 2]!, gx - ix)) }
  return cubic(values[0]!, values[1]!, values[2]!, values[3]!, gy - iy)
}

export interface RegionalBase {
  extent: number; resolution: number; columns: number; rows: number; seed: number; seaLevel: number
  eroded: ReturnType<typeof erodeTerrain>
}
const pending = new Map<string, Promise<RegionalTerrain>>()
export function regionalTerrainKey(input: RegionalRequest) { return `${REGIONAL_PHYSICS_VERSION}:${input.seed}:${input.coastType ?? 'bay'}:${input.relief ?? 'hills'}` }
function previewFrame(base: Pick<RegionalBase, 'columns' | 'rows' | 'resolution'>, elevation: Float32Array, iteration: number, iterations: number, seaLevel: number, onPreview?: (frame: RegionalPreview) => void, process: RegionalPreview['process'] = 'fluvial', cached = false) {
  if (!onPreview) return
  const stride = 2, columns = Math.floor((base.columns - 1) / stride) + 1, rows = Math.floor((base.rows - 1) / stride) + 1, elevations: number[] = []
  for (let y = 0; y < base.rows; y += stride) for (let x = 0; x < base.columns; x += stride) elevations.push(elevation[y * base.columns + x]!)
  onPreview({ surface: { columns, rows, cellSize: base.resolution * stride, elevations }, iteration, iterations, cached, seaLevel, process })
}

/** This base is private until BOTH fluvial and marine evolution are complete. */
export function buildRegionalBase(input: RegionalRequest, onPreview?: (frame: RegionalPreview) => void, onFluvialStep?: LandscapeOptions['onStep']): RegionalBase {
  const extent = 24_000, resolution = 50, columns = extent / resolution + 1, rows = columns, count = columns * rows
  const seed = terrainSeed(`${input.seed}:uplift-v1`), coastType = input.coastType ?? 'bay', relief = input.relief ?? 'hills'
  const initial = initialLandscape({ columns, resolution, extent, noise: terrainNoise, seed, coastType, relief })
  const seaAt = (iteration: number, iterations: number) => coastalSeaLevel(coastType, iteration, iterations)
  const eroded = erodeTerrain(initial.elevation, columns, rows, resolution, {
    passes: 256, timeStepYears: 4000, uplift: initial.uplift, erodibility: initial.erodibility,
    diffusivity: .15, sediment: true,
    // Drowned valleys and island-margin bays result from a late base-level
    // rise over the eroded terrain, never a stamped outline or restored mask.
    seaLevel: seaAt,
    onStep: state => { previewFrame({ columns, rows, resolution }, state.elevation, state.iteration, state.iterations, state.seaLevel, onPreview); onFluvialStep?.(state) },
  })
  if (eroded.rawDEM.length !== count) throw new Error('広域地形の計算格子が一致しません。')
  return { extent, columns, rows, resolution, seed, seaLevel: seaAt(eroded.erosion.iterations, eroded.erosion.iterations), eroded }
}

/** Only boundary-connected water is ocean; enclosed negative lakes stay lakes. */
export function regionalOceanMask(elevation: Float32Array, columns: number, rows: number, seaLevel: number): Uint8Array {
  const count = columns * rows, ocean = new Uint8Array(count), queue = new Int32Array(count)
  let head = 0, tail = 0
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) if (!row || !col || row === rows - 1 || col === columns - 1) {
    const i = row * columns + col
    if (elevation[i]! <= seaLevel && !ocean[i]) { ocean[i] = 1; queue[tail++] = i }
  }
  while (head < tail) {
    const i = queue[head++]!, x = i % columns, y = Math.floor(i / columns)
    for (const j of [x > 0 ? i - 1 : -1, x + 1 < columns ? i + 1 : -1, y > 0 ? i - columns : -1, y + 1 < rows ? i + columns : -1]) {
      if (j >= 0 && !ocean[j] && elevation[j]! <= seaLevel) { ocean[j] = 1; queue[tail++] = j }
    }
  }
  return ocean
}
function marineInput(base: RegionalBase): MarineReworkingInput {
  return { elevation: base.eroded.rawDEM, alluvium: base.eroded.alluvium64, columns: base.columns, rows: base.rows, cellSize: base.resolution, seaLevel: base.seaLevel, ocean: regionalOceanMask(base.eroded.rawDEM, base.columns, base.rows, base.seaLevel) }
}

/** Shared materialization for CPU and GPU. Never reuse pre-coast drainage or
 * mutate an already cached world's DEM/query closures in place. */
export function materializeRegionalTerrain(base: RegionalBase, marine: MarineReworkingResult): RegionalTerrain {
  const { eroded, columns, rows, resolution, extent, seed } = base, rawDEM = marine.elevation
  const count = columns * rows, area = resolution ** 2
  if (rawDEM.length !== count || marine.alluvium.length !== count || marine.suspended.length !== count || marine.delta.length !== count) throw new Error('沿岸地形と土砂の計算格子が一致しません。')
  if (!rawDEM.every(Number.isFinite) || !marine.delta.every(Number.isFinite) || !marine.alluvium.every(value => Number.isFinite(value) && value >= 0) || !marine.suspended.every(value => Number.isFinite(value) && value >= 0) || !Object.values(marine.budget).every(Number.isFinite)) throw new Error('沿岸の標高・土砂収支に不正な値があります。')
  const drainage = routeDrainage(rawDEM, columns, rows, resolution)
  const initialFlow = routeDrainage(eroded.initialDEM, columns, rows, resolution).flowTo
  let stored = 0, finalTerrainVolume = 0, squares = 0, absolute = 0, changedCells = 0, reorganized = 0, maxIncision = 0, maxRaising = 0
  for (let i = 0; i < count; i++) {
    stored += (marine.alluvium[i]! + marine.suspended[i]!) * area
    finalTerrainVolume += rawDEM[i]! * area
    const change = rawDEM[i]! - eroded.initialDEM[i]!
    squares += change * change; absolute += Math.abs(change)
    if (Math.abs(change) > .01) changedCells++
    if (initialFlow[i] !== drainage.flowTo[i]) reorganized++
    maxIncision = Math.max(maxIncision, -change); maxRaising = Math.max(maxRaising, change)
  }
  const budget = marine.budget
  const sediment: SedimentDiagnostics = { ...eroded.sediment,
    erodedSourceVolume: eroded.sediment.erodedSourceVolume + budget.bedrockErodedVolume,
    sedimentReentrainedVolume: eroded.sediment.sedimentReentrainedVolume + budget.reentrainedVolume,
    depositedVolume: eroded.sediment.depositedVolume + budget.depositedVolume,
    marineDepositedVolume: eroded.sediment.marineDepositedVolume + budget.depositedVolume,
    exportedVolume: eroded.sediment.exportedVolume + budget.exportedVolume,
    storedVolume: stored,
  }
  sediment.massBalanceError = sediment.erodedSourceVolume - sediment.storedVolume - sediment.exportedVolume
  const erosion: ErosionDiagnostics = { ...eroded.erosion, rmsHistory: [...eroded.erosion.rmsHistory],
    erodedVolume: eroded.erosion.erodedVolume + budget.bedrockErodedVolume + budget.reentrainedVolume,
    finalTerrainVolume, rmsElevationChange: Math.sqrt(squares / count), meanAbsoluteChange: absolute / count, changedCells, flowReorganization: reorganized / count, maxIncision, maxRaising,
  }
  erosion.terrainBalanceError = finalTerrainVolume - erosion.initialTerrainVolume - erosion.upliftVolume + erosion.erodedVolume - sediment.depositedVolume - erosion.diffusionNetVolume
  return { extent, columns, rows, resolution, seed, ...eroded, rawDEM, alluvium: Float32Array.from(marine.alluvium), alluvium64: marine.alluvium,
    sediment, erosion, ...drainage, ocean: regionalOceanMask(rawDEM, columns, rows, base.seaLevel), marine,
    fluvial: { erosion: { ...eroded.erosion, rmsHistory: [...eroded.erosion.rmsHistory] }, sediment: { ...eroded.sediment } },
  }
}
function cachedRegional(key: string, onPreview?: (frame: RegionalPreview) => void) {
  const world = cache.get(key)
  if (!world) return undefined
  cache.delete(key); cache.set(key, world)
  previewFrame(world, world.rawDEM, world.erosion.iterations, world.erosion.iterations, 0, onPreview, 'marine', true)
  return world
}
function installRegional(key: string, result: RegionalTerrain) {
  cache.set(key, result)
  while (cache.size > 6) cache.delete(cache.keys().next().value!)
  return result
}

/** Synchronous fallback solves the identical marine model on the CPU. */
export function getRegionalTerrain(seedText: string, coastType: CityConfig['coastType'] = 'bay', onPreview?: (frame: RegionalPreview) => void, relief: CityConfig['relief'] = 'hills'): RegionalTerrain {
  const input = { seed: seedText, coastType, relief }, key = regionalTerrainKey(input), cached = cachedRegional(key, onPreview)
  if (cached) return cached
  const base = buildRegionalBase(input, onPreview)
  const marine = reworkMarineCPU(marineInput(base), { onStep: step => previewFrame(base, step.elevation, step.iteration, step.iterations, base.seaLevel, onPreview, 'marine') })
  return installRegional(key, materializeRegionalTerrain(base, marine))
}

/** The worker awaits this before creating its local crop. A capability failure
 * computes the SAME marine stage on CPU; partial GPU state is never installed. */
export async function prepareRegionalTerrain(input: RegionalRequest, options: RegionalComputeOptions = {}, onPreview?: (frame: RegionalPreview) => void): Promise<RegionalTerrain> {
  const key = regionalTerrainKey(input), cached = cachedRegional(key, onPreview)
  if (cached) return cached
  const existing = pending.get(key)
  if (existing) return existing
  const task = (async () => {
    const base = buildRegionalBase(input, onPreview, options.onFluvialStep)
    const marine = await prepareMarineReworking(marineInput(base), { mode: options.mode, signal: options.signal, timeoutMs: options.timeoutMs, onStep: step => previewFrame(base, step.elevation, step.iteration, step.iterations, base.seaLevel, onPreview, 'marine') })
    return installRegional(key, materializeRegionalTerrain(base, marine))
  })()
  pending.set(key, task)
  try { return await task } finally { pending.delete(key) }
}
