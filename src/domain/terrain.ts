import type { Area, CityConfig, CityType, Point, Terrain } from './types'
import { getRegionalTerrain, sampleRegional, sampleRegionalCubic } from './regional-terrain.ts'
import type { RegionalPreview, RegionalTerrain } from './regional-terrain.ts'
import { contourConnectedSea } from './sea-contour.ts'
import { evolveChannel } from './river-evolution.ts'
import { reworkChannelBed } from './channel-sediment.ts'
import type { ChannelBedSection, ChannelSedimentBudget } from './channel-sediment.ts'
import type { AbandonedChannel } from './channel-cutoff.ts'
import { extendHeadwaterPath, runoffSourceModel } from './channel-headwaters.ts'
import { clipWaterRegion } from './terrain-water.ts'
import type { WaterRegion } from './terrain-water.ts'
import { extractDepressionLakes } from './depression-lakes.ts'
import { coastalWindow } from './coastal-window.ts'
import { regionQuery } from './region-query.ts'
import { contourNaturalLand } from './land-use'
import { boundsOf, regionArea, subtractRegions } from './geometry'

const lakeCache = new WeakMap<RegionalTerrain, ReturnType<typeof extractDepressionLakes>>()

export interface TerrainModelInput {
  width: number
  height: number
  seed: string
  terrain: Terrain
  forest: number
  type: CityType
  settlement?: CityConfig['settlement']
  coastType?: CityConfig['coastType']
  relief?: CityConfig['relief']
  onTerrainPreview?: (frame: RegionalPreview) => void
}

export interface TerrainModel {
  areas: Area[]
  elevation: (point: Point) => number
  slope: (point: Point) => number
  waterAt: (point: Point) => boolean
  bridgeSites: Point[]
  cityOrigin: Point
  landform: (point: Point) => 'water' | 'valley' | 'terrace' | 'hillside' | 'ridge'
  wetness: (point: Point) => number
  terrainCost: (point: Point) => number
  cultivable: (point: Point) => boolean
  bankDistance: (point: Point) => number
  channelAt: (point: Point) => { point: Point; tangent: Point; bankDistance: number; width: number; surfaceElevation: number; riverId: string } | null
  rivers: TerrainRiver[]
  bridgeCandidates: { point: Point; bankA: Point; bankB: Point; width: number; cost: number; riverId: string }[]
  continuationTerrain?: { bounds: { minX: number; minY: number; maxX: number; maxY: number }; contains(p: Point): boolean; elevation(p: Point): number; slope(p: Point): number; waterAt(p: Point): boolean; seaAt(p: Point): boolean }
  standingWaterAt?: (p: Point) => { id: string; level: number; kind: 'lake' | 'wetland' } | null
  hydrology: RegionalTerrain & { cropOrigin: Point; frame: { worldAnchor: Point; localAnchor: Point; angle: number; mirrored: boolean }; localResolution: number; localDEM: Float32Array; localColumns: number; localRows: number; channelEvolution: { id: string; steps: number; maxMigration: number; cutoffs: number }[]; bankSediment?: ChannelSedimentBudget; localInitialBedDEM?: Float32Array; localBedDEM?: Float32Array; localBankDeposition?: Float32Array; oxbows: { id: string; sourceRiverId: string; formedAtStep: number }[]; depressionLakes: { id: string; level: number; kind: 'lake' | 'wetland'; area: number; volume: number }[] }
}
export interface TerrainRiver { id: string; points: Point[]; widths: number[]; drainageArea: number[]; surfaceElevation: number[]; source?: { kind: 'runoff-headwater' | 'viewport-inflow'; point: Point; catchmentArea: number; estimatedBaseflowM3s: number } }

const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v))
const smooth = (t: number) => t * t * (3 - 2 * t)
function seedNumber(seed: string) {
  let n = 2166136261
  for (const c of seed) n = Math.imul(n ^ c.charCodeAt(0), 16777619)
  return n >>> 0
}
function noise(seed: number, x: number, y: number) {
  const hash = (i: number, j: number) => {
    let n = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ seed
    n = Math.imul(n ^ n >>> 13, 1274126177)
    return ((n ^ n >>> 16) >>> 0) / 4294967295
  }
  const i = Math.floor(x), j = Math.floor(y), u = smooth(x - i), v = smooth(y - j)
  return (hash(i, j) * (1 - u) + hash(i + 1, j) * u) * (1 - v) + (hash(i, j + 1) * (1 - u) + hash(i + 1, j + 1) * u) * v
}
function inside(point: Point, polygon: Point[]) {
  let hit = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}
function area(polygon: Point[]) {
  return polygon.reduce((sum, p, i) => {
    const q = polygon[(i + 1) % polygon.length]!
    return sum + p.x * q.y - q.x * p.y
  }, 0) / 2
}
function simplifyLine(path: Point[], tolerance: number): Point[] {
  if (path.length < 3) return path
  const a = path[0]!, b = path.at(-1)!, dx = b.x - a.x, dy = b.y - a.y
  let farthest = 0, distance = tolerance
  for (let i = 1; i < path.length - 1; i++) {
    const p = path[i]!, t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))
    const d = Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t)
    if (d > distance) { distance = d; farthest = i }
  }
  return farthest ? [...simplifyLine(path.slice(0, farthest + 1), tolerance).slice(0, -1), ...simplifyLine(path.slice(farthest), tolerance)] : [a, b]
}
/** Remove tiny offset-bank loops where bend radius is smaller than half-width. */
function cleanBank(path: Point[]) {
  let result = path
  for (let guard = 0; guard < path.length; guard++) {
    let changed = false
    outer: for (let i = 0; i < result.length - 1; i++) for (let j = i + 2; j < result.length - 1; j++) {
      const a = result[i]!, b = result[i + 1]!, c = result[j]!, d = result[j + 1]!
      const ax = b.x - a.x, ay = b.y - a.y, bx = d.x - c.x, by = d.y - c.y, det = ax * by - ay * bx
      if (Math.abs(det) < 1e-10) continue
      const t = ((c.x - a.x) * by - (c.y - a.y) * bx) / det, u = ((c.x - a.x) * ay - (c.y - a.y) * ax) / det
      if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue
      result = [...result.slice(0, i + 1), { x: a.x + ax * t, y: a.y + ay * t }, ...result.slice(j + 1)]
      changed = true; break outer
    }
    if (!changed) break
  }
  return result
}

/** Mountain-foot woodland uses the same continuous terrain suitability used by
 * land placement. A binary 40m mask followed by 32m simplification turned a
 * curved mountain foot into long straight bands. Keep its signed values and
 * their holes through contouring; these polygons also constrain development. */
