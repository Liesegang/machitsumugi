/** Single-grain, depth-integrated storm reworking. The wave resuspension and
 * cross-shelf advection/diffusion mechanism follows Harris & Wiberg (2001/2002):
 * https://www.usgs.gov/publications/across-shelf-sediment-transport-interactions-between-suspended-and-bed-sediment
 * This is a bounded morphodynamic closure, not a wave/current hydrodynamics
 * solver or a calibrated coastal forecast. Fixed-point sediment is conserved;
 * sub-quantum loose sediment remains in its original cell, never as a source. */
export const MARINE_PHYSICS_VERSION = 'marine-storm-integer-v2-active-layer'
export const MARINE_Q = 4096
export interface MarineReworkingInput {
  elevation: Float32Array
  alluvium: Float64Array
  ocean: Uint8Array
  columns: number
  rows: number
  cellSize: number
  seaLevel: number
  suspended?: Float64Array
}
export interface MarineReworkingOptions {
  steps?: number
  timeStepSeconds?: number
  quantumMetres?: .0001 | .001
  waveHeightMetres?: number
  wavePeriodSeconds?: number
  waveBaseDepthMetres?: number
  waveFrictionFactor?: number
  criticalStressPascals?: number
  resuspensionMetresPerSecond?: number
  rockErosionMetresPerSecond?: number
  rockErosionLimitMetres?: number
  settlingVelocityMetresPerSecond?: number
  mixingDepthMetres?: number
  currentMetresPerSecond?: { x: number; y: number }
  diffusivityM2PerSecond?: number
  openBoundary?: boolean
  mode?: 'auto' | 'gpu' | 'cpu'
  signal?: AbortSignal
  timeoutMs?: number
  onStep?: (state: { elevation: Float32Array; iteration: number; iterations: number; seaLevel: number }) => void
}
export interface MarineReworkingBudget {
  initialLooseVolume: number
  finalLooseVolume: number
  initialSuspendedVolume: number
  suspendedVolume: number
  bedrockErodedVolume: number
  reentrainedVolume: number
  depositedVolume: number
  exportedVolume: number
  roundingResidualVolume: number
  immobileLooseVolume: number
  activeLayerDepthMetres: number
  renderRoundingVolume: number
  integerMassBalanceErrorUnits: number
  massBalanceError: number
  terrainBalanceError: number
  maxInputElevationQuantizationErrorMetres: number
  maxRenderRoundingMetres: number
  quantumMetres: number
  activeOceanCells: number
}
export interface MarineReworkingResult {
  elevation: Float32Array
  alluvium: Float64Array
  suspended: Float64Array
  delta: Float64Array
  budget: MarineReworkingBudget
  backend: 'webgpu' | 'cpu'
  metrics: { milliseconds: number; gpuMilliseconds: number; dispatches: number; readbacks: number; steps: number; fallbackReason?: string; adapter?: string }
  /** Exact integer state/ledger for CPU/GPU differential verification. */
  integerState: Uint32Array
  integerLedger: Uint32Array
}
export interface MarineKernel {
  input: MarineReworkingInput
  options: MarineReworkingOptions
  count: number
  steps: number
  quantum: number
  base: Int32Array
  ocean: Uint32Array
  coefficients: Uint32Array
  parameters: Uint32Array
  state: Uint32Array
  initialLoose: Uint32Array
  initialSuspended: Uint32Array
  activeCells: number
  roundingResidual: number
  immobileLoose: number
  activeLayerUnits: number
  maxQuantizationError: number
  gpuSafe: boolean
}
const nonnegative = (value: number, name: string) => { if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative`); return value }
export const marineScale = (value: number, fraction: number) => Math.floor(value / MARINE_Q) * fraction + Math.floor((value % MARINE_Q) * fraction / MARINE_Q)

function bottomStress(depth: number, height: number, period: number, friction: number) {
  const h = Math.max(.25, depth), wave = Math.min(height, .78 * h), omega = 2 * Math.PI / period
  let k = Math.max(omega * omega / 9.81, omega / Math.sqrt(9.81 * h))
  for (let n = 0; n < 10; n++) {
    const kh = Math.min(50, k * h), t = Math.tanh(kh)
    k = Math.max(1e-9, k - (9.81 * k * t - omega * omega) / (9.81 * (t + k * h * (1 - t * t))))
  }
  const velocity = Math.PI * wave / (period * Math.sinh(Math.min(50, k * h)))
  return .5 * 1025 * friction * velocity * velocity
}

export function createMarineKernel(input: MarineReworkingInput, options: MarineReworkingOptions = {}): MarineKernel {
  const { columns, rows, cellSize, seaLevel } = input, count = columns * rows
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 2 || rows < 2 || count > 1_000_000 || !Number.isFinite(cellSize) || cellSize <= 0 || !Number.isFinite(seaLevel)) throw new RangeError('Marine grids require 2..1,000,000 finite, positive cells')
  if ([input.elevation.length, input.alluvium.length, input.ocean.length, input.suspended?.length ?? count].some(length => length !== count)) throw new RangeError('Marine grid arrays have inconsistent lengths')
  const steps = options.steps ?? 96, dt = options.timeStepSeconds ?? 900, quantum = options.quantumMetres ?? .0001
  if (!Number.isInteger(steps) || steps < 0 || steps > 2048 || !Number.isFinite(dt) || dt <= 0 || ![.0001, .001].includes(quantum)) throw new RangeError('Marine steps, duration or sediment quantum are invalid')
  const waveHeight = nonnegative(options.waveHeightMetres ?? 1.5, 'Wave height'), period = nonnegative(options.wavePeriodSeconds ?? 8, 'Wave period')
  const waveBase = nonnegative(options.waveBaseDepthMetres ?? 40, 'Wave base'), critical = nonnegative(options.criticalStressPascals ?? .2, 'Critical stress')
  const friction = nonnegative(options.waveFrictionFactor ?? .02, 'Wave friction'), mixing = nonnegative(options.mixingDepthMetres ?? 10, 'Mixing depth')
  if (period <= 0 || critical <= 0 || mixing <= 0 || waveBase < .01 || waveBase > 200) throw new RangeError('Marine wave period, stress, mixing depth or wave base is outside supported bounds')
  const resuspension = nonnegative(options.resuspensionMetresPerSecond ?? 5e-6, 'Resuspension rate'), rockRate = nonnegative(options.rockErosionMetresPerSecond ?? 3e-9, 'Rock erosion rate')
  const rockLimit = nonnegative(options.rockErosionLimitMetres ?? .05, 'Rock erosion limit'), settling = nonnegative(options.settlingVelocityMetresPerSecond ?? .001, 'Settling velocity')
  const current = options.currentMetresPerSecond ?? { x: 0, y: 0 }, diffusion = nonnegative(options.diffusivityM2PerSecond ?? .2, 'Diffusivity')
  if (!Number.isFinite(current.x) || !Number.isFinite(current.y)) throw new RangeError('Marine current must be finite')
  const advection = [Math.max(0, -current.x), Math.max(0, current.x), Math.max(0, -current.y), Math.max(0, current.y)].map(value => Math.floor(value * dt / cellSize * MARINE_Q))
  const diff = Math.floor(diffusion * dt / (cellSize * cellSize) * MARINE_Q)
  if (advection.reduce((sum, v) => sum + v, 0) + diff * 4 > MARINE_Q * .95) throw new RangeError('Marine advection/diffusion exceeds the explicit face-flux CFL limit; reduce timeStepSeconds')
  const maxDepth = Math.ceil(waveBase * 100), coefficients = new Uint32Array((maxDepth + 1) * 2)
  for (let cm = 0; cm <= maxDepth; cm++) {
    const depth = cm / 100, stress = bottomStress(depth, waveHeight, period, friction)
    coefficients[cm * 2] = cm === maxDepth ? 0 : Math.floor(Math.min(1, Math.max(0, (stress / critical - 1) / 3)) * MARINE_Q)
    coefficients[cm * 2 + 1] = Math.floor((1 - Math.exp(-settling * dt / Math.max(.25, Math.min(mixing, depth)))) * MARINE_Q)
  }
  const rockQ = Math.floor(rockRate * dt / quantum * MARINE_Q), resuspendQ = Math.floor(resuspension * dt / quantum * MARINE_Q)
  const rockCap = Math.min(Math.floor(rockLimit / quantum), Math.ceil(rockQ / MARINE_Q * steps))
  if ([rockQ, resuspendQ, rockCap].some(value => value > 1_000_000_000)) throw new RangeError('Marine erosion rate exceeds the integer closure range')
  const parameters = new Uint32Array(20), signed = new Int32Array(parameters.buffer)
  parameters.set([columns, rows, count, 0, 0, Math.round(.01 / quantum), maxDepth, rockCap, rockQ, resuspendQ, MARINE_Q, 0, ...advection, diff, Number(options.openBoundary ?? true), 1, 0])
  signed[4] = Math.round(seaLevel / quantum)
  const base = new Int32Array(count), ocean = new Uint32Array(count), state = new Uint32Array(count * 8)
  const initialLoose = new Uint32Array(count), initialSuspended = new Uint32Array(count)
  // No event can entrain more than rate*duration from one cell. Deeper bulk is
  // immutable during this event and stays in the original f64 inventory. The
  // extra quantum prevents falsely exposing rock at the final rate-limited step.
  const activeLayerUnits = Math.ceil(resuspendQ / MARINE_Q * steps) + 1
  let activeCells = 0, initialUnits = 0, roundingResidual = 0, immobileLoose = 0, maxQuantizationError = 0, maxBase = 0
  for (let i = 0; i < count; i++) {
    if (!Number.isFinite(input.elevation[i]!) || Math.abs(input.elevation[i]!) > 20_000 || input.ocean[i]! > 1) throw new RangeError('Marine elevations/mask are outside supported bounds')
    nonnegative(input.alluvium[i]!, 'Loose sediment'); nonnegative(input.suspended?.[i] ?? 0, 'Suspended sediment')
    base[i] = Math.round(input.elevation[i]! / quantum)
    maxBase = Math.max(maxBase, Math.abs(base[i]!))
    maxQuantizationError = Math.max(maxQuantizationError, Math.abs(base[i]! * quantum - input.elevation[i]!))
    if (!input.ocean[i]) continue
    ocean[i] = 1; activeCells++
    const fullLoose = Math.floor(input.alluvium[i]! / quantum), loose = Math.min(fullLoose, activeLayerUnits), suspended = Math.floor((input.suspended?.[i] ?? 0) / quantum)
    if (!Number.isSafeInteger(fullLoose) || loose > 1_000_000_000 || suspended > 1_000_000_000) throw new RangeError('One marine cell exceeds the integer sediment range')
    initialLoose[i] = loose; initialSuspended[i] = suspended
    state[i * 8 + 1] = loose; state[i * 8 + 2] = suspended
    initialUnits += loose + suspended
    roundingResidual += input.alluvium[i]! - fullLoose * quantum + (input.suspended?.[i] ?? 0) - suspended * quantum
    immobileLoose += (fullLoose - loose) * quantum
  }
  const globalBound = initialUnits + activeCells * rockCap
  // A source budget bounds every gather, including the sum of four neighbours.
  // Never saturate, wrap or silently discard sediment to satisfy this limit.
  const ledgerBound = initialUnits + activeCells * (Math.ceil(resuspendQ / MARINE_Q) + Math.ceil(rockQ / MARINE_Q)) * steps
  if (!Number.isSafeInteger(globalBound) || globalBound + maxBase >= 2 ** 31 || ledgerBound >= 2 ** 32) {
    if (options.quantumMetres === undefined) return createMarineKernel(input, { ...options, quantumMetres: .001 })
    throw new RangeError('Marine sediment ledger exceeds its conservative 31-bit global mass bound')
  }
  return { input, options, count, steps, quantum, base, ocean, coefficients, parameters, state, initialLoose, initialSuspended, activeCells, roundingResidual, immobileLoose, activeLayerUnits, maxQuantizationError, gpuSafe: true }
}

export function marineDepthIndex(kernel: MarineKernel, state: Uint32Array, i: number) {
  const signed = new Int32Array(state.buffer, state.byteOffset, state.length), sea = new Int32Array(kernel.parameters.buffer)[4]!
  return Math.min(kernel.parameters[6]!, Math.floor(Math.max(0, sea - kernel.base[i]! - signed[i * 8]!) / kernel.parameters[5]!))
}

export function marineElevation(kernel: MarineKernel, state: Uint32Array) {
  const result = new Float32Array(kernel.input.elevation), signed = new Int32Array(state.buffer, state.byteOffset, state.length)
  for (let i = 0; i < result.length; i++) result[i] = kernel.input.elevation[i]! + signed[i * 8]! * kernel.quantum
  return result
}

export function finishMarineKernel(kernel: MarineKernel, state: Uint32Array, ledger: Uint32Array, backend: MarineReworkingResult['backend'], metrics: MarineReworkingResult['metrics']): MarineReworkingResult {
  const { input, quantum, count } = kernel, area = input.cellSize ** 2, unitVolume = quantum * area
  const elevation = marineElevation(kernel, state), alluvium = new Float64Array(input.alluvium), suspended = input.suspended ? new Float64Array(input.suspended) : new Float64Array(count), delta = new Float64Array(count)
  const signed = new Int32Array(state.buffer, state.byteOffset, state.length)
  let initialLooseVolume = 0, finalLooseVolume = 0, initialSuspendedVolume = 0, suspendedVolume = 0
  let rockUnits = 0, reentrainedUnits = 0, depositedUnits = 0, exportedUnits = 0, integerBalance = 0, deltaUnits = 0, renderRoundingVolume = 0, maxRenderRoundingMetres = 0
  for (let i = 0; i < count; i++) {
    const s = i * 8, l = i * 4
    if (kernel.ocean[i]) {
      alluvium[i] += (state[s + 1]! - kernel.initialLoose[i]!) * quantum
      suspended[i] += (state[s + 2]! - kernel.initialSuspended[i]!) * quantum
      delta[i] = signed[s]! * quantum; deltaUnits += signed[s]!
      integerBalance += kernel.initialLoose[i]! + kernel.initialSuspended[i]! + state[s + 3]! - state[s + 1]! - state[s + 2]! - ledger[l + 2]!
      rockUnits += state[s + 3]!; reentrainedUnits += ledger[l]!; depositedUnits += ledger[l + 1]!; exportedUnits += ledger[l + 2]!
    }
    initialLooseVolume += input.alluvium[i]! * area; finalLooseVolume += alluvium[i]! * area
    initialSuspendedVolume += (input.suspended?.[i] ?? 0) * area; suspendedVolume += suspended[i]! * area
    const rounding = elevation[i]! - input.elevation[i]! - delta[i]!
    renderRoundingVolume += rounding * area; maxRenderRoundingMetres = Math.max(maxRenderRoundingMetres, Math.abs(rounding))
  }
  const bedrockErodedVolume = rockUnits * unitVolume, exportedVolume = exportedUnits * unitVolume
  const budget: MarineReworkingBudget = {
    initialLooseVolume, finalLooseVolume, initialSuspendedVolume, suspendedVolume, bedrockErodedVolume, reentrainedVolume: reentrainedUnits * unitVolume, depositedVolume: depositedUnits * unitVolume, exportedVolume,
    roundingResidualVolume: kernel.roundingResidual * area, immobileLooseVolume: kernel.immobileLoose * area, activeLayerDepthMetres: kernel.activeLayerUnits * quantum, renderRoundingVolume, integerMassBalanceErrorUnits: integerBalance,
    massBalanceError: initialLooseVolume + initialSuspendedVolume + bedrockErodedVolume - finalLooseVolume - suspendedVolume - exportedVolume,
    terrainBalanceError: deltaUnits * unitVolume + suspendedVolume - initialSuspendedVolume + exportedVolume,
    maxInputElevationQuantizationErrorMetres: kernel.maxQuantizationError, maxRenderRoundingMetres, quantumMetres: quantum, activeOceanCells: kernel.activeCells,
  }
  return { elevation, alluvium, suspended, delta, budget, backend, metrics, integerState: state, integerLedger: ledger }
}

export function reworkMarineCPU(input: MarineReworkingInput, options: MarineReworkingOptions = {}): MarineReworkingResult {
  if (options.signal?.aborted) throw new DOMException('Marine reworking was cancelled', 'AbortError')
  const started = performance.now(), kernel = createMarineKernel(input, options), { count, parameters: p } = kernel
  const a = kernel.state.slice(), b = new Uint32Array(a.length), ai = new Int32Array(a.buffer), bi = new Int32Array(b.buffer)
  const flux = new Uint32Array(count * 4), ledger = new Uint32Array(count * 4), sea = new Int32Array(p.buffer)[4]!
  const target = (i: number, d: number) => { const x = i % input.columns, y = Math.floor(i / input.columns); return d === 0 ? x ? i - 1 : -1 : d === 1 ? x + 1 < input.columns ? i + 1 : -1 : d === 2 ? y ? i - input.columns : -1 : y + 1 < input.rows ? i + input.columns : -1 }
  const depth = (signed: Int32Array, i: number) => Math.min(p[6]!, Math.floor(Math.max(0, sea - kernel.base[i]! - signed[i * 8]!) / p[5]!))
  options.onStep?.({ elevation: new Float32Array(input.elevation), iteration: 0, iterations: kernel.steps, seaLevel: input.seaLevel })
  for (let step = 0; step < kernel.steps; step++) {
    if (options.signal?.aborted) throw new DOMException('Marine reworking was cancelled', 'AbortError')
    b.set(a)
    for (let i = 0; i < count; i++) {
      const s = i * 8
      if (!kernel.ocean[i] || kernel.base[i]! + ai[s]! > sea) continue
      const activity = kernel.coefficients[depth(ai, i) * 2]!
      const credit = marineScale(p[9]!, activity) + a[s + 4]!, removed = Math.min(a[s + 1]!, Math.floor(credit / MARINE_Q))
      b[s + 4] = removed < a[s + 1]! ? credit % MARINE_Q : 0
      b[s + 1] = a[s + 1]! - removed; b[s + 2] = a[s + 2]! + removed
      let rock = 0
      if (!b[s + 1]) {
        const rockCredit = marineScale(p[8]!, activity) + a[s + 5]!
        rock = Math.min(p[7]! - a[s + 3]!, Math.floor(rockCredit / MARINE_Q)); b[s + 5] = rockCredit % MARINE_Q
      } else b[s + 5] = 0
      b[s + 2] += rock; b[s + 3] = a[s + 3]! + rock; bi[s] = ai[s]! - removed - rock; ledger[i * 4] += removed
    }
    flux.fill(0)
    for (let i = 0; i < count; i++) {
      const s = i * 8
      if (!kernel.ocean[i] || kernel.base[i]! + bi[s]! > sea) continue
      for (let d = 0; d < 4; d++) {
        const j = target(i, d)
        if (j < 0 ? !p[17] : !kernel.ocean[j] || kernel.base[j]! + bi[j * 8]! > sea) continue
        const other = j < 0 ? 0 : b[j * 8 + 2]!
        flux[i * 4 + d] = marineScale(b[s + 2]!, p[12 + d]!) + marineScale(Math.max(0, b[s + 2]! - other), p[16]!)
      }
    }
    a.set(b)
    for (let i = 0; i < count; i++) {
      if (!kernel.ocean[i]) continue
      const s = i * 8, l = i * 4
      let load = b[s + 2]!, exported = 0
      for (let d = 0; d < 4; d++) {
        load -= flux[l + d]!
        const j = target(i, d)
        if (j < 0) exported += flux[l + d]!; else load += flux[j * 4 + (d ^ 1)]!
      }
      const settling = kernel.base[i]! + bi[s]! > sea ? MARINE_Q : kernel.coefficients[depth(bi, i) * 2 + 1]!
      const deposited = marineScale(load, settling)
      a[s + 1] = b[s + 1]! + deposited; a[s + 2] = load - deposited; ai[s] = bi[s]! + deposited
      ledger[l + 1] += deposited; ledger[l + 2] += exported
    }
    if ((step + 1) % 32 === 0 || step + 1 === kernel.steps) options.onStep?.({ elevation: marineElevation(kernel, a), iteration: step + 1, iterations: kernel.steps, seaLevel: input.seaLevel })
  }
  return finishMarineKernel(kernel, a, ledger, 'cpu', { milliseconds: performance.now() - started, gpuMilliseconds: 0, dispatches: 0, readbacks: 0, steps: kernel.steps })
}
