import { generateCity } from './generator'
import type { CityConfig } from './types'
self.onmessage = (event: MessageEvent<{ id: number; config: CityConfig }>) => {
  try { self.postMessage({ id: event.data.id, map: generateCity(event.data.config) }) }
  catch (error) { self.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : '生成できませんでした' }) }
}
