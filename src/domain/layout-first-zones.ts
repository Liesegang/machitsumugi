import type { CityConfig, Point, Station } from './types'
import type { TerrainModel } from './terrain'
import type { LayoutFirstZone } from './layout-first-types'
import { distance, distanceToSegment, pointInRegion, seededRandom } from './geometry'

export interface LayoutZoneInput {
  config: CityConfig; width: number; height: number
  terrain: Pick<TerrainModel, 'cityOrigin' | 'elevation' | 'slope' | 'waterAt'>
}
export interface LayoutZoneResult { center: Point; zones: LayoutFirstZone[] }

/** Only acquired stations can acquire an opening-era street neighbourhood.
 * Its public gate, surrounding dry ground and existing whole-city envelope
 * constrain the survey. This is an access brief, not an apartment-zone stamp. */
export function planLayoutFirstStationZones(input: LayoutZoneInput & { zones: readonly LayoutFirstZone[]; stations: readonly Station[]; gates: readonly { id: string; point: Point }[] }): LayoutFirstZone[] {
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
      let reach = 0
      for (let sample = 15; sample <= radius; sample += 20) {
        const point = { x: gate.x + Math.cos(theta) * sample, y: gate.y + Math.sin(theta) * sample }
        if (point.x < 12 || point.y < 12 || point.x > input.width - 12 || point.y > input.height - 12 || input.terrain.waterAt(point) || input.terrain.slope(point) > .13 || sample > 55 && !inEnvelope(point)) break
        reach = sample
      }
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
      // A district edge follows its surveyed shore/slope. A separate selected
      // neighbourhood may develop the opposite bank; this one cannot claim it
      // with a decorative disk spanning water or a mountain shoulder.
      let localRadius = Math.min(35, proposed)
      for (let reach = localRadius; reach <= proposed; reach += 35) {
        const point = { x: candidate.point.x + Math.cos(theta) * reach, y: candidate.point.y + Math.sin(theta) * reach }
        if (point.x < 12 || point.y < 12 || point.x > width - 12 || point.y > height - 12 || terrain.waterAt(point) || terrain.slope(point) > .17) break
        localRadius = reach
      }
      return { x: Math.max(12, Math.min(width - 12, candidate.point.x + Math.cos(theta) * localRadius)), y: Math.max(12, Math.min(height - 12, candidate.point.y + Math.sin(theta) * localRadius)) }
    })
    return { id: `layout-zone-${index + 1}`, center: candidate.point, radius, polygon, kind, angle, builtYear, density: Math.max(.08, density * (village ? .45 : rural ? .65 : fringe ? .78 : 1)), maximumFloors: kind === 'industrial' ? 3 : kind === 'historic' || village || rural ? 2 : settlement === 'metropolis' ? 6 : 3 }
  })
  return { center, zones }
}
