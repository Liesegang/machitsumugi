import type { Area, Point, Road } from './types'
export { planRailBranch } from './railway-branch.ts'
import { planRailBranch } from './railway-branch.ts'
import { railwayCorridors } from './railway-corridor.ts'
import type { RailwaySettlement } from './railway-corridor.ts'
import { railwayRoadCost } from './railway-road-cost.ts'

interface RailwayTerrain {
  areas: Area[]
  elevation(point: Point): number
  waterAt(point: Point): boolean
  slope?(point: Point): number
  channelAt?(point: Point): { bankDistance: number; width: number } | null
}
export interface RailwayPlanInput { width: number; height: number; seed: string; origin: Point; terrain: RailwayTerrain; core?: Point[] | null; allowTerminus?: boolean; settlements?: RailwaySettlement[]; inheritedRoads?: Road[] }
export interface RailwayStructure { kind: 'bridge' | 'cutting' | 'embankment'; from: Point; to: Point; maxHeight: number; length: number }
export interface RailwayPlan {
  points: Point[]
  /** Track elevation is distinct from the unmodified terrain DEM, in metres. */
  elevations: number[]
  structures: RailwayStructure[]
  terminus?: Point
  stationTargets?: Point[]
  diagnostics: { maxGroundGrade: number; maxTrackGrade: number; maxCurvature: number; minCurveRadius: number; maxEarthwork: number; bridgeLength: number; maxBridgeLength: number }
}

// Fictional regional-rail design assumptions, not a jurisdictional railway code.
const MAX_GRADE = .035, MIN_RADIUS = 150, MAX_EARTHWORK = 12, MAX_BRIDGE = 180
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
function inside(p: Point, polygon: Point[]) {
  let hit = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}
function segmentDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y, t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1)
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t)
}

/** Fit the actual sampled bridge/earthwork profile, including between DP rows. */
function fitProfile(points: Point[], ground: number[], wet: boolean[], preferred: number[]) {
  const lower = ground.map((z, i) => z + (wet[i] ? 4.2 : -11)), upper = ground.map((z, i) => z + (wet[i] ? 17 : 11))
  for (let i = 1; i < points.length; i++) {
    const rise = (points[i]!.y - points[i - 1]!.y) * MAX_GRADE
    lower[i] = Math.max(lower[i]!, lower[i - 1]! - rise)
    upper[i] = Math.min(upper[i]!, upper[i - 1]! + rise)
    if (lower[i]! > upper[i]!) return null
  }
  const result = [...preferred]
  result[result.length - 1] = clamp(result.at(-1)!, lower.at(-1)!, upper.at(-1)!)
  for (let i = points.length - 2; i >= 0; i--) {
    const rise = (points[i + 1]!.y - points[i]!.y) * MAX_GRADE
    result[i] = clamp(preferred[i]!, Math.max(lower[i]!, result[i + 1]! - rise), Math.min(upper[i]!, result[i + 1]! + rise))
  }
  // A compact vertical transition curve preserves the conservative dy grade
  // bound. The .7m margin in fit constraints absorbs this 20m smoothing window.
  return result.map((_, i) => (result[Math.max(0, i - 2)]! + result[Math.max(0, i - 1)]! * 2 + result[i]! * 3 + result[Math.min(result.length - 1, i + 1)]! * 2 + result[Math.min(result.length - 1, i + 2)]!) / 9)
}

/**
 * Global north/south alignment, not independent best-x columns. The DP state is
 * (position, heading, track elevation); grade and heading transitions are hard
 * constraints. A C2 spline removes raster corners, then the complete horizontal
 * and vertical alignment is resampled and physically validated. Cuts/fills and
 * river decks are returned explicitly; the terrain is never flattened to cheat.
 */
