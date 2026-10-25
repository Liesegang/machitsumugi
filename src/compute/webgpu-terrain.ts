/// <reference types="@webgpu/types" />
import { erodeTerrain } from '../domain/hydrology'
import type { LandscapeOptions } from '../domain/hydrology'
import { TERRAIN_EROSION_SHADER } from './webgpu-terrain-shader'
export { erodeTerrainReference, routeTerrainReference } from './webgpu-terrain-reference'
export const GPU_TERRAIN_PHYSICS_VERSION = 'landscape-gpu-v1:minimax-flat-distance:ltd:implicit-incision:mfd-sediment'
export interface TerrainComputeOptions extends LandscapeOptions { mode?: 'auto' | 'gpu' | 'cpu'; signal?: AbortSignal; timeoutMs?: number; profile?: boolean }
export interface TerrainComputeMetrics { milliseconds: number; gpuMilliseconds: number; dispatches: number; readbacks: number; routingIterations: number; adapter?: string; fallbackReason?: string; terrainRoundingResidualVolume?: number; maxCellTerrainResidualMetres?: number; readbackWaitMilliseconds?: number; conditioningWallMilliseconds?: number; queueWorkgroupSize?: number; gpuPhaseSamples?: Record<string, { milliseconds: number; dispatches: number }> }
export type TerrainErosionResult = ReturnType<typeof erodeTerrain> & { backend: 'webgpu' | 'cpu'; metrics: TerrainComputeMetrics; ocean?: Uint8Array }
const STRIDE = 28, FLOAT_BYTES = 4, CELL_BYTES = STRIDE * FLOAT_BYTES
const abortError = () => new DOMException('Terrain erosion was cancelled', 'AbortError')

/** All physical phases execute on GPU. Readbacks are small convergence flags,
 * requested previews, and final state; no CPU basin/river/erosion work occurs
 * inside this path. Non-WebGPU fallback deliberately retains the old solver. */
