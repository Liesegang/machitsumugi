import { describe, expect, it, vi } from 'vitest'
import { createGenerationTerrainCache } from './generation-terrain-cache'
import { applyHarborTerrain } from './harbor-terrain'
import type { TerrainModel, TerrainModelInput } from './terrain'

const input: TerrainModelInput = { width: 1200, height: 1200, seed: 'cache-coast', terrain: 'coast', forest: 0, type: 'port' }
// This isolated fixture tests cache ownership and dated reclamation, rather
// than rerunning a landscape just to exercise the two-entry metadata policy.
const model = (): TerrainModel => ({
  areas: [{ id: 'sea', kind: 'water', name: '自然海岸', polygon: [{ x: 0, y: 800 }, { x: 1200, y: 800 }, { x: 1200, y: 1200 }, { x: 0, y: 1200 }] }],
  rivers: [{ id: 'river', points: [{ x: 100, y: 0 }, { x: 100, y: 800 }], widths: [8, 12], drainageArea: [100, 200], surfaceElevation: [10, 0], source: { kind: 'viewport-inflow', point: { x: 100, y: 0 }, catchmentArea: 100, estimatedBaseflowM3s: 1 } }],
  cityOrigin: { x: 350, y: 400 }, bridgeSites: [], bridgeCandidates: [],
  elevation: p => p.y < 800 ? 3 : -4, slope: () => 0, waterAt: p => p.y >= 800,
  landform: p => p.y < 800 ? 'terrace' : 'water', wetness: () => .1, terrainCost: () => 1, cultivable: p => p.y < 800, bankDistance: p => Math.abs(p.y - 800), channelAt: () => null,
  hydrology: { columns: 3, rows: 3, resolution: 600, rawDEM: new Float32Array([3, 3, 3, 3, 3, 3, -4, -4, -4]), erosion: { iterations: 256 } } as TerrainModel['hydrology'],
})

describe('worker-local natural landscape cache', () => {
  it('reuses physical terrain while copying map names and mutable geometry', () => {
    const build = vi.fn(model), get = createGenerationTerrainCache(build)
    const first = get(input)
    first.areas[0]!.name = '別の地図名'; first.areas[0]!.polygon[0]!.x = 999
    first.rivers[0]!.points[0]!.x = 999; first.rivers[0]!.widths[0] = 999
    const preview = vi.fn(), second = get({ ...input, coastType: 'bay', relief: 'hills', settlement: 'regional-city', onTerrainPreview: preview })
    expect(build).toHaveBeenCalledTimes(1)
    expect(second.areas[0]!.name).toBe('自然海岸')
    expect(second.areas[0]!.polygon[0]!.x).toBe(0)
    expect(second.rivers[0]!.points[0]!.x).toBe(100)
    expect(second.rivers[0]!.widths[0]).toBe(8)
    expect(preview.mock.calls[0]![0].cached).toBe(true)
    expect(preview.mock.calls[0]![0].surface.elevations).toEqual([3, 3, -4, -4])
  })
  it('bounds memory to two landscapes and invalidates every physical input', () => {
    const build = vi.fn(model), get = createGenerationTerrainCache(build)
    get(input); get({ ...input, seed: 'second' }); get(input); get({ ...input, seed: 'third' }); get(input)
    expect(build).toHaveBeenCalledTimes(3)
    get({ ...input, seed: 'second' })
    expect(build).toHaveBeenCalledTimes(4)
    const changes: Partial<TerrainModelInput>[] = [{ width: 2400 }, { height: 2400 }, { terrain: 'river' }, { coastType: 'ria' }, { relief: 'mountains' }, { forest: 20 }, { type: 'onsen' }, { settlement: 'village' }]
    for (const change of changes) get({ ...input, ...change })
    expect(build).toHaveBeenCalledTimes(4 + changes.length)
  })
  it('does not carry a later reclaimed harbor into an earlier natural coast', () => {
    const get = createGenerationTerrainCache(model), modernBase = get(input)
    const modern = applyHarborTerrain(modernBase, { width: 1200, height: 1200, seed: input.seed, enabled: true })
    expect(modern.harbor).not.toBeNull()
    const harbor = modern.harbor!, point = { x: (harbor.quay[0].x + harbor.quay[1].x) / 2 - harbor.outward.x * 15, y: (harbor.quay[0].y + harbor.quay[1].y) / 2 - harbor.outward.y * 15 }
    expect(modern.terrain.waterAt(point)).toBe(false)
    const historic = get(input)
    expect(historic.waterAt(point)).toBe(true)
    expect(historic.elevation(point)).toBe(-4)
    expect(historic.areas).toEqual(model().areas)
  })
})
