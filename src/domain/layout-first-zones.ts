import type { CityConfig, Point, Station } from './types'
import type { TerrainModel } from './terrain'
import type { LayoutFirstZone } from './layout-first-types'
import { distance, distanceToSegment, pointInRegion, seededRandom } from './geometry'
import { regionQuery } from './region-query'

export interface LayoutZoneInput {
  config: CityConfig; width: number; height: number
  terrain: Pick<TerrainModel, 'cityOrigin' | 'elevation' | 'slope' | 'waterAt'> & {
    areas?: TerrainModel['areas']
    channelAt?: TerrainModel['channelAt']
    standingWaterAt?: TerrainModel['standingWaterAt']
    seaAt?: (point: Point) => boolean
    continuationTerrain?: Pick<NonNullable<TerrainModel['continuationTerrain']>, 'seaAt'>
  }
}
export interface LayoutZoneResult { center: Point; zones: LayoutFirstZone[] }

/** Demand can continue over an identified tributary; it never certifies a
 * crossing or changes the physical water mask. Missing natural metadata keeps
 * the conservative first-water stop. Sea, lakes and the main river remain
 * barriers even where the nearest-channel query happens to return a branch. */
function demandRaySurvey({ terrain, width, height }: LayoutZoneInput) {
  const branches = new Map((terrain.areas ?? []).filter(area => area.kind === 'water' && area.id.startsWith('river-branch-')).map(area => [area.id, regionQuery([area])]))
  const blockedWater = regionQuery((terrain.areas ?? []).filter(area => area.kind === 'water' && !area.id.startsWith('river-branch-')))
  const inBounds = (point: Point) => point.x >= 12 && point.y >= 12 && point.x <= width - 12 && point.y <= height - 12
  const channel = (point: Point) => {
    if (blockedWater(point) || terrain.seaAt?.(point) || terrain.continuationTerrain?.seaAt(point) || terrain.standingWaterAt?.(point)) return null
    const hit = terrain.channelAt?.(point)
    return hit && hit.width > 0 && hit.width <= 45 && branches.get(hit.riverId)?.(point) ? hit : null
  }
  return (origin: Point, theta: number, maximum: number, start: number, step: number, grade: number, allowTributaries: boolean, inEnvelope: (point: Point, reach: number) => boolean = () => true) => {
    const at = (reach: number): Point => ({ x: origin.x + Math.cos(theta) * reach, y: origin.y + Math.sin(theta) * reach })
    let lastDry = 0, crossings = 0
    for (let reach = start; reach <= maximum; reach += step) {
      const point = at(reach)
      if (!inBounds(point) || terrain.slope(point) > grade || !inEnvelope(point, reach)) break
      if (!terrain.waterAt(point)) { lastDry = reach; continue }
      const first = allowTributaries && crossings < 2 ? channel(point) : null
      if (!first) break
      // Locate the entry inside this existing dry-to-wet interval, then allow
      // at most120m along the ray. Width metadata alone cannot hide broad water.
      let low = lastDry, entry = reach
      for (let i = 0; i < 7; i++) { const middle = (low + entry) / 2; if (terrain.waterAt(at(middle))) entry = middle; else low = middle }
      let landing = 0
      for (let sample = reach + 5; sample <= Math.min(maximum, entry + 120); sample += 5) {
        const p = at(sample)
        if (!inBounds(p) || terrain.slope(p) > grade || !inEnvelope(p, sample)) break
        if (!terrain.waterAt(p)) { landing = sample; break }
        const hit = channel(p)
        if (!hit || hit.riverId !== first.riverId) break
      }
      if (!landing) break
      // A short sandbar or a thin peninsula is insufficient hinterland. This
      // is only a bounded dry-ground check; roads still need their own survey.
      const backing = [0, 30, 60].flatMap(along => [-20, 0, 20].map(side => {
        const p = at(landing + along)
        return { x: p.x - Math.sin(theta) * side, y: p.y + Math.cos(theta) * side }
      }))
      if (backing.some(p => !inBounds(p) || terrain.waterAt(p) || terrain.slope(p) > grade)) break
      lastDry = landing; reach = landing; crossings++
    }
    return lastDry
  }
}

/** Only acquired stations can acquire an opening-era street neighbourhood.
 * Its public gate, surrounding dry ground and existing whole-city envelope
 * constrain the survey. This is an access brief, not an apartment-zone stamp. */
