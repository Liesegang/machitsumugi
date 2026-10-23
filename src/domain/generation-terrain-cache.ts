import { createTerrainModel } from './terrain'
import type { TerrainModel, TerrainModelInput } from './terrain'

export type GenerationTerrainSource = (input: TerrainModelInput) => TerrainModel
const pointCopy = <T extends { x: number; y: number }>(point: T): T => ({ ...point })

/** Copy mutable map metadata/geometry on checkout. Expensive terrain fields and
 * their query closures remain shared read-only. A modern harbor is an overlay
 * returned by applyHarborTerrain, never a replacement of this natural model. */
function checkout(base: TerrainModel): TerrainModel {
  return { ...base,
    cityOrigin: pointCopy(base.cityOrigin),
    areas: base.areas.map(area => ({ ...area, polygon: area.polygon.map(pointCopy), holes: area.holes?.map(ring => ring.map(pointCopy)) })),
    rivers: base.rivers.map(river => ({ ...river, points: river.points.map(pointCopy), widths: [...river.widths], drainageArea: [...river.drainageArea], surfaceElevation: [...river.surfaceElevation], source: river.source ? { ...river.source, point: pointCopy(river.source.point) } : undefined })),
    bridgeSites: base.bridgeSites.map(pointCopy),
    bridgeCandidates: base.bridgeCandidates.map(bridge => ({ ...bridge, point: pointCopy(bridge.point), bankA: pointCopy(bridge.bankA), bankB: pointCopy(bridge.bankB) })),
  }
}

/** Two worker-local natural landscapes. The key includes every physical input
 * consumed by createTerrainModel; population density, rail/road settings,
 * facilities, era, names and selected year do not shape that natural terrain. */
export function createGenerationTerrainCache(build: GenerationTerrainSource = createTerrainModel): GenerationTerrainSource {
  const cache = new Map<string, TerrainModel>()
  return input => {
    const physical: TerrainModelInput = { width: input.width, height: input.height, seed: input.seed, terrain: input.terrain, coastType: input.coastType ?? 'bay', relief: input.relief ?? 'hills', forest: input.forest, type: input.type, settlement: input.settlement ?? 'regional-city' }
    const key = JSON.stringify(physical), cached = cache.get(key)
    if (cached) {
      cache.delete(key); cache.set(key, cached)
      if (input.onTerrainPreview) {
        const world = cached.hydrology, stride = 2, columns = Math.floor((world.columns - 1) / stride) + 1, elevations: number[] = []
        for (let y = 0; y < world.rows; y += stride) for (let x = 0; x < world.columns; x += stride) elevations.push(world.rawDEM[y * world.columns + x]!)
        input.onTerrainPreview({ surface: { columns, rows: columns, cellSize: world.resolution * stride, elevations }, iteration: world.erosion.iterations, iterations: world.erosion.iterations, cached: true, seaLevel: 0 })
      }
      return checkout(cached)
    }
    physical.onTerrainPreview = input.onTerrainPreview
    const result = build(physical)
    // Returned query closures can retain the physical input; don't retain a
    // completed request's preview callback and its UI/message closure with it.
    physical.onTerrainPreview = undefined
    cache.set(key, result)
    if (cache.size > 2) cache.delete(cache.keys().next().value!)
    return checkout(result)
  }
}
