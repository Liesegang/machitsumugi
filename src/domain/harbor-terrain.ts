import type { Area, Point, TimelineVersion } from './types'
import type { TerrainModel } from './terrain'
import { boundsOf, distance, intersectRegions, pointInRegion, regionArea, subtractRegions } from './geometry.ts'
import type { PolygonRegion } from './geometry.ts'
import { surveyHarborEarthworks } from './harbor-earthworks'

export interface HarborTerrainInput { width: number; height: number; seed: string; enabled: boolean; originClearance?: number; throughYear?: number; capitalBudget?: number }
export interface HarborStage extends ReturnType<typeof surveyHarborEarthworks> {
  id: string; constructionYear: number; platform: Point[]; quay: [Point, Point]; landwardAccess: Point; tangent: Point; outward: Point; deckElevation: number
  reclaimedRegions: PolygonRegion[]; reclaimedArea: number; internalPath: Point[]
}
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
  stages: HarborStage[]
  capitalBudget: number
  constructionCost: number
}
export interface HarborTerrainResult { terrain: TerrainModel; harbor: HarborPlatform | null; terrainAt(year: number): TerrainModel }

/** Adopt only dated, actually surveyed ground; callers may decline an access
 * project without installing that phase's reclamation into the natural sea. */
export function harborTerrainAt(base: TerrainModel, stages: HarborStage[], year: number): TerrainModel {
  const active = stages.filter(stage => stage.constructionYear <= year)
  if (!active.length) return base
  const pads = active.map(stage => ({ polygon: stage.platform }))
  const areas = base.areas.flatMap(area => subtractRegions(area, pads).map((region, index) => ({ ...area, ...region, holes: region.holes, id: index ? `${area.id}-harbor-${index}` : area.id })))
  const indexed = active.map(stage => ({ stage, bounds: boundsOf(stage.platform) }))
  const onPad = (p: Point) => { for (let i = indexed.length - 1; i >= 0; i--) { const { stage, bounds } = indexed[i]!; if (p.x >= bounds.minX && p.x <= bounds.maxX && p.y >= bounds.minY && p.y <= bounds.maxY && pointInRegion(p, { polygon: stage.platform })) return stage } return undefined }
  const continuationTerrain = base.continuationTerrain ? { ...base.continuationTerrain, elevation: (p: Point) => onPad(p)?.deckElevation ?? base.continuationTerrain!.elevation(p), slope: (p: Point) => onPad(p) ? 0 : base.continuationTerrain!.slope(p), waterAt: (p: Point) => onPad(p) ? false : base.continuationTerrain!.waterAt(p), seaAt: (p: Point) => onPad(p) ? false : base.continuationTerrain!.seaAt(p) } : undefined
  return { ...base, areas, continuationTerrain, waterAt: p => onPad(p) ? false : base.waterAt(p), elevation: p => onPad(p)?.deckElevation ?? base.elevation(p), slope: p => onPad(p) ? 0 : base.slope(p), landform: p => onPad(p) ? 'terrace' : base.landform(p), wetness: p => onPad(p) ? .12 : base.wetness(p), terrainCost: p => onPad(p) ? 1 : base.terrainCost(p), cultivable: p => !onPad(p) && base.cultivable(p) }
}

/** Exact dated natural-area changes from the same adopted earthwork pads. */
export function harborAreaHistory(areas: Area[], stages: HarborStage[]): TimelineVersion<Area>[] {
  const result: TimelineVersion<Area>[] = [], current = new Map<string, TimelineVersion<Area>>()
  const update = (values: Area[], year: number) => {
    const next = new Map(values.map(value => [value.id, value]))
    for (const [id, previous] of current) {
      const value = next.get(id)
      if (value && JSON.stringify([value.polygon, value.holes]) === JSON.stringify([previous.value.polygon, previous.value.holes])) { next.delete(id); continue }
      previous.to = year; current.delete(id)
    }
    for (const value of next.values()) { const version = { from: year, value }; result.push(version); current.set(value.id, version) }
  }
  update(areas, 1650)
  for (const stage of stages) {
    const pads = stages.filter(s => s.constructionYear <= stage.constructionYear).map(s => ({ polygon: s.platform }))
    update(areas.flatMap(area => subtractRegions(area, pads).map((region, index) => ({ ...area, ...region, holes: region.holes, id: index ? `${area.id}-harbor-${index}` : area.id }))), stage.constructionYear)
  }
  return result
}

/**
 * A surveyed, modest reclamation pad changes BOTH the sea polygons and their
 * terrain predicates before streets grow. It is an explicit human earthwork,
 * not random geometric perturbation of the natural coastline. A bad coast has
 * no harbor; neither mountains nor rivers are removed to force a placement.
 */
