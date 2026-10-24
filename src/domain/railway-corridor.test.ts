import { describe, expect, it } from 'vitest'
import { railwayCorridors } from './railway-corridor'
import { planRailway } from './railway-planner'
import type { Area, Point } from './types'

const axis = (y: number) => 900 + 500 * Math.exp(-(((y - 1500) / 900) ** 2))
const elevation = (p: Point) => 20 + ((p.x - axis(p.y)) / 120) ** 2 * 3
const slope = (p: Point) => Math.hypot(elevation({ x: p.x + 5, y: p.y }) - elevation({ x: p.x - 5, y: p.y }), elevation({ x: p.x, y: p.y + 5 }) - elevation({ x: p.x, y: p.y - 5 })) / 10
const input = { width: 3000, height: 3000, seed: 'geographic-rail', origin: { x: 1400, y: 1500 }, terrain: { areas: [] as Area[], elevation, slope, waterAt: () => false, channelAt: (p: Point) => ({ bankDistance: Math.abs(p.x - axis(p.y)), width: 35 }) }, settlements: [{ point: { x: 1400, y: 1500 }, demand: 1600 }] }
describe('regional railway corridor and inherited settlement access', () => {
  it('uses valley exits and dry settlement land rather than the origin-minus-650 column', () => {
    const corridors = railwayCorridors(input)
    expect(corridors.length).toBeGreaterThan(0)
    expect(corridors[0]!.station.x).toBeGreaterThan(1150)
    expect(corridors[0]!.from.y !== corridors[0]!.to.y).toBe(true)
    const result = planRailway(input)!
    expect(result).not.toBeNull()
    expect(result.stationTargets!.some(p => Math.hypot(p.x - 1400, p.y - 1500) < 300)).toBe(true)
    const middle = result.points.filter(p => p.y > 1200 && p.y < 1800)
    expect(Math.min(...middle.map(p => p.x))).toBeGreaterThan(1100)
    expect(Math.max(...result.points.map(p => p.x)) - Math.min(...result.points.map(p => p.x))).toBeGreaterThan(200)
    expect(result.diagnostics.minCurveRadius).toBeGreaterThanOrEqual(150)
    expect(result.diagnostics.maxTrackGrade).toBeLessThanOrEqual(.035 + 1e-6)
    expect(result.diagnostics.maxEarthwork).toBeLessThanOrEqual(12)
  })
  it('follows a valley between adjacent survey edges and excludes open sea boundary samples', () => {
    const sea: Area = { id: 'sea', kind: 'water', polygon: [{ x: 2600, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 3000 }, { x: 0, y: 3000 }, { x: 0, y: 2600 }] }
    // The exact east/south viewport edge is open in this polygon query. The
    // seafloor remains real: treating that boundary as land is not permitted.
    const waterAt = (p: Point) => p.x + p.y > 2600 && p.x < 3000 && p.y < 3000
    const coastal = { width: 3000, height: 3000, seed: 'adjacent-valley', origin: { x: 800, y: 900 },
      terrain: { areas: [sea], elevation: (p: Point) => p.x + p.y > 2600 ? -30 : 10, slope: () => 0, waterAt,
        channelAt: (p: Point) => ({ bankDistance: 180 + Math.min(Math.hypot(p.x - 1200, p.y), Math.hypot(p.x, p.y - 2100)), width: 36 }) },
      settlements: [{ point: { x: 800, y: 900 }, demand: 1000 }] }
    expect(waterAt({ x: 3000, y: 1500 })).toBe(false)
    const corridors = railwayCorridors(coastal)
    expect(corridors.length).toBeGreaterThan(0)
    for (const corridor of corridors) for (const endpoint of [corridor.from, corridor.to]) {
      expect(endpoint.x + endpoint.y).toBeLessThanOrEqual(2600)
      expect(endpoint.y === 0 || endpoint.x === 0).toBe(true)
    }
    const result = planRailway(coastal)!
    expect(result).not.toBeNull()
    expect(result.points.every(point => !waterAt(point))).toBe(true)
    expect(result.points[0]!.y).toBe(0)
    expect(result.points.at(-1)!.x).toBe(0)
    expect(result.diagnostics.maxTrackGrade).toBeLessThanOrEqual(.035 + 1e-6)
    expect(result.diagnostics.minCurveRadius).toBeGreaterThanOrEqual(150)
    expect(result.diagnostics.maxEarthwork).toBeLessThanOrEqual(12)
  })
  it('keeps a dry boundary exit when a bridgeable stream crosses its inland approach', () => {
    const creek: Area = { id: 'river-creek', kind: 'water', polygon: [{ x: 0, y: 10 }, { x: 3000, y: 10 }, { x: 3000, y: 24 }, { x: 0, y: 24 }] }
    const survey = { ...input, terrain: { ...input.terrain, areas: [creek], waterAt: (p: Point) => p.y > 10 && p.y < 24 } }
    expect(railwayCorridors(survey).some(corridor => corridor.from.y === 0)).toBe(true)
  })
  it('reserves independent through and terminal budgets with different external approaches', () => {
    const through = railwayCorridors(input), mixed = railwayCorridors({ ...input, allowTerminus: true })
    expect(mixed.filter(corridor => !corridor.terminus)).toEqual(through)
    expect(through.length).toBeLessThanOrEqual(12)
    const terminals = mixed.filter(corridor => corridor.terminus)
    expect(terminals.length).toBeGreaterThan(0); expect(terminals.length).toBeLessThanOrEqual(3)
    for (const [i, terminal] of terminals.entries()) for (const other of terminals.slice(i + 1)) expect(Math.hypot(terminal.from.x - other.from.x, terminal.from.y - other.from.y)).toBeGreaterThan(400)
  })
  it('rejects attractive seafloor corners whose edge-normal survey stays on an open clip boundary', () => {
    const sea: Area = { id: 'sea', kind: 'water', polygon: [{ x: 2600, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 3000 }, { x: 2600, y: 3000 }] }
    const survey = { width: 3000, height: 3000, seed: 'open-sea-corners', origin: { x: 1200, y: 1500 }, allowTerminus: true,
      terrain: { areas: [sea], elevation: (p: Point) => p.x > 2600 ? -30 : 10, slope: () => 0,
        waterAt: (p: Point) => p.x > 2600 && p.x < 3000,
        channelAt: (p: Point) => p.x === 3000 ? { bankDistance: 180, width: 36 } : null },
      settlements: [{ point: { x: 1200, y: 1500 }, demand: 1600 }] }
    const corridors = railwayCorridors(survey)
    expect(corridors.length).toBeGreaterThan(0)
    for (const corridor of corridors) for (const endpoint of [corridor.from, corridor.to]) expect(endpoint.x).toBeLessThan(2600)
  })
})
