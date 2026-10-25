import { difference, intersection, union } from 'polygon-clipping'
import type { MultiPolygon } from 'polygon-clipping'
import type { Point, Road } from './types'
import type { PolygonRegion } from './geometry'
import { boundsOf, corridorPolygon, distance, distanceToSegment, overlaps, pointInRegion, polygonArea, polygonOverlapsRegion, projectPoint, regionArea } from './geometry'
import { buildLayoutCoveragePriority } from './layout-first-coverage-priority'
import type { LayoutCoveragePrioritySite } from './layout-first-coverage-priority'

export interface LayoutCoverageMask { regions: PolygonRegion[]; area: number; excludedRegions?: PolygonRegion[] }
export interface LayoutCoverageAnchor { point: Point; roadId: string; builtYear: number }
export interface LayoutCoverageProposal {
  from: LayoutCoverageAnchor
  to: LayoutCoverageAnchor
  through: Point
  builtYear: number
  width: number
  gapArea: number
}
export interface LayoutStreetCoverage {
  enclosedArea: number
  coveredArea: number
  uncoveredArea: number
  coveredRegions: PolygonRegion[]
  uncoveredRegions: PolygonRegion[]
}

const geometry = (regions: readonly PolygonRegion[]): MultiPolygon => regions.filter(region => region.polygon.length >= 3 && regionArea(region) > .01)
  .map(region => [region.polygon, ...region.holes ?? []].map(ring => ring.map(point => [Math.round(point.x * 10000) / 10000, Math.round(point.y * 10000) / 10000] as [number, number])))
const merged = (regions: readonly PolygonRegion[]): MultiPolygon => {
  const polygons = geometry(regions)
  return polygons.length ? union(polygons[0]!, ...polygons.slice(1)) : []
}
const regionsOf = (polygons: MultiPolygon): PolygonRegion[] => polygons.map(polygon => ({ polygon: polygon[0]!.slice(0, -1).map(([x, y]) => ({ x, y })),
  ...(polygon.length > 1 ? { holes: polygon.slice(1).map(ring => ring.slice(0, -1).map(([x, y]) => ({ x, y }))) } : {}) })).filter(region => regionArea(region) > .01)
const areaOf = (polygons: MultiPolygon) => regionsOf(polygons).reduce((sum, region) => sum + regionArea(region), 0)

/** Exact union/intersection/difference preserves protected holes. Suitability
 * is mandatory; a planning demand outline alone never grants usable land. */
export function createLayoutCoverageMask(input: { demandRegions: readonly PolygonRegion[]; suitableRegions: readonly PolygonRegion[]; excludedRegions: readonly PolygonRegion[] }): LayoutCoverageMask {
  const demand = merged(input.demandRegions), suitable = merged(input.suitableRegions), excluded = merged(input.excludedRegions)
  if (!demand.length || !suitable.length) return { regions: [], area: 0, excludedRegions: regionsOf(excluded) }
  const adopted = intersection(demand, suitable), dry = excluded.length && adopted.length ? difference(adopted, excluded) : adopted
  return { regions: regionsOf(dry), area: areaOf(dry), excludedRegions: regionsOf(excluded) }
}

/** Measure accepted physical faces, not proposed links or field cells.
 * An oversized face is enclosed but still lacks a usable major-block frame;
 * subdividing it with real streets can therefore increase coveredArea. */
export function measureLayoutStreetCoverage(input: { faces: readonly Point[][]; mask: LayoutCoverageMask; maximumFaceArea?: number }): LayoutStreetCoverage {
  const mask = merged(input.mask.regions), maximum = input.maximumFaceArea ?? 600000
  if (!mask.length) return { enclosedArea: 0, coveredArea: 0, uncoveredArea: 0, coveredRegions: [], uncoveredRegions: [] }
  const faces = input.faces.filter(polygon => polygon.length >= 3 && polygonArea(polygon) > 150)
  const all = merged(faces.map(polygon => ({ polygon }))), usable = merged(faces.filter(polygon => polygonArea(polygon) <= maximum).map(polygon => ({ polygon })))
  const enclosed = all.length ? intersection(mask, all) : [], covered = usable.length ? intersection(mask, usable) : []
  const uncovered = covered.length ? difference(mask, covered) : mask
  return { enclosedArea: areaOf(enclosed), coveredArea: areaOf(covered), uncoveredArea: areaOf(uncovered), coveredRegions: regionsOf(covered), uncoveredRegions: regionsOf(uncovered) }
}

