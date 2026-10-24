import { describe, expect, it } from 'vitest'
import type { Building, CityMap, Station } from '../domain/types'
import { rectangle } from '../domain/geometry'
import { buildingArchitecture, castleWallArchitecture, footprintFrame, stationArchitecture, stationArchitectureLayout } from './landmark-geometry'
import { surveyStationArchitecture } from '../domain/station-architecture'

const map = (): CityMap => ({ width: 400, height: 400, config: { name: '試験市', seed: 'architecture', type: 'castle', terrain: 'plain', density: 50, forest: 0, railway: true, stations: 1, arterial: false, facilities: [], settlement: 'regional-city' }, railways: [{ id: 'main', name: '試験線', points: [{ x: 10, y: 200 }, { x: 390, y: 200 }], elevations: [12, 12] }], stations: [{ id: 'station', point: { x: 200, y: 200 }, name: '試験駅' }], roads: [], buildings: [], areas: [], facilities: [], districts: [], description: '' })
const elevation = () => 10

describe('batched landmark architecture', () => {
  it('aligns a rotated footprint and preserves its metric dimensions', () => {
    const angle = .63, polygon = rectangle(-20, -8, 40, 16).map(p => ({ x: 90 + p.x * Math.cos(angle) - p.y * Math.sin(angle), y: 70 + p.x * Math.sin(angle) + p.y * Math.cos(angle) }))
    const frame = footprintFrame(polygon)!
    expect(frame.length).toBeCloseTo(40); expect(frame.depth).toBeCloseTo(16)
    expect(frame.center.x).toBeCloseTo(90); expect(frame.center.y).toBeCloseTo(70)
    expect(Math.abs(frame.along.x)).toBeCloseTo(Math.cos(angle))
  })
  it('gives keeps receding storeys and curved roofs inside their original ground footprint', () => {
    const keep: Building = { id: 'castle-keep', kind: 'public', height: 5, polygon: rectangle(100, 100, 30, 25) }, mesh = buildingArchitecture(keep, 20)!
    expect(mesh.length).toBeGreaterThan(100)
    const points = mesh.flatMap(t => t.points), heights = new Set(points.map(p => p.elevation))
    expect(heights.size).toBeGreaterThan(15)
    expect(Math.max(...points.map(p => p.elevation))).toBeGreaterThan(40)
    for (const p of points) { expect(Number.isFinite(p.elevation)).toBe(true); expect(p.x).toBeGreaterThanOrEqual(100 - 1e-8); expect(p.x).toBeLessThanOrEqual(130 + 1e-8); expect(p.y).toBeGreaterThanOrEqual(100 - 1e-8); expect(p.y).toBeLessThanOrEqual(125 + 1e-8) }
    expect(buildingArchitecture({ ...keep, id: 'house', kind: 'residential' }, 20)).toBeUndefined()
  })
  it('keeps an L-shaped school courtyard open while adding separate windows and a parapet', () => {
    const building: Building = { id: 'facility-building-school', kind: 'public', height: 3, polygon: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 19 }, { x: 40, y: 19 }, { x: 40, y: 43 }, { x: 0, y: 43 }] }, mesh = buildingArchitecture(building, 10)!
    expect(mesh.some(t => t.color === '#5c7981')).toBe(true)
    expect(Math.max(...mesh.flatMap(t => t.points).map(p => p.elevation))).toBeCloseTo(20.1)
    for (const triangle of mesh) {
      const centroid = triangle.points.reduce((p, q) => ({ x: p.x + q.x / 3, y: p.y + q.y / 3 }), { x: 0, y: 0 })
      expect(centroid.x > 40.05 && centroid.y > 19.05).toBe(false)
    }
  })
  it('leaves the bailey hole open in raised stone enclosure walls', () => {
    const mesh = castleWallArchitecture({ id: 'castle-wall-honmaru-0', kind: 'field', polygon: rectangle(0, 0, 40, 40), holes: [rectangle(4, 4, 32, 32)] }, elevation)
    expect(mesh.length).toBeGreaterThan(12)
    for (const triangle of mesh.filter(t => t.color === '#b6b19a')) {
      const p = triangle.points.reduce((sum, q) => ({ x: sum.x + q.x / 3, y: sum.y + q.y / 3 }), { x: 0, y: 0 })
      expect(p.x > 4 && p.x < 36 && p.y > 4 && p.y < 36).toBe(false)
    }
  })
  it('builds a metric station house, platforms, columns, roofs and a safe-height footbridge', () => {
    const city = map(), stations = surveyStationArchitecture({ ...city, waterAt: () => false, slope: () => 0, elevation })
    const layout = stationArchitectureLayout(city, stations[0]!, elevation)!, mesh = stationArchitecture(layout, elevation)
    expect(layout.building).toHaveLength(4); expect(layout.platforms).toHaveLength(2)
    expect(mesh.some(t => t.color === '#375c67')).toBe(true)
    expect(mesh.some(t => t.color === '#d9bf64')).toBe(true)
    expect(mesh.some(t => t.color === '#b8c2b6' && t.points.every(p => Math.abs(p.elevation - 18.5) < 1e-7))).toBe(true)
    expect(Math.max(...mesh.flatMap(t => t.points).map(p => p.elevation))).toBeLessThan(24)
  })
  it('renders subway entrances without surface railway platforms or a footbridge', () => {
    const city = map()
    city.railways[0] = { ...city.railways[0]!, mode: 'subway' }
    city.stations[0] = { ...city.stations[0]!, mode: 'subway', railwayId: 'main' }
    const stations = surveyStationArchitecture({ ...city, waterAt: () => false, slope: () => 0, elevation }), layout = stationArchitectureLayout(city, stations[0]!, elevation)!, mesh = stationArchitecture(layout, elevation)
    expect(layout.platforms).toHaveLength(0)
    expect(mesh.some(t => t.color === '#344e55')).toBe(true)
    expect(Math.max(...mesh.flatMap(t => t.points).map(p => p.elevation))).toBeLessThan(13)
  })
  it('shortens platforms on a bent legacy line instead of cutting through the curve', () => {
    const city = map()
    city.railways[0]!.points = [{ x: 10, y: 160 }, { x: 180, y: 200 }, { x: 220, y: 200 }, { x: 390, y: 260 }]
    city.railways[0]!.elevations = [12, 12, 12, 12]
    const layout = stationArchitectureLayout(city, city.stations[0]!, elevation)!
    expect(layout.platforms.length).toBe(2)
    expect(footprintFrame(layout.platforms[0]!)!.length).toBeLessThan(70)
  })
  it('uses station line identity when underground and surface routes cross', () => {
    const city = map()
    city.railways.push({ id: 'metro', name: '地下線', mode: 'subway', points: [{ x: 200, y: 0 }, { x: 200, y: 400 }] })
    const station = { ...city.stations[0]!, railwayId: 'metro' } as Station
    expect(stationArchitectureLayout(city, station, elevation)!.subway).toBe(true)
  })
})
