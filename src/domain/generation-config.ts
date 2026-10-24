import { simulationEndYear } from './simulation-calendar'
import type { CityConfig } from './types'
import type { TerrainModelInput } from './terrain'

/** Shared by the synchronous simulator and the worker's asynchronous compute
 * preparation. Both must survey precisely the same physical configuration. */
export function resolveGenerationConfig(input: CityConfig) {
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
  const factor = input.mapSize === 'large' ? 3 : input.mapSize === 'medium' ? 2 : 1
  const width = 4000 * factor, height = 3000 * factor
  const config: CityConfig = { ...input, facilities: [...input.facilities], density: clamp(input.density, 0, 100), forest: clamp(input.forest, 0, 100), stations: clamp(Math.round(input.stations), 1, 5), era: input.era ?? 'present' }
  if ((config.type === 'port' || config.facilities.includes('port')) && config.terrain === 'plain') config.terrain = 'coast'
  const year = simulationEndYear(config)
  if (input.targetYear !== undefined) config.targetYear = year
  const terrainInput: TerrainModelInput = { width, height, seed: config.seed, terrain: config.terrain, coastType: config.coastType, relief: config.relief, forest: config.forest, type: config.type, settlement: config.settlement }
  return { config, year, width, height, factor, terrainInput }
}
