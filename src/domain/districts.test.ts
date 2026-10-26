import { afterEach, describe, expect, it, vi } from 'vitest'
import * as polygonClipping from 'polygon-clipping'
import ClipperLib from 'clipper-lib'
import { buildDistricts, districtMergeDiagnostics, mergeDistrictRegions } from './districts'
import type { DistrictInput } from './districts'
import type { Parcel, Road } from './types'
import type { PolygonRegion } from './geometry'
import { intersectRegions, pointInRegion, polygonArea, rectangle, regionArea, subtractRegions } from './geometry'

vi.mock('polygon-clipping', async importOriginal => {
  const actual = await importOriginal<typeof import('polygon-clipping')>()
  const library = ('default' in actual ? actual.default : actual) as typeof actual
  return { ...actual, ...library, union: vi.fn(library.union) }
})

const config: DistrictInput['config'] = { name: '試験市', seed: 'districts', type: 'castle', terrain: 'river', density: 65, forest: 30, railway: false, stations: 0, arterial: true, facilities: [], settlement: 'regional-city' }
const parcel = (id: string, x: number, y: number, roadId: string, year = 1900): Parcel => ({ id, polygon: rectangle(x, y, 20, 30), entrance: { x, y: y + 15 }, roadId, createdYear: year, developedYear: year + 5, use: 'residential' })
const contains = (district: ReturnType<typeof buildDistricts>[number], point: { x: number; y: number }) => district.regions!.some(region => pointInRegion(point, region))

function grid(columns = 4, rows = 4): DistrictInput {
  const roads: Road[] = [], blocks: DistrictInput['blocks'] = [], parcels: Parcel[] = []
  for (let x = 0; x <= columns; x++) roads.push({ id: `vertical-${x}`, points: Array.from({ length: rows + 1 }, (_, y) => ({ x: x * 200, y: y * 180 })), kind: x === 2 ? 'arterial' : 'local', width: x === 2 ? 12 : 5, builtYear: 1700 })
  for (let y = 0; y <= rows; y++) roads.push({ id: `horizontal-${y}`, points: Array.from({ length: columns + 1 }, (_, x) => ({ x: x * 200, y: y * 180 })), kind: 'local', width: 5, builtYear: 1700 })
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    blocks.push({ id: `block-${x}-${y}`, polygon: rectangle(x * 200, y * 180, 200, 180) })
    parcels.push(parcel(`lot-${x}-${y}`, x * 200 + 12, y * 180 + 30, `vertical-${x}`, 1700 + y * 20))
  }
  return { width: columns * 200 + 500, height: rows * 180 + 500, config, roads, blocks, parcels, areas: [] }
}

