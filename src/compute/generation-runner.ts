import { generateCity, terrainGenerationPreview } from '../domain/generator'
import { generateLayoutCity, layoutGenerationReport } from '../domain/layout-first-generator'
import { generateContinuousCity, continuousCityGenerationReport } from '../domain/continuous-city-generator'
import { resolveGenerationConfig } from '../domain/generation-config'
import type { GenerationTerrainSource } from '../domain/generation-terrain-cache'
import type { TerrainModel } from '../domain/terrain'
import type { CityConfig, CityMap } from '../domain/types'
import { prepareTerrainWasm, terrainWasmStatus } from './wasm-terrain'
import { prepareWebGpuRegionQuery } from './webgpu-region-query'
import type { PreparedRegionQuery } from './webgpu-region-query'
import { prepareRegionalTerrain } from '../domain/regional-terrain'
import { sliceCityAtYear } from '../domain/timeline'

export interface GenerationComputeOptions {
  /** Reference backends are useful for reproducible benchmarks and capability QA. */
  wasm?: boolean
  gpu?: 'auto' | 'gpu' | 'cpu'
}
interface RegionAcceleration { water?: PreparedRegionQuery }
const regionCache = new WeakMap<TerrainModel['hydrology'], Map<string, Promise<RegionAcceleration>>>()

/** Preparation is asynchronous, but the actual simulator and all exact point
 * queries retain their synchronous contract. No per-query GPU readback occurs. */
export async function runAcceleratedGeneration(input: CityConfig, terrainSource: GenerationTerrainSource, onProgress: (label: string) => void, onPreview: (map: CityMap) => void, options: GenerationComputeOptions = {}) {
  const started = performance.now()
  onProgress('地形の計算エンジンを準備中…')
  const wasm = options.wasm === false ? false : await prepareTerrainWasm()
  const preparedAt = performance.now()
  const requestedYear = resolveGenerationConfig(input).year
  const fullInput = { ...input, targetYear: 2025 }
  const { config, width, height, terrainInput } = resolveGenerationConfig(fullInput)
  onProgress(wasm ? '地形・水系をWASMで計算中…' : '地形・水系を計算中…')
  const regional = await prepareRegionalTerrain({ seed: terrainInput.seed, coastType: terrainInput.coastType, relief: terrainInput.relief }, { mode: options.gpu ?? 'auto' }, terrainGenerationPreview(config, onProgress, onPreview))
  const terrain = terrainSource({ ...terrainInput, onTerrainPreview: terrainGenerationPreview(config, onProgress, onPreview) })
  const terrainAt = performance.now()
  const mode = options.gpu ?? 'auto'
  let cached = regionCache.get(terrain.hydrology)
  if (!cached) { cached = new Map(); regionCache.set(terrain.hydrology, cached) }
  let pending = cached.get(mode)
  if (!pending) {
    onProgress('水域の照会索引を計算中…')
    const bounds = { minX: 0, minY: 0, maxX: width, maxY: height, cellSize: 6, mode }
    pending = (async () => {
      // Full-city traces contain over 100M water queries. At this scale the
      // wrapper itself outweighed the small map's indexing benefit. Keep the
      // original exact closure for small automatic/CPU runs, not another layer.
      if (mode !== 'gpu' && width * height / 36 < 1_000_000) return {}
      const water = await prepareWebGpuRegionQuery(terrain.areas.filter(area => area.kind === 'water'), bounds)
      return { water }
    })()
    cached.set(mode, pending)
    // An unexpected preparation failure must be retryable, not poison a cache.
    pending.catch(() => cached!.delete(mode))
  }
  const indexes = await pending
  const indexedAt = performance.now()
  const accelerated: TerrainModel = indexes.water ? { ...terrain, waterAt: indexes.water.query } : terrain
  onProgress(input.cityEngine === 'continuous' ? '連続した街路網と、街区全体の土地割を設計中…' : input.cityEngine === 'layout' ? '施設用地・街路・街区を設計中…' : '街道・建物の変遷を2025年まで一度だけ計算中…')
  const generate = input.cityEngine === 'continuous' ? generateContinuousCity : input.cityEngine === 'layout' ? generateLayoutCity : generateCity
  let previousCityLabel = ''
  const cityProgress = (label: string) => {
    let display = label
    if (input.cityEngine === 'continuous' && label.startsWith('土地被覆:')) {
      const fraction = label.match(/(\d+)\/(\d+)/)
      const percent = fraction && Number(fraction[2]) > 0 ? Math.floor(Number(fraction[1]) / Number(fraction[2]) * 20) * 5 : undefined
      display = label.includes('農地区') ? '農地のまとまりを整備中…' : /森林|斜面|自然被覆/.test(label) ? '林と緑地を整理中…' : '土地の用途を整理中…'
      if (percent !== undefined) display += ` ${percent}%`
    }
    if (display !== previousCityLabel) { previousCityLabel = display; onProgress(display) }
  }
  const complete = generate(fullInput, cityProgress, onPreview, () => accelerated)
  const map = sliceCityAtYear(complete, requestedYear)
  return { map, acceleration: {
    terrainBackend: wasm ? 'wasm' : 'javascript', wasm: terrainWasmStatus(),
    marine: regional.marine ? { backend: regional.marine.backend, metrics: regional.marine.metrics, budget: regional.marine.budget } : undefined,
    water: indexes.water ? { ...indexes.water.metrics } : { backend: 'exact-cpu', reason: 'Small-map full-city measurement favours the original exact query' },
    initializationMilliseconds: preparedAt - started, terrainMilliseconds: terrainAt - preparedAt,
    indexMilliseconds: indexedAt - terrainAt, cityMilliseconds: performance.now() - indexedAt,
    totalMilliseconds: performance.now() - started,
    ...(input.cityEngine === 'layout' ? { layout: layoutGenerationReport(complete) } : {}),
    ...(input.cityEngine === 'continuous' ? { continuous: continuousCityGenerationReport(complete) } : {}),
  } }
}
