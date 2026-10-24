import { describe, expect, it } from 'vitest'
import { planSubway } from './subway'
import { createCityTimeline, sliceCityAtYear } from './timeline'
import { parseProject, portableProject } from './project'
import { civicTransportAcquisitions } from './civic-transport'
import { distance, distanceToSegment, rectangle } from './geometry'
import type { Building, CityConfig, CityMap, Road, TimelineVersion } from './types'

const config: CityConfig = { name: '桜井市', seed: 'metro', type: 'newtown', terrain: 'plain', density: 85, forest: 0, settlement: 'metropolis', subway: true, railway: true, stations: 3, arterial: true, facilities: [] }
function input() {
  const points = [{ x: 500, y: 1000 }, { x: 1500, y: 1000 }, { x: 2500, y: 1500 }, { x: 3500, y: 1500 }, { x: 4500, y: 1000 }, { x: 5500, y: 1000 }]
  const roads: TimelineVersion<Road>[] = [{ from: 1950, value: { id: 'main', kind: 'arterial', width: 16, points, builtYear: 1950 } }]
  const buildings: TimelineVersion<Building>[] = []
  for (let i = 1; i < points.length; i++) for (let j = 0; j < 40; j++) for (const offset of [-150, -90, 90, 150]) {
    const a = points[i - 1]!, b = points[i]!, p = { x: a.x + (b.x - a.x) * j / 40, y: a.y + (b.y - a.y) * j / 40 + offset }
    buildings.push({ from: 1950, value: { id: `b-${i}-${j}-${offset}`, polygon: rectangle(p.x - 5, p.y - 5, 10, 10), kind: 'residential', height: 3, builtYear: 1950 } })
  }
  return { config, throughYear: 2025, roads, buildings, stations: [{ id: 'surface', point: points[0]!, name: '桜井駅', builtYear: 1900 }], terrain: { elevation: (p: { x: number }) => 40 + .02 * p.x, slope: () => .02, waterAt: () => false } }
}

describe('dated urban subway investment', () => {
  it('connects real built-up road corridors with several accessible stations and a curved underground profile', () => {
    const source = input(), before = JSON.stringify(source), plan = planSubway(source)!
    expect(plan).not.toBeNull(); expect(plan.railway.mode).toBe('subway'); expect(plan.railway.builtYear).toBe(1965)
    expect(plan.stations.length).toBeGreaterThanOrEqual(3)
    expect(plan.stations.map(s => [s.name, s.entrance])).toContainEqual(['桜井駅', expect.any(Object)])
    const { points, elevations } = plan.railway
    expect(points.length).toBeGreaterThan(100)
    let smallestRadius = Infinity
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[i - 1]!, b = points[i]!, c = points[i + 1]!, cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
      if (cross > 1e-5) smallestRadius = Math.min(smallestRadius, distance(a, b) * distance(b, c) * distance(a, c) / (2 * cross))
    }
    expect(smallestRadius).toBeGreaterThanOrEqual(109)
    for (let i = 0; i < points.length; i++) {
      expect(source.terrain.elevation(points[i]!) - elevations![i]!).toBeGreaterThanOrEqual(17.999)
      if (i) expect(Math.abs(elevations![i]! - elevations![i - 1]!) / distance(points[i - 1]!, points[i]!)).toBeLessThanOrEqual(.035001)
    }
    for (const station of plan.stations) {
      expect(station.mode).toBe('subway'); expect(station.builtYear).toBe(1965); expect(station.railwayId).toBe(plan.railway.id)
      const entrance = station.entrance!
      expect(Math.min(...source.roads[0]!.value.points.slice(1).map((p, i) => distanceToSegment(entrance, source.roads[0]!.value.points[i]!, p)))).toBeLessThan(.001)
      expect(distance(entrance, station.point)).toBeLessThanOrEqual(180)
    }
    expect(JSON.stringify(source)).toBe(before)
  })

  it('uses the first genuinely built-up survey year, never future buildings or a small-town checkbox', () => {
    const source = input()
    expect(planSubway({ ...source, throughYear: 1930 })).toBeNull()
    expect(planSubway({ ...source, config: { ...config, settlement: 'regional-city' } })).toBeNull()
    expect(planSubway({ ...source, config: { ...config, subway: false } })).toBeNull()
    expect(planSubway({ ...source, buildings: source.buildings.map(v => ({ ...v, from: 1975, value: { ...v.value, builtYear: 1975 } })) })!.railway.builtYear).toBe(1980)
    expect(planSubway({ ...source, buildings: source.buildings.slice(0, 150) })).toBeNull()
    expect(planSubway({ ...source, terrain: { ...source.terrain, waterAt: () => true } })).toBeNull()
  })

  it('archives the actual opening year and preserves station buildings/entrances through portable import', () => {
    const plan = planSubway(input())!, map: CityMap = { width: 6000, height: 3000, config, year: 2025, description: '', roads: input().roads.map(v => v.value), buildings: [], areas: [], facilities: [], districts: [], railways: [plan.railway], stations: plan.stations.map(s => ({ ...s, buildingPolygon: rectangle(s.entrance!.x - 2, s.entrance!.y + 10, 4, 8) })) }
    map.timeline = createCityTimeline(map)
    expect(sliceCityAtYear(map, 1964).stations).toHaveLength(0)
    expect(sliceCityAtYear(map, 1964).railways).toHaveLength(0)
    expect(sliceCityAtYear(map, 1965).stations).toHaveLength(plan.stations.length)
    const imported = parseProject(JSON.stringify(portableProject({ version: 2, config, snapshot: map, style: 'standard', annotations: [], layers: { railway: true, terrain: true, labels: true, buildings: true, roads: true, facilities: true, grid: false } }))).snapshot!
    expect(imported.railways).toEqual(map.railways); expect(imported.stations).toEqual(map.stations)
    expect(imported.config.subway).toBe(true)
    expect(sliceCityAtYear(imported, 1964).stations).toHaveLength(0)
  })

  it('does not acquire civic ground for a subway tunnel, while a surface line still does', () => {
    const railway = { id: 'rail', mode: 'subway' as const, name: '地下鉄', builtYear: 1965, points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] }
    const campus = rectangle(30, 35, 40, 30)
    expect(civicTransportAcquisitions([], [railway], 2025)(campus, 1900, '')).toBeNull()
    expect(civicTransportAcquisitions([], [{ ...railway, mode: 'surface' }], 2025)(campus, 1900, '')?.year).toBe(1965)
  })
})