export async function prepareTerrainErosion(raw: Float32Array, columns: number, rows: number, cellSize: number, options: TerrainComputeOptions = {}): Promise<TerrainErosionResult> {
  const started = performance.now(), passes = options.passes ?? 32, dt = options.timeStepYears ?? 250, count = raw.length
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 2 || rows < 2 || columns * rows !== count || !Number.isFinite(cellSize) || cellSize <= 0 || !Number.isInteger(passes) || passes < 0 || passes > 4096 || !Number.isFinite(dt) || dt < 0 || !Number.isFinite(options.diffusivity ?? .2) || (options.diffusivity ?? .2) < 0) throw new RangeError('Invalid GPU terrain grid or integration parameters')
  for (let i = 0; i < count; i++) if (!Number.isFinite(raw[i]) || !Number.isFinite(options.uplift?.[i] ?? 0) || !Number.isFinite(options.erodibility?.[i] ?? 2.5e-5) || (options.erodibility?.[i] ?? 2.5e-5) < 0) throw new RangeError('GPU terrain inputs must be finite, with nonnegative erodibility')
  if (options.uplift && options.uplift.length !== count || options.erodibility && options.erodibility.length !== count) throw new RangeError('GPU terrain field dimensions do not match')
  if (options.signal?.aborted) throw abortError()
  let lastPreview = -1
  const onStep: LandscapeOptions['onStep'] = options.onStep ? state => { if (state.iteration > lastPreview) { lastPreview = state.iteration; options.onStep!(state) } } : undefined
  const metrics: TerrainComputeMetrics = { milliseconds: 0, gpuMilliseconds: 0, dispatches: 0, readbacks: 0, routingIterations: 0 }
  const fallback = (reason?: string): TerrainErosionResult => { const result = erodeTerrain(raw, columns, rows, cellSize, { ...options, onStep }); metrics.milliseconds = performance.now() - started; metrics.fallbackReason = reason; return { ...result, backend: 'cpu', metrics } }
  if (options.mode === 'cpu') return fallback()
  if (typeof navigator === 'undefined' || !navigator.gpu) return fallback('WebGPU compute is unavailable')
  let device: GPUDevice | undefined, timer: ReturnType<typeof setTimeout> | undefined, cancelled = false, querySet: GPUQuerySet | undefined
  const buffers: GPUBuffer[] = [], cleanup = () => { for (const buffer of buffers) { if (buffer.mapState === 'mapped') buffer.unmap(); buffer.destroy() }; querySet?.destroy(); device?.destroy() }
  const check = () => { if (options.signal?.aborted) throw abortError(); if (cancelled) throw new Error('GPU terrain execution stopped') }
  let abortListener: (() => void) | undefined
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { cancelled = true; cleanup(); reject(new Error('GPU terrain calculation timed out')) }, options.timeoutMs ?? 120_000)
    abortListener = () => { cancelled = true; cleanup(); reject(abortError()) }; options.signal?.addEventListener('abort', abortListener, { once: true })
  })
  const gpuStarted = performance.now()
  const run = async () => {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); check()
    if (!adapter) throw new Error('No WebGPU terrain compute adapter')
    metrics.adapter = [adapter.info.vendor, adapter.info.architecture, adapter.info.description].filter(Boolean).join(' / ')
    const timestamp = options.profile && adapter.features.has('timestamp-query')
    const supportedWorkers = Math.min(adapter.limits.maxComputeInvocationsPerWorkgroup, adapter.limits.maxComputeWorkgroupSizeX), queueWorkers = supportedWorkers >= 1024 ? 1024 : supportedWorkers >= 512 ? 512 : 256
    metrics.queueWorkgroupSize = queueWorkers
    device = await adapter.requestDevice({ requiredFeatures: timestamp ? ['timestamp-query'] : [], requiredLimits: { maxComputeInvocationsPerWorkgroup: queueWorkers, maxComputeWorkgroupSizeX: queueWorkers } }); if (cancelled) device.destroy(); check(); device.pushErrorScope('validation')
    if (timestamp) querySet = device.createQuerySet({ type: 'timestamp', count: 2048 })
    const queryNames: string[] = []
    const allocate = (size: number, usage: GPUBufferUsageFlags, data?: ArrayBufferView) => { if (size > device!.limits.maxBufferSize || usage & GPUBufferUsage.STORAGE && size > device!.limits.maxStorageBufferBindingSize) throw new Error('Terrain grid exceeds GPU buffer limits'); const buffer = device!.createBuffer({ size: Math.max(16, size), usage }); buffers.push(buffer); if (data) device!.queue.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength); return buffer }
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    const inputs = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) { inputs[i * 4] = raw[i]!; inputs[i * 4 + 1] = options.uplift?.[i] ?? 0; inputs[i * 4 + 2] = options.erodibility?.[i] ?? 2.5e-5 }
    const input = allocate(inputs.byteLength, storage, inputs), cells = allocate(count * CELL_BYTES, storage), a = allocate(count * 16, storage), b = allocate(count * 16, storage), queue = allocate(count * 4, storage), control = allocate((passes + 32) * 4, storage), faces = allocate(count * 64, storage)
    const smallRead = allocate(16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ), previewRead = allocate(count * 16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
    const uniformBytes = new ArrayBuffer((passes + 1) * 2 * 256), integers = new Uint32Array(uniformBytes), floats = new Float32Array(uniformBytes)
    for (let pass = 0; pass <= passes; pass++) for (let mode = 0; mode < 2; mode++) { const offset = (pass * 2 + mode) * 64; integers.set([columns, rows, count, mode], offset); floats.set([cellSize, dt, Math.min(.2, (options.diffusivity ?? .2) * dt / cellSize ** 2), options.seaLevel?.(pass === 0 ? 0 : pass, passes) ?? 0], offset + 4); integers[offset + 8] = Number(!!options.sediment); integers[offset + 9] = pass; if (!Number.isFinite(floats[offset + 7])) throw new RangeError('Terrain sea level must be finite') }
    const uniform = allocate(uniformBytes.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, new Uint8Array(uniformBytes))
    const layout = device.createBindGroupLayout({ entries: Array.from({ length: 8 }, (_, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: binding === 0 ? 'uniform' : binding === 1 ? 'read-only-storage' : 'storage', ...(binding === 0 ? { hasDynamicOffset: true, minBindingSize: 48 } : {}) } })) })
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }), module = device.createShaderModule({ label: 'Full conservative landscape erosion and sediment transport', code: TERRAIN_EROSION_SHADER })
    const errors = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error')
    check()
    if (errors.length) throw new Error(errors.map(e => `Terrain shader ${e.lineNum}:${e.linePos}: ${e.message}`).join('\n'))
    const names = ['initialize', 'resetChanged', 'resetQueue', 'initializeFlood', 'initializeWarmFlood', 'jumpWarmFlood', 'initializeOcean', 'hookOcean', 'jumpOcean', 'markOceanBoundary', 'finishOcean', 'floodTile', 'initializeDistance', 'distanceTile', 'initializeSources', 'routeLTD', 'initializeReceivers', 'incision', 'hillslope', 'clearFaces', 'sediment', 'finishWithoutSediment', 'summarizeStep', 'packPreview'] as const
    const pipelines = Object.fromEntries(await Promise.all(names.map(async entryPoint => [entryPoint, await device!.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint, ...(['routeLTD', 'incision', 'sediment'].includes(entryPoint) ? { constants: { QUEUE_WORKERS: queueWorkers } } : {}) } })]))) as Record<typeof names[number], GPUComputePipeline>
    check()
    const bindings = (from: GPUBuffer, to: GPUBuffer) => device!.createBindGroup({ layout, entries: [uniform, input, cells, from, to, queue, control, faces].map((buffer, binding) => ({ binding, resource: { buffer, ...(binding === 0 ? { size: 48 } : {}) } })) })
    const ab = bindings(a, b), ba = bindings(b, a), groups = Math.ceil(count / 128)
    const dispatch = (encoder: GPUCommandEncoder, name: typeof names[number], binding: GPUBindGroup, pass: number, mode: number, size?: [number, number]) => { const index = queryNames.length, record = querySet && index < 1024; const computation = encoder.beginComputePass(record ? { timestampWrites: { querySet: querySet!, beginningOfPassWriteIndex: index * 2, endOfPassWriteIndex: index * 2 + 1 } } : undefined); if (record) queryNames.push(name); computation.setPipeline(pipelines[name]); computation.setBindGroup(0, binding, [(pass * 2 + mode) * 256]); if (size) computation.dispatchWorkgroups(...size); else computation.dispatchWorkgroups(['routeLTD', 'incision', 'sediment', 'summarizeStep', 'resetChanged', 'resetQueue'].includes(name) ? 1 : groups); computation.end(); metrics.dispatches++ }
    const submit = (encoder: GPUCommandEncoder) => { check(); device!.queue.submit([encoder.finish()]) }
    const readControl = async (offset: number) => { const encoder = device!.createCommandEncoder(); encoder.copyBufferToBuffer(control, offset * 4, smallRead, 0, 16); submit(encoder); const started = performance.now(); await smallRead.mapAsync(GPUMapMode.READ); metrics.readbackWaitMilliseconds = (metrics.readbackWaitMilliseconds ?? 0) + performance.now() - started; check(); const value = new Uint32Array(smallRead.getMappedRange().slice(0)); smallRead.unmap(); metrics.readbacks++; return value }
    let direction = false
    const group = () => direction ? ba : ab, finalRoute = () => direction ? b : a, otherRoute = () => direction ? a : b
    const condition = async (pass: number, mode: number) => {
      const started = performance.now()
      let encoder = device!.createCommandEncoder()
      if (pass === 0 && mode === 0) dispatch(encoder, 'initializeFlood', group(), pass, mode)
      else { dispatch(encoder, 'initializeWarmFlood', group(), pass, mode); for (let jump = 0; jump < Math.ceil(Math.log2(count)); jump++) { dispatch(encoder, 'jumpWarmFlood', group(), pass, mode); direction = !direction } }
      dispatch(encoder, 'initializeOcean', group(), pass, mode); submit(encoder)
      let fillConverged = false, oceanConverged = false
      for (let batch = 0; batch < Math.ceil(count / 16); batch++) {
        encoder = device!.createCommandEncoder()
        for (let iteration = 0; iteration < 8; iteration++) {
          if (iteration === 7) dispatch(encoder, 'resetChanged', group(), pass, mode)
          if (!fillConverged) { dispatch(encoder, 'floodTile', group(), pass, mode, [Math.ceil(columns / 16), Math.ceil(rows / 16)]); direction = !direction; metrics.routingIterations++ }
          if (!oceanConverged) { dispatch(encoder, 'hookOcean', group(), pass, mode); dispatch(encoder, 'jumpOcean', group(), pass, mode) }
        }
        submit(encoder); const status = await readControl(3)
        fillConverged ||= !status[0]; oceanConverged ||= !status[2]
        if (fillConverged && oceanConverged) break
      }
      if (!fillConverged || !oceanConverged) throw new Error('GPU terrain basin/ocean conditioning did not converge')
      encoder = device!.createCommandEncoder(); dispatch(encoder, 'markOceanBoundary', group(), pass, mode); dispatch(encoder, 'finishOcean', group(), pass, mode); submit(encoder)
      for (const phase of ['distanceTile'] as const) {
        encoder = device!.createCommandEncoder(); dispatch(encoder, 'initializeDistance', group(), pass, mode); submit(encoder)
        let converged = false
        // No fixed-pass approximation: every basin/flat solve is checked at
        // its final relaxation, and failure never masquerades as a solution.
        for (let batch = 0; batch < Math.ceil(count / 16); batch++) {
          encoder = device!.createCommandEncoder()
          for (let iteration = 0; iteration < 8; iteration++) { if (iteration === 7) dispatch(encoder, 'resetChanged', group(), pass, mode); dispatch(encoder, phase, group(), pass, mode, [Math.ceil(columns / 16), Math.ceil(rows / 16)]); direction = !direction; metrics.routingIterations++ }
          submit(encoder)
          if (!(await readControl(3))[0]) { converged = true; break }
        }
        if (!converged) throw new Error(`GPU terrain ${phase} did not converge`)
      }
      encoder = device!.createCommandEncoder(); dispatch(encoder, 'resetQueue', group(), pass, mode); dispatch(encoder, 'initializeSources', group(), pass, mode); dispatch(encoder, 'routeLTD', group(), pass, mode); submit(encoder)
      metrics.conditioningWallMilliseconds = (metrics.conditioningWallMilliseconds ?? 0) + performance.now() - started
    }
    let encoder = device.createCommandEncoder(); dispatch(encoder, 'initialize', group(), 0, 0); submit(encoder)
    await condition(0, 0)
    const preview = async (iteration: number) => { encoder = device!.createCommandEncoder(); dispatch(encoder, 'packPreview', group(), iteration, 0); encoder.copyBufferToBuffer(otherRoute(), 0, previewRead, 0, count * 16); submit(encoder); await previewRead.mapAsync(GPUMapMode.READ); check(); const values = new Float32Array(previewRead.getMappedRange().slice(0)); previewRead.unmap(); metrics.readbacks++; const elevation = new Float32Array(count), alluvium = new Float64Array(count); for (let i = 0; i < count; i++) { elevation[i] = values[i * 4]!; alluvium[i] = values[i * 4 + 1]! }; onStep?.({ elevation, alluvium, iteration, iterations: passes, seaLevel: options.seaLevel?.(iteration, passes) ?? 0 }) }
    if (options.onStep) await preview(0)
    for (let pass = 1; pass <= passes; pass++) {
      encoder = device.createCommandEncoder(); dispatch(encoder, 'resetQueue', group(), pass, 0); dispatch(encoder, 'initializeReceivers', group(), pass, 0); dispatch(encoder, 'incision', group(), pass, 0); dispatch(encoder, 'hillslope', group(), pass, 0); submit(encoder)
      if (options.sediment) {
        await condition(pass, 1)
        encoder = device.createCommandEncoder(); dispatch(encoder, 'clearFaces', group(), pass, 1); dispatch(encoder, 'resetQueue', group(), pass, 1); dispatch(encoder, 'initializeSources', group(), pass, 1); dispatch(encoder, 'sediment', group(), pass, 1); submit(encoder)
      } else { encoder = device.createCommandEncoder(); dispatch(encoder, 'finishWithoutSediment', group(), pass, 0); submit(encoder) }
      encoder = device.createCommandEncoder(); dispatch(encoder, 'summarizeStep', group(), pass - 1, 0); submit(encoder)
      await condition(pass, 0)
      if (options.onStep && (pass % 4 === 0 || pass === passes)) await preview(pass)
    }
    const failure = (await readControl(6))[0]
    if (failure) throw new Error(`GPU terrain dependency/queue invariant failed (${failure})`)
    const stateBytes = count * CELL_BYTES, routeBytes = count * 16, queueBytes = count * 4, controlBytes = (passes + 32) * 4
    const readback = allocate(stateBytes + routeBytes + queueBytes + controlBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
    encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(cells, 0, readback, 0, stateBytes); encoder.copyBufferToBuffer(finalRoute(), 0, readback, stateBytes, routeBytes); encoder.copyBufferToBuffer(queue, 0, readback, stateBytes + routeBytes, queueBytes); encoder.copyBufferToBuffer(control, 0, readback, stateBytes + routeBytes + queueBytes, controlBytes); submit(encoder)
    await readback.mapAsync(GPUMapMode.READ); check(); const bytes = readback.getMappedRange().slice(0); readback.unmap(); metrics.readbacks++
    if (querySet && queryNames.length) {
      const length = queryNames.length * 16, resolved = allocate(length, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC), timed = allocate(length, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
      encoder = device.createCommandEncoder(); encoder.resolveQuerySet(querySet, 0, queryNames.length * 2, resolved, 0); encoder.copyBufferToBuffer(resolved, 0, timed, 0, length); submit(encoder)
      await timed.mapAsync(GPUMapMode.READ); const values = new BigUint64Array(timed.getMappedRange().slice(0)); timed.unmap(); metrics.readbacks++; metrics.gpuPhaseSamples = {}
      queryNames.forEach((name, i) => { const sample = metrics.gpuPhaseSamples![name] ?? { milliseconds: 0, dispatches: 0 }; sample.milliseconds += Number(values[i * 2 + 1]! - values[i * 2]!) / 1e6; sample.dispatches++; metrics.gpuPhaseSamples![name] = sample })
    }
    const validation = await device.popErrorScope(); if (validation) throw new Error(`Terrain WebGPU validation failed: ${validation.message}`)
    metrics.gpuMilliseconds = performance.now() - gpuStarted
    const result = finishTerrain(raw, columns, cellSize, passes, dt, bytes, stateBytes, routeBytes, queueBytes, metrics)
    metrics.milliseconds = performance.now() - started
    return result
  }
  try { return await Promise.race([run(), interrupted]) }
  catch (error) { if (options.signal?.aborted) throw abortError(); metrics.gpuMilliseconds = performance.now() - gpuStarted; return fallback(error instanceof Error ? error.message : 'WebGPU terrain computation failed') }
  finally { if (timer !== undefined) clearTimeout(timer); if (abortListener) options.signal?.removeEventListener('abort', abortListener); cleanup() }
}

