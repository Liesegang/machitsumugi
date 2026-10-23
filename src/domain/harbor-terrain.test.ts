import { describe, expect, it } from 'vitest'
import { applyHarborTerrain } from './harbor-terrain'
import { pointInRegion, rectangle, regionArea } from './geometry'
import type { TerrainModel } from './terrain'
import type { Area, Point } from './types'

const input = { width: 4000, height: 3000, seed: 'surveyed-harbor', enabled: true }
function coast(extraAreas: Area[] = []): TerrainModel {
  const areas: Area[] = [{ id: 'sea', kind: 'water', polygon: rectangle(2200, 0, 1800, 3000) }, ...extraAreas]
  const waterAt = (p: Point) => areas.some(a => a.kind === 'water' && pointInRegion(p, a))
  return { areas, waterAt, cityOrigin: { x: 1800, y: 1500 }, elevation: p => waterAt(p) ? -2 : 5, slope: () => 0,
    bridgeSites: [], bridgeCandidates: [], rivers: [], bankDistance: () => Infinity, channelAt: () => null, cultivable: p => !waterAt(p), wetness: () => .2,
    terrainCost: p => waterAt(p) ? 100 : 1, landform: p => waterAt(p) ? 'water' : 'terrace', hydrology: {} as TerrainModel['hydrology'] }
}

describe('explicit harbor reclamation', () => {
  it('changes the same sea geometry used by drawing and placement and retains its natural remainder', () => {
    const base = coast([{ id: 'wood', kind: 'forest', polygon: rectangle(2100, 1300, 95, 400) }])
    const { terrain, harbor } = applyHarborTerrain(base, input)
    expect(harbor).not.toBeNull()
    expect(harbor!.reclaimedArea).toBeGreaterThan(14000)
    expect(harbor!.reclaimedArea).toBeLessThan(22000)
    const originalSea = base.areas.filter(a => a.kind === 'water').reduce((sum, a) => sum + regionArea(a), 0)
    const sea = terrain.areas.filter(a => a.kind === 'water')
    expect(originalSea - sea.reduce((sum, a) => sum + regionArea(a), 0)).toBeCloseTo(harbor!.reclaimedArea, 1)
    expect(base.waterAt(harbor!.landwardAccess)).toBe(false)
    expect(harbor!.quay.every(p => base.waterAt(p))).toBe(true)
    const center = { x: (harbor!.quay[0].x + harbor!.landwardAccess.x) / 2, y: (harbor!.quay[0].y + harbor!.landwardAccess.y) / 2 }
    expect(terrain.waterAt(center)).toBe(false)
    expect(terrain.elevation(center)).toBe(harbor!.deckElevation)
    expect(terrain.slope(center)).toBe(0)
    expect(terrain.landform(center)).toBe('terrace')
    expect(terrain.cultivable(center)).toBe(false)
    expect(terrain.areas.some(a => a.kind === 'forest' && pointInRegion(center, a))).toBe(false)
    for (let y = 20; y < input.height; y += 43) for (let x = 20; x < input.width; x += 41) {
      const p = { x, y }
      expect(terrain.waterAt(p)).toBe(sea.some(a => pointInRegion(p, a)))
      if (!pointInRegion(p, { polygon: harbor!.platform })) expect(terrain.waterAt(p)).toBe(base.waterAt(p))
    }
    expect(applyHarborTerrain(base, input).harbor).toEqual(harbor)
  })
  it('does not dam a river mouth or build across inaccessible high coastal cliffs', () => {
    const mouth: Area = { id: 'river-mouth', kind: 'water', polygon: rectangle(2170, 0, 160, 3000) }
    expect(applyHarborTerrain(coast([mouth]), input).harbor).toBeNull()
    const cliff = coast()
    cliff.elevation = p => p.x < 2200 ? 24 : -2
    expect(applyHarborTerrain(cliff, input).harbor).toBeNull()
  })
  it('preserves the original model when disabled or when there is no connected sea', () => {
    const model = coast()
    expect(applyHarborTerrain(model, { ...input, enabled: false }).terrain).toBe(model)
    model.areas = []
    expect(applyHarborTerrain(model, input).terrain).toBe(model)
  })
})