describe('street- and parcel-derived district territories', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    const actual = await vi.importActual<typeof import('polygon-clipping')>('polygon-clipping')
    const library = ('default' in actual ? actual.default : actual) as typeof actual
    vi.mocked(polygonClipping.union).mockReset().mockImplementation(library.union)
  })

  it('keeps successful floating unions unchanged, including coordinates finer than the fallback grid', () => {
    const value = 123.123456789, before = districtMergeDiagnostics.integerFallbacks
    const result = mergeDistrictRegions([{ polygon: rectangle(value, 10, 10, 10) }, { polygon: rectangle(value + 5, 10, 10, 10) }])
    expect(result.some(region => region.polygon.some(point => point.x === value))).toBe(true)
    expect(districtMergeDiagnostics.integerFallbacks).toBe(before)
  })

  it('retains holes, nested islands and disconnected fill when floating union cannot complete a ring', () => {
    const x = 6000.1234567, y = 4000.7654321, regions: PolygonRegion[] = [
      { polygon: rectangle(x, y, 100, 100), holes: [rectangle(x + 20, y + 20, 20, 20).reverse()] },
      { polygon: rectangle(x + 90, y, 50, 100).reverse() },
      { polygon: rectangle(x + 25, y + 25, 5, 5) },
      { polygon: rectangle(x + 200, y + 50, 10, 10) },
    ]
    const expected = mergeDistrictRegions(regions), before = JSON.stringify(regions), failed = vi.fn()
    for (const region of regions) for (const ring of [region.polygon, ...(region.holes ?? [])]) { ring.forEach(Object.freeze); Object.freeze(ring) }
    vi.mocked(polygonClipping.union).mockImplementationOnce(() => { throw new Error('Unable to complete output ring starting at native-like contact') })
    const result = mergeDistrictRegions(regions, failed)
    expect(failed).toHaveBeenCalledWith(regions, expect.any(Error))
    expect(JSON.stringify(regions)).toBe(before)
    expect(result.reduce((sum, region) => sum + regionArea(region), 0)).toBeCloseTo(13725, 4)
    for (const [point, covered] of [[{ x: x + 10, y: y + 10 }, true], [{ x: x + 22, y: y + 22 }, false], [{ x: x + 27, y: y + 27 }, true], [{ x: x + 205, y: y + 55 }, true], [{ x: x + 170, y: y + 55 }, false]] as const) expect(result.some(region => pointInRegion(point, region))).toBe(covered)
    for (const [subjects, cuts] of [[result, expected], [expected, result]]) expect(subjects.reduce((sum, region) => sum + subtractRegions(region, cuts).reduce((area, part) => area + regionArea(part), 0), 0)).toBeLessThan(.001)
  })

  it('normalizes exact zero-fill backtracking while preserving both genuine figure-eight lobes', () => {
    const a = { x: .00000123, y: .00000234 }, b = { x: 1.234567, y: .345678 }, c = { x: 1234.567, y: 3456.78 }, backtrack = [a, b, c, b]
    expect(polygonArea(backtrack)).toBeGreaterThan(0) // Floating cancellation noise, not fill.
    const regions = [{ polygon: backtrack }, { polygon: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }] }, { polygon: rectangle(20, 0, 5, 5) }], before = JSON.stringify(regions), normalized = districtMergeDiagnostics.normalizedEmptyRings
    vi.mocked(polygonClipping.union).mockImplementationOnce(() => { throw new Error('float ring failure') })
    const result = mergeDistrictRegions(regions)
    expect(result.reduce((sum, region) => sum + regionArea(region), 0)).toBeCloseTo(75, 6)
    expect(districtMergeDiagnostics.normalizedEmptyRings).toBeGreaterThan(normalized)
    expect(result.some(region => pointInRegion({ x: 2, y: 1 }, region))).toBe(true)
    expect(result.some(region => pointInRegion({ x: 2, y: 9 }, region))).toBe(true)
    expect(result.some(region => pointInRegion({ x: .5, y: 5 }, region))).toBe(false)
    expect(JSON.stringify(regions)).toBe(before)
  })

  it('retains every exact source component and hole if the integer backend also fails', () => {
    const regions = [{ polygon: rectangle(0, 0, 50, 50), holes: [rectangle(10, 10, 10, 10)] }, { polygon: rectangle(100, 0, 20, 20) }], before = JSON.stringify(regions), fallbacks = districtMergeDiagnostics.exactSourceFallbacks
    vi.mocked(polygonClipping.union).mockImplementationOnce(() => { throw new Error('floating backend failed') })
    vi.spyOn(ClipperLib.Clipper.prototype, 'Execute').mockReturnValueOnce(false)
    expect(mergeDistrictRegions(regions)).toBe(regions)
    expect(JSON.stringify(regions)).toBe(before)
    expect(districtMergeDiagnostics.exactSourceFallbacks).toBe(fallbacks + 1)
    expect(regions.some(region => pointInRegion({ x: 15, y: 15 }, region))).toBe(false)
    expect(regions.some(region => pointInRegion({ x: 110, y: 10 }, region))).toBe(true)
  })

  it('keeps a genuinely positive sub-grid hole instead of filling it during fallback conversion', () => {
    const regions = [{ polygon: rectangle(0, 0, 10, 10), holes: [rectangle(1, 1, 1e-8, 1e-8)] }, { polygon: rectangle(20, 0, 5, 5) }], before = JSON.stringify(regions)
    vi.mocked(polygonClipping.union).mockImplementationOnce(() => { throw new Error('floating backend failed') })
    expect(mergeDistrictRegions(regions)).toBe(regions)
    expect(JSON.stringify(regions)).toBe(before)
    expect(regions.some(region => pointInRegion({ x: 1 + 5e-9, y: 1 + 5e-9 }, region))).toBe(false)
  })

  it('keeps all named territories and their complete area when floating district merges fail', () => {
    const input = grid(), expected = buildDistricts(input)
    vi.mocked(polygonClipping.union).mockImplementation(() => { throw new Error('floating backend failed') })
    const result = buildDistricts(input)
    expect(result.map(d => [d.id, d.name, d.kind, d.foundedYear])).toEqual(expected.map(d => [d.id, d.name, d.kind, d.foundedYear]))
    expect(result.reduce((sum, d) => sum + d.regions!.reduce((area, r) => area + regionArea(r), 0), 0)).toBe(800 * 720)
    for (const district of result) expect(contains(district, district.point)).toBe(true)
  })

  it('groups occupied street faces with shared road boundaries, without filling surrounding countryside', () => {
    const input = grid(), districts = buildDistricts(input)
    expect(districts.length).toBeGreaterThan(2)
    expect(districts.length).toBeLessThan(input.blocks.length)
    expect(districts.every(d => d.kind === 'town' && d.namingSource === 'provisional' && d.foundedYear! >= 1700)).toBe(true)
    expect(districts.reduce((sum, d) => sum + d.regions!.reduce((n, r) => n + regionArea(r), 0), 0)).toBe(800 * 720)
    for (const d of districts) {
      expect(contains(d, d.point)).toBe(true)
      expect(contains(d, { x: 1100, y: 1000 })).toBe(false)
    }
    for (let i = 0; i < districts.length; i++) for (let j = i + 1; j < districts.length; j++) for (const a of districts[i]!.regions!) for (const b of districts[j]!.regions!) expect(intersectRegions(a, b).reduce((sum, r) => sum + regionArea(r), 0)).toBeLessThan(.001)
    // Every positive-area street face belongs to exactly one town as a whole,
    // rather than being cut through by a distance-to-label Voronoi boundary.
    for (const b of input.blocks) expect(districts.filter(d => contains(d, { x: b.polygon[0]!.x + 100, y: b.polygon[0]!.y + 90 }))).toHaveLength(1)
  })

  it('splits an occupied face at actual river and woodland geometry, retaining islands and holes', () => {
    const input: DistrictInput = { width: 500, height: 200, config, roads: [], blocks: [{ id: 'river-block', polygon: rectangle(0, 0, 400, 100) }], parcels: [parcel('west', 20, 20, 'west'), parcel('east', 350, 20, 'east')], areas: [{ id: 'river', kind: 'water', polygon: rectangle(180, 0, 40, 100) }, { id: 'grove', kind: 'forest', polygon: rectangle(100, 40, 20, 20) }] }
    const districts = buildDistricts(input)
    expect(districts).toHaveLength(2)
    expect(districts.some(d => contains(d, { x: 200, y: 50 }))).toBe(false)
    expect(districts.some(d => contains(d, { x: 110, y: 50 }))).toBe(false)
    expect(districts.some(d => d.regions!.some(r => r.holes?.length))).toBe(true)
    expect(districts.every(d => contains(d, d.point))).toBe(true)
    expect(districts.reduce((sum, d) => sum + d.regions!.reduce((n, r) => n + regionArea(r), 0), 0)).toBe(35600)
  })

  it('follows real open-street frontage while leaving the undeveloped gap and retired titles outside', () => {
    const road: Road = { id: 'valley', points: [{ x: 0, y: 50 }, { x: 1000, y: 50 }], kind: 'local', width: 5 }
    const input: DistrictInput = { width: 1200, height: 300, config: { ...config, settlement: 'village' }, roads: [road], blocks: [], parcels: [parcel('one', 100, 70, 'valley', 1650), parcel('two', 145, 70, 'valley', 1750), parcel('remote', 900, 70, 'valley', 1900), { ...parcel('retired', 200, 70, 'valley'), retiredYear: 1980 }, { ...parcel('proposed', 250, 70, 'valley'), developedYear: undefined }], areas: [] }
    const districts = buildDistricts(input)
    expect(districts).toHaveLength(2)
    expect(districts.every(d => d.kind === 'town' && !d.parentId)).toBe(true)
    expect(districts.reduce((sum, d) => sum + d.regions!.reduce((n, r) => n + regionArea(r), 0), 0)).toBe(1800)
    expect(districts.some(d => contains(d, { x: 500, y: 85 }))).toBe(false)
    expect(districts.some(d => contains(d, { x: 210, y: 85 }))).toBe(false)
    expect(districts.find(d => contains(d, { x: 110, y: 85 }))!.foundedYear).toBe(1650)
  })

  it('does not turn a very large, sparsely inhabited road loop into a blanket territory', () => {
    const input = grid(1, 1)
    input.width = input.height = 3000
    input.blocks = [{ id: 'countryside-loop', polygon: rectangle(0, 0, 2500, 2500) }]
    const districts = buildDistricts(input)
    expect(districts).toHaveLength(1)
    expect(districts[0]!.regions!.reduce((n, r) => n + regionArea(r), 0)).toBe(600)
    expect(contains(districts[0]!, { x: 2000, y: 2000 })).toBe(false)
  })

  it('attaches a final inhabited frontage remnant through its real road instead of naming each house separately', () => {
    const input: DistrictInput = {
      width: 800, height: 600, config, areas: [], blocks: [{ id: 'large-inhabited-face', polygon: rectangle(100, 50, 500, 400) }],
      roads: [{ id: 'edge-street', points: [{ x: 100, y: 0 }, { x: 100, y: 500 }], kind: 'local', width: 5 }],
      parcels: [...Array.from({ length: 40 }, (_, i) => parcel(`old-${i}`, 110 + i % 5 * 25, 70 + Math.floor(i / 5) * 40, 'edge-street', 1700)), parcel('later-frontage', 65, 100, 'edge-street', 1900)],
    }
    const districts = buildDistricts(input)
    expect(districts).toHaveLength(1)
    expect(contains(districts[0]!, { x: 75, y: 115 })).toBe(true)
    expect(contains(districts[0]!, { x: 250, y: 200 })).toBe(true)
  })

  it('is deterministic under collection reordering and has no labels without recorded occupation', () => {
    const input = grid()
    expect(buildDistricts({ ...input, roads: [...input.roads].reverse(), blocks: [...input.blocks].reverse(), parcels: [...input.parcels].reverse() })).toEqual(buildDistricts(input))
    expect(buildDistricts({ ...input, parcels: [] })).toEqual([])
  })

  it('dates the oldest recorded local title including retired development, rather than claiming legal establishment', () => {
    const input = grid(1, 1)
    input.parcels = [parcel('current', 20, 30, 'vertical-0', 1970), { ...parcel('old-retired', 70, 30, 'vertical-0', 1650), retiredYear: 1960 }, { ...parcel('outside-retired', 500, 900, 'other', 1500), retiredYear: 1800 }, { ...parcel('unbuilt-proposal', 100, 30, 'vertical-0', 1600), developedYear: undefined }]
    const districts = buildDistricts(input)
    expect(districts).toHaveLength(1)
    expect(districts[0]!.foundedYear).toBe(1650)
    expect(districts[0]!.namingSource).toBe('provisional')
    expect(districts[0]!.nameOrigin).toBeUndefined()
  })

  it('adds upper wards only for metropolitan catchments and preserves the exact town territories', () => {
    const input = grid(7, 7)
    input.config = { ...config, settlement: 'metropolis' }
    const districts = buildDistricts(input), towns = districts.filter(d => d.kind === 'town'), wards = districts.filter(d => d.kind === 'ward')
    expect(towns.length).toBeGreaterThanOrEqual(8)
    expect(wards.length).toBeGreaterThan(0)
    expect(wards.length).toBeLessThan(towns.length)
    expect(towns.every(town => wards.some(ward => ward.id === town.parentId))).toBe(true)
    for (const ward of wards) {
      const children = towns.filter(town => town.parentId === ward.id)
      expect(ward.regions!.reduce((sum, r) => sum + regionArea(r), 0)).toBeCloseTo(children.reduce((sum, town) => sum + town.regions!.reduce((n, r) => n + regionArea(r), 0), 0), 5)
      expect(contains(ward, ward.point)).toBe(true)
    }
  })
})
