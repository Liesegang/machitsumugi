/// <reference types="@webgpu/types" />
import { createMarineKernel, finishMarineKernel, marineElevation, reworkMarineCPU } from './webgpu-marine-kernel'
import type { MarineKernel } from './webgpu-marine-kernel'
import type { MarineReworkingInput, MarineReworkingOptions, MarineReworkingResult } from './webgpu-marine-kernel'
export { MARINE_PHYSICS_VERSION, reworkMarineCPU } from './webgpu-marine-kernel'
export type { MarineReworkingInput, MarineReworkingOptions, MarineReworkingResult, MarineReworkingBudget } from './webgpu-marine-kernel'

export const MARINE_SEDIMENT_SHADER = /* wgsl */ `
struct Parameters {
  info: vec4<u32>, sea: i32, unitsPerCm: u32, maxDepth: u32, rockCap: u32,
  rates: vec4<u32>, advection: vec4<u32>, transport: vec4<u32>
}
struct State {
  delta: i32, loose: u32, suspended: u32, rock: u32,
  resuspCarry: u32, rockCarry: u32, pad0: u32, pad1: u32
}
@group(0) @binding(0) var<uniform> p: Parameters;
@group(0) @binding(1) var<storage, read> base: array<i32>;
@group(0) @binding(2) var<storage, read> ocean: array<u32>;
@group(0) @binding(3) var<storage, read> coefficients: array<vec2<u32>>;
@group(0) @binding(4) var<storage, read> statesIn: array<State>;
@group(0) @binding(5) var<storage, read_write> statesOut: array<State>;
@group(0) @binding(6) var<storage, read_write> faces: array<vec4<u32>>;
@group(0) @binding(7) var<storage, read_write> ledger: array<vec4<u32>>;

// Quotient/remainder decomposition avoids overflowing value*fraction.
fn scale(value: u32, fraction: u32) -> u32 {
  return (value / 4096u) * fraction + ((value % 4096u) * fraction) / 4096u;
}
fn depth(i: u32, state: State) -> u32 {
  return min(p.maxDepth, u32(max(0, p.sea - base[i] - state.delta)) / p.unitsPerCm);
}
fn neighborCell(i: u32, direction: u32) -> i32 {
  let x = i % p.info.x; let y = i / p.info.x;
  if (direction == 0u) { if (x == 0u) { return -1; } return i32(i) - 1; }
  if (direction == 1u) { if (x + 1u == p.info.x) { return -1; } return i32(i) + 1; }
  if (direction == 2u) { if (y == 0u) { return -1; } return i32(i) - i32(p.info.x); }
  if (y + 1u == p.info.y) { return -1; } return i32(i) + i32(p.info.x);
}

@compute @workgroup_size(128)
fn entrain(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x; if (i >= p.info.z) { return; }
  var state = statesIn[i];
  if (ocean[i] == 0u || base[i] + state.delta > p.sea + i32(p.transport.w)) { statesOut[i] = state; return; }
  let activity = coefficients[depth(i, state)].x;
  let credit = scale(p.rates.y, activity) + state.resuspCarry;
  let removed = min(state.loose, credit / 4096u);
  state.resuspCarry = select(0u, credit % 4096u, removed < state.loose);
  state.loose -= removed; state.suspended += removed;
  var rock = 0u;
  if (state.loose == 0u && ocean[i] == 1u) {
    let rockCredit = scale(p.rates.x, activity) + state.rockCarry;
    rock = min(p.rockCap - state.rock, rockCredit / 4096u);
    state.rockCarry = rockCredit % 4096u;
  } else { state.rockCarry = 0u; }
  state.suspended += rock; state.rock += rock;
  state.delta -= i32(removed + rock);
  ledger[i].x += removed;
  statesOut[i] = state;
}

@compute @workgroup_size(128)
fn transport(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x; if (i >= p.info.z) { return; }
  let state = statesIn[i]; var flow = vec4<u32>(0u);
  if (ocean[i] == 0u || base[i] + state.delta > p.sea + i32(p.transport.w)) { faces[i] = flow; return; }
  let backwash = base[i] + state.delta > p.sea;
  var wetFaces = 0u;
  if (backwash) {
    for (var d = 0u; d < 4u; d++) {
      let j = neighborCell(i, d);
      if (j >= 0 && ocean[u32(j)] != 0u && base[u32(j)] + statesIn[u32(j)].delta <= p.sea) { wetFaces += 1u; }
    }
  }
  for (var d = 0u; d < 4u; d++) {
    let j = neighborCell(i, d); var other = 0u;
    if (j < 0) { if (p.transport.y == 0u || backwash) { continue; } }
    else {
      if (ocean[u32(j)] == 0u || base[u32(j)] + statesIn[u32(j)].delta > p.sea) { continue; }
      other = statesIn[u32(j)].suspended;
    }
    if (backwash) { flow[d] = scale(state.suspended, 4096u / wetFaces); continue; }
    let difference = state.suspended - min(state.suspended, other);
    flow[d] = scale(state.suspended, p.advection[d]) + scale(difference, p.transport.x);
  }
  faces[i] = flow;
}

@compute @workgroup_size(128)
fn settle(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x; if (i >= p.info.z) { return; }
  var state = statesIn[i];
  if (ocean[i] == 0u) { statesOut[i] = state; return; }
  var load = state.suspended; var exported = 0u;
  for (var d = 0u; d < 4u; d++) {
    load -= faces[i][d];
    let j = neighborCell(i, d);
    if (j < 0) { exported += faces[i][d]; }
    else { load += faces[u32(j)][d ^ 1u]; }
  }
  var fraction = coefficients[depth(i, state)].y;
  if (base[i] + state.delta > p.sea) { fraction = 4096u; }
  let accommodation = u32(max(0, p.sea - base[i] - state.delta - 1));
  let deposited = min(scale(load, fraction), accommodation);
  state.loose += deposited; state.suspended = load - deposited; state.delta += i32(deposited);
  ledger[i].y += deposited; ledger[i].z += exported;
  statesOut[i] = state;
}
`

