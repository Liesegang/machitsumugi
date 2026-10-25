import type { CityConfig, Point } from './types'
import type { TerrainModel } from './terrain'
import type { LayoutFirstZone } from './layout-first-types'
import { distance, seededRandom } from './geometry'

export interface LayoutZoneInput {
  config: CityConfig; width: number; height: number
  terrain: Pick<TerrainModel, 'cityOrigin' | 'elevation' | 'slope' | 'waterAt'>
}
export interface LayoutZoneResult { center: Point; zones: LayoutFirstZone[] }

/** A complete spatial brief before streets and titles exist. Selection sees
 * dry, gentle land across the crop; a river does not terminate an urban region.
 * This is not a historical population forecast and creates no paid land. */
export function planLayoutFirstZones({ config, width, height, terrain }: LayoutZoneInput): LayoutZoneResult {
  const random = seededRandom(`${config.seed}:layout-districts`), area = width * height
  const settlement = config.settlement ?? 'regional-city', density = Math.max(0, Math.min(1, config.density / 100))
  const mapScale = Math.sqrt(area / 12_000_000)
  const baseCount = settlement === 'metropolis' ? 14 : settlement === 'regional-city' ? 10 : settlement === 'rural-town' ? 4 : 2
  const target = Math.max(settlement === 'village' ? 1 : 2, Math.min(45, Math.round(baseCount * Math.max(.8, mapScale) * (.35 + .65 * density))))
  const sampleSpacing = Math.max(110, Math.min(420, Math.min(width, height) / 16)), margin = Math.min(110, sampleSpacing * .55)
  type Candidate = { point: Point; quality: number; grade: number }
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
    return { point, grade: average, quality: dryFraction * Math.exp(-average * 18) * Math.exp(-centerGrade * 5) }
  }
  const origin = quality(terrain.cityOrigin)
  if (origin) candidates.push(origin)
  for (let y = margin; y < height - margin; y += sampleSpacing) for (let x = margin; x < width - margin; x += sampleSpacing) {
    const candidate = quality({ x: x + (random() - .5) * sampleSpacing * .22, y: y + (random() - .5) * sampleSpacing * .22 })
    if (candidate) candidates.push(candidate)
  }
  if (!candidates.length) return { center: { ...terrain.cityOrigin }, zones: [] }
  const centerChoice = origin ?? candidates.slice().sort((a, b) => distance(a.point, terrain.cityOrigin) / (a.quality + .2) - distance(b.point, terrain.cityOrigin) / (b.quality + .2))[0]!
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
    const kind: LayoutFirstZone['kind'] = index === 0 ? 'historic' : config.railway && index === 1 && !village ? 'station' : village || rural && index > 1 ? 'rural' : settlement === 'metropolis' && index > 2 && index % 7 === 0 ? 'industrial' : settlement === 'metropolis' && index % 3 === 0 ? 'apartment' : 'residential'
    const builtYear = kind === 'historic' ? 1650 : kind === 'station' ? 1900 : kind === 'rural' ? 1750 + index % 3 * 50 : [1955, 1975, 1995][index % 3]!
    const radius = nominalRadius * (index === 0 ? .82 : .92 + random() * .18) * Math.max(.6, 1 - candidate.grade * 2)
    const angle = baseAngle + Math.sin(candidate.point.x / Math.max(500, nominalRadius * 3) + candidate.point.y / Math.max(700, nominalRadius * 4)) * .13
    const phases = [random() * Math.PI * 2, random() * Math.PI * 2]
    const polygon = Array.from({ length: 16 }, (_, n) => {
      const theta = n * Math.PI / 8, localRadius = radius * (1 + Math.sin(theta * 2 + phases[0]!) * .07 + Math.sin(theta * 3 + phases[1]!) * .045)
      return { x: Math.max(12, Math.min(width - 12, candidate.point.x + Math.cos(theta) * localRadius)), y: Math.max(12, Math.min(height - 12, candidate.point.y + Math.sin(theta) * localRadius)) }
    })
    return { id: `layout-zone-${index + 1}`, center: candidate.point, radius, polygon, kind, angle, builtYear, density: Math.max(.08, density * (village ? .45 : rural ? .65 : 1)), maximumFloors: kind === 'apartment' ? 10 : kind === 'station' && settlement === 'metropolis' ? 12 : kind === 'station' ? 5 : kind === 'industrial' ? 3 : kind === 'historic' || village || rural ? 2 : settlement === 'metropolis' ? 6 : 3 }
  })
  return { center, zones }
}