export function planLayoutFirstStationZones(input: LayoutZoneInput & { zones: readonly LayoutFirstZone[]; stations: readonly Station[]; gates: readonly { id: string; point: Point }[] }): LayoutFirstZone[] {
  const survey = demandRaySurvey(input)
  return input.stations.flatMap(station => {
    const gate = input.gates.find(target => target.id === station.id.replace('station-', 'station-access-'))?.point
    if (!gate || input.terrain.waterAt(gate) || input.terrain.slope(gate) > .13) return []
    const parent = input.zones.filter(zone => zone.kind !== 'industrial' && zone.kind !== 'rural').slice().sort((a, b) => distance(gate, a.center) / a.radius - distance(gate, b.center) / b.radius)[0]
    if (!parent) return []
    const radius = Math.max(170, Math.min(input.config.settlement === 'village' ? 210 : 460, parent.radius * .65))
    const margin = Math.min(150, parent.radius * .2)
    const inEnvelope = (point: Point) => pointInRegion(point, parent) || parent.polygon.some((a, i) => distanceToSegment(point, a, parent.polygon[(i + 1) % parent.polygon.length]!) <= margin)
    const polygon = Array.from({ length: 24 }, (_, index) => {
      const theta = index * Math.PI / 12
      const reach = survey(gate, theta, radius, 15, 20, .13, input.config.settlement === 'metropolis' || input.config.settlement === 'regional-city', (point, sample) => sample <= 55 || inEnvelope(point))
      return { x: gate.x + Math.cos(theta) * reach, y: gate.y + Math.sin(theta) * reach }
    })
    const maximumFloors = Math.max(parent.maximumFloors, input.config.settlement === 'metropolis' ? 6 : input.config.settlement === 'village' ? 2 : 4)
    return [{ id: `layout-station-context-${station.id}`, center: gate, polygon, radius, kind: 'station' as const, builtYear: station.builtYear ?? 1900, density: parent.density, maximumFloors, angle: parent.angle }]
  })
}

/** Survey the entire crop before streets and titles exist. The geological
 * origin is a candidate, not an inherited town. Select a centre with a broad
 * buildable hinterland, then compose neighbourhoods, employment and fringe.
 * Railway demand is planned here; station intensity requires actual rail and
 * street access and is deliberately absent from this pre-rail brief. */