const abortError = () => new DOMException('Marine reworking was cancelled', 'AbortError')

async function runMarineGPU(kernel: MarineKernel, metrics: MarineReworkingResult['metrics']) {
  const { input, options, count } = kernel
  if (typeof navigator === 'undefined' || !navigator.gpu) throw new Error('WebGPU compute is unavailable')
  const buffers: GPUBuffer[] = [], destroyed = new Set<GPUBuffer>()
  let device: GPUDevice | undefined, cancelled = false, timeout: ReturnType<typeof setTimeout> | undefined, abortListener: (() => void) | undefined
  const cleanup = () => {
    for (const buffer of buffers) if (!destroyed.has(buffer)) { if (buffer.mapState === 'mapped') buffer.unmap(); buffer.destroy(); destroyed.add(buffer) }
    device?.destroy()
  }
  const interruption = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => { cancelled = true; cleanup(); reject(new Error('Marine WebGPU calculation timed out')) }, options.timeoutMs ?? 30_000)
    abortListener = () => { cancelled = true; cleanup(); reject(abortError()) }
    options.signal?.addEventListener('abort', abortListener, { once: true })
  })
  const check = () => { if (options.signal?.aborted) throw abortError(); if (cancelled) throw new Error('Marine WebGPU calculation was cancelled') }
  const computation = (async () => {
    check()
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    check()
    if (!adapter) throw new Error('No marine WebGPU compute adapter')
    metrics.adapter = [adapter.info.vendor, adapter.info.architecture, adapter.info.description].filter(Boolean).join(' / ')
    device = await adapter.requestDevice()
    if (cancelled) { device.destroy(); check() }
    check()
    let lost = false
    void device.lost.then(() => { lost = true })
    device.pushErrorScope('validation')
    const allocate = (bytes: number, usage: GPUBufferUsageFlags, data?: ArrayBufferView) => {
      if (bytes > device!.limits.maxStorageBufferBindingSize) throw new Error('Marine compute buffer exceeds adapter limits')
      const buffer = device!.createBuffer({ size: Math.max(16, bytes), usage })
      buffers.push(buffer)
      if (data?.byteLength) device!.queue.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
      return buffer
    }
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, stateBytes = kernel.state.byteLength, ledgerBytes = count * 16
    const parameters = allocate(kernel.parameters.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, kernel.parameters)
    const base = allocate(kernel.base.byteLength, storage, kernel.base), ocean = allocate(kernel.ocean.byteLength, storage, kernel.ocean), coefficients = allocate(kernel.coefficients.byteLength, storage, kernel.coefficients)
    const a = allocate(stateBytes, storage | GPUBufferUsage.COPY_SRC, kernel.state), b = allocate(stateBytes, storage)
    const faces = allocate(count * 16, storage), ledger = allocate(ledgerBytes, storage | GPUBufferUsage.COPY_SRC)
    const readback = allocate(stateBytes + ledgerBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
    const visibility = GPUShaderStage.COMPUTE
    const bindLayout = device.createBindGroupLayout({ entries: Array.from({ length: 8 }, (_, binding) => ({ binding, visibility, buffer: { type: binding === 0 ? 'uniform' : binding < 5 ? 'read-only-storage' : 'storage' } })) })
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] })
    const module = device.createShaderModule({ label: 'Conservative marine entrainment face flux and settling', code: MARINE_SEDIMENT_SHADER })
    const compilation = await module.getCompilationInfo()
    const shaderErrors = compilation.messages.filter(message => message.type === 'error')
    if (shaderErrors.length) throw new Error(shaderErrors.map(message => `Marine shader ${message.lineNum}:${message.linePos}: ${message.message}`).join('\n'))
    const [entrain, transport, settle] = await Promise.all(['entrain', 'transport', 'settle'].map(entryPoint => device!.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint } })))
    check()
    const bindGroup = (from: GPUBuffer, to: GPUBuffer) => device!.createBindGroup({ layout: bindLayout, entries: [parameters, base, ocean, coefficients, from, to, faces, ledger].map((buffer, binding) => ({ binding, resource: { buffer } })) })
    const ab = bindGroup(a, b), ba = bindGroup(b, a), groups = Math.ceil(count / 128)
    if (groups > device.limits.maxComputeWorkgroupsPerDimension) throw new Error('Marine grid exceeds the adapter dispatch limit')
    let state = kernel.state.slice(), finalLedger = new Uint32Array(count * 4)
    const stride = options.onStep ? 32 : kernel.steps
    for (let first = 0; first < kernel.steps; first += stride) {
      check()
      const last = Math.min(kernel.steps, first + stride), encoder = device.createCommandEncoder()
      for (let step = first; step < last; step++) for (const [pipeline, bindings] of [[entrain, ab], [transport, ba], [settle, ba]] as const) {
        const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.dispatchWorkgroups(groups); pass.end(); metrics.dispatches++
      }
      encoder.copyBufferToBuffer(a, 0, readback, 0, stateBytes)
      if (last === kernel.steps) encoder.copyBufferToBuffer(ledger, 0, readback, stateBytes, ledgerBytes)
      device.queue.submit([encoder.finish()])
      await readback.mapAsync(GPUMapMode.READ)
      check()
      if (lost) throw new Error('Marine WebGPU device was lost')
      const bytes = readback.getMappedRange()
      state = new Uint32Array(bytes.slice(0, stateBytes))
      if (last === kernel.steps) finalLedger = new Uint32Array(bytes.slice(stateBytes, stateBytes + ledgerBytes))
      readback.unmap(); metrics.readbacks++
      options.onStep?.({ elevation: marineElevation(kernel, state), iteration: last, iterations: kernel.steps, seaLevel: input.seaLevel })
    }
    const error = await device.popErrorScope()
    if (error) throw new Error(`Marine WebGPU validation failed: ${error.message}`)
    return { state, ledger: finalLedger }
  })()
  try { return await Promise.race([computation, interruption]) }
  finally {
    if (timeout !== undefined) clearTimeout(timeout)
    if (abortListener) options.signal?.removeEventListener('abort', abortListener)
    cleanup()
  }
}

