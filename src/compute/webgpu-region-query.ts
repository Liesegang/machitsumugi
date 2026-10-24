/// <reference types="@webgpu/types" />
import type { Point } from '../domain/types'
import { regionQuery } from '../domain/region-query'
import { fillRegionGridCPU, prepareRegionGrid, regionGridIndex } from './webgpu-region-grid'
import type { ComputeRegion, PreparedRegionGrid, RegionGridBounds } from './webgpu-region-grid'

export interface WebGpuRegionOptions extends RegionGridBounds {
  mode?: 'auto' | 'gpu' | 'cpu'
  signal?: AbortSignal
  /** Includes adapter, shader compilation, transfer, dispatch and readback. */
  timeoutMs?: number
  minGpuCells?: number
  /** Query counters cost time in the synchronous road-search hot loop. */
  diagnostics?: boolean
  /** Injectable only for capability/failure tests; omitted in production. */
  gpu?: GPU | null
}
export interface RegionComputeMetrics {
  backend: 'webgpu' | 'cpu'
  cells: number
  boundaryCells: number
  uncertainCells: number
  prepareMilliseconds: number
  gpuMilliseconds: number
  dispatches: number
  fastQueries: number
  exactQueries: number
  fallbackReason?: string
  adapter?: string
  disposed: boolean
  scope: 'preparation-only' | 'preparation-and-queries'
}
export interface PreparedRegionQuery {
  query(point: Point): boolean
  readonly backend: 'webgpu' | 'cpu'
  metrics: RegionComputeMetrics
  /** Releases the CPU mask too; future queries remain correct via CPU geometry. */
  dispose(): void
}

/** Arithmetic signs are accepted only outside a conservative f32 error bound.
 * Border cells are excluded using original double-precision geometry before
 * upload. A GPU result never snaps the requested point onto a grid centre. */
export const REGION_GRID_SHADER = /* wgsl */ `
struct Parameters { grid: vec4<u32>, domain: vec4<f32>, accuracy: vec4<f32> }
struct Ring { bounds: vec4<f32>, bandOffset: u32, firstRow: i32, rowCount: u32, pad: u32 }
@group(0) @binding(0) var<uniform> parameters: Parameters;
@group(0) @binding(1) var<storage, read> regions: array<vec2<u32>>;
@group(0) @binding(2) var<storage, read> rings: array<Ring>;
@group(0) @binding(3) var<storage, read> edges: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> bands: array<vec2<u32>>;
@group(0) @binding(5) var<storage, read> edgeIndices: array<u32>;
@group(0) @binding(6) var<storage, read_write> result: array<u32>;

fn ringContains(index: u32, row: u32, p: vec2<f32>) -> u32 {
  let ring = rings[index];
  let error = parameters.accuracy.x;
  if (p.x < ring.bounds.x - error || p.y < ring.bounds.y - error || p.x > ring.bounds.z + error || p.y > ring.bounds.w + error) { return 0u; }
  let localRow = i32(row) - ring.firstRow;
  if (localRow < 0 || u32(localRow) >= ring.rowCount) { return 0u; }
  let band = bands[ring.bandOffset + u32(localRow)];
  var occupied = false;
  for (var n = 0u; n < band.y; n++) {
    let edge = edges[edgeIndices[band.x + n]];
    if (p.x > max(edge.x, edge.z) + error) { continue; }
    if (abs(edge.y - p.y) <= error * 2.0 || abs(edge.w - p.y) <= error * 2.0) { return 2u; }
    if ((edge.y > p.y) == (edge.w > p.y)) { continue; }
    let dx = edge.z - edge.x;
    let dy = edge.w - edge.y;
    let px = p.x - edge.x;
    let py = p.y - edge.y;
    let left = dx * py;
    let right = dy * px;
    let determinant = left - right;
    let bound = 2.0 * error * (abs(dx) + abs(dy) + abs(px) + abs(py)) + 8.0 * error * error + (abs(left) + abs(right) + 1.0) * 0.0000019073486328125;
    if (abs(determinant) <= bound) { return 2u; }
    if ((determinant > 0.0) == (dy > 0.0)) { occupied = !occupied; }
  }
  return select(0u, 1u, occupied);
}

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x + invocation.y * parameters.grid.w;
  let count = parameters.grid.x * parameters.grid.y;
  if (index >= count || result[index] == 2u) { return; }
  let row = index / parameters.grid.x;
  let column = index % parameters.grid.x;
  let p = parameters.domain.xy + (vec2<f32>(f32(column), f32(row)) + vec2<f32>(0.5)) * parameters.domain.z;
  var uncertain = false;
  for (var r = 0u; r < parameters.grid.z; r++) {
    let region = regions[r];
    let outer = ringContains(region.x, row, p);
    if (outer == 2u) { uncertain = true; continue; }
    if (outer == 0u) { continue; }
    var inHole = false;
    var holeUncertain = false;
    for (var h = 1u; h < region.y; h++) {
      let hole = ringContains(region.x + h, row, p);
      if (hole == 1u) { inHole = true; break; }
      if (hole == 2u) { holeUncertain = true; }
    }
    if (!inHole && !holeUncertain) { result[index] = 1u; return; }
    if (!inHole && holeUncertain) { uncertain = true; }
  }
  result[index] = select(0u, 2u, uncertain);
}
`