export function applyHarborTerrain(base: TerrainModel, input: HarborTerrainInput): HarborTerrainResult {
  const unchanged = { terrain: base, harbor: null, terrainAt: () => base }
  if (!input.enabled || (input.throughYear ?? 2025) < 1920) return unchanged
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
  const stages: HarborStage[] = [], capitalBudget = input.capitalBudget ?? 12_000
  const adopt = (platform: Point[], quay: [Point, Point], landwardAccess: Point, internalPath: Point[], constructionYear: number) => {
    if (constructionYear > (input.throughYear ?? 2025) || platform.some(p => p.x < 20 || p.x > input.width - 20 || p.y < 20 || p.y > input.height - 20 || distance(p, base.cityOrigin) < (input.originClearance ?? 280))) return
    const pad = { polygon: platform }
    if (otherWater.some(a => intersectRegions(pad, a).some(r => regionArea(r) > .1))) return
    const current = harborTerrainAt(base, stages, constructionYear), reclaimedRegions = current.areas.filter(a => a.id.startsWith('sea')).flatMap(a => intersectRegions(pad, a)), reclaimedArea = reclaimedRegions.reduce((sum, r) => sum + regionArea(r), 0)
    if (reclaimedArea < 2000) return
    for (const p of platform) if (base.elevation(p) < -12 || !base.waterAt(p) && (base.elevation(p) > 15 || base.slope(p) > .15)) return
    const works = surveyHarborEarthworks(base, pad, stages.map(stage => ({ polygon: stage.platform })), site.deck, distance(quay[0], quay[1]))
    if (stages.reduce((sum, stage) => sum + stage.constructionCost, 0) + works.constructionCost > capitalBudget) return
    stages.push({ id: `harbor-stage-${constructionYear}`, constructionYear, platform, quay, landwardAccess, tangent: site.tangent, outward: site.outward, deckElevation: site.deck, reclaimedRegions, reclaimedArea, internalPath, ...works })
  }
  const center = { x: (site.quay[0].x + site.quay[1].x) / 2 - site.outward.x * 8, y: (site.quay[0].y + site.quay[1].y) / 2 - site.outward.y * 8 }
  adopt(site.platform, site.quay, site.landwardAccess, [site.landwardAccess, center], 1920)
  if (!stages.length) return unchanged
  const pivot = { x: (site.platform[0]!.x + site.platform[1]!.x) / 2 + site.outward.x * inland, y: (site.platform[0]!.y + site.platform[1]!.y) / 2 + site.outward.y * inland }
  const point = (u: number, v: number): Point => ({ x: pivot.x + site.tangent.x * u + site.outward.x * v, y: pivot.y + site.tangent.y * u + site.outward.y * v })
  const extension = 160 + (hash >>> 8) % 101, reach = 150 + (hash >>> 16) % 81
  const a = frontage / 2 - 35, b = frontage / 2 + extension
  adopt([[a, -35], [b, -35], [b, reach], [b - 75, reach], [b - 75, 92], [a + 42, 92], [a + 42, 135], [a, 135]].map(([u, v]) => point(u!, v!)), [point(b - 75, reach), point(b, reach)], point(a + 15, -30), [point(a + 15, -30), point(b - 37.5, -30), point(b - 37.5, reach - 8)], 1955)
  const left = -frontage / 2 - extension * .8, right = -frontage / 2 + 30, outer = reach + 45
  adopt([[left, -35], [right, -35], [right, 72], [left + 65, 72], [left + 65, outer], [left, outer]].map(([u, v]) => point(u!, v!)), [point(left, outer), point(left + 65, outer)], point(right - 15, -30), [point(right - 15, -30), point(left + 32.5, -30), point(left + 32.5, outer - 8)], 1975)
  const harbor: HarborPlatform = { platform: site.platform, quay: site.quay, landwardAccess: site.landwardAccess, tangent: site.tangent, outward: site.outward, deckElevation: site.deck,
    reclaimedRegions: stages.flatMap(stage => stage.reclaimedRegions), reclaimedArea: stages.reduce((sum, stage) => sum + stage.reclaimedArea, 0), earthworkVolume: stages.reduce((sum, stage) => sum + stage.earthworkVolume, 0), constructionYear: 1920, stages, capitalBudget, constructionCost: stages.reduce((sum, stage) => sum + stage.constructionCost, 0) }
  const terrainAt = (year: number) => harborTerrainAt(base, stages, year)
  return { harbor, terrain: terrainAt(input.throughYear ?? 2025), terrainAt }
}