/** Full sediment state and face fluxes stay resident for all steps. Readback is
 * once at completion, or every32 steps only when an actual preview is requested.
 * The three kernels update erosion, suspension, conservative transport and bed
 * deposition; this is not a shader used solely to colour an existing surface. */
export async function prepareMarineReworking(input: MarineReworkingInput, options: MarineReworkingOptions = {}): Promise<MarineReworkingResult> {
  if (options.signal?.aborted) throw abortError()
  if (options.mode === 'cpu' || !(options.steps ?? 96) || options.mode !== 'gpu' && (input.elevation.length < 16384 || (options.steps ?? 96) < 16)) return reworkMarineCPU(input, options)
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    const result = reworkMarineCPU(input, options)
    result.metrics.fallbackReason = 'WebGPU compute is unavailable'
    return result
  }
  let lastPreview = -1
  const computationOptions: MarineReworkingOptions = { ...options, onStep: options.onStep ? state => { if (state.iteration > lastPreview) { lastPreview = state.iteration; options.onStep!(state) } } : undefined }
  const started = performance.now(), kernel = createMarineKernel(input, computationOptions)
  const metrics: MarineReworkingResult['metrics'] = { milliseconds: 0, gpuMilliseconds: 0, dispatches: 0, readbacks: 0, steps: kernel.steps }
  computationOptions.onStep?.({ elevation: new Float32Array(input.elevation), iteration: 0, iterations: kernel.steps, seaLevel: input.seaLevel })
  const gpuStarted = performance.now()
  try {
    const completed = await runMarineGPU(kernel, metrics)
    metrics.gpuMilliseconds = performance.now() - gpuStarted
    const result = finishMarineKernel(kernel, completed.state, completed.ledger, 'webgpu', metrics)
    metrics.milliseconds = performance.now() - started
    return result
  } catch (error) {
    if (options.signal?.aborted) throw abortError()
    const result = reworkMarineCPU(input, computationOptions)
    result.metrics.fallbackReason = error instanceof Error ? error.message : 'Marine WebGPU compute failed'
    result.metrics.gpuMilliseconds = performance.now() - gpuStarted - result.metrics.milliseconds
    result.metrics.milliseconds = performance.now() - started
    return result
  }
}
