import type { DrainageResult, ErosionDiagnostics, LandscapeOptions, SedimentDiagnostics } from '../domain/hydrology'
import { TERRAIN_WASM_SHA256 } from './terrain-kernel-version'

interface KernelExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory
  terrain_abi_version(): number
  terrain_grid(columns: number, rows: number, cellSize: number, passes: number): number
  terrain_buffer(slot: number): number
  terrain_route(ltd: number): number
  terrain_start(dt: number, diffusivity: number, flags: number): number
  terrain_step(until: number): number
  terrain_release(): void
}
export type WasmLandscape = DrainageResult & {
  rawDEM: Float32Array; initialDEM: Float32Array; alluvium: Float32Array; alluvium64: Float64Array
  sediment: SedimentDiagnostics; erosion: ErosionDiagnostics
}
let kernel: KernelExports | undefined, preparing: Promise<boolean> | undefined, busy = false
let state: 'unprepared' | 'loading' | 'ready' | 'unavailable' = 'unprepared', failure: string | undefined

export function terrainWasmStatus() { return { state, reason: failure } }

/** Initialize once per worker. The checked-in binary requires no Rust toolchain
 * at runtime; unavailable WASM/network/verification leaves the JS fallback usable. */
export function prepareTerrainWasm(input: { bytes?: BufferSource; url?: string | URL } = {}): Promise<boolean> {
  if (kernel) return Promise.resolve(true)
  if (preparing) return preparing
  state = 'loading'
  preparing = (async () => {
    try {
      if (typeof WebAssembly === 'undefined' || !globalThis.crypto?.subtle) throw new Error('WebAssembly or SHA-256 verification unavailable')
      let bytes: ArrayBuffer
      if (input.bytes) {
        const view = ArrayBuffer.isView(input.bytes) ? new Uint8Array(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength) : new Uint8Array(input.bytes)
        bytes = Uint8Array.from(view).buffer
      } else {
        const base = typeof location === 'undefined' ? undefined : new URL(import.meta.env.BASE_URL, location.href)
        if (!input.url && !base) throw new Error('No browser URL or supplied WASM bytes')
        // Pages may cache public files across releases. Key the request by the
        // verified binary so a new bundle cannot receive the previous kernel.
        const response = await fetch(input.url ?? new URL(`compute/terrain.wasm?sha256=${TERRAIN_WASM_SHA256}`, base!), { signal: AbortSignal.timeout(5000) })
        if (!response.ok) throw new Error(`Terrain WASM HTTP ${response.status}`)
        bytes = await response.arrayBuffer()
      }
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      const hash = [...digest].map(value => value.toString(16).padStart(2, '0')).join('')
      if (hash !== TERRAIN_WASM_SHA256) throw new Error('Terrain WASM binary/source version mismatch')
      const loaded = await WebAssembly.instantiate(bytes, { math: { hypot: Math.hypot, exp: Math.exp } })
      const exports = loaded.instance.exports as KernelExports
      if (!(exports.memory instanceof WebAssembly.Memory) || typeof exports.terrain_abi_version !== 'function' || exports.terrain_abi_version() !== 1) throw new Error('Terrain WASM ABI mismatch')
      kernel = exports; state = 'ready'; failure = undefined; return true
    } catch (error) {
      state = 'unavailable'; failure = error instanceof Error ? error.message : String(error); return false
    }
  })()
  return preparing
}

function validGrid(raw: Float32Array, columns: number, rows: number, cellSize: number) {
  return raw instanceof Float32Array && Number.isInteger(columns) && columns > 0 && Number.isInteger(rows) && rows > 0 && raw.length === columns * rows && raw.length <= 1_048_576 && Number.isFinite(cellSize) && cellSize > 0 && Number.isFinite(cellSize ** 2) && raw.every(Number.isFinite)
}
function view32(exports: KernelExports, slot: number, length: number) { return new Float32Array(exports.memory.buffer, exports.terrain_buffer(slot), length) }
function view64(exports: KernelExports, slot: number, length: number) { return new Float64Array(exports.memory.buffer, exports.terrain_buffer(slot), length) }
function readDrainage(exports: KernelExports, count: number): DrainageResult {
  const stats = view64(exports, 10, 40)
  return {
    hydroDEM: view32(exports, 6, count).slice(),
    flowTo: new Int32Array(exports.memory.buffer, exports.terrain_buffer(7), count).slice(),
    accumulatedArea: view64(exports, 8, count).slice(),
    order: new Int32Array(exports.memory.buffer, exports.terrain_buffer(9), count).slice(),
    processedCells: stats[25]!, outletArea: stats[26]!, fillVolume: stats[27]!,
  }
}

/** Synchronous after preparation; null means use the unchanged JS reference.
 * Results own their arrays and cannot be invalidated by subsequent WASM calls. */