export function woodlandContours(input: {
  width: number; height: number; forest: number; origin: Point; coreRadius: number
  elevation(p: Point): number; slope(p: Point): number; bankDistance(p: Point): number
  variation(p: Point): number; water: WaterRegion[]
}): WaterRegion[] {
  if (input.forest <= 0) return []
  const reference = input.elevation(input.origin), threshold = 110 - clamp(input.forest / 100) * 90
  const water = input.water.map(region => ({ ...region, bounds: boundsOf(region.polygon) }))
  const contours = contourNaturalLand(input.width, input.height, p => Math.min(
    input.elevation(p) - reference + input.slope(p) * 320 + input.variation(p) - threshold,
    input.bankDistance(p) - 65,
    Math.hypot(p.x - input.origin.x, p.y - input.origin.y) - input.coreRadius - 75,
  ), 24)
  return contours.flatMap(region => clipWaterRegion(region, input.width, input.height)).flatMap(region => {
    const b = boundsOf(region.polygon)
    return subtractRegions(region, water.filter(w => w.bounds.maxX >= b.minX && w.bounds.minX <= b.maxX && w.bounds.maxY >= b.minY && w.bounds.minY <= b.maxY))
  }).filter(region => regionArea(region) > 12_000).sort((a, b) => regionArea(b) - regionArea(a))
}

