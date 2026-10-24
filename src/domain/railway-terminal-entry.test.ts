import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Area, Point } from './types'
import { planRailway } from './railway-planner'

const { corridors } = vi.hoisted(() => ({ corridors: vi.fn() }))
vi.mock('./railway-corridor.ts', () => ({ railwayCorridors: corridors }))

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const from = { x: 0, y: 3000 }
function input(station: Point) {
  corridors.mockReturnValue([{ from, to: station, station, terminus: true, score: 1, points: [from, station] }])
  return { width: 4000, height: 3000, seed: 'oblique-terminal-entry', origin: station, allowTerminus: true, settlements: [{ point: station, demand: 1600 }],
    terrain: { areas: [] as Area[], elevation: () => 20, waterAt: (_p: Point) => false } }
}

describe('terminal external approach clearance', () => {
  beforeEach(() => corridors.mockReset())

  it.each([{ x: 2148, y: 2175 }, { x: 3000, y: 2800 }])('admits the full track width at a corner toward $x,$y', station => {
    const options = input(station), result = planRailway(options)!
    expect(result).not.toBeNull()
    expect(result.points[0]).toEqual(from)
    const span = distance(from, station), direction = { x: (station.x - from.x) / span, y: (station.y - from.y) / span }
    const start = result.points.find(p => p.x >= 12 + Math.abs(direction.y) * 5 && p.y <= options.height - 12 - Math.abs(direction.x) * 5)!
    expect(distance(from, start)).toBeGreaterThan(40)
    for (const side of [-5, 5]) {
      const shoulder = { x: start.x - direction.y * side, y: start.y + direction.x * side }
      expect(shoulder.x).toBeGreaterThanOrEqual(12); expect(shoulder.x).toBeLessThanOrEqual(options.width - 12)
      expect(shoulder.y).toBeGreaterThanOrEqual(12); expect(shoulder.y).toBeLessThanOrEqual(options.height - 12)
    }
    expect(distance(result.stationTargets![0]!, station)).toBeLessThan(90)
    expect(result.diagnostics.maxTrackGrade).toBeLessThanOrEqual(.035 + 1e-6)
    expect(result.diagnostics.minCurveRadius).toBeGreaterThanOrEqual(150)
    expect(result.diagnostics.maxEarthwork).toBeLessThanOrEqual(12)
    expect(result.diagnostics.maxBridgeLength).toBeLessThanOrEqual(180)
  })

  it('checks water and earthwork throughout the extended approach', () => {
    const station = { x: 3000, y: 2800 }
    const wet = input(station)
    wet.terrain.waterAt = p => p.x > 100 && p.x < 110
    expect(planRailway(wet)).toBeNull()
    const cliff = input(station)
    cliff.terrain.elevation = (p?: Point) => p && p.x > 100 && p.x < 110 ? 100 : 20
    expect(planRailway(cliff)).toBeNull()
  })

  it('keeps the extended track shoulders out of protected land', () => {
    const options = input({ x: 3000, y: 2800 })
    options.terrain.areas.push({ id: 'historic-core', kind: 'park', polygon: [{ x: 95, y: 2995 }, { x: 110, y: 2995 }, { x: 110, y: 2999 }, { x: 95, y: 2999 }] })
    expect(planRailway(options)).toBeNull()
  })

  it.each([{ ground: 17, kind: 'embankment' }, { ground: 23, kind: 'cutting' }])('records surveyed approach $kind without changing its track level', ({ ground, kind }) => {
    const options = input({ x: 3000, y: 2800 })
    options.terrain.elevation = (p?: Point) => p && p.x > 100 && p.x < 110 ? ground : 20
    const result = planRailway(options)!
    expect(result).not.toBeNull()
    expect(result.elevations).toHaveLength(result.points.length)
    const survey = result.points.filter(p => distance(from, p) <= 250)
    expect(survey.length).toBeGreaterThan(40)
    for (let i = 1; i < survey.length; i++) expect(distance(survey[i - 1]!, survey[i]!)).toBeCloseTo(5, 8)
    const structure = result.structures.find(s => s.kind === kind && s.to.x < 260)!
    expect(structure).toBeDefined()
    expect(structure.length).toBeCloseTo(distance(structure.from, structure.to), 8)
    expect(structure.maxHeight).toBe(3)
    expect(structure.from.x).toBeLessThan(100); expect(structure.to.x).toBeGreaterThan(110)
    expect(result.diagnostics.maxEarthwork).toBe(3)
    expect(result.elevations.every(z => z === 20)).toBe(true)
  })
})