export function wasmRouteDrainage(raw: Float32Array, columns: number, rows: number, cellSize: number, method: 'd8' | 'd8-ltd' = 'd8-ltd'): DrainageResult | null {
  if (!kernel || busy || !validGrid(raw, columns, rows, cellSize) || method !== 'd8' && method !== 'd8-ltd') return null
  const exports = kernel; busy = true
  try {
    if (!exports.terrain_grid(columns, rows, cellSize, 0)) return null
    view32(exports, 0, raw.length).set(raw)
    if (!exports.terrain_route(Number(method === 'd8-ltd'))) throw new Error('Terrain WASM drainage failed')
    return readDrainage(exports, raw.length)
  } finally { exports.terrain_release(); busy = false }
}

/** Full erosion remains in one WASM allocation. Only the four-pass preview
 * boundaries are copied out; sea level is evaluated for EVERY individual pass. */
export function wasmErodeTerrain(raw: Float32Array, columns: number, rows: number, cellSize: number, options: number | LandscapeOptions = 32): WasmLandscape | null {
  if (!kernel || busy || !validGrid(raw, columns, rows, cellSize)) return null
  const settings = typeof options === 'number' ? { passes: options } : options
  const passes = settings.passes ?? 32, dt = settings.timeStepYears ?? 250, diffusivity = settings.diffusivity ?? .2
  if (!Number.isInteger(passes) || passes < 0 || passes > 4096 || !Number.isFinite(dt) || dt < 0 || !Number.isFinite(diffusivity) || diffusivity < 0) return null
  for (const field of [settings.uplift, settings.erodibility]) if (field && (!(field instanceof Float32Array) || field.length !== raw.length || !field.every(Number.isFinite))) return null
  const exports = kernel, count = raw.length; busy = true
  try {
    if (!exports.terrain_grid(columns, rows, cellSize, passes)) return null
    view32(exports, 0, count).set(raw)
    if (settings.uplift) view32(exports, 1, count).set(settings.uplift)
    if (settings.erodibility) view32(exports, 2, count).set(settings.erodibility)
    if (!exports.terrain_start(dt, diffusivity, Number(!!settings.uplift) | Number(!!settings.erodibility) * 2 | Number(!!settings.sediment) * 4)) throw new Error('Terrain WASM initialization failed')
    const seaAt = (iteration: number) => {
      const level = settings.seaLevel?.(iteration, passes) ?? 0
      if (!Number.isFinite(level)) throw new Error('Terrain sea level must be finite')
      return level
    }
    const preview = (iteration: number, seaLevel: number) => {
      if (!settings.onStep) return
      const elevation = view32(exports, 4, count).slice(), alluvium = view64(exports, 5, count).slice()
      settings.onStep({ elevation, iteration, iterations: passes, alluvium, seaLevel })
      // Match the reference's callback-visible mutable snapshots without exposing
      // linear memory or allowing a nested call to destroy the current state.
      view32(exports, 4, count).set(elevation); view64(exports, 5, count).set(alluvium)
    }
    if (settings.onStep) preview(0, seaAt(0))
    for (let start = 0; start < passes; start += 4) {
      const end = Math.min(passes, start + 4)
      let level = 0
      for (let iteration = start + 1; iteration <= end; iteration++) {
        level = seaAt(iteration); view64(exports, 3, passes + 1)[iteration] = level
      }
      if (exports.terrain_step(end) !== end) throw new Error('Terrain WASM iteration failed')
      preview(end, level)
    }
    // Match final diagnostics after the last callback, including its mutable
    // snapshots. This advances no extra simulation iterations.
    exports.terrain_step(passes)
    const stats = view64(exports, 10, 40)
    const sediment: SedimentDiagnostics = {
      erodedSourceVolume: stats[0]!, depositedVolume: stats[1]!, exportedVolume: stats[2]!, sedimentReentrainedVolume: stats[3]!,
      marineDepositedVolume: stats[4]!, terrestrialDepositedVolume: stats[5]!, lakeDepositedVolume: stats[6]!, hillslopeBedrockVolume: stats[7]!, hillslopeTransferredVolume: stats[8]!, storedVolume: stats[9]!, massBalanceError: stats[10]!,
    }
    const erosion: ErosionDiagnostics = {
      iterations: passes, timeStepYears: dt, elapsedYears: passes * dt, erodedVolume: stats[11]!, upliftVolume: stats[12]!, diffusionNetVolume: stats[13]!,
      maxIncision: stats[14]!, maxCumulativeIncision: stats[15]!, maxRaising: stats[16]!, rmsElevationChange: stats[17]!, meanAbsoluteChange: stats[18]!, changedCells: stats[19]!, finalStepRms: stats[20]!, flowReorganization: stats[21]!,
      initialTerrainVolume: stats[22]!, finalTerrainVolume: stats[23]!, terrainBalanceError: stats[24]!, rmsHistory: [...view64(exports, 11, passes)],
    }
    const alluvium64 = view64(exports, 5, count).slice()
    return { rawDEM: view32(exports, 4, count).slice(), initialDEM: new Float32Array(raw), alluvium: Float32Array.from(alluvium64), alluvium64, sediment, erosion, ...readDrainage(exports, count) }
  } finally { exports.terrain_release(); busy = false }
}
