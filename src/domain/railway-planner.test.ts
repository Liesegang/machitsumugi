import { describe, expect, it } from 'vitest'
import { planRailway } from './railway-planner'
import { createTerrainModel } from './terrain'
import type { Area, Point } from './types'

const base = { width: 4000, height: 3000, seed: 'rail-review', origin: { x: 1800, y: 1500 } }
const flat = { areas: [] as Area[], elevation: () => 20, waterAt: () => false }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

describe('regional railway horizontal and vertical alignment', { timeout: 180000 }, () => {
  it('finds a smooth global corridor around a core and respects its track grade', () => {
    const core = [{ x: 950, y: 1100 }, { x: 1350, y: 1100 }, { x: 1350, y: 1900 }, { x: 950, y: 1900 }]
    const result = planRailway({ ...base, terrain: flat, core })!
    expect(result).not.toBeNull()
    expect(result.points.some(p => p.y > 1200 && p.y < 1800 && (p.x < 940 || p.x > 1360))).toBe(true)
    expect(result.diagnostics.minCurveRadius).toBeGreaterThanOrEqual(150)
    expect(result.diagnostics.maxTrackGrade).toBeLessThanOrEqual(.035 + 1e-6)
    expect(planRailway({ ...base, terrain: flat, core })).toEqual(result)
  })
  it('returns an explicit bank-to-bank bridge for a mandatory river crossing', () => {
    const river: Area = { id: 'river', kind: 'water', polygon: [{ x: 0, y: 1460 }, { x: 4000, y: 1460 }, { x: 4000, y: 1540 }, { x: 0, y: 1540 }] }
    const waterAt = (p: Point) => p.y > 1460 && p.y < 1540
    const result = planRailway({ ...base, terrain: { areas: [river], waterAt, elevation: p => waterAt(p) ? 15 : 20 } })!
    expect(result).not.toBeNull()
    const bridges = result.structures.filter(s => s.kind === 'bridge')
    expect(bridges.length).toBe(1)
    expect(waterAt(bridges[0]!.from)).toBe(false)
    expect(waterAt(bridges[0]!.to)).toBe(false)
    expect(bridges[0]!.length).toBeLessThanOrEqual(180)
    for (let i = 0; i < result.points.length; i++) if (waterAt(result.points[i]!)) expect(result.elevations[i]!).toBeGreaterThanOrEqual(18)
  })
  it('represents necessary earthworks without altering the ground DEM', () => {
    const elevation = (p: Point) => 20 + 20 * Math.exp(-(((p.y - 1500) / 170) ** 2))
    const result = planRailway({ ...base, terrain: { ...flat, elevation } })!
    expect(result).not.toBeNull()
    expect(result.diagnostics.maxGroundGrade).toBeGreaterThan(.035)
    expect(result.diagnostics.maxTrackGrade).toBeLessThanOrEqual(.035 + 1e-6)
    expect(result.structures.some(s => s.kind === 'cutting')).toBe(true)
    expect(result.diagnostics.maxEarthwork).toBeLessThanOrEqual(12)
    expect(elevation({ x: 1150, y: 1500 })).toBe(40)
  })
  it('records a bridge when a narrow creek lies between the ordinary track samples', () => {
    const waterAt = (p: Point) => p.y > 1503 && p.y < 1505
    const creek: Area = { id: 'river-creek', kind: 'water', polygon: [{ x: 0, y: 1503 }, { x: 4000, y: 1503 }, { x: 4000, y: 1505 }, { x: 0, y: 1505 }] }
    const result = planRailway({ ...base, terrain: { ...flat, areas: [creek], waterAt } })!
    expect(result).not.toBeNull()
    expect(result.structures.some(structure => structure.kind === 'bridge' && structure.from.y < 1503 && structure.to.y > 1505)).toBe(true)
    expect(result.diagnostics.maxTrackGrade).toBeLessThanOrEqual(.035 + 1e-6)
  })
  it('rejects an impossible grade and a sea barrier', () => {
    expect(planRailway({ ...base, terrain: { ...flat, elevation: p => p.y * .07 } })).toBeNull()
    const sea: Area = { id: 'sea', kind: 'water', polygon: [{ x: 0, y: 1000 }, { x: 4000, y: 1000 }, { x: 4000, y: 2000 }, { x: 0, y: 2000 }] }
    expect(planRailway({ ...base, terrain: { ...flat, areas: [sea], waterAt: p => p.y > 1000 && p.y < 2000 } })).toBeNull()
  })
  it('permits an explicitly requested inland terminal without bridging the surrounding sea', () => {
    const rectangle = (id: string, x: number, y: number, width: number, height: number): Area => ({ id, kind: 'water', polygon: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }] })
    const areas = [rectangle('sea-west', 0, 0, 500, 3000), rectangle('sea-east', 2200, 0, 1800, 3000), rectangle('sea-south', 0, 2100, 4000, 900)]
    const waterAt = (p: Point) => p.x < 500 || p.x > 2200 || p.y > 2100
    const input = { ...base, terrain: { ...flat, areas, waterAt } }
    expect(planRailway(input)).toBeNull()
    const result = planRailway({ ...input, allowTerminus: true })!
    expect(result).not.toBeNull()
    expect(result.terminus).toEqual(result.points.at(-1))
    expect(result.points.every(p => !waterAt(p))).toBe(true)
    expect(result.points.slice(1).reduce((sum, p, i) => sum + distance(result.points[i]!, p), 0)).toBeGreaterThanOrEqual(1500)
    expect(distance(result.terminus!, base.origin)).toBeLessThanOrEqual(700)
    expect(result.diagnostics.maxTrackGrade).toBeLessThanOrEqual(.035 + 1e-6)
    expect(result.diagnostics.minCurveRadius).toBeGreaterThanOrEqual(150)
  })
  for (const seed of ['minato-2026', 'another-valley', 'sakura-19']) it(`${seed}: all landform modes produce physically bounded railway profiles`, () => {
    for (const terrain of ['river', 'plain', 'coast'] as const) for (const type of ['castle', 'port'] as const) {
      const model = createTerrainModel({ width: 4000, height: 3000, seed, terrain, type, forest: 30 })
      const result = planRailway({ ...base, seed, origin: model.cityOrigin, terrain: model, allowTerminus: terrain === 'coast' || type === 'port' })!
      expect(result, `${terrain}/${type}`).not.toBeNull()
      expect(result.diagnostics.minCurveRadius).toBeGreaterThanOrEqual(150)
      expect(result.diagnostics.maxTrackGrade).toBeLessThanOrEqual(.035 + 1e-6)
      expect(result.diagnostics.maxEarthwork).toBeLessThanOrEqual(12)
      expect(result.diagnostics.maxBridgeLength).toBeLessThanOrEqual(180)
      for (let i = 1; i < result.points.length; i++) expect(Math.abs(result.elevations[i]! - result.elevations[i - 1]!) / distance(result.points[i]!, result.points[i - 1]!)).toBeLessThanOrEqual(.035 + 1e-6)
    }
  })
})