function finishTerrain(raw: Float32Array, columns: number, cellSize: number, passes: number, dt: number, bytes: ArrayBuffer, stateBytes: number, routeBytes: number, queueBytes: number, metrics: TerrainComputeMetrics): TerrainErosionResult {
  const count = raw.length, area = cellSize ** 2, state = new Float32Array(bytes, 0, count * STRIDE), signed = new Int32Array(bytes, 0, count * STRIDE), unsigned = new Uint32Array(bytes, 0, count * STRIDE), routes = new Float32Array(bytes, stateBytes, count * 4), finalControls = new Float32Array(bytes, stateBytes + routeBytes + queueBytes)
  const rawDEM = new Float32Array(count), alluvium = new Float32Array(count), alluvium64 = new Float64Array(count), hydroDEM = new Float32Array(count), ocean = new Uint8Array(count), routeBits = new Uint32Array(bytes, stateBytes, count * 4), flowTo = new Int32Array(count), accumulatedArea = new Float64Array(count), order = new Int32Array(bytes.slice(stateBytes + routeBytes, stateBytes + routeBytes + queueBytes))
  const sediment = { erodedSourceVolume: 0, depositedVolume: 0, exportedVolume: 0, sedimentReentrainedVolume: 0, marineDepositedVolume: 0, terrestrialDepositedVolume: 0, lakeDepositedVolume: 0, hillslopeBedrockVolume: 0, hillslopeTransferredVolume: 0, storedVolume: 0, massBalanceError: 0 }
  let squares = 0, absolute = 0, changedCells = 0, reorganized = 0, maxIncision = 0, maxCumulativeIncision = 0, maxRaising = 0, erodedVolume = 0, upliftVolume = 0, diffusionNetVolume = 0, initialTerrainVolume = 0, finalTerrainVolume = 0, outletArea = 0, fillVolume = 0, maxCellResidual = 0
  for (let i = 0; i < count; i++) {
    const s = i * STRIDE, z = state[s]!, loose = state[s + 1]!
    if (!Number.isFinite(z) || !Number.isFinite(loose) || loose < 0) throw new Error(`Nonphysical GPU terrain/material at cell${i}`)
    rawDEM[i] = z; alluvium[i] = loose; alluvium64[i] = loose; hydroDEM[i] = routes[i * 4]!; ocean[i] = routeBits[i * 4 + 2]!; flowTo[i] = signed[s + 6]!; accumulatedArea[i] = unsigned[s + 7]! * area
    const change = z - raw[i]!; squares += change ** 2; absolute += Math.abs(change); changedCells += Number(Math.abs(change) > .01); reorganized += Number(flowTo[i] !== signed[s + 10]); maxIncision = Math.max(maxIncision, -change); maxRaising = Math.max(maxRaising, change); maxCumulativeIncision = Math.max(maxCumulativeIncision, state[s + 2]!)
    sediment.erodedSourceVolume += state[s + 13]! * area; sediment.depositedVolume += state[s + 14]! * area; sediment.exportedVolume += state[s + 15]! * area; sediment.sedimentReentrainedVolume += state[s + 16]! * area; sediment.marineDepositedVolume += state[s + 17]! * area; sediment.terrestrialDepositedVolume += state[s + 18]! * area; sediment.lakeDepositedVolume += state[s + 19]! * area; sediment.hillslopeBedrockVolume += state[s + 20]! * area; sediment.hillslopeTransferredVolume += state[s + 21]! * area; sediment.storedVolume += loose * area
    upliftVolume += state[s + 22]! * area; erodedVolume += state[s + 23]! * area; diffusionNetVolume += state[s + 24]! * area; initialTerrainVolume += raw[i]! * area; finalTerrainVolume += z * area; fillVolume += (hydroDEM[i]! - z) * area; if (flowTo[i]! < 0) outletArea += accumulatedArea[i]!
    maxCellResidual = Math.max(maxCellResidual, Math.abs(z - raw[i]! - state[s + 22]! + state[s + 23]! - state[s + 14]! - state[s + 24]!))
  }
  const rank = new Uint32Array(count), seen = new Uint8Array(count)
  for (let k = 0; k < count; k++) { const i = order[k]!; if (i < 0 || i >= count || seen[i]) throw new Error('GPU drainage order is incomplete'); seen[i] = 1; rank[i] = k }
  for (let i = 0; i < count; i++) { const j = flowTo[i]!, boundary = i < columns || i >= count - columns || i % columns === 0 || i % columns === columns - 1; if (!Number.isFinite(hydroDEM[i]) || hydroDEM[i]! < rawDEM[i]! || boundary && hydroDEM[i] !== rawDEM[i] || j >= count || j >= 0 && (rank[j]! <= rank[i]! || hydroDEM[j]! > hydroDEM[i]!)) throw new Error(`GPU drainage violates its boundary, is cyclic, uphill or below solid bed at cell${i}`) }
  if (outletArea !== count * area) throw new Error('GPU drainage does not conserve the complete watershed area')
  sediment.massBalanceError = sediment.erodedSourceVolume - sediment.storedVolume - sediment.exportedVolume
  const rmsHistory = Array.from(finalControls.slice(16, 16 + passes)), terrainBalanceError = finalTerrainVolume - initialTerrainVolume - upliftVolume + erodedVolume - sediment.depositedVolume - diffusionNetVolume
  metrics.terrainRoundingResidualVolume = terrainBalanceError
  metrics.maxCellTerrainResidualMetres = maxCellResidual
  const erosion = { iterations: passes, timeStepYears: dt, elapsedYears: passes * dt, erodedVolume, upliftVolume, maxIncision, maxCumulativeIncision, maxRaising, rmsElevationChange: Math.sqrt(squares / count), meanAbsoluteChange: absolute / count, changedCells, finalStepRms: rmsHistory.at(-1) ?? 0, flowReorganization: reorganized / count, rmsHistory, initialTerrainVolume, finalTerrainVolume, diffusionNetVolume, terrainBalanceError }
  return { rawDEM, initialDEM: raw.slice(), alluvium, alluvium64, sediment, erosion, hydroDEM, flowTo, accumulatedArea, order, processedCells: count, outletArea, fillVolume, ocean, backend: 'webgpu', metrics }
}