const abortError = () => new DOMException('Region computation was cancelled', 'AbortError')

async function gpuMask(grid: PreparedRegionGrid, options: WebGpuRegionOptions, metrics: RegionComputeMetrics): Promise<Uint32Array> {
  const gpu = options.gpu === undefined ? (typeof navigator === 'undefined' ? undefined : navigator.gpu) : options.gpu
  if (!gpu) throw new Error('WebGPU is unavailable')
  const resources: GPUBuffer[] = []
  let device: GPUDevice | undefined, cancelled = false
  const cleanup = () => {
    for (const buffer of resources) { if (buffer.mapState === 'mapped') buffer.unmap(); buffer.destroy() }
    device?.destroy()
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  const cancelledPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => { cancelled = true; cleanup(); reject(new Error('WebGPU region preparation timed out')) }, options.timeoutMs ?? 8000)
    abortListener = () => { cancelled = true; cleanup(); reject(abortError()) }
    options.signal?.addEventListener('abort', abortListener, { once: true })
  })
  const check = () => { if (options.signal?.aborted) throw abortError(); if (cancelled) throw new Error('WebGPU region preparation was cancelled') }
  const computation = (async () => {
    check()
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
    check()
    if (!adapter) throw new Error('No WebGPU compute adapter')
    metrics.adapter = [adapter.info.vendor, adapter.info.architecture, adapter.info.description].filter(Boolean).join(' / ')
    device = await adapter.requestDevice()
    if (cancelled) { device.destroy(); check() }
    check()
    let lost = false
    void device.lost.then(() => { lost = true })
    const maxBytes = device.limits.maxStorageBufferBindingSize
    const storage = [grid.regions, grid.rings, grid.edges, grid.bands, grid.edgeIndices, grid.mask]
    if (storage.some(array => array.byteLength > maxBytes)) throw new Error('Region compute data exceeds the adapter buffer limit')
    const buffer = (array: ArrayBuffer | ArrayBufferView, usage: GPUBufferUsageFlags) => {
      const created = device!.createBuffer({ size: Math.max(16, Math.ceil(array.byteLength / 4) * 4), usage })
      resources.push(created)
      if (array.byteLength) device!.queue.writeBuffer(created, 0, array instanceof ArrayBuffer ? array : array.buffer as ArrayBuffer, array instanceof ArrayBuffer ? 0 : array.byteOffset, array.byteLength)
      return created
    }
    device.pushErrorScope('validation')
    const groups = Math.ceil(grid.mask.length / 128), groupsX = Math.min(groups, device.limits.maxComputeWorkgroupsPerDimension), groupsY = Math.ceil(groups / groupsX)
    if (groupsY > device.limits.maxComputeWorkgroupsPerDimension) throw new Error('Region compute grid exceeds adapter dispatch limits')
    const parameters = new ArrayBuffer(48), words = new Uint32Array(parameters), floats = new Float32Array(parameters)
    words.set([grid.columns, grid.rows, grid.regions.length / 2, groupsX * 128])
    floats.set([grid.bounds.minX, grid.bounds.minY, grid.bounds.cellSize, 0, grid.coordinateError, 0, 0, 0], 4)
    const uniform = buffer(parameters, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
    const inputs = storage.map((array, i) => buffer(array, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | (i === storage.length - 1 ? GPUBufferUsage.COPY_SRC : 0)))
    const readback = device.createBuffer({ size: grid.mask.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    resources.push(readback)
    const module = device.createShaderModule({ label: 'Conservative immutable region grid', code: REGION_GRID_SHADER })
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } })
    check()
    const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [uniform, ...inputs].map((resource, binding) => ({ binding, resource: { buffer: resource } })) })
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.dispatchWorkgroups(groupsX, groupsY); pass.end()
    encoder.copyBufferToBuffer(inputs.at(-1)!, 0, readback, 0, grid.mask.byteLength)
    device.queue.submit([encoder.finish()]); metrics.dispatches++
    await readback.mapAsync(GPUMapMode.READ)
    check()
    if (lost) throw new Error('WebGPU device was lost during region computation')
    const error = await device.popErrorScope()
    if (error) throw new Error(`WebGPU region validation failed: ${error.message}`)
    return new Uint32Array(readback.getMappedRange().slice(0))
  })()
  try { return await Promise.race([computation, cancelledPromise]) }
  finally {
    if (timeout !== undefined) clearTimeout(timeout)
    if (abortListener) options.signal?.removeEventListener('abort', abortListener)
    cleanup()
  }
}

