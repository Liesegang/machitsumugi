import { generateCity } from './generator'
import type { CityConfig } from './types'
import { createGenerationTerrainCache } from './generation-terrain-cache'
const terrainSource = createGenerationTerrainCache()
self.onmessage = (event: MessageEvent<{ id: number; config: CityConfig }>) => {
  try { self.postMessage({ id: event.data.id, map: generateCity(event.data.config, progress => self.postMessage({ id: event.data.id, progress }), preview => self.postMessage({ id: event.data.id, preview }), terrainSource) }) }
  catch (error) { self.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : '生成できませんでした' }) }
}
