import { describe, expect, it, vi } from 'vitest'
import { erodeTerrainJs } from './hydrology'
import { getRegionalTerrain, regionalOceanMask } from './regional-terrain'
import type { RegionalTerrain } from './regional-terrain'
import { createTerrainModel } from './terrain'
import type { Point } from './types'
import { regionQuery } from './region-query'

vi.mock('./regional-terrain.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./regional-terrain.ts')>(),
  getRegionalTerrain: vi.fn(),
}))

function surveyedCoast(): RegionalTerrain {
  const columns = 65, resolution = 100, extent = (columns - 1) * resolution
  const raw = Float32Array.from({ length: columns ** 2 }, (_, i) => {
    const x = i % columns * resolution, y = Math.floor(i / columns) * resolution
    // A coastal plane plus a separate below-sea-level, enclosed inland basin.
    return Math.min((3600 - y) * .06, (Math.hypot(x - 3900, y - 3300) - 150) * .12)
  })
  const eroded = erodeTerrainJs(raw, columns, columns, resolution, 0)
  // This fixture tests a surveyed crop, without introducing a separate river
  // network or running geological evolution just to test ocean materialization.
  eroded.accumulatedArea.fill(resolution ** 2)
  return { extent, columns, rows: columns, resolution, seed: 1, ...eroded,
    ocean: regionalOceanMask(raw, columns, columns, 0) }
}

describe('physical ocean in a non-coastal survey window', () => {
  it('keeps offshore seabed wet in river crops, including construction and continuation queries', () => {
    const world = surveyedCoast(), original = world.rawDEM.slice()
    vi.mocked(getRegionalTerrain).mockReturnValue(world)
    const terrain = createTerrainModel({ width: 1000, height: 800, seed: 'river-crop-contains-ocean', terrain: 'river', type: 'onsen', forest: 0 })
    const frame = terrain.hydrology.frame, cosine = Math.cos(frame.angle), sine = Math.sin(frame.angle), mirror = frame.mirrored ? -1 : 1
    const local = (p: Point): Point => ({ x: frame.localAnchor.x + mirror * (cosine * (p.x - frame.worldAnchor.x) + sine * (p.y - frame.worldAnchor.y)), y: frame.localAnchor.y - sine * (p.x - frame.worldAnchor.x) + cosine * (p.y - frame.worldAnchor.y) })
    const sea = terrain.areas.filter(area => area.id === 'sea' || area.id.startsWith('sea-'))
    expect(sea.length).toBeGreaterThan(0)
    expect(sea.every(area => area.kind === 'water' && area.waterLevel === 0)).toBe(true)
    let checked = 0
    for (let y = 3750; y <= 4000; y += 50) for (let x = 3500; x <= 4300; x += 50) {
      const p = local({ x, y })
      if (p.x < 20 || p.x > 980 || p.y < 20 || p.y > 780) continue
      checked++
      expect(terrain.waterAt(p)).toBe(true)
      expect(terrain.landform(p)).toBe('water')
      expect(terrain.cultivable(p)).toBe(false)
      expect(terrain.terrainCost(p)).toBe(Infinity)
      expect(terrain.continuationTerrain!.seaAt(p)).toBe(true)
    }
    expect(checked).toBeGreaterThan(5)
    const lake = local({ x: 3900, y: 3300 })
    expect(lake.x).toBeGreaterThan(0); expect(lake.x).toBeLessThan(1000)
    expect(lake.y).toBeGreaterThan(0); expect(lake.y).toBeLessThan(800)
    expect(regionQuery(sea)(lake)).toBe(false)
    expect(terrain.continuationTerrain!.seaAt(lake)).toBe(false)
    expect(terrain.standingWaterAt!(lake)?.kind).toBe('lake')
    expect(world.rawDEM).toEqual(original)
  })
})
