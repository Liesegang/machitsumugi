import { describe, expect, it } from 'vitest'
import { clipSegmentToMap, clipSurfaceToMap, partitionTerrainWater, roadDeckOffsets, roadSurfaceClearance, splitTerrainFace, terrainMeshGrid } from './scene-geometry'
import type { Road } from '../domain/types'
import { intersectRegions, pointInRegion, polygonArea, rectangle, regionArea } from '../domain/geometry'

describe('3D map geometry', () => {
  it('retains canonical route direction while trimming outside both crop edges', () => {
    const clipped = clipSegmentToMap({ x: -324, y: 25 }, { x: 424, y: 75 }, 100, 100)!
    expect(clipped.from.x).toBe(0)
    expect(clipped.to.x).toBe(100)
    expect(clipped.from.y).toBeCloseTo(46.657754)
    expect(clipped.to.y).toBeCloseTo(53.342246)
    expect(clipSegmentToMap({ x: -4, y: -20 }, { x: -4, y: 120 }, 100, 100)).toBeNull()
    expect(clipSegmentToMap({ x: -4, y: -20 }, { x: -4, y: 120 }, 100, 100, 6)).not.toBeNull()
  })
  it('clips wide decks as surfaces, preserving their linear vertical profile', () => {
    const vertices = [{ x: -30, y: -5, elevation: 7 }, { x: 130, y: -5, elevation: 23 }, { x: 130, y: 20, elevation: 23 }, { x: -30, y: 20, elevation: 7 }]
    const cropped = clipSurfaceToMap(vertices, 100, 100)
    expect(cropped).toHaveLength(4)
    for (const p of cropped) {
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(100)
      expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(100)
      expect(p.elevation).toBeCloseTo(10 + p.x * .1)
    }
    expect(clipSurfaceToMap(vertices.map(p => ({ ...p, y: p.y - 50 })), 100, 100)).toEqual([])
  })
  it('raises the mainline consistently and connects the ramp from ground by actual distance', () => {
    const base: Road = { id: 'route', points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 90 }], kind: 'arterial', width: 22 }
    expect(roadDeckOffsets({ ...base, role: 'expressway', level: 1 })).toEqual([6, 6, 6])
    expect(roadDeckOffsets({ ...base, role: 'ramp', level: 1 })).toEqual([0, 1.5, 6])
    expect(roadDeckOffsets({ ...base, role: 'highway', level: 0 })).toEqual([0, 0, 0])
  })
  it('samples the actual displayed triangle planes instead of a different bilinear saddle', () => {
    const grid = terrainMeshGrid({ columns: 2, rows: 2, cellSize: 10, elevations: [0, 0, 0, 20] }, 10, 10)
    expect(grid.elevation({ x: 5, y: 5 })).toBe(0)
    expect(grid.elevation({ x: 8, y: 8 })).toBeCloseTo(12)
    expect(grid.elevation({ x: 10, y: 10 })).toBe(20)
  })
  it('keeps every interior point of a wide road above sharp DEM triangle ridges', () => {
    const grid = terrainMeshGrid({ columns: 4, rows: 3, cellSize: 10, elevations: [0, 0, 12, 0, 0, 24, 0, 15, 0, 0, 20, 0] }, 30, 20)
    const road: Road = { id: 'saddle-road', kind: 'local', width: 6, points: [{ x: 0, y: 4 }, { x: 30, y: 4 }] }, clearance = roadSurfaceClearance(road)
    const polygon = rectangle(0, 1, 30, 6), pieces = [...splitTerrainFace(polygon, grid)]
    expect(pieces.length).toBeGreaterThan(5)
    expect(pieces.reduce((sum, piece) => sum + polygonArea(piece.polygon), 0)).toBeCloseTo(polygonArea(polygon), 6)
    for (const piece of pieces) for (let i = 1; i < piece.polygon.length - 1; i++) {
      const face = [piece.polygon[0]!, piece.polygon[i]!, piece.polygon[i + 1]!]
      const p = face.reduce((sum, p) => ({ x: sum.x + p.x / 3, y: sum.y + p.y / 3 }), { x: 0, y: 0 })
      const roadSurface = face.reduce((sum, p) => sum + (grid.elevation(p) + clearance) / 3, 0)
      expect(roadSurface - grid.elevation(p)).toBeCloseTo(clearance, 8)
      expect(clearance).toBeLessThan(.3)
    }
    expect(roadSurfaceClearance({ ...road, kind: 'arterial' })).toBeGreaterThan(clearance)
  })
  it('removes ground under water and overlapping confluence faces while keeping a lake island', () => {
    const ground = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }]
    const lake = { polygon: rectangle(10, 10, 30, 30), holes: [rectangle(20, 20, 5, 5)], level: 25 }
    const river = { polygon: rectangle(0, 12, 60, 4), level: undefined }
    const result = partitionTerrainWater(ground, [lake, river, river])
    for (const water of result.surfaces) for (const dry of result.dry) expect(intersectRegions(water, dry).reduce((sum, region) => sum + regionArea(region), 0)).toBeLessThan(1e-6)
    for (let i = 0; i < result.surfaces.length; i++) for (let j = i + 1; j < result.surfaces.length; j++) expect(intersectRegions(result.surfaces[i]!, result.surfaces[j]!).reduce((sum, region) => sum + regionArea(region), 0)).toBeLessThan(1e-6)
    expect(result.dry.some(region => pointInRegion({ x: 22, y: 22 }, region))).toBe(true)
    expect(result.surfaces.some(region => pointInRegion({ x: 22, y: 22 }, region))).toBe(false)
    expect(result.surfaces.find(region => pointInRegion({ x: 15, y: 14 }, region))!.level).toBe(25)
    expect([...result.dry, ...result.surfaces].reduce((sum, region) => sum + regionArea(region), 0)).toBeCloseTo(polygonArea(ground), 5)
  })
})