/** Prepare once per immutable natural-water/woodland geometry, before synchronous
 * road searches. Rebuild after reclamation or clipping. The shader runs compute,
 * with a single bulk readback; no road query waits for or talks to the GPU.
 * Completed results live in CPU memory, so a later device loss cannot alter them. */
export async function prepareWebGpuRegionQuery(regions: readonly ComputeRegion[], options: WebGpuRegionOptions): Promise<PreparedRegionQuery> {
  const started = performance.now()
  if (options.signal?.aborted) throw abortError()
  const metrics: RegionComputeMetrics = { backend: 'cpu', cells: 0, boundaryCells: 0, uncertainCells: 0, prepareMilliseconds: 0, gpuMilliseconds: 0, dispatches: 0, fastQueries: 0, exactQueries: 0, disposed: false, scope: options.diagnostics ? 'preparation-and-queries' : 'preparation-only' }
  let lookup: Pick<PreparedRegionGrid, 'bounds' | 'columns' | 'rows'> | undefined, mask: Uint32Array | undefined
  let exact: ((point: Point) => boolean) | undefined
  try {
    const grid = prepareRegionGrid(regions, options)
    exact = grid.exact
    lookup = { bounds: grid.bounds, columns: grid.columns, rows: grid.rows }
    metrics.cells = grid.mask.length; metrics.boundaryCells = grid.boundaryCells
    if (!grid.regions.length) {
      mask = grid.mask
      metrics.fallbackReason = 'Empty region geometry'
    } else if (options.mode === 'cpu' || grid.mask.length < (options.minGpuCells ?? 1_000_000) && options.mode !== 'gpu') {
      metrics.fallbackReason = options.mode === 'cpu' ? 'CPU selected explicitly' : 'Grid below GPU threshold or empty geometry'
      mask = fillRegionGridCPU(grid)
    } else {
      const gpuStarted = performance.now()
      try { mask = await gpuMask(grid, options, metrics); metrics.backend = 'webgpu' }
      catch (error) {
        if (options.signal?.aborted) throw abortError()
        metrics.fallbackReason = error instanceof Error ? error.message : 'WebGPU region computation failed'
        mask = fillRegionGridCPU(grid)
      } finally { metrics.gpuMilliseconds = performance.now() - gpuStarted }
    }
    if (grid.regions.length) for (const value of mask) if (value === 2) metrics.uncertainCells++
  } catch (error) {
    if (options.signal?.aborted) throw abortError()
    metrics.fallbackReason = error instanceof Error ? error.message : 'Region grid could not be prepared'
    lookup = undefined
  }
  exact ??= regionQuery(regions)
  metrics.prepareMilliseconds = performance.now() - started
  const query = options.diagnostics
    ? (point: Point) => {
      const index = lookup && mask ? regionGridIndex(lookup, point) : -1
      const value = index < 0 ? 2 : mask![index]!
      if (value === 2) { metrics.exactQueries++; return exact!(point) }
      metrics.fastQueries++; return value === 1
    }
    : (point: Point) => {
      const index = lookup && mask ? regionGridIndex(lookup, point) : -1
      const value = index < 0 ? 2 : mask![index]!
      return value === 2 ? exact!(point) : value === 1
    }
  return {
    query,
    get backend() { return metrics.backend },
    metrics,
    dispose() { mask = undefined; lookup = undefined; metrics.disposed = true },
  }
}
