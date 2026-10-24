import type { CityConfig } from './types'
import { createGenerationTerrainCache } from './generation-terrain-cache'
import { runAcceleratedGeneration } from '../compute/generation-runner'
import type { GenerationComputeOptions } from '../compute/generation-runner'
const terrainSource = createGenerationTerrainCache()
let running = false
self.onmessage = async (event: MessageEvent<{ id: number; config: CityConfig; compute?: GenerationComputeOptions }>) => {
  if (running) { self.postMessage({ id: event.data.id, error: '生成中の処理を中止してから再生成してください。' }); return }
  running = true
  try { self.postMessage({ id: event.data.id, ...await runAcceleratedGeneration(event.data.config, terrainSource, progress => self.postMessage({ id: event.data.id, progress }), preview => self.postMessage({ id: event.data.id, preview }), event.data.compute) }) }
  catch (error) { self.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : '生成できませんでした' }) }
  finally { running = false }
}