function planNorthSouth(input: RailwayPlanInput & { terminalTarget?: Point; startTarget?: Point; stationTarget?: Point; corridor?: Point[]; inBounds?: (p: Point) => boolean }): RailwayPlan | null {
  const { width, height, origin, terrain, core } = input
  const streetCost = railwayRoadCost(input.inheritedRoads ?? [])
  const dx = 40, rows = Math.ceil(height / 100) + 1, dy = height / (rows - 1), margin = input.corridor ? 0 : Math.min(200, width * .06)
  const columns = Math.floor((width - margin * 2) / dx) + 1, headings = 5, offsets = 33, elevationStep = .5, planningEarthwork = 8
  if (columns < 3 || rows < 3) return null
  const stride = columns * headings * offsets, count = columns * rows
  const ground = new Float32Array(count), bases = new Float32Array(count), wet = new Uint8Array(count), blocked = new Uint8Array(count), nodeCost = new Float32Array(count)
  const sea = terrain.areas.filter(a => a.kind === 'water' && a.id.startsWith('sea')), forest = terrain.areas.filter(a => a.kind === 'forest')
  const reserved = terrain.areas.filter(a => a.id === 'historic-core' || a.id.startsWith('moat-'))
  const bounds = (a: Area) => ({ area: a, x0: Math.min(...a.polygon.map(p => p.x)), x1: Math.max(...a.polygon.map(p => p.x)), y0: Math.min(...a.polygon.map(p => p.y)), y1: Math.max(...a.polygon.map(p => p.y)) })
  const seas = sea.map(bounds), woods = forest.map(bounds)
  const reserves = reserved.map(bounds)
  const within = (p: Point, regions: ReturnType<typeof bounds>[]) => regions.some(r => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1 && inside(p, r.area.polygon) && !(r.area.holes ?? []).some(hole => inside(p, hole)))
  const nearCore = (p: Point, pad: number) => !!core && (inside(p, core) || core.some((a, i) => segmentDistance(p, a, core[(i + 1) % core.length]!) < pad))
  const preferred = clamp(origin.x - 650, margin, width - margin)
  const point = (col: number, row: number): Point => ({ x: margin + col * dx, y: row * dy })
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    const i = row * columns + col, p = point(col, row), z = terrain.elevation(p)
    ground[i] = z; bases[i] = Math.ceil((z - planningEarthwork) / elevationStep) * elevationStep
    blocked[i] = Number(within(p, seas) || within(p, reserves) || nearCore(p, 45) || input.inBounds && !input.inBounds(p) || input.stationTarget && Math.abs(p.y - input.stationTarget.y) <= dy * .51 && Math.abs(p.x - input.stationTarget.x) > 145)
    wet[i] = Number(terrain.waterAt(p))
    const woodland = within(p, woods) ? .55 : 0
    const guideDistance = input.corridor ? Math.min(...input.corridor.slice(1).map((b, j) => segmentDistance(p, input.corridor![j]!, b))) : Math.abs(p.x - preferred)
    nodeCost[i] = 1 + guideDistance * (input.corridor ? .007 : .0012) + Math.max(0, z) * .001 + woodland + streetCost.pointCost(p)
  }
  const parents = new Int32Array(rows * stride).fill(-1)
  let previous = new Float64Array(stride).fill(Infinity)
  const state = (col: number, heading: number, level: number) => (col * headings + heading) * offsets + level
  for (let col = 0; col < columns; col++) if (!blocked[col]) for (let level = 0; level < offsets; level++) {
    if (input.startTarget && distance(point(col, 0), input.startTarget) > dx * .49) continue
    const z = bases[col]! + level * elevationStep
    if (Math.abs(z - ground[col]!) > planningEarthwork || wet[col] && z < ground[col]! + 4) continue
    previous[state(col, 2, level)] = nodeCost[col]! * dy + (z - ground[col]!) ** 2 * 10
  }
  // Edge geometry is checked once, independently of vertical-profile states.
  const edgeCost = new Float64Array(columns * headings), edgeDeck = new Float64Array(columns * headings)
  for (let row = 1; row < rows; row++) {
    edgeCost.fill(Infinity)
    edgeDeck.fill(-Infinity)
    for (let col = 0; col < columns; col++) for (let heading = 0; heading < headings; heading++) {
      const previousCol = col - (heading - 2)
      if (previousCol < 0 || previousCol >= columns) continue
      const i = row * columns + col, before = (row - 1) * columns + previousCol
      if (blocked[i] || blocked[before]) continue
      const a = point(previousCol, row - 1), b = point(col, row), length = distance(a, b)
      let waterCount = wet[i]! + wet[before]!, invalid = false
      let deck = Math.max(wet[i] ? ground[i]! + 6 : -Infinity, wet[before] ? ground[before]! + 6 : -Infinity)
      for (const t of [.25, .5, .75]) {
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
        if (within(p, seas) || within(p, reserves) || nearCore(p, 38) || input.inBounds && !input.inBounds(p)) { invalid = true; break }
        if (terrain.waterAt(p)) { waterCount++; deck = Math.max(deck, terrain.elevation(p) + 6) }
      }
      if (invalid) continue
      const grade = Math.abs(ground[i]! - ground[before]!) / length
      edgeDeck[col * headings + heading] = deck
      edgeCost[col * headings + heading] = length * (nodeCost[i]! + nodeCost[before]!) * .5 + Math.max(0, grade - .02) ** 2 * length * 1000 + waterCount * 100 + streetCost.edgeCost(a, b)
    }
    const current = new Float64Array(stride).fill(Infinity), maxLevelDelta = MAX_GRADE * dy / elevationStep
    for (let col = 0; col < columns; col++) for (let heading = 0; heading < headings; heading++) {
      const routeCost = edgeCost[col * headings + heading]!
      if (!Number.isFinite(routeCost)) continue
      const previousCol = col - (heading - 2), i = row * columns + col, before = (row - 1) * columns + previousCol
      for (let level = 0; level < offsets; level++) {
        const z = bases[i]! + level * elevationStep, earthwork = z - ground[i]!
        const deck = edgeDeck[col * headings + heading]!
        if (Math.abs(earthwork) > planningEarthwork || wet[i] && z < ground[i]! + 4 || z < deck) continue
        const middle = (z - bases[before]!) / elevationStep, first = Math.max(0, Math.ceil(middle - maxLevelDelta - 1e-7)), last = Math.min(offsets - 1, Math.floor(middle + maxLevelDelta + 1e-7))
        const target = state(col, heading, level), workCost = earthwork ** 2 * dy * .055
        let best = Infinity, bestParent = -1
        for (let oldHeading = Math.max(0, heading - 1); oldHeading <= Math.min(headings - 1, heading + 1); oldHeading++) {
          const start = state(previousCol, oldHeading, 0), turnCost = Math.abs(heading - oldHeading) * 18
          for (let oldLevel = first; oldLevel <= last; oldLevel++) {
            if (bases[before]! + oldLevel * elevationStep < deck) continue
            const previousState = start + oldLevel, cost = previous[previousState]! + routeCost + workCost + turnCost
            if (cost < best) { best = cost; bestParent = previousState }
          }
        }
        current[target] = best; parents[row * stride + target] = bestParent
      }
    }
    previous = current
  }
  const endings: { state: number; cost: number; col: number }[] = []
  for (let col = 0; col < columns; col++) {
    let best = Infinity, endState = -1
    for (let heading = 0; heading < headings; heading++) for (let level = 0; level < offsets; level++) {
      const id = state(col, heading, level)
      if (previous[id]! < best) { best = previous[id]!; endState = id }
    }
    if (endState >= 0) {
      const endpoint = point(col, rows - 1)
      if (input.terminalTarget && distance(endpoint, input.terminalTarget) > (input.corridor ? dx * .49 : 650)) continue
      endings.push({ state: endState, cost: best + (input.terminalTarget ? distance(endpoint, input.terminalTarget) * 3 : 0), col })
    }
  }
  endings.sort((a, b) => a.cost - b.cost)
  const attempted: number[] = []
  for (const ending of endings) {
    if (attempted.some(col => Math.abs(col - ending.col) < 2)) continue
    attempted.push(ending.col)
    const controls: { x: number; y: number; z: number }[] = []
    let id = ending.state
    for (let row = rows - 1; row >= 0; row--) {
      const level = id % offsets, col = Math.floor(id / offsets / headings)
      controls.push({ ...point(col, row), z: bases[row * columns + col]! + level * elevationStep })
      id = parents[row * stride + id]!
    }
    controls.reverse()
    const sample = (i: number) => i < 0 ? { x: controls[0]!.x * 2 - controls[1]!.x, z: controls[0]!.z * 2 - controls[1]!.z } : i >= controls.length ? { x: controls.at(-1)!.x * 2 - controls.at(-2)!.x, z: controls.at(-1)!.z * 2 - controls.at(-2)!.z } : controls[i]!
    const points: Point[] = [], elevations: number[] = []
    for (let segment = 0; segment < controls.length - 1; segment++) {
      const steps = Math.ceil(dy / 10)
      for (let j = 0; j <= steps; j++) {
        if (segment && !j) continue
        const t = j / steps, a = sample(segment - 1), b = sample(segment), c = sample(segment + 1), d = sample(segment + 2)
        const w0 = (1 - t) ** 3 / 6, w1 = (3 * t ** 3 - 6 * t ** 2 + 4) / 6, w2 = (-3 * t ** 3 + 3 * t ** 2 + 3 * t + 1) / 6, w3 = t ** 3 / 6
        points.push({ x: a.x * w0 + b.x * w1 + c.x * w2 + d.x * w3, y: (segment + t) * dy })
        elevations.push(a.z * w0 + b.z * w1 + c.z * w2 + d.z * w3)
      }
    }
    const structures: RailwayStructure[] = []
    let invalid = false, maxGroundGrade = 0, maxTrackGrade = 0, maxCurvature = 0, maxEarthwork = 0, bridgeLength = 0, maxBridgeLength = 0
    const groundSamples = points.map(p => terrain.elevation(p)), water = points.map(p => terrain.waterAt(p))
    // Fine runoff-fed channels can lie wholly between 10m track samples. Probe
    // each edge at metre scale and conservatively include both bank samples in
    // the bridge profile. A narrow stream must not become an invisible crossing.
    for (let i = 1; i < points.length && !invalid; i++) {
      const a = points[i - 1]!, b = points[i]!, samples = Math.max(1, Math.ceil(distance(a, b)))
      for (let j = 1; j < samples; j++) {
        const t = j / samples, p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
        if (within(p, seas) || within(p, reserves) || nearCore(p, 12)) { invalid = true; break }
        if (terrain.waterAt(p)) water[i - 1] = water[i] = true
      }
    }
    if (invalid) continue
    const fitted = fitProfile(points, groundSamples, water, elevations)
    if (!fitted) continue
    for (let i = 0; i < fitted.length; i++) elevations[i] = fitted[i]!
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!, earthwork = elevations[i]! - groundSamples[i]!
      if (within(p, seas) || within(p, reserves) || nearCore(p, 12) || input.inBounds && !input.inBounds(p) || water[i] && earthwork < 3 || !water[i] && Math.abs(earthwork) > MAX_EARTHWORK) { invalid = true; break }
      if (!water[i]) maxEarthwork = Math.max(maxEarthwork, Math.abs(earthwork))
      if (i) {
        const length = distance(points[i - 1]!, p)
        maxGroundGrade = Math.max(maxGroundGrade, Math.abs(groundSamples[i]! - groundSamples[i - 1]!) / length)
        maxTrackGrade = Math.max(maxTrackGrade, Math.abs(elevations[i]! - elevations[i - 1]!) / length)
      }
      if (i && i + 1 < points.length) {
        const a = points[i - 1]!, b = points[i + 1]!, cross = Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x))
        maxCurvature = Math.max(maxCurvature, 2 * cross / (distance(a, p) * distance(p, b) * distance(a, b) || 1))
      }
    }
    if (invalid || maxTrackGrade > MAX_GRADE + 1e-6 || maxCurvature > 1 / MIN_RADIUS + 1e-6) continue
    const kinds = points.map((_, i): RailwayStructure['kind'] | null => water[i] ? 'bridge' : elevations[i]! - groundSamples[i]! > 1.5 ? 'embankment' : groundSamples[i]! - elevations[i]! > 1.5 ? 'cutting' : null)
    for (let i = 0; i < kinds.length;) {
      const kind = kinds[i], first = i
      while (i + 1 < kinds.length && kinds[i + 1] === kind) i++
      if (kind) {
        const from = Math.max(0, first - 1), to = Math.min(points.length - 1, i + 1)
        let length = 0, maxHeight = 0
        for (let j = from; j <= to; j++) { if (j > from) length += distance(points[j - 1]!, points[j]!); maxHeight = Math.max(maxHeight, Math.abs(elevations[j]! - groundSamples[j]!)) }
        if (kind === 'bridge') {
          if (first === 0 || i === kinds.length - 1 || length > MAX_BRIDGE) { invalid = true; break }
          bridgeLength += length; maxBridgeLength = Math.max(maxBridgeLength, length)
        }
        structures.push({ kind, from: points[from]!, to: points[to]!, maxHeight, length })
      }
      i++
    }
    if (!invalid) return { points, elevations, structures, diagnostics: { maxGroundGrade, maxTrackGrade, maxCurvature, minCurveRadius: maxCurvature ? 1 / maxCurvature : Infinity, maxEarthwork, bridgeLength, maxBridgeLength } }
    if (attempted.length >= 12) break
  }
  return null
}

