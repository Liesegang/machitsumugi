import { describe, expect, it } from 'vitest'
import { resolveGenerationConfig } from './generation-config'
import type { CityConfig } from './types'

const config: CityConfig = { name: '港町', seed: 'physical-input', type: 'port', terrain: 'plain', density: 105, forest: -2, railway: true, stations: 8, arterial: true, facilities: ['port'] }
describe('shared worker and simulator configuration', () => {
  it('surveys the same coastal dimensions and bounded physical inputs without editing the draft', () => {
    const draft = { ...config, mapSize: 'large' as const, targetYear: 1919.8 }
    const result = resolveGenerationConfig(draft)
    expect(result.config).toEqual({ ...draft, terrain: 'coast', density: 100, forest: 0, stations: 5, era: 'present', targetYear: 1920 })
    expect(result.year).toBe(1920)
    expect(result.terrainInput).toMatchObject({ width: 12000, height: 9000, terrain: 'coast', forest: 0, seed: config.seed })
    expect(draft.terrain).toBe('plain')
    expect(draft.stations).toBe(8)
    expect(result.config.facilities).not.toBe(draft.facilities)
  })
  it('keeps legacy era defaults and a non-port plain intact', () => {
    const result = resolveGenerationConfig({ ...config, type: 'post', facilities: [], era: 'historic', mapSize: 'medium' })
    expect(result.year).toBe(1800)
    expect(result.config.targetYear).toBeUndefined()
    expect(result.terrainInput).toMatchObject({ width: 8000, height: 6000, terrain: 'plain' })
  })
})
