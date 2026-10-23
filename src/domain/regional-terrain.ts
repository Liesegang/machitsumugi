import { erodeTerrain } from './hydrology.ts'
import { initialLandscape } from './initial-landscape.ts'
import type { ErosionDiagnostics, SedimentDiagnostics } from './hydrology.ts'
import type { CityConfig, TerrainSurface } from './types'
export interface RegionalPreview { surface: TerrainSurface; iteration: number; iterations: number; cached?: boolean; seaLevel: number }

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
  erosion: ErosionDiagnostics
  alluvium: Float32Array
  sediment: SedimentDiagnostics
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

/** Regional landforms precede the 4×3km city crop; river catchments are never viewport-sized. */
export function getRegionalTerrain(seedText: string, coastType: CityConfig['coastType'] = 'bay', onPreview?: (frame: RegionalPreview) => void, relief: CityConfig['relief'] = 'hills'): RegionalTerrain {
  const key = `${seedText}:${coastType}:${relief}`, cached = cache.get(key)
  const frame = (elevation: Float32Array, columns: number, resolution: number, iteration: number, iterations: number, cached = false, seaLevel = 0) => {
    if (!onPreview) return
    const stride = 2, side = Math.floor((columns - 1) / stride) + 1, elevations: number[] = []
    for (let y = 0; y < columns; y += stride) for (let x = 0; x < columns; x += stride) elevations.push(elevation[y * columns + x]!)
    onPreview({ surface: { columns: side, rows: side, cellSize: resolution * stride, elevations }, iteration, iterations, cached, seaLevel })
  }
  if (cached) { cache.delete(key); cache.set(key, cached); frame(cached.rawDEM, cached.columns, cached.resolution, cached.erosion.iterations, cached.erosion.iterations, true); return cached }
  const extent = 24_000, resolution = 100, columns = extent / resolution + 1, rows = columns, count = columns * rows
  const seed = terrainSeed(`${seedText}:uplift-v1`)
  const initial = initialLandscape({ columns, resolution, extent, noise: terrainNoise, seed, coastType, relief })
  const eroded = erodeTerrain(initial.elevation, columns, rows, resolution, {
    passes: 256, timeStepYears: 4000, uplift: initial.uplift, erodibility: initial.erodibility,
    diffusivity: .15, sediment: true,
    // Drowned valleys result from a late base-level rise over the previously
    // eroded terrain. No ria outline or river-mouth trumpet is stamped on it.
    seaLevel: coastType === 'ria' ? (iteration, iterations) => -40 * (1 - clamp((iteration - iterations + 16) / 16)) : undefined,
    onStep: state => frame(state.elevation, columns, resolution, state.iteration, state.iterations, false, state.seaLevel),
  })
  const ocean = new Uint8Array(count), queue = new Int32Array(count)
  let head = 0, tail = 0
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) if (!row || !col || row === rows - 1 || col === columns - 1) {
    const i = row * columns + col
    if (eroded.rawDEM[i]! <= 0 && !ocean[i]) { ocean[i] = 1; queue[tail++] = i }
  }
  while (head < tail) {
    const i = queue[head++]!, x = i % columns, y = Math.floor(i / columns)
    for (const j of [x > 0 ? i - 1 : -1, x + 1 < columns ? i + 1 : -1, y > 0 ? i - columns : -1, y + 1 < rows ? i + columns : -1]) {
      if (j >= 0 && !ocean[j] && eroded.rawDEM[j]! <= 0) { ocean[j] = 1; queue[tail++] = j }
    }
  }
  const result: RegionalTerrain = { extent, columns, rows, resolution, seed, ...eroded, ocean }
  cache.set(key, result)
  while (cache.size > 6) cache.delete(cache.keys().next().value!)
  return result
}