export function planLayoutFirstZones({ config, width, height, terrain }: LayoutZoneInput): LayoutZoneResult {
  const survey = demandRaySurvey({ config, width, height, terrain })
  const random = seededRandom(`${config.seed}:layout-districts`), area = width * height
  const settlement = config.settlement ?? 'regional-city', density = Math.max(0, Math.min(1, config.density / 100))
  const mapScale = Math.sqrt(area / 12_000_000)
  const baseCount = settlement === 'metropolis' ? 14 : settlement === 'regional-city' ? 10 : settlement === 'rural-town' ? 4 : 2
  const target = Math.max(settlement === 'village' ? 1 : 2, Math.min(45, Math.round(baseCount * Math.max(.8, mapScale) * (.35 + .65 * density))))
  const sampleSpacing = Math.max(110, Math.min(420, Math.min(width, height) / 16)), margin = Math.min(110, sampleSpacing * .55)
  type Candidate = { point: Point; quality: number; grade: number; elevation: number }
  const candidates: Candidate[] = []
  const quality = (point: Point): Candidate | null => {
    if (point.x < margin || point.y < margin || point.x > width - margin || point.y > height - margin || terrain.waterAt(point)) return null
    let grade = 0, dry = 0, probes = 0
    const reach = Math.min(140, sampleSpacing * .65)
    for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
      const p = { x: point.x + dx * reach, y: point.y + dy * reach }
      if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) continue
      probes++
      if (!terrain.waterAt(p)) { dry++; grade += Math.max(0, terrain.slope(p)) }
    }
    const centerGrade = terrain.slope(point), average = grade / Math.max(1, dry), dryFraction = dry / Math.max(1, probes)
    if (!Number.isFinite(centerGrade) || centerGrade > .17 || average > .13 || dryFraction < .5) return null
    return { point, grade: average, elevation: terrain.elevation(point), quality: dryFraction * Math.exp(-average * 18) * Math.exp(-centerGrade * 5) }
  }
  const origin = quality(terrain.cityOrigin)
  if (origin) candidates.push(origin)
  for (let y = margin; y < height - margin; y += sampleSpacing) for (let x = margin; x < width - margin; x += sampleSpacing) {
    const candidate = quality({ x: x + (random() - .5) * sampleSpacing * .22, y: y + (random() - .5) * sampleSpacing * .22 })
    if (candidate) candidates.push(candidate)
  }
  if (!candidates.length) return { center: { ...terrain.cityOrigin }, zones: [] }
  // The former origin-first choice pinned the entire new city to one small
  // corner even when continuous lowland lay across the rest of the map.
  const qualitySum = candidates.reduce((sum, candidate) => sum + candidate.quality, 0)
  const landCenter = candidates.reduce((sum, candidate) => ({ x: sum.x + candidate.point.x * candidate.quality / qualitySum, y: sum.y + candidate.point.y * candidate.quality / qualitySum }), { x: 0, y: 0 })
  const hinterlandReach = Math.min(1000, Math.min(width, height) * .15), scale = Math.hypot(width, height)
  const centreScore = (candidate: Candidate) => {
    let buildable = 0, probes = 0
    for (let a = 0; a < 12; a++) for (const fraction of [.45, 1]) {
      const theta = a * Math.PI / 6, point = { x: candidate.point.x + Math.cos(theta) * hinterlandReach * fraction, y: candidate.point.y + Math.sin(theta) * hinterlandReach * fraction }
      probes++
      if (point.x > margin && point.x < width - margin && point.y > margin && point.y < height - margin && !terrain.waterAt(point) && terrain.slope(point) <= .13) buildable++
    }
    return candidate.quality * .42 + buildable / probes * .58 - distance(candidate.point, landCenter) / scale * .9
  }
  const centreScores = new Map(candidates.map(candidate => [candidate, centreScore(candidate)]))
  const centerChoice = candidates.slice().sort((a, b) => centreScores.get(b)! - centreScores.get(a)! || distance(a.point, landCenter) - distance(b.point, landCenter))[0]!
  const center = { ...centerChoice.point }
  const urbanFraction = (settlement === 'metropolis' ? .85 : settlement === 'regional-city' ? .58 : settlement === 'rural-town' ? .20 : .055) * (.18 + .82 * density)
  const coverageRadius = Math.sqrt(area * urbanFraction / Math.PI) * 1.30
  const nominalRadius = Math.max(settlement === 'village' ? 110 : 240, Math.min(mapScale > 1.5 ? 950 : 600, Math.sqrt(area * urbanFraction / target / Math.PI) * 1.16))
  const selected: Candidate[] = [centerChoice]
  while (selected.length < target) {
    let best: Candidate | undefined, bestScore = -Infinity
    for (const candidate of candidates) {
      const fromCenter = distance(candidate.point, center)
      if (fromCenter > coverageRadius + nominalRadius * .45) continue
      const nearest = Math.min(...selected.map(site => distance(site.point, candidate.point)))
      if (nearest < nominalRadius * .95) continue
      // Farthest coverage, tempered by actual land quality, avoids selecting
      // all districts beside the original bank or all four crop corners.
      const centrality = Math.max(.12, 1 - fromCenter / Math.max(1, coverageRadius + nominalRadius))
      const score = nearest * (.35 + candidate.quality * .65) * (.65 + centrality * .35)
      if (score > bestScore) { best = candidate; bestScore = score }
    }
    if (!best) break
    selected.push(best)
  }
  // A coherent broad street bearing responds to local terrain. Satellite
  // districts vary smoothly from it, rather than each rotating at random.
  const derivativeReach = Math.min(180, sampleSpacing)
  const east = terrain.elevation({ x: Math.min(width - 1, center.x + derivativeReach), y: center.y }) - terrain.elevation({ x: Math.max(1, center.x - derivativeReach), y: center.y })
  const north = terrain.elevation({ x: center.x, y: Math.min(height - 1, center.y + derivativeReach) }) - terrain.elevation({ x: center.x, y: Math.max(1, center.y - derivativeReach) })
  const baseAngle = Math.hypot(east, north) > 2 ? Math.atan2(north, east) + Math.PI / 2 : (random() - .5) * .42
  const zones = selected.map((candidate, index): LayoutFirstZone => {
    const village = settlement === 'village', rural = settlement === 'rural-town'
    const fromCenter = distance(candidate.point, center), fringe = fromCenter > coverageRadius * .76
    const lowland = candidate.grade <= .035 && candidate.elevation <= centerChoice.elevation + 18
    const employment = !village && !rural && index > 1 && fromCenter > nominalRadius * 1.25 && lowland && index % 7 === 0
    const kind: LayoutFirstZone['kind'] = index === 0 ? 'historic' : village || rural && index > 1 || fringe && candidate.quality < .62 ? 'rural' : employment ? 'industrial' : 'residential'
    const builtYear = kind === 'historic' ? 1650 : kind === 'rural' ? 1750 + index % 3 * 50 : [1900, 1955, 1975, 1995][index % 4]!
    const radius = nominalRadius * (index === 0 ? .82 : .92 + random() * .18) * Math.max(.6, 1 - candidate.grade * 2)
    const angle = baseAngle + Math.sin(candidate.point.x / Math.max(500, nominalRadius * 3) + candidate.point.y / Math.max(700, nominalRadius * 4)) * .13
    const phases = [random() * Math.PI * 2, random() * Math.PI * 2]
    const polygon = Array.from({ length: 16 }, (_, n) => {
      const theta = n * Math.PI / 8, proposed = radius * (1 + Math.sin(theta * 2 + phases[0]!) * .07 + Math.sin(theta * 3 + phases[1]!) * .045)
      // Keep the demand envelope continuous across small identified branches.
      // Actual wet ground remains excluded by downstream physical surveys.
      const localRadius = survey(candidate.point, theta, proposed, Math.min(35, proposed), 35, .17, !village && !rural && kind !== 'rural')
      return { x: Math.max(12, Math.min(width - 12, candidate.point.x + Math.cos(theta) * localRadius)), y: Math.max(12, Math.min(height - 12, candidate.point.y + Math.sin(theta) * localRadius)) }
    })
    return { id: `layout-zone-${index + 1}`, center: candidate.point, radius, polygon, kind, angle, builtYear, density: Math.max(.08, density * (village ? .45 : rural ? .65 : fringe ? .78 : 1)), maximumFloors: kind === 'industrial' ? 3 : kind === 'historic' || village || rural ? 2 : settlement === 'metropolis' ? 6 : 3 }
  })
  return { center, zones }
}
