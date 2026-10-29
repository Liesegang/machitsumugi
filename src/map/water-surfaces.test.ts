import { describe, expect, it } from 'vitest'
import { waterGeometry, waterSurfaceElevation } from './water-surfaces'
import { intersectRegions, pointInRegion, rectangle, regionArea } from '../domain/geometry'
import type { Area } from '../domain/types'

const lake: Area = { id: 'lake-1', kind: 'water', polygon: rectangle(100, 100, 200, 200), holes: [rectangle(180, 180, 40, 40)], waterLevel: 25, name: '湖' }
const river: Area = { id: 'river', kind: 'water', polygon: rectangle(0, 130, 400, 20) }
const source = [lake, river]

describe('one visible water body at lake inlets and outlets', () => {
  it('does not draw retraced section cuts inside a saved river surface', () => {
    const area: Area = {id:'legacy-river',kind:'water',polygon:[{x:0,y:0},{x:200,y:0},{x:200,y:50},{x:130,y:50},{x:130,y:25},{x:130,y:50},{x:0,y:50}]}
    const before = structuredClone(area), result = waterGeometry([area])
    expect(result.shorelines).toHaveLength(1)
    expect(result.shorelines[0]!.polygon.every(p=>p.y===0||p.y===50)).toBe(true)
    expect(regionArea(result.shorelines[0]!)).toBe(10000)
    expect(area).toEqual(before)
  })
  it('removes submerged river surfaces while preserving physical occupancy and an island', () => {
    const before = structuredClone(source), geometry = waterGeometry(source)
    const flowing = geometry.surfaces.filter(area => area.waterLevel === undefined)
    expect(flowing).toHaveLength(2)
    for (const surface of flowing) expect(intersectRegions(surface, lake).reduce((sum, part) => sum + regionArea(part), 0)).toBe(0)
    expect(geometry.surfaces.find(area => area.id === lake.id)).toBe(lake)
    expect(geometry.shorelines).toHaveLength(1)
    expect(geometry.shorelines[0]!.holes).toHaveLength(1)
    expect(pointInRegion({ x: 200, y: 200 }, geometry.shorelines[0]!)).toBe(false)
    for (let x = 5; x < 400; x += 10) for (let y = 5; y < 400; y += 10) {
      const point = { x, y }, physical = source.some(area => pointInRegion(point, area))
      expect(geometry.surfaces.some(area => pointInRegion(point, area))).toBe(physical)
      expect(geometry.shorelines.some(area => pointInRegion(point, area))).toBe(physical)
    }
    expect(source).toEqual(before)
    // No inlet cap at x=100 remains in the external shoreline: it would run
    // across water at y=130..150, instead of being an exposed bank.
    expect(geometry.shorelines[0]!.polygon.some((a, i, ring) => { const b = ring[(i + 1) % ring.length]!; return a.x === 100 && b.x === 100 && Math.min(a.y, b.y) < 150 && Math.max(a.y, b.y) > 130 })).toBe(false)
  })
  it('clips flowing water beneath wetlands and the sea without changing their hydraulic levels', () => {
    const wetland: Area = { ...lake, id: 'wetland', landUse: 'wetland', waterLevel: 7 }
    const sea: Area = { id: 'sea', kind: 'water', polygon: rectangle(320, 0, 80, 400), waterLevel: 0 }
    const geometry = waterGeometry([river, wetland, sea])
    for (const flowing of geometry.surfaces.filter(area => area.waterLevel === undefined)) for (const standing of [wetland, sea]) expect(intersectRegions(flowing, standing).reduce((sum, area) => sum + regionArea(area), 0)).toBe(0)
    expect(waterSurfaceElevation(wetland, { x: 120, y: 120 }, () => -100)).toBe(7.5)
    expect(waterSurfaceElevation(sea, { x: 350, y: 140 }, () => -500)).toBe(.5)
    expect(waterSurfaceElevation(river, { x: 20, y: 140 }, () => 8)).toBe(8.7)
  })
  it('reuses geometry across panning/exports and invalidates a preview whose water areas are replaced', () => {
    const areas = [...source], first = waterGeometry(areas)
    expect(waterGeometry(areas)).toBe(first)
    areas[0] = { ...lake, polygon: rectangle(110, 110, 190, 190) }
    expect(waterGeometry(areas)).not.toBe(first)
    const second = waterGeometry(areas)
    areas[0]!.waterLevel = 30
    expect(waterGeometry(areas)).not.toBe(second)
  })
})
