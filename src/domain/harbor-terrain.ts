import type { Point } from './types'
import type { TerrainModel } from './terrain'
import { distance, intersectRegions, pointInRegion, regionArea, subtractRegions } from './geometry.ts'
import type { PolygonRegion } from './geometry.ts'

export interface HarborTerrainInput { width: number; height: number; seed: string; enabled: boolean; originClearance?: number }
export interface HarborPlatform {
  platform: Point[]
  /** Straight sea-facing retaining wall, with genuine land behind it. */
  quay: [Point, Point]
  landwardAccess: Point
  tangent: Point
  outward: Point
  deckElevation: number
  reclaimedRegions: PolygonRegion[]
  reclaimedArea: number
  earthworkVolume: number
  /** A small modern quay scenario, not a model of historical marine deposition. */
  constructionYear: 1920
}
export interface HarborTerrainResult { terrain: TerrainModel; harbor: HarborPlatform | null }

/**
 * A surveyed, modest reclamation pad changes BOTH the sea polygons and their
 * terrain predicates before streets grow. It is an explicit human earthwork,
 * not random geometric perturbation of the natural coastline. A bad coast has
 * no harbor; neither mountains nor rivers are removed to force a placement.
 */
export function applyHarborTerrain(base: TerrainModel, input: HarborTerrainInput): HarborTerrainResult {
  const unchanged = { terrain: base, harbor: null }
  if (!input.enabled) return unchanged
  const seas = base.areas.filter(a => a.kind === 'water' && a.id.startsWith('sea'))
  if (!seas.length) return unchanged
  const isSea = (p: Point) => seas.some(a => pointInRegion(p, a))
  const otherWater = base.areas.filter(a => a.kind === 'water' && !a.id.startsWith('sea'))
  let hash = 2166136261
  for (const character of input.seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  const frontage = 200 + (hash >>> 0) % 61, inland = 45, seaward = 75
  type Candidate = { platform: Point[]; quay: [Point, Point]; landwardAccess: Point; tangent: Point; outward: Point; deck: number; cost: number; reclaimedRegions: PolygonRegion[] }
  const candidates: Candidate[] = []
  for (const sea of seas) {
    const polygon = sea.polygon
    const lengths = polygon.map((a, i) => distance(a, polygon[(i + 1) % polygon.length]!))
    const cumulative = [0]
    for (const length of lengths) cumulative.push(cumulative.at(-1)! + length)
    const perimeter = cumulative.at(-1)!
    const at = (offset: number): Point => {
      const d = (offset % perimeter + perimeter) % perimeter
      let index = 0
      while (index + 1 < cumulative.length && cumulative[index + 1]! <= d) index++
      const a = polygon[index]!, b = polygon[(index + 1) % polygon.length]!, t = (d - cumulative[index]!) / (lengths[index] || 1)
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
    for (let offset = 0; offset < perimeter; offset += 35) {
      const p = at(offset)
      if (p.x < frontage || p.x > input.width - frontage || p.y < frontage || p.y > input.height - frontage || distance(p, base.cityOrigin) < 300 || distance(p, base.cityOrigin) > 1650) continue
      const before = at(offset - 80), after = at(offset + 80), length = distance(before, after)
      if (length < 110) continue // do not fill a tight natural inlet with an oversized rectangle
      const tangent = { x: (after.x - before.x) / length, y: (after.y - before.y) / length }
      let outward = { x: -tangent.y, y: tangent.x }
      const point = (along: number, cross: number): Point => ({ x: p.x + tangent.x * along + outward.x * cross, y: p.y + tangent.y * along + outward.y * cross })
      if (!isSea(point(0, 18))) outward = { x: -outward.x, y: -outward.y }
      if (!isSea(point(0, 18)) || isSea(point(0, -18))) continue
      const back = [-.5, -.25, 0, .25, .5].map(t => point(t * frontage, -inland))
      const front = [-.5, -.25, 0, .25, .5].map(t => point(t * frontage, seaward))
      if (back.some(q => base.waterAt(q) || base.slope(q) > .14) || front.some(q => !isSea(q))) continue
      const heights = back.map(q => base.elevation(q))
      if (Math.max(...heights) > 13 || Math.max(...heights) - Math.min(...heights) > 7) continue
      const platform = [point(-frontage / 2, -inland), point(frontage / 2, -inland), point(frontage / 2, seaward), point(-frontage / 2, seaward)]
      if (platform.some(q => q.x < 20 || q.y < 20 || q.x > input.width - 20 || q.y > input.height - 20)) continue
      if (platform.some(q => distance(q, base.cityOrigin) < (input.originClearance ?? 280))) continue
      // No reclamation across a river mouth, where a retaining wall would block
      // the drainage represented elsewhere in the model.
      if (otherWater.some(a => intersectRegions({ polygon: platform }, a).some(r => regionArea(r) > 1))) continue
      const reclaimedRegions = seas.flatMap(a => intersectRegions({ polygon: platform }, a))
      const reclaimedArea = reclaimedRegions.reduce((sum, a) => sum + regionArea(a), 0)
      if (reclaimedArea < frontage * 35 || reclaimedArea > frontage * 100) continue
      const deck = Math.max(2.8, heights.reduce((a, b) => a + b, 0) / heights.length)
      candidates.push({ platform, quay: [front[0]!, front.at(-1)!], landwardAccess: point(0, -inland), tangent, outward, deck, reclaimedRegions,
        cost: distance(p, base.cityOrigin) + Math.max(...heights) * 24 + (Math.max(...heights) - Math.min(...heights)) * 40 })
    }
  }
  candidates.sort((a, b) => a.cost - b.cost)
  const site = candidates[0]
  if (!site) return unchanged
  const pad = { polygon: site.platform }
  const areas = base.areas.flatMap(area => area.kind === 'water' && !area.id.startsWith('sea') ? [area] : subtractRegions(area, [pad]).map((region, index) => ({ ...area, ...region, holes: region.holes, id: index ? `${area.id}-harbor-${index}` : area.id })))
  const water = areas.filter(a => a.kind === 'water')
  const onPad = (p: Point) => pointInRegion(p, pad)
  const waterAt = (p: Point) => water.some(a => pointInRegion(p, a))
  const elevation = (p: Point) => onPad(p) ? site.deck : base.elevation(p)
  const slope = (p: Point) => onPad(p) ? 0 : base.slope(p)
  const continuationTerrain = base.continuationTerrain ? { ...base.continuationTerrain,
    elevation: (p: Point) => onPad(p) ? site.deck : base.continuationTerrain!.elevation(p),
    slope: (p: Point) => onPad(p) ? 0 : base.continuationTerrain!.slope(p),
    waterAt: (p: Point) => onPad(p) ? false : base.continuationTerrain!.waterAt(p),
    seaAt: (p: Point) => onPad(p) ? false : base.continuationTerrain!.seaAt(p),
  } : undefined
  let earthworkVolume = 0
  const center = { x: (site.platform[0]!.x + site.platform[2]!.x) / 2, y: (site.platform[0]!.y + site.platform[2]!.y) / 2 }
  for (let along = -frontage / 2 + 5; along < frontage / 2; along += 10) for (let cross = -(inland + seaward) / 2 + 5; cross < (inland + seaward) / 2; cross += 10) {
    const p = { x: center.x + site.tangent.x * along + site.outward.x * cross, y: center.y + site.tangent.y * along + site.outward.y * cross }
    earthworkVolume += Math.abs(site.deck - base.elevation(p)) * 100
  }
  const harbor: HarborPlatform = { platform: site.platform, quay: site.quay, landwardAccess: site.landwardAccess, tangent: site.tangent, outward: site.outward, deckElevation: site.deck,
    reclaimedRegions: site.reclaimedRegions, reclaimedArea: site.reclaimedRegions.reduce((sum, a) => sum + regionArea(a), 0), earthworkVolume, constructionYear: 1920 }
  return { harbor, terrain: { ...base, areas, waterAt, elevation, slope, continuationTerrain, landform: p => onPad(p) ? 'terrace' : base.landform(p),
    wetness: p => onPad(p) ? .12 : base.wetness(p), terrainCost: p => onPad(p) ? 1 : base.terrainCost(p), cultivable: p => !onPad(p) && base.cultivable(p) } }
}