/** A regional alignment may enter a coastal town east/west rather than cross its bay. */
export function planRailway(input: RailwayPlanInput): RailwayPlan | null {
  if (input.settlements?.length || input.terrain.channelAt) {
    const corridors = railwayCorridors({ ...input, settlements: input.settlements?.length ? input.settlements : [{ point: input.origin, demand: 1 }] })
    for (const corridor of corridors) {
      const length = distance(corridor.from, corridor.to)
      if (length < 1200) continue
      const axis = { x: (corridor.to.x - corridor.from.x) / length, y: (corridor.to.y - corridor.from.y) / length }, normal = { x: axis.y, y: -axis.x }
      const projection = (p: Point) => (p.x - corridor.from.x) * normal.x + (p.y - corridor.from.y) * normal.y
      const corners = [{ x: 0, y: 0 }, { x: input.width, y: 0 }, { x: 0, y: input.height }, { x: input.width, y: input.height }].map(projection)
      const shift = Math.ceil((40 - Math.min(...corners)) / 40) * 40, frameWidth = Math.ceil((Math.max(...corners) - Math.min(...corners) + 80) / 40) * 40
      const forward = (p: Point): Point => ({ x: shift + projection(p), y: (p.x - corridor.from.x) * axis.x + (p.y - corridor.from.y) * axis.y })
      const backward = (p: Point): Point => ({ x: corridor.from.x + (p.x - shift) * normal.x + p.y * axis.x, y: corridor.from.y + (p.x - shift) * normal.y + p.y * axis.y })
      const result = planNorthSouth({ ...input, width: frameWidth, height: length, origin: forward(input.origin), core: input.core?.map(forward), inheritedRoads: input.inheritedRoads?.map(road => ({ ...road, points: road.points.map(forward) })), startTarget: { x: shift, y: 0 }, terminalTarget: { x: shift, y: length }, stationTarget: forward(corridor.station), corridor: corridor.points.map(forward), inBounds: p => { const q = backward(p); return q.x >= -1e-5 && q.x <= input.width + 1e-5 && q.y >= -1e-5 && q.y <= input.height + 1e-5 }, terrain: { areas: input.terrain.areas.map(a => ({ ...a, polygon: a.polygon.map(forward), holes: a.holes?.map(h => h.map(forward)) })), elevation: p => input.terrain.elevation(backward(p)), waterAt: p => input.terrain.waterAt(backward(p)), slope: p => input.terrain.slope?.(backward(p)) ?? 0 } })
      if (result) { const points = result.points.map(backward); return { ...result, points, stationTargets: [corridor.station], ...(corridor.terminus ? { terminus: points.at(-1)! } : {}), structures: result.structures.map(s => ({ ...s, from: backward(s.from), to: backward(s.to) })) } }
    }
    if (input.allowTerminus) for (const corridor of corridors.filter(c => c.terminus)) {
      const span = distance(corridor.from, corridor.station)
      if (span < 1450) continue
      const direction = { x: (corridor.station.x - corridor.from.x) / span, y: (corridor.station.y - corridor.from.y) / span }
      const start = { x: corridor.from.x + direction.x * 40, y: corridor.from.y + direction.y * 40 }, trackLevel = input.terrain.elevation(start)
      let validApproach = true, maxEarthwork = 0, maxGroundGrade = 0
      for (let j = 0; j <= 8; j++) {
        const p = { x: corridor.from.x + direction.x * j * 5, y: corridor.from.y + direction.y * j * 5 }, earthwork = Math.abs(trackLevel - input.terrain.elevation(p))
        if (input.terrain.waterAt(p) || earthwork > 11) validApproach = false
        maxEarthwork = Math.max(maxEarthwork, earthwork)
        if (j) { const before = { x: p.x - direction.x * 5, y: p.y - direction.y * 5 }; maxGroundGrade = Math.max(maxGroundGrade, Math.abs(input.terrain.elevation(p) - input.terrain.elevation(before)) / 5) }
      }
      if (!validApproach) continue
      const plan = planRailBranch({ width: input.width, height: input.height, terrain: input.terrain, core: input.core, inheritedRoads: input.inheritedRoads, start: { point: start, heading: Math.atan2(direction.y, direction.x), elevation: trackLevel, grade: 0 }, goal: corridor.station, maxNodes: 24000 })
      if (!plan || plan.length + 40 < 1500) continue
      const points = [corridor.from, ...plan.points]
      return { ...plan, points, elevations: [trackLevel, ...plan.elevations], stationTargets: [points.at(-1)!], terminus: points.at(-1)!, diagnostics: { ...plan.diagnostics, maxEarthwork: Math.max(maxEarthwork, plan.diagnostics.maxEarthwork), maxGroundGrade: Math.max(maxGroundGrade, plan.diagnostics.maxGroundGrade) } }
    }
    return null
  }
  const preferred = planNorthSouth(input)
  if (preferred) return preferred
  if (!input.allowTerminus) return null
  const toWorld = (p: Point): Point => ({ x: p.y, y: input.height - p.x })
  const toPlanner = (p: Point): Point => ({ x: input.height - p.y, y: p.x })
  const crosswise = planNorthSouth({ ...input, width: input.height, height: input.width, origin: toPlanner(input.origin), core: input.core?.map(toPlanner), inheritedRoads: input.inheritedRoads?.map(road => ({ ...road, points: road.points.map(toPlanner) })), terrain: {
    areas: input.terrain.areas.map(a => ({ ...a, polygon: a.polygon.map(toPlanner), holes: a.holes?.map(hole => hole.map(toPlanner)) })),
    elevation: p => input.terrain.elevation(toWorld(p)), waterAt: p => input.terrain.waterAt(toWorld(p)), slope: p => input.terrain.slope?.(toWorld(p)) ?? 0,
  } })
  if (crosswise) return { ...crosswise, points: crosswise.points.map(toWorld), structures: crosswise.structures.map(s => ({ ...s, from: toWorld(s.from), to: toWorld(s.to) })) }
  // On a ria coast, a branch line can legitimately end beside the town instead
  // of crossing the bay to satisfy an artificial viewport-spanning contract.
  // Try inland boundary approaches, retaining every grade/curve/earthwork check.
  const frames = [
    { width: input.width, height: input.height, forward: (p: Point) => p, backward: (p: Point) => p },
    { width: input.height, height: input.width, forward: toPlanner, backward: toWorld },
    { width: input.width, height: input.height, forward: (p: Point) => ({ x: input.width - p.x, y: input.height - p.y }), backward: (p: Point) => ({ x: input.width - p.x, y: input.height - p.y }) },
  ]
  for (const frame of frames) {
    const center = frame.forward(input.origin), terminalY = Math.min(frame.height - 120, Math.max(1500, center.y + 240))
    if (terminalY < 1500 || frame.height < 1700) continue
    const terrain = { areas: input.terrain.areas.map(a => ({ ...a, polygon: a.polygon.map(frame.forward), holes: a.holes?.map(hole => hole.map(frame.forward)) })), elevation: (p: Point) => input.terrain.elevation(frame.backward(p)), waterAt: (p: Point) => input.terrain.waterAt(frame.backward(p)), slope: (p: Point) => input.terrain.slope?.(frame.backward(p)) ?? 0 }
    const branch = planNorthSouth({ ...input, width: frame.width, height: terminalY, origin: center, core: input.core?.map(frame.forward), inheritedRoads: input.inheritedRoads?.map(road => ({ ...road, points: road.points.map(frame.forward) })), terrain, terminalTarget: { x: center.x, y: terminalY } })
    if (!branch) continue
    const points = branch.points.map(frame.backward)
    return { ...branch, points, terminus: points.at(-1)!, structures: branch.structures.map(s => ({ ...s, from: frame.backward(s.from), to: frame.backward(s.to) })) }
  }
  return null
}
