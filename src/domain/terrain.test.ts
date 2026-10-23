import { describe, expect, it } from 'vitest'
import { createTerrainModel } from './terrain'
import type { Point } from './types'

const defaults = { width: 4000, height: 3000, seed: 'minato-2026', terrain: 'river' as const, forest: 30, type: 'castle' as const }
const inside = (p: Point, polygon: Point[]) => {
  let result = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) result = !result
  }
  return result
}
const polygonArea = (p: Point[]) => Math.abs(p.reduce((s, a, i) => s + a.x * p[(i + 1) % p.length]!.y - p[(i + 1) % p.length]!.x * a.y, 0)) / 2
const crosses = (a: Point, b: Point, c: Point, d: Point) => {
  const turn = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  return turn(a, b, c) * turn(a, b, d) < -1e-7 && turn(c, d, a) * turn(c, d, b) < -1e-7
}
const model = createTerrainModel(defaults)

describe('regional terrain and local suitability', { timeout: 180000 }, () => {
  it('is deterministic and uses a catchment larger than the visible map', () => {
    expect(createTerrainModel(defaults).areas).toEqual(model.areas)
    expect(model.hydrology.extent).toBeGreaterThan(defaults.width * 4)
    expect(model.hydrology.processedCells).toBe(model.hydrology.rawDEM.length)
    expect(model.hydrology.outletArea).toBe(model.hydrology.rawDEM.length * model.hydrology.resolution ** 2)
    expect(createTerrainModel({ ...defaults, seed: 'another-valley' }).areas).not.toEqual(model.areas)
  })
  it('varies the settlement bank and map orientation without unsupported crop corners', () => {
    const samples = [model, ...['another-valley', 'sakura-19'].map(seed => createTerrainModel({ ...defaults, seed }))]
    const anchors = samples.map(m => m.hydrology.frame.localAnchor.x)
    expect(Math.max(...anchors) - Math.min(...anchors)).toBeGreaterThan(defaults.width * .25)
    expect(samples.some(m => m.hydrology.frame.mirrored)).toBe(true)
    expect(samples.some(m => !m.hydrology.frame.mirrored)).toBe(true)
    for (const m of samples) {
      const f = m.hydrology.frame, cosine = Math.cos(f.angle), sine = Math.sin(f.angle), mirror = f.mirrored ? -1 : 1
      for (const p of [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 0, y: 3000 }, { x: 4000, y: 3000 }]) {
        const x = f.worldAnchor.x + cosine * mirror * (p.x - f.localAnchor.x) - sine * (p.y - f.localAnchor.y)
        const y = f.worldAnchor.y + sine * mirror * (p.x - f.localAnchor.x) + cosine * (p.y - f.localAnchor.y)
        expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(m.hydrology.extent)
        expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(m.hydrology.extent)
        expect(Number.isFinite(m.elevation(p))).toBe(true)
      }
    }
  })
  it('reserves a dry, unwooded castle precinct and chooses a buildable origin', () => {
    expect(model.slope(model.cityOrigin)).toBeLessThan(.12)
    const forest = model.areas.filter(a => a.kind === 'forest')
    for (let y = -250; y <= 250; y += 25) for (let x = -250; x <= 250; x += 25) {
      if (Math.hypot(x, y) > 250) continue
      const p = { x: model.cityOrigin.x + x, y: model.cityOrigin.y + y }
      expect(model.waterAt(p)).toBe(false)
      expect(forest.some(a => inside(p, a.polygon))).toBe(false)
    }
  })
  it('keeps downstream area nondecreasing and channel surface nonincreasing', () => {
    expect(model.rivers.length).toBeGreaterThan(0)
    for (const river of model.rivers) for (let i = 1; i < river.points.length; i++) {
      expect(river.drainageArea[i]).toBeGreaterThanOrEqual(river.drainageArea[i - 1]!)
      expect(river.widths[i]).toBeGreaterThanOrEqual(river.widths[i - 1]!)
      expect(river.surfaceElevation[i]).toBeLessThanOrEqual(river.surfaceElevation[i - 1]!)
    }
  })
  it('keeps visible tributary confluences connected after channel smoothing', () => {
    for (const river of model.rivers.filter(r => r.id !== 'river')) {
      const endpoint = river.points.at(-1)!
      if (endpoint.x <= 0 || endpoint.x >= defaults.width || endpoint.y <= 0 || endpoint.y >= defaults.height) continue
      const joined = model.rivers.some(other => other !== river && other.points.some(p => Math.hypot(p.x - endpoint.x, p.y - endpoint.y) < .01))
      expect(joined).toBe(true)
      expect(model.waterAt(endpoint)).toBe(true)
    }
  })
  it('selects bridge candidates on water with dry, gently sloping banks', () => {
    expect(model.bridgeCandidates.length).toBeGreaterThan(0)
    // Every independent river barrier needs surveys. A global cap of eight
    // discarded the tributary between the town and all trunk bridge sites.
    expect(model.bridgeCandidates.every(site => model.rivers.some(r => r.id === site.riverId))).toBe(true)
    expect(model.bridgeSites.length).toBeLessThanOrEqual(3)
    expect(model.bridgeCandidates.some(c => c.riverId === 'river')).toBe(true)
    for (const bridge of model.bridgeCandidates) {
      expect(model.waterAt(bridge.point)).toBe(true)
      expect(model.waterAt(bridge.bankA)).toBe(false)
      expect(model.waterAt(bridge.bankB)).toBe(false)
      expect(model.slope(bridge.bankA)).toBeLessThan(.12)
      expect(model.slope(bridge.bankB)).toBeLessThan(.12)
    }
  })
  it('retains distinct surveys for the trunk and tributary barriers instead of assuming one bridge crosses the whole valley', () => {
    // A laterally adjoining tributary can require a second bridge. Requiring a
    // fixed straight road from one trunk bank to the viewport edge would force
    // the terrain model to delete a valid tributary whenever drainage changes.
    const trunk = model.bridgeCandidates.filter(c => c.riverId === 'river')
    const tributaries = model.bridgeCandidates.filter(c => c.riverId !== 'river')
    expect(trunk.length).toBeGreaterThanOrEqual(2)
    expect(tributaries.length).toBeGreaterThan(0)
    for (const id of new Set(model.bridgeCandidates.map(c => c.riverId))) {
      const sites = model.bridgeCandidates.filter(c => c.riverId === id)
      for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) expect(Math.hypot(sites[i]!.point.x - sites[j]!.point.x, sites[i]!.point.y - sites[j]!.point.y)).toBeGreaterThan(600)
    }
  })
  it('continues physical water and ground beyond the viewport within an explicit surveyed boundary', () => {
    const continuation = model.continuationTerrain!
    for (const p of [{ x: 120, y: 200 }, { x: 2200, y: 1700 }, { x: 3900, y: 2700 }]) {
      expect(continuation.waterAt(p)).toBe(model.waterAt(p))
      expect(continuation.elevation(p)).toBe(model.elevation(p))
    }
    const outside = model.rivers.flatMap(r => r.points).filter(p => (p.x < -20 || p.x > defaults.width + 20 || p.y < -20 || p.y > defaults.height + 20) && continuation.contains(p))
    expect(outside.some(p => continuation.waterAt(p))).toBe(true)
    expect(continuation.contains({ x: -600, y: 1000 })).toBe(false)
    expect(() => continuation.waterAt({ x: -600, y: 1000 })).toThrow(RangeError)
  })
  it('makes forest amount monotonic and excludes water from cultivable land', () => {
    const empty = createTerrainModel({ ...defaults, forest: 0 }), full = createTerrainModel({ ...defaults, forest: 100 })
    expect(empty.areas.some(a => a.kind === 'forest')).toBe(false)
    const woodedArea = (m: typeof model) => m.areas.filter(a => a.kind === 'forest').reduce((sum, a) => sum + polygonArea(a.polygon), 0)
    expect(woodedArea(full)).toBeGreaterThan(woodedArea(model))
    for (const bridge of model.bridgeSites) expect(model.cultivable(bridge)).toBe(false)
    expect(model.cultivable(model.cityOrigin)).toBe(true)
  })
  for (const terrain of ['plain', 'river', 'coast'] as const) it(`${terrain}: exact water occupancy and valid visible polygon boundaries`, () => {
    const m = createTerrainModel({ ...defaults, terrain, forest: 100 }), water = m.areas.filter(a => a.kind === 'water')
    if (terrain === 'coast') expect(water.some(a => a.id === 'sea')).toBe(true)
    for (let x = 37; x < 4000; x += 181) for (let y = 29; y < 3000; y += 173) expect(m.waterAt({ x, y })).toBe(water.some(a => inside({ x, y }, a.polygon) && !a.holes?.some(h => inside({ x, y }, h))))
    for (const region of m.areas) {
      const p = region.polygon
      expect(p.every(q => q.x >= 0 && q.y >= 0 && q.x <= 4000 && q.y <= 3000)).toBe(true)
      let selfIntersects = false
      for (let i = 0; i < p.length; i++) for (let j = i + 2; j < p.length; j++) {
        if (i === 0 && j === p.length - 1) continue
        if (crosses(p[i]!, p[(i + 1) % p.length]!, p[j]!, p[(j + 1) % p.length]!)) selfIntersects = true
      }
      expect(selfIntersects, region.id).toBe(false)
    }
  })
})