/** Regional watershed formation precedes urban site choice and the local map crop. */
export function createTerrainModel(input: TerrainModelInput): TerrainModel {
  return buildTerrainModel(input, true)
}
function buildTerrainModel(input: TerrainModelInput, allowCutoff: boolean): TerrainModel {
  const { width: w, height: h } = input, world = getRegionalTerrain(input.seed, input.coastType, input.onTerrainPreview, input.relief), seed = seedNumber(`${input.seed}:local-terrain-v4`)
  let standingWater = lakeCache.get(world)
  if (!standingWater) { standingWater = extractDepressionLakes({ rawDEM: world.rawDEM, hydroDEM: world.hydroDEM, columns: world.columns, rows: world.rows, cellSize: world.resolution, oceanMask: world.ocean }); lakeCache.set(world, standingWater) }
  const worldPoint = (i: number): Point => ({ x: i % world.columns * world.resolution, y: Math.floor(i / world.columns) * world.resolution })
  const indexAt = (p: Point) => Math.round(clamp(p.y / world.resolution, 0, world.rows - 1)) * world.columns + Math.round(clamp(p.x / world.resolution, 0, world.columns - 1))
  const worldSlope = (i: number) => {
    const x = i % world.columns, y = Math.floor(i / world.columns)
    if (!x || !y || x === world.columns - 1 || y === world.rows - 1) return 1
    return Math.hypot(world.rawDEM[i + 1]! - world.rawDEM[i - 1]!, world.rawDEM[i + world.columns]! - world.rawDEM[i - world.columns]!) / (2 * world.resolution)
  }
  // Urban origins need a supply of connected usable land, not merely one flat
  // cell beside a spectacular gorge. This surveys the evolved ground; it never
  // lowers slopes or creates a plain to satisfy a settlement-size request.
  const habitable = new Uint8Array(world.rawDEM.length), labels = new Int32Array(world.rawDEM.length), componentSizes = [0], queue = new Int32Array(world.rawDEM.length)
  for (let i = 0; i < habitable.length; i++) habitable[i] = Number(!world.ocean[i] && world.hydroDEM[i]! - world.rawDEM[i]! < .2 && worldSlope(i) < .065)
  for (let i = 0; i < habitable.length; i++) if (habitable[i] && !labels[i]) {
    const label = componentSizes.length; let head = 0, tail = 1; queue[0] = i; labels[i] = label
    while (head < tail) { const cell = queue[head++]!, x = cell % world.columns, y = Math.floor(cell / world.columns); for (const next of [x ? cell - 1 : -1, x + 1 < world.columns ? cell + 1 : -1, y ? cell - world.columns : -1, y + 1 < world.rows ? cell + world.columns : -1]) if (next >= 0 && habitable[next] && !labels[next]) { labels[next] = label; queue[tail++] = next } }
    componentSizes.push(tail)
  }
  const integralStride = world.columns + 1, integral = new Uint32Array((world.rows + 1) * integralStride)
  for (let y = 0; y < world.rows; y++) { let row = 0; for (let x = 0; x < world.columns; x++) { row += habitable[y * world.columns + x]!; integral[(y + 1) * integralStride + x + 1] = integral[y * integralStride + x + 1]! + row } }
  const landSupply = (i: number, metres: number) => {
    const radius = Math.round(metres / world.resolution), x = i % world.columns, y = Math.floor(i / world.columns), x0 = Math.max(0, x - radius), x1 = Math.min(world.columns, x + radius + 1), y0 = Math.max(0, y - radius), y1 = Math.min(world.rows, y + radius + 1)
    return (integral[y1 * integralStride + x1]! - integral[y0 * integralStride + x1]! - integral[y1 * integralStride + x0]! + integral[y0 * integralStride + x0]!) / ((x1 - x0) * (y1 - y0))
  }
  const connectedSupply = (i: number) => {
    let best = 0
    for (let oy = -6; oy <= 6; oy += 3) for (let ox = -6; ox <= 6; ox += 3) { const x = i % world.columns + ox, y = Math.floor(i / world.columns) + oy; if (x >= 0 && x < world.columns && y >= 0 && y < world.rows) best = Math.max(best, componentSizes[labels[y * world.columns + x]!] ?? 0) }
    return Math.min(1, best * world.resolution ** 2 / 3_000_000)
  }
  const urbanScale = (input.settlement === 'village' ? .15 : input.settlement === 'rural-town' ? .6 : input.settlement === 'metropolis' ? 1.35 : 1) * (input.type === 'onsen' ? .3 : 1)
  const sitePotential = (i: number) => urbanScale * (landSupply(i, 1200) * 3 + connectedSupply(i) * 1.5)
  let pivot = -1, score = Infinity
  const coastalCandidates: { index: number; point: Point; score: number }[] = []
  for (let i = 0; i < world.rawDEM.length; i++) {
    const p = worldPoint(i), catchment = world.accumulatedArea[i]!, z = world.rawDEM[i]!, next = world.flowTo[i]!
    const inlandMargin = input.terrain === 'coast' ? 500 : 3500
    if (p.x < inlandMargin || p.x > world.extent - inlandMargin || p.y < inlandMargin || p.y > world.extent - (input.terrain === 'coast' ? 500 : 2100) || world.ocean[i]) continue
    if (input.terrain === 'plain') {
      if (z < 28 || z > 150 || catchment > 300_000 || worldSlope(i) > .035) continue
      let surroundings = 0
      for (const [dx, dy] of [[-8, 0], [8, 0], [0, -8], [0, 8]]) surroundings += worldSlope(i + dy! * world.columns + dx!)
      if (surroundings > .17) continue
      const cost = Math.abs(p.x / world.extent - .71) + Math.abs(p.y / world.extent - .54) + worldSlope(i) * 12 + surroundings * 4 - sitePotential(i)
      if (cost < score) { score = cost; pivot = i }
    } else if (input.terrain === 'coast') {
      const shore = [i - 1, i + 1, i - world.columns, i + world.columns].some(j => j >= 0 && j < world.ocean.length && world.ocean[j])
      if (!shore || z > 25 || worldSlope(i) > .12) continue
      // Survey the real land/sea interface. A minimum 5km² river-mouth test
      // silently fell back inland when smaller catchments reached the coast.
      const cost = -Math.log(Math.max(2500, catchment)) + worldSlope(i) * 8 + Math.abs(p.x / world.extent - .57) * .5 + (next >= 0 && world.ocean[next] ? -.35 : 0)
      coastalCandidates.push({ index: i, point: p, score: cost })
      if (cost < score) { score = cost; pivot = i }
    } else {
      if (catchment < 12_000_000 || z < 5 || z > 270 || worldSlope(i) > .13) continue
      const cost = Math.abs(p.x / world.extent - .59) * 2 + Math.abs(p.y / world.extent - .53) * 1.5 + Math.abs(Math.log(catchment / 55_000_000)) * .12 - sitePotential(i)
      if (cost < score) { score = cost; pivot = i }
    }
  }
  if (pivot < 0 && input.terrain === 'coast') {
    // A rocky peninsula may have no low, gently sloping shoreline. Frame the
    // least costly real shore anyway; do not invent one at a fixed southern
    // coordinate. The city planner still checks buildability on this ground.
    for (let i = 0; i < world.rawDEM.length; i++) {
      const p = worldPoint(i)
      if (world.ocean[i] || p.x < 500 || p.y < 500 || p.x > world.extent - 500 || p.y > world.extent - 500) continue
      if (![i - 1, i + 1, i - world.columns, i + world.columns].some(j => j >= 0 && j < world.ocean.length && world.ocean[j])) continue
      const cost = worldSlope(i) * 100 + Math.max(0, world.rawDEM[i]! - 25) / 10 - sitePotential(i)
      coastalCandidates.push({ index: i, point: p, score: cost })
      if (cost < score) { score = cost; pivot = i }
    }
  }
  if (pivot < 0) pivot = indexAt({ x: world.extent * .59, y: world.extent * .55 })
  // The viewport is a surveyed window into the entire regional watershed. A
  // fixed river-at-68% crop made every seed have the same west-bank composition.
  // Transform *all* regional sampling, including the DEM and ocean, rather than
  // rotating already clipped polygons (which would leave unsupported corners).
  const frameSeed = seedNumber(`${input.seed}:map-frame-v1`)
  const style = noise(frameSeed, 0, 8), mirrored = frameSeed % 2 === 1, mirror = mirrored ? -1 : 1
  const coastFrame = input.terrain === 'coast' ? coastalWindow({ width: w, height: h, extent: world.extent, margin: 500, mirrored, preferredBearing: style * Math.PI * 2, ...(input.coastType === 'peninsula' ? { landform: 'peninsula' as const } : {}), candidates: coastalCandidates, seaAt: p => p.x >= 0 && p.y >= 0 && p.x <= world.extent && p.y <= world.extent && !!world.ocean[indexAt(p)], usableAt: p => !!habitable[indexAt(p)] }) : null
  if (coastFrame) pivot = coastFrame.index
  const angle = coastFrame?.angle ?? (style - .5) * .9, cosine = Math.cos(angle), sine = Math.sin(angle)
  const oppositeBank = style > .5
  // Coastal surveys include offshore ridge remnants and neighbouring drowned
  // tributary valleys; always cropping just above one river mouth hides them.
  const localAnchor = coastFrame?.localAnchor ?? { x: w * (input.terrain === 'plain' ? .5 : (oppositeBank ? .26 : .64) + noise(frameSeed, 7.4, 9.2) * .12), y: h * (input.terrain === 'coast' ? .43 : .5) }
  const offset = (p: Point): Point => ({ x: cosine * mirror * (p.x - localAnchor.x) - sine * (p.y - localAnchor.y), y: sine * mirror * (p.x - localAnchor.x) + cosine * (p.y - localAnchor.y) })
  const surveyMargin = input.terrain === 'coast' ? 500 : 1000
  const corners = [{ x: -surveyMargin, y: -surveyMargin }, { x: w + surveyMargin, y: -surveyMargin }, { x: -surveyMargin, y: h + surveyMargin }, { x: w + surveyMargin, y: h + surveyMargin }].map(offset)
  const anchor = coastFrame?.worldAnchor ?? worldPoint(pivot)
  if (input.terrain !== 'coast' && input.type !== 'onsen' && input.settlement !== 'village') {
    let site = pivot, best = Infinity
    const px = pivot % world.columns, py = Math.floor(pivot / world.columns), radius = Math.ceil(1100 / world.resolution)
    for (let oy = -radius; oy <= radius; oy++) for (let ox = -radius; ox <= radius; ox++) {
      const x = px + ox, y = py + oy, i = y * world.columns + x
      if (x < 1 || x >= world.columns - 1 || y < 1 || y >= world.rows - 1 || !habitable[i] || Math.hypot(ox, oy) * world.resolution > 1100) continue
      const score = Math.hypot(ox, oy) * world.resolution / 1600 - landSupply(i, 650) * 2.2 - Math.min(1, (componentSizes[labels[i]!] ?? 0) * world.resolution ** 2 / 3_000_000) * 1.5 + worldSlope(i) * 3
      if (score < best) { best = score; site = i }
    }
    const settlement = worldPoint(site), target = offset({ x: w * .45, y: h * .48 })
    anchor.x = settlement.x - target.x; anchor.y = settlement.y - target.y
  }
  anchor.x = clamp(anchor.x, 100 - Math.min(...corners.map(p => p.x)), world.extent - 100 - Math.max(...corners.map(p => p.x)))
  anchor.y = clamp(anchor.y, 100 - Math.min(...corners.map(p => p.y)), world.extent - 100 - Math.max(...corners.map(p => p.y)))
  const regional = (p: Point): Point => { const q = offset(p); return { x: anchor.x + q.x, y: anchor.y + q.y } }
  const cropOrigin = regional({ x: 0, y: 0 })
  const local = (p: Point): Point => ({ x: localAnchor.x + mirror * (cosine * (p.x - anchor.x) + sine * (p.y - anchor.y)), y: localAnchor.y - sine * (p.x - anchor.x) + cosine * (p.y - anchor.y) })
  const lakeAt = (p: Point) => standingWater.at(regional(p))
  const coastalSurface = (p: Point) => {
    // Reconstruct the evolved regional ground, without post-simulation relief
    // noise that would change shore geometry outside the sediment ledger.
    return sampleRegionalCubic(world, world.rawDEM, p.x, p.y)
  }
  const sourceModel = runoffSourceModel()
  // This threshold selects the principal network, not the physical headwater.
  // Its real feeders are followed upstream below, into fine runoff-fed valleys.
  const channel = (i: number) => i >= 0 && world.accumulatedArea[i]! >= 4_000_000 && !world.ocean[i]
  const upstream = (i: number) => {
    const result: number[] = [], x = i % world.columns, y = Math.floor(i / world.columns)
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy
      if ((!dx && !dy) || nx < 0 || nx >= world.columns || ny < 0 || ny >= world.rows) continue
      const j = ny * world.columns + nx
      if (world.flowTo[j] === i && channel(j)) result.push(j)
    }
    return result
  }
  const main: number[] = [], used = new Uint8Array(world.rawDEM.length)
  for (let i = pivot, guard = 0; channel(i) && guard < world.rawDEM.length; guard++) {
    main.push(i)
    const branches = upstream(i).sort((a, b) => world.accumulatedArea[b]! - world.accumulatedArea[a]!)
    if (!branches.length) break
    i = branches[0]!
  }
  main.reverse()
  for (let i = world.flowTo[pivot]!, guard = 0, marineSteps = 0; i >= 0 && guard < world.rawDEM.length; guard++, i = world.flowTo[i]!) { main.push(i); if (world.ocean[i] && ++marineSteps >= 4) break }
  for (const i of main) used[i] = 1
  const cellPaths: number[][] = main.length > 1 ? [main] : []
  for (let i = 0; i < world.rawDEM.length; i++) {
    if (!channel(i) || used[i] || upstream(i).length) continue
    const path: number[] = []
    for (let j = i, guard = 0, marineSteps = 0; j >= 0 && guard < world.rawDEM.length; guard++, j = world.flowTo[j]!) {
      path.push(j)
      if (used[j] || world.ocean[j] && ++marineSteps >= 4) break
      used[j] = 1
    }
    if (path.length > 3) cellPaths.push(path)
  }
  const nearestOnLine = (p: Point, a: Point, b: Point) => {
    const dx = b.x - a.x, dy = b.y - a.y, t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))
    return { t, distance: Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t) }
  }
  const smoothOpen = (path: Point[]) => {
    const tangents = path.map((p, i) => {
      const a = path[Math.max(0, i - 1)]!, b = path[Math.min(path.length - 1, i + 1)]!
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1
      const left = i ? Math.hypot(p.x - a.x, p.y - a.y) : Math.hypot(b.x - p.x, b.y - p.y)
      const right = i + 1 < path.length ? Math.hypot(b.x - p.x, b.y - p.y) : left
      const scale = Math.min(left, right) * .9 / length
      return { x: (b.x - a.x) * scale, y: (b.y - a.y) * scale }
    })
    const result: Point[] = [path[0]!]
    // Shared Hermite tangents keep the bank offset continuous at confluences.
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!, ta = tangents[i - 1]!, tb = tangents[i]!
      const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 20))
      for (let j = 1; j <= steps; j++) {
        const t = j / steps, t2 = t * t, t3 = t2 * t
        const f0 = 2 * t3 - 3 * t2 + 1, f1 = t3 - 2 * t2 + t, f2 = -2 * t3 + 3 * t2, f3 = t3 - t2
        result.push({ x: a.x * f0 + ta.x * f1 + b.x * f2 + tb.x * f3, y: a.y * f0 + ta.y * f1 + b.y * f2 + tb.y * f3 })
      }
    }
    return result
  }
  const rivers: TerrainRiver[] = [], channelEvolution: TerrainModel['hydrology']['channelEvolution'] = []
  const initialSections: ChannelBedSection[] = [], abandoned: (AbandonedChannel & { id: string; sourceRiverId: string; level: number })[] = []
  const mobileSediment = (world as RegionalTerrain & { alluvium?: Float32Array }).alluvium
  for (const [pathIndex, selectedPath] of cellPaths.entries()) {
    const fullPath = extendHeadwaterPath({ cells: selectedPath, flowTo: world.flowTo, accumulatedArea: world.accumulatedArea, ocean: world.ocean, columns: world.columns, rows: world.rows, sourceArea: sourceModel.sourceArea })
    const visible = fullPath.map(i => local(worldPoint(i)))
    let first = -1, last = -1
    for (let i = 0; i < visible.length; i++) { const p = visible[i]!; if (p.x > -1000 && p.x < w + 1000 && p.y > -1000 && p.y < h + 1000) { if (first < 0) first = i; last = i } }
    if (first < 0 || last - first < 2) continue
    const cells = fullPath.slice(Math.max(0, first - 2), Math.min(fullPath.length, last + 3)), original = cells.map(i => local(worldPoint(i)))
    // Junctions are shared geometric constraints. Smoothing a whole trunk would
    // move its confluences away from the tributary endpoints and break the water.
    const knots = [0, ...cells.flatMap((cell, i) => i > 0 && i < cells.length - 1 && upstream(cell).length > 1 ? [i] : []), cells.length - 1]
    const evolved = evolveChannel({ points: original, widths: cells.map((cell, i) => sourceModel.width(pathIndex > 0 && i === cells.length - 1 ? Math.min(world.accumulatedArea[cell]!, world.accumulatedArea[cells[i - 1]!]! * 1.02) : world.accumulatedArea[cell]!)), pinned: knots, allowCutoff, valleyElevation: p => { const q = regional(p); return sampleRegionalCubic(world, world.rawDEM, q.x, q.y) }, alluvium: mobileSediment ? p => { if (lakeAt(p)) return 0; const q = regional(p); return sampleRegional(world, mobileSediment, q.x, q.y) } : undefined })
    const sourceRiverId = pathIndex === 0 ? 'river' : `river-branch-${pathIndex}`
    channelEvolution.push({ id: sourceRiverId, steps: evolved.steps, maxMigration: evolved.maxMigration, cutoffs: evolved.abandoned.length })
    const levelAt = (p: Point) => { const q = regional(p); return world.ocean[indexAt(q)] ? 0 : sampleRegional(world, world.hydroDEM, q.x, q.y) }
    for (const old of evolved.abandoned) abandoned.push({ ...old, id: `oxbow-${pathIndex}-${abandoned.length}`, sourceRiverId, level: Math.min(...old.points.map(levelAt)) })
    const geometry = (line: Point[], pinned: number[]) => {
      const controls: Point[] = []
      for (let i = 1; i < pinned.length; i++) {
        // A 60m chord tolerance erased real valley bends. Keep the evolved course
        // to 2.5m accuracy; grid-turn removal happened before physical migration.
        const run = simplifyLine(line.slice(pinned[i - 1]!, pinned[i]! + 1), 2.5)
        controls.push(...(controls.length ? run.slice(1) : run))
      }
      return smoothOpen(controls)
    }
    const attributes = (line: Point[]) => {
      const widths: number[] = [], drainageArea: number[] = [], surfaceElevation: number[] = []
      let lastElevation = Infinity, lastArea = 0
      for (const p of line) {
        let closest = 0, fraction = 0, d = Infinity
        for (let j = 1; j < original.length; j++) { const hit = nearestOnLine(p, original[j - 1]!, original[j]!); if (hit.distance < d) { d = hit.distance; closest = j - 1; fraction = hit.t } }
        const a = cells[closest]!, b = cells[Math.min(cells.length - 1, closest + 1)]!
        const areaA = world.accumulatedArea[a]!, areaB = pathIndex > 0 && closest + 1 === cells.length - 1 ? Math.min(world.accumulatedArea[b]!, areaA * 1.02) : world.accumulatedArea[b]!
        const accumulated = Math.max(lastArea, areaA * (1 - fraction) + areaB * fraction)
        const z = Math.min(lastElevation, (world.ocean[a] ? 0 : world.hydroDEM[a]!) * (1 - fraction) + (world.ocean[b] ? 0 : world.hydroDEM[b]!) * fraction)
        widths.push(sourceModel.width(accumulated))
        drainageArea.push(accumulated); surfaceElevation.push(z); lastArea = accumulated; lastElevation = z
      }
      return { widths, drainageArea, surfaceElevation }
    }
    // Initial and evolved beds use the exact same reconstruction and width
    // rule. Mapping simplification itself must not be counted as bank erosion.
    const initialPinned = knots.map(k => evolved.initialPoints.findIndex(p => Math.hypot(p.x - original[k]!.x, p.y - original[k]!.y) < .001)).filter(k => k >= 0)
    const initialPoints = geometry(evolved.initialPoints, initialPinned), initialAttributes = attributes(initialPoints)
    initialSections.push({ points: initialPoints, widths: initialAttributes.widths, levels: initialAttributes.surfaceElevation })
    const points = geometry(evolved.points, evolved.pinned), { widths, drainageArea, surfaceElevation } = attributes(points)
    const catchmentArea = drainageArea[0]!, trueHead = cells[0] === fullPath[0]
    rivers.push({ id: pathIndex === 0 ? 'river' : `river-branch-${pathIndex}`, points, widths, drainageArea, surfaceElevation, source: { kind: trueHead ? 'runoff-headwater' : 'viewport-inflow', point: points[0]!, catchmentArea, estimatedBaseflowM3s: sourceModel.baseflow(catchmentArea) } })
  }
  // Confluences share the same endpoint and enter with downstream momentum.
  // Independently rounded branch/trunk curves can otherwise make an upstream
  // hook or a right-angle kink at exactly their shared numerical D8 vertex.
  const alignConfluences = (channels: { points: Point[] }[]) => {
  for (const branch of channels) {
    const end = branch.points.at(-1)!
    const parent = channels.flatMap(river => river === branch ? [] : river.points.flatMap((p, index) => index > 0 && index < river.points.length - 1 && Math.hypot(p.x - end.x, p.y - end.y) < .01 ? [{ river, index }] : []))[0]
    if (!parent) continue
    let start = branch.points.length - 2, length = 0
    while (start > 0 && length < 160) { length += Math.hypot(branch.points[start + 1]!.x - branch.points[start]!.x, branch.points[start + 1]!.y - branch.points[start]!.y); start-- }
    // A tributary can itself receive another tributary inside this approach.
    // Preserve those graph junctions while changing its downstream tangent.
    for (let i = start + 1; i < branch.points.length - 1; i++) if (channels.some(other => other !== branch && Math.hypot(other.points.at(-1)!.x - branch.points[i]!.x, other.points.at(-1)!.y - branch.points[i]!.y) < .01)) start = i
    const a = branch.points[start]!, before = branch.points[Math.max(0, start - 2)]!, after = branch.points[Math.min(branch.points.length - 1, start + 2)]!
    const ma = parent.river.points[Math.max(0, parent.index - 3)]!, mb = parent.river.points[Math.min(parent.river.points.length - 1, parent.index + 3)]!
    const mainLength = Math.hypot(mb.x - ma.x, mb.y - ma.y) || 1, incomingLength = Math.hypot(end.x - a.x, end.y - a.y) || 1, firstLength = Math.hypot(after.x - before.x, after.y - before.y) || 1
    const direction = { x: (mb.x - ma.x) / mainLength * .7 + (end.x - a.x) / incomingLength * .3, y: (mb.y - ma.y) / mainLength * .7 + (end.y - a.y) / incomingLength * .3 }
    const d = Math.hypot(direction.x, direction.y) || 1, handle = Math.min(70, incomingLength * .38)
    const c1 = { x: a.x + (after.x - before.x) / firstLength * handle, y: a.y + (after.y - before.y) / firstLength * handle }, c2 = { x: end.x - direction.x / d * handle, y: end.y - direction.y / d * handle }
    for (let i = start + 1; i < branch.points.length - 1; i++) {
      const t = (i - start) / (branch.points.length - 1 - start), u = 1 - t
      branch.points[i] = { x: u ** 3 * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * end.x, y: u ** 3 * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * end.y }
    }
  }
  }
  alignConfluences(rivers)
  alignConfluences(initialSections)
  const areas: Area[] = []
  const fullWaterRegions: WaterRegion[] = []
  const fullSeaRegions: WaterRegion[] = []
  const visibleLakes: TerrainModel['hydrology']['depressionLakes'] = []
  for (const body of standingWater.bodies) {
    let visible = false, partIndex = 0
    for (const polygon of body.polygons) {
      const region = { polygon: polygon.polygon.map(local), holes: polygon.holes.map(hole => hole.map(local)) }
      const xs = region.polygon.map(p => p.x), ys = region.polygon.map(p => p.y)
      if (Math.max(...xs) < -1500 || Math.min(...xs) > w + 1500 || Math.max(...ys) < -1500 || Math.min(...ys) > h + 1500) continue
      fullWaterRegions.push(region)
      for (const clipped of clipWaterRegion(region, w, h)) { visible = true; areas.push({ id: `${body.id}-${partIndex++}`, kind: 'water', waterLevel: body.level, ...(body.kind === 'wetland' ? { landUse: 'wetland' as const } : {}), ...clipped, name: body.kind === 'lake' ? '湖' : '冠水湿地' }) }
    }
    if (visible) visibleLakes.push({ id: body.id, level: body.level, kind: body.kind, area: body.area, volume: body.volume })
  }
  for (const river of rivers) {
    const left: Point[] = [], right: Point[] = []
    for (let i = 0; i < river.points.length; i++) {
      const p = river.points[i]!, a = river.points[Math.max(0, i - 1)]!, b = river.points[Math.min(river.points.length - 1, i + 1)]!
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1, nx = -(b.y - a.y) / length, ny = (b.x - a.x) / length, half = river.widths[i]! / 2
      left.push({ x: p.x + nx * half, y: p.y + ny * half }); right.push({ x: p.x - nx * half, y: p.y - ny * half })
    }
    const region = { polygon: [...cleanBank(left), ...cleanBank(right).reverse()] }
    fullWaterRegions.push(region)
    for (const [i, part] of clipWaterRegion(region, w, h).entries()) if (part.polygon.length > 3 && Math.abs(area(part.polygon)) > 4) areas.push({ id: i ? `${river.id}-part-${i}` : river.id, kind: 'water', ...part, name: river.id === 'river' && !i ? '水杜川' : undefined })
  }
  for (const lake of abandoned) {
    const left: Point[] = [], right: Point[] = []
    for (let i = 0; i < lake.points.length; i++) {
      const p = lake.points[i]!, a = lake.points[Math.max(0, i - 1)]!, b = lake.points[Math.min(lake.points.length - 1, i + 1)]!, length = Math.hypot(b.x - a.x, b.y - a.y) || 1, half = lake.widths[i]! / 2
      left.push({ x: p.x - (b.y - a.y) / length * half, y: p.y + (b.x - a.x) / length * half })
      right.push({ x: p.x + (b.y - a.y) / length * half, y: p.y - (b.x - a.x) / length * half })
    }
    const cap = (at: number, direction: number) => {
      const p = lake.points[at]!, a = lake.points[Math.max(0, at - 1)]!, b = lake.points[Math.min(lake.points.length - 1, at + 1)]!, heading = Math.atan2(b.y - a.y, b.x - a.x), radius = lake.widths[at]! / 2
      return Array.from({ length: 9 }, (_, j) => { const angle = heading + direction * Math.PI / 2 - j * Math.PI / 8; return { x: p.x + Math.cos(angle) * radius, y: p.y + Math.sin(angle) * radius } })
    }
    const region = { polygon: [...cleanBank(left), ...cap(lake.points.length - 1, 1), ...cleanBank(right).reverse(), ...cap(0, -1)] }
    fullWaterRegions.push(region)
    for (const [i, part] of clipWaterRegion(region, w, h).entries()) if (part.polygon.length > 3 && Math.abs(area(part.polygon)) > 4) areas.push({ id: i ? `${lake.id}-part-${i}` : lake.id, kind: 'water', waterLevel: lake.level, ...part, name: '旧河道湖' })
  }
  // The preset chooses the survey window, not the physical presence of sea.
  // A wide river/mountain crop can extend offshore too. Omitting its ocean
  // polygons exposed negative seabed as dry terrain and allowed construction
  // there. Closed negative basins are excluded by the regional ocean mask.
  const oceanInSurvey = world.ocean.some((wet, i) => {
    if (!wet) return false
    const p = local(worldPoint(i)), margin = 1000 + world.resolution
    return p.x >= -margin && p.y >= -margin && p.x <= w + margin && p.y <= h + margin
  })
  if (oceanInSurvey) {
    const nx = Math.ceil(w / 12), ny = Math.ceil(h / 12), sx = w / nx, sy = h / ny, mx = Math.ceil(1000 / sx), my = Math.ceil(1000 / sy)
    const seas = contourConnectedSea({ width: (nx + mx * 2) * sx, height: (ny + my * 2) * sy, columns: nx + mx * 2, rows: ny + my * 2, origin: { x: -mx * sx, y: -my * sy }, elevation: p => coastalSurface(regional(p)), regionalOcean: p => world.ocean[indexAt(regional(p))] === 1 })
    fullWaterRegions.push(...seas)
    fullSeaRegions.push(...seas)
    const netArea = (region: WaterRegion) => Math.abs(area(region.polygon)) - (region.holes ?? []).reduce((sum, hole) => sum + Math.abs(area(hole)), 0)
    const visibleSea = seas.flatMap(sea => clipWaterRegion(sea, w, h)).sort((a, b) => netArea(b) - netArea(a))
    for (const [count, part] of visibleSea.entries()) areas.push({ id: count ? `sea-${count}` : 'sea', kind: 'water', waterLevel: 0, ...part, name: count ? undefined : '青凪湾' })
  }
  const waterAt = regionQuery(areas.filter(a => a.kind === 'water'))
  const continuedWaterAt = regionQuery(fullWaterRegions), continuedSeaAt = regionQuery(fullSeaRegions)
  type RiverSegment = { a: Point; b: Point; widthA: number; widthB: number; zA: number; zB: number; riverId: string }
  const bucketSize = 220
  const bucketsFor = (sections: { id: string; points: Point[]; widths: number[]; levels: number[] }[]) => {
    const buckets = new Map<string, RiverSegment[]>()
    for (const river of sections) for (let i = 1; i < river.points.length; i++) {
      const a = river.points[i - 1]!, b = river.points[i]!, segment: RiverSegment = { a, b, widthA: river.widths[i - 1]!, widthB: river.widths[i]!, zA: river.levels[i - 1]!, zB: river.levels[i]!, riverId: river.id }
      for (let x = Math.floor((Math.min(a.x, b.x) - 320) / bucketSize); x <= Math.floor((Math.max(a.x, b.x) + 320) / bucketSize); x++) for (let y = Math.floor((Math.min(a.y, b.y) - 320) / bucketSize); y <= Math.floor((Math.max(a.y, b.y) + 320) / bucketSize); y++) { const key = `${x},${y}`, bucket = buckets.get(key) ?? []; bucket.push(segment); buckets.set(key, bucket) }
    }
    return buckets
  }
  const riverBuckets = bucketsFor(rivers.map(r => ({ ...r, levels: r.surfaceElevation })))
  const queryRiver = (p: Point, buckets: Map<string, RiverSegment[]>) => {
    let distance = Infinity, width = 0, z = 0, riverId = ''
    let point: Point = p, tangent: Point = { x: 0, y: 1 }
    for (const segment of buckets.get(`${Math.floor(p.x / bucketSize)},${Math.floor(p.y / bucketSize)}`) ?? []) {
      const hit = nearestOnLine(p, segment.a, segment.b)
      if (hit.distance < distance) {
        distance = hit.distance; width = segment.widthA * (1 - hit.t) + segment.widthB * hit.t; z = segment.zA * (1 - hit.t) + segment.zB * hit.t; riverId = segment.riverId
        point = { x: segment.a.x + (segment.b.x - segment.a.x) * hit.t, y: segment.a.y + (segment.b.y - segment.a.y) * hit.t }
        const length = Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y) || 1
        tangent = { x: (segment.b.x - segment.a.x) / length, y: (segment.b.y - segment.a.y) / length }
      }
    }
    return { distance, width, z, bankDistance: distance - width / 2, point, tangent, riverId }
  }
  const nearRiver = (p: Point) => queryRiver(p, riverBuckets)
  const localResolution = 10, localColumns = Math.ceil((w + 2000) / localResolution) + 1, localRows = Math.ceil((h + 2000) / localResolution) + 1
  const localDEM = new Float32Array(localColumns * localRows)
  for (let y = 0; y < localRows; y++) for (let x = 0; x < localColumns; x++) {
    const p = { x: x * localResolution - 1000, y: y * localResolution - 1000 }
    const worldPosition = regional(p)
    localDEM[y * localColumns + x] = coastalSurface(worldPosition)
  }
  const bankStage = mobileSediment ? reworkChannelBed({ ground: localDEM, columns: localColumns, rows: localRows, resolution: localResolution, origin: { x: -1000, y: -1000 }, initial: initialSections, exclude: p => !!lakeAt(p),
    current: rivers.map(river => ({ points: river.points, widths: river.widths, levels: river.surfaceElevation })), abandoned: abandoned.map(lake => ({ points: lake.points, widths: lake.widths, levels: lake.points.map(() => lake.level), lake: true })) }) : null
  // A geometric neck contact alone does not create a disconnected lake. If the
  // actual excavated supply cannot close its plug cells, retain the last open
  // river state. Never draw a closed crescent while its bed is still connected.
  if (allowCutoff && abandoned.length && bankStage && !bankStage.budget.plugsClosed) return buildTerrainModel({ ...input, onTerrainPreview: undefined }, false)
  if (bankStage) for (let y = 0; y < localRows; y++) for (let x = 0; x < localColumns; x++) {
    const p = { x: x * localResolution - 1000, y: y * localResolution - 1000 }, index = y * localColumns + x
    // The cost surface uses water level, while the bed/point-bar DEM and its
    // actual erosion/deposition volumes remain separately inspectable.
    if (!waterAt(p)) localDEM[index] = bankStage.bed[index]!
    else {
      const depression = lakeAt(p), lake = abandoned.find(lake => areas.some(a => (a.id === lake.id || a.id.startsWith(`${lake.id}-part-`)) && inside(p, a.polygon) && !a.holes?.some(h => inside(p, h))))
      if (depression) localDEM[index] = depression.level
      else if (lake) localDEM[index] = lake.level
      else { const river = nearRiver(p); if (river.bankDistance <= 0) localDEM[index] = river.z }
    }
  }
  const elevation = (p: Point) => {
    const depression = lakeAt(p)
    if (depression) return depression.level
    const gx = clamp((p.x + 1000) / localResolution, 0, localColumns - 1.001), gy = clamp((p.y + 1000) / localResolution, 0, localRows - 1.001)
    const x = Math.floor(gx), y = Math.floor(gy), u = gx - x, v = gy - y, i = y * localColumns + x
    return (localDEM[i]! * (1 - u) + localDEM[i + 1]! * u) * (1 - v) + (localDEM[i + localColumns]! * (1 - u) + localDEM[i + localColumns + 1]! * u) * v
  }
  const slope = (p: Point) => Math.hypot(elevation({ x: p.x + 10, y: p.y }) - elevation({ x: p.x - 10, y: p.y }), elevation({ x: p.x, y: p.y + 10 }) - elevation({ x: p.x, y: p.y - 10 })) / 20
  const wetness = (p: Point) => {
    if (waterAt(p)) return 1
    const r = nearRiver(p), z = elevation(p), worldPosition = regional(p), flow = sampleRegional(world, world.accumulatedArea, worldPosition.x, worldPosition.y)
    return clamp((r.distance < 320 ? Math.exp(-Math.max(0, z - r.z) / 3) * Math.exp(-Math.max(0, r.bankDistance) / 180) : 0) * .7 + Math.log1p(flow / 2500) / 15 * .3)
  }
  const landform: TerrainModel['landform'] = p => waterAt(p) ? 'water' : slope(p) > .16 ? 'ridge' : slope(p) > .065 ? 'hillside' : wetness(p) > .5 ? 'valley' : 'terrace'
  const terrainCost = (p: Point) => waterAt(p) ? Infinity : 1 + slope(p) ** 2 * 140 + wetness(p) * .6
  const cultivable = (p: Point) => !waterAt(p) && slope(p) < .06 && landform(p) !== 'ridge'
  const mainRiver = rivers.find(r => r.id === 'river') ?? rivers.reduce<TerrainRiver | undefined>((best, river) => !best || river.drainageArea.at(-1)! > best.drainageArea.at(-1)! ? river : best, undefined)
  const shoreEdges = input.terrain === 'coast' && input.type === 'port' ? areas.filter(a => a.id.startsWith('sea')).flatMap(a => [a.polygon, ...(a.holes ?? [])].flatMap(ring => ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length]! })))) : []
  const shoreDistance = (p: Point) => {
    let nearest = Infinity
    for (const { a, b } of shoreEdges) {
      const dx = b.x - a.x, dy = b.y - a.y, t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))
      nearest = Math.min(nearest, Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t))
    }
    return nearest
  }
  const desired: Point = input.type === 'onsen' && mainRiver ? { x: mainRiver.points[Math.floor(mainRiver.points.length * .5)]!.x - 250, y: h * .54 } : input.type === 'port' ? { x: w * .50, y: h * .58 } : input.type === 'temple' ? { x: w * .31, y: h * .36 } : { x: w * .45, y: h * .48 }
  let cityOrigin: Point = { x: w * .45, y: h * .48 }, originScore = Infinity
  const coreRadius = input.type === 'castle' || input.type === 'temple' ? 270 : 90
  for (let y = 380; y < h - 330; y += 35) for (let x = 380; x < w - 330; x += 35) {
    const p = { x, y }, r = nearRiver(p), gradient = slope(p)
    if (waterAt(p) || gradient > (input.type === 'onsen' ? .12 : .055) || r.bankDistance < coreRadius) continue
    if ([0, 1, 2, 3, 4, 5, 6, 7].some(i => waterAt({ x: x + Math.cos(i * Math.PI / 4) * coreRadius, y: y + Math.sin(i * Math.PI / 4) * coreRadius }))) continue
    const bankPreference = input.type === 'port' ? Math.abs((shoreEdges.length ? shoreDistance(p) : r.bankDistance) - 180) * .8 : input.type === 'onsen' ? Math.abs(r.bankDistance - 220) * .25 : 0
    const cost = Math.hypot(x - desired.x, y - desired.y) + gradient * 1200 + wetness(p) * 140 + bankPreference - landSupply(indexAt(regional(p)), 500) * 500 * urbanScale
    if (cost < originScore) { originScore = cost; cityOrigin = p }
  }
  const bridgeCandidates: TerrainModel['bridgeCandidates'] = []
  for (const river of rivers) for (let i = 3; i < river.points.length - 3; i += 3) {
    const p = river.points[i]!, a = river.points[i - 3]!, b = river.points[i + 3]!, length = Math.hypot(b.x - a.x, b.y - a.y), width = river.widths[i]!
    if (p.x < 100 || p.x > w - 100 || p.y < 100 || p.y > h - 100 || width < 1.5 || width > 110 || !waterAt(p) || length < 1) continue
    const nx = -(b.y - a.y) / length, ny = (b.x - a.x) / length, span = width / 2 + 35
    const bankA = { x: p.x + nx * span, y: p.y + ny * span }, bankB = { x: p.x - nx * span, y: p.y - ny * span }
    if (waterAt(bankA) || waterAt(bankB) || slope(bankA) > .12 || slope(bankB) > .12) continue
    const cost = width + Math.abs(elevation(bankA) - elevation(bankB)) * 3 + (slope(bankA) + slope(bankB)) * 200 + Math.abs(p.x - w * .67) * .03
    bridgeCandidates.push({ point: p, bankA, bankB, width, cost, riverId: river.id })
  }
  bridgeCandidates.sort((a, b) => a.cost - b.cost)
  // A globally cheapest shortlist would select only narrow tributaries and omit
  // the main river, making a feasible cross-valley road impossible. Survey each
  // connected channel separately and retain several spatially distinct corridors.
  const selected: TerrainModel['bridgeCandidates'] = []
  for (const river of [...rivers].sort((a, b) => Number(b.id === 'river') - Number(a.id === 'river'))) {
    const perRiver: TerrainModel['bridgeCandidates'] = []
    const options = bridgeCandidates.filter(c => c.riverId === river.id).sort((a, b) => a.cost + Math.abs(a.point.y - h * .63) * .035 - b.cost - Math.abs(b.point.y - h * .63) * .035)
    for (const candidate of options) if (perRiver.every(bridge => Math.hypot(bridge.point.x - candidate.point.x, bridge.point.y - candidate.point.y) > 600)) {
      perRiver.push(candidate)
      if (perRiver.length === (river.id === 'river' ? 3 : 2)) break
    }
    selected.push(...perRiver)
  }
  const bridgeSites = selected.filter(c => c.riverId === 'river').map(c => c.point)
  for (const candidate of selected) if (bridgeSites.length < 3 && bridgeSites.every(p => Math.hypot(p.x - candidate.point.x, p.y - candidate.point.y) > 650)) bridgeSites.push(candidate.point)
  if (input.forest > 0) {
    const forest = woodlandContours({ width: w, height: h, forest: input.forest, origin: cityOrigin, coreRadius, elevation, slope,
      bankDistance: p => nearRiver(p).bankDistance, variation: p => (noise(seed, p.x / 240, p.y / 240) - .5) * 14, water: areas.filter(area => area.kind === 'water') })
    for (const [i, region] of forest.entries()) areas.push({ id: `forest-${i}`, kind: 'forest', ...region, name: i === 0 ? '北山丘陵' : i === 1 ? '西ノ森' : undefined })
  }
  const channelAt: TerrainModel['channelAt'] = p => { const r = nearRiver(p); return Number.isFinite(r.distance) ? { point: r.point, tangent: r.tangent, bankDistance: r.bankDistance, width: r.width, surfaceElevation: r.z, riverId: r.riverId } : null }
  const bounds = { minX: -500, minY: -500, maxX: w + 500, maxY: h + 500 }
  const contains = (p: Point) => { const q = regional(p); return p.x >= bounds.minX && p.x <= bounds.maxX && p.y >= bounds.minY && p.y <= bounds.maxY && q.x >= 20 && q.y >= 20 && q.x <= world.extent - 20 && q.y <= world.extent - 20 }
  const continuationTerrain = { bounds, contains, elevation: (p: Point) => { if (!contains(p)) throw new RangeError('Terrain continuation query exceeds the surveyed 500m margin'); return elevation(p) }, slope: (p: Point) => { if (!contains(p)) throw new RangeError('Terrain continuation query exceeds the surveyed 500m margin'); return slope(p) }, waterAt: (p: Point) => { if (!contains(p)) throw new RangeError('Terrain continuation query exceeds the surveyed 500m margin'); if (p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h) return waterAt(p); return continuedWaterAt(p) }, seaAt: (p: Point) => { if (!contains(p)) throw new RangeError('Terrain continuation query exceeds the surveyed 500m margin'); return continuedSeaAt(p) } }
  return { areas, elevation, slope, waterAt, bridgeSites, cityOrigin, landform, wetness, terrainCost, cultivable, bankDistance: p => nearRiver(p).bankDistance, channelAt, rivers, bridgeCandidates: selected, continuationTerrain, standingWaterAt: p => { const lake = lakeAt(p); return lake ? { id: lake.id, level: lake.level, kind: lake.kind } : null }, hydrology: { ...world, cropOrigin, frame: { worldAnchor: anchor, localAnchor, angle, mirrored }, localResolution, localDEM, localColumns, localRows, channelEvolution,
    bankSediment: bankStage?.budget, localInitialBedDEM: bankStage?.initialBed, localBedDEM: bankStage?.bed, localBankDeposition: bankStage?.deposition, oxbows: abandoned.map(lake => ({ id: lake.id, sourceRiverId: lake.sourceRiverId, formedAtStep: lake.formedAtStep })), depressionLakes: visibleLakes } }
}