export function measureLayoutCoverageGain(input: { beforeFaces: readonly Point[][]; afterFaces: readonly Point[][]; mask: LayoutCoverageMask; streetLength: number; maximumFaceArea?: number }) {
  const before = measureLayoutStreetCoverage({ faces: input.beforeFaces, mask: input.mask, maximumFaceArea: input.maximumFaceArea })
  const after = measureLayoutStreetCoverage({ faces: input.afterFaces, mask: input.mask, maximumFaceArea: input.maximumFaceArea })
  const coveredGain = after.coveredArea - before.coveredArea
  return { enclosedGain: after.enclosedArea - before.enclosedArea, coveredGain, areaPerMeter: input.streetLength > 0 ? coveredGain / input.streetLength : 0 }
}

interface StreetSegment { a: Point; b: Point; road: Road; along: number; length: number; tangent: number }
interface Anchor extends LayoutCoverageAnchor { tangent: number; along: number }

/** Finite geometric proposals only. The field locates unserved demand;
 * neither its cell edges nor demand/mask boundaries are proposed as streets.
 * Callers must survey through the interior point, stage the accepted geometry
 * in the real planar graph, and measure actual face gain before committing. */
export function proposeLayoutCoverageBlocks(input: {
  roads: readonly Road[]
  faces: readonly Point[][]
  mask: LayoutCoverageMask
  builtYear: number
  canAnchor: (point: Point) => boolean
  cellSize?: number
  maximumFieldCells?: number
  maximumProposals?: number
  maximumFaceArea?: number
  prioritySites?: readonly LayoutCoveragePrioritySite[]
}) {
  const coverage = measureLayoutStreetCoverage(input), proposals: LayoutCoverageProposal[] = []
  const maximumProposals = Math.min(16, Math.max(0, Math.floor(input.maximumProposals ?? 8)))
  const maximumCells = Math.min(20000, Math.max(16, Math.floor(input.maximumFieldCells ?? 12000)))
  const diagnostics = { fieldCellSize: 0, fieldCells: 0, gaps: coverage.uncoveredRegions.length, inspectedGaps: 0, candidatePairs: 0, uncoveredArea: coverage.uncoveredArea, activePrioritySites: 0, priorityGaps: 0 }
  if (!coverage.uncoveredRegions.length || !maximumProposals) return { proposals, diagnostics }
  const publicRoads = input.roads.filter(road => !road.controlledAccess && road.role !== 'expressway' && road.role !== 'ramp' && (road.level ?? 0) === 0 && road.width >= 4.6 && road.points.length >= 2 && (road.builtYear ?? 1650) <= input.builtYear)
  const segments: StreetSegment[] = [], bins = new Map<string, StreetSegment[]>()
  const binKeys = (a: Point, b: Point) => {
    const keys: string[] = []
    for (let x = Math.floor(Math.min(a.x, b.x) / 250); x <= Math.floor(Math.max(a.x, b.x) / 250); x++) for (let y = Math.floor(Math.min(a.y, b.y) / 250); y <= Math.floor(Math.max(a.y, b.y) / 250); y++) keys.push(`${x}:${y}`)
    return keys
  }
  for (const road of publicRoads) {
    let along = 0
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!, length = distance(a, b)
      if (length < 1e-7) continue
      const segment = { a, b, road, along, length, tangent: Math.atan2(b.y - a.y, b.x - a.x) }; segments.push(segment)
      for (const key of binKeys(a, b)) { const list = bins.get(key) ?? []; list.push(segment); bins.set(key, list) }
      along += length
    }
  }
  if (!segments.length) return { proposals, diagnostics }
  const nearestDistance = (point: Point) => {
    for (const radius of [250, 750, 1750]) {
      let best = Infinity
      const found = new Set<StreetSegment>()
      for (const key of binKeys({ x: point.x - radius, y: point.y - radius }, { x: point.x + radius, y: point.y + radius })) for (const segment of bins.get(key) ?? []) found.add(segment)
      for (const segment of found) best = Math.min(best, distanceToSegment(point, segment.a, segment.b))
      if (best <= radius) return best
    }
    return Infinity
  }
  const bounds = boundsOf(coverage.uncoveredRegions.flatMap(region => region.polygon)), spanX = bounds.maxX - bounds.minX, spanY = bounds.maxY - bounds.minY
  let step = Math.max(50, input.cellSize ?? 100), columns = Math.max(1, Math.ceil(spanX / step)), rows = Math.max(1, Math.ceil(spanY / step))
  while (columns * rows > maximumCells) { step *= Math.sqrt(columns * rows / maximumCells) * 1.001; columns = Math.max(1, Math.ceil(spanX / step)); rows = Math.max(1, Math.ceil(spanY / step)) }
  diagnostics.fieldCellSize = step; diagnostics.fieldCells = columns * rows
  const priority = buildLayoutCoveragePriority({ roads: publicRoads, sites: input.prioritySites ?? [], builtYear: input.builtYear, excluded: input.mask.excludedRegions ?? [] })
  const byArea = coverage.uncoveredRegions.slice().sort((a, b) => regionArea(b) - regionArea(a))
  const siteDistance = (region: PolygonRegion) => Math.min(Infinity, ...priority.sites.map(site => pointInRegion(site.point, region) ? 0 : Math.min(...[region.polygon, ...region.holes ?? []].flatMap(ring => ring.map((a, i) => distanceToSegment(site.point, a, ring[(i + 1) % ring.length]!))))))
  const siteDistances = new Map(priority.sites.length ? byArea.map(region => [region, siteDistance(region)]) : [])
  // Prioritize real acquired centres and station gates, while retaining one
  // largest remaining fringe gap. This field still grants no street or lot.
  const nearby = priority.sites.length ? byArea.filter(region => siteDistances.get(region)! <= 900).sort((a, b) => siteDistances.get(a)! - siteDistances.get(b)! || regionArea(b) - regionArea(a)).slice(0, 3) : []
  diagnostics.activePrioritySites = priority.sites.length; diagnostics.priorityGaps = nearby.length
  const gaps = [...nearby, ...byArea.filter(region => !nearby.includes(region))].slice(0, Math.min(4, maximumProposals))
  const gapBounds = gaps.map(region => boundsOf(region.polygon)), choices = gaps.map(() => [] as { point: Point; distance: number }[])
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const point = { x: bounds.minX + (column + .5) * spanX / columns, y: bounds.minY + (row + .5) * spanY / rows }
    for (let gap = 0; gap < gaps.length; gap++) {
      const b = gapBounds[gap]!
      if (point.x < b.minX || point.x > b.maxX || point.y < b.minY || point.y > b.maxY || !pointInRegion(point, gaps[gap]!)) continue
      const d = nearestDistance(point)
      if (!Number.isFinite(d) || d < 120 || d > 1600) continue
      choices[gap]!.push({ point, distance: d })
    }
  }
  for (let gap = 0; gap < gaps.length && proposals.length < maximumProposals; gap++) {
    diagnostics.inspectedGaps++
    const urgent = priority.sites.length ? choices[gap]!.map(item => ({ ...item, walk: priority.distanceAt(item.point) })).filter(item => item.walk <= 900).sort((a, b) => b.distance / (1 + b.walk / 900) - a.distance / (1 + a.walk / 900)) : []
    const ranked = urgent.length ? urgent : choices[gap]!.sort((a, b) => b.distance - a.distance), best = ranked[0]
    if (!best) continue
    const core = ranked.filter(item => item.distance >= best.distance * .9).slice(0, 7)
    const average = core.reduce((sum, item) => ({ x: sum.x + item.point.x / core.length, y: sum.y + item.point.y / core.length }), { x: 0, y: 0 })
    const through = pointInRegion(average, gaps[gap]!) && (!urgent.length || priority.distanceAt(average) <= 900) ? average : best.point
    const barriers = [...(input.mask.excludedRegions ?? []), ...(gaps[gap]!.holes ?? []).map(polygon => ({ polygon }))].map(region => ({ region, bounds: boundsOf(region.polygon) }))
    const clearGuide = (point: Point) => {
      const bounds = boundsOf([point, through]), corridor = corridorPolygon(point, through, .01)
      return barriers.every(item => !overlaps(bounds, item.bounds) || !polygonOverlapsRegion(corridor, item.region))
    }
    const anchors: Anchor[] = []
    for (const segment of segments) {
      // Project to real pavement, then retain chainage-spaced contacts. No
      // field or mask vertex can become an endpoint through this interface.
      const samples = [projectPoint(through, segment.a, segment.b)]
      for (let along = Math.ceil(segment.along / 120) * 120; along <= segment.along + segment.length; along += 120) {
        const t = (along - segment.along) / segment.length
        samples.push({ x: segment.a.x + (segment.b.x - segment.a.x) * t, y: segment.a.y + (segment.b.y - segment.a.y) * t })
      }
      for (const point of samples) {
        if (distance(through, point) > 2300 || !input.canAnchor(point)) continue
        const along = segment.along + distance(segment.a, point)
        if (!anchors.some(anchor => anchor.roadId === segment.road.id && Math.abs(anchor.along - along) < 100) && clearGuide(point)) anchors.push({ point, roadId: segment.road.id, builtYear: segment.road.builtYear ?? 1650, tangent: segment.tangent, along })
      }
    }
    const near = anchors.sort((a, b) => distance(a.point, through) - distance(b.point, through)).slice(0, 48)
    const candidates: { from: Anchor; to: Anchor; score: number }[] = []
    for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
      diagnostics.candidatePairs++
      const from = near[i]!, to = near[j]!, chord = distance(from.point, to.point), length = distance(from.point, through) + distance(to.point, through)
      if (chord < 240 || length > 4000) continue
      const first = Math.atan2(through.y - from.point.y, through.x - from.point.x), last = Math.atan2(through.y - to.point.y, through.x - to.point.x)
      if (Math.min(Math.abs(Math.sin(first - from.tangent)), Math.abs(Math.sin(last - to.tangent))) < Math.sin(Math.PI * 35 / 180)) continue
      if (from.roadId === to.roadId && polygonArea([from.point, through, to.point]) < 50000) continue
      const midpoint = { x: (from.point.x + to.point.x) / 2, y: (from.point.y + to.point.y) / 2 }
      candidates.push({ from, to, score: length + distance(midpoint, through) * .1 })
    }
    candidates.sort((a, b) => a.score - b.score)
    const selected: typeof candidates = []
    for (const candidate of candidates) {
      if (selected.some(other => distance(candidate.from.point, other.from.point) < 180 && distance(candidate.to.point, other.to.point) < 180)) continue
      selected.push(candidate)
      proposals.push({ from: { point: candidate.from.point, roadId: candidate.from.roadId, builtYear: candidate.from.builtYear }, to: { point: candidate.to.point, roadId: candidate.to.roadId, builtYear: candidate.to.builtYear }, through,
        builtYear: Math.max(input.builtYear, candidate.from.builtYear, candidate.to.builtYear), width: 8, gapArea: regionArea(gaps[gap]!) })
      if (selected.length >= 2 || proposals.length >= maximumProposals) break
    }
  }
  return { proposals, diagnostics }
}
