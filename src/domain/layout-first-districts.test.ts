import { describe, expect, it } from 'vitest'
import { buildLayoutFirstDistricts } from './layout-first-districts'
import { buildDistricts } from './districts'
import type { DistrictInput } from './districts'
import type { Parcel, Road } from './types'
import { pointInRegion, rectangle, regionArea } from './geometry'

const config: DistrictInput['config'] = { name: '広域試験市', seed: 'coherent-urban-wards', type: 'post', terrain: 'plain', density: 80, forest: 20, railway: false, stations: 1, arterial: true, facilities: [], settlement: 'metropolis' }
function grid(columns: number, rows: number, offset = 0, prefix = ''): Pick<DistrictInput, 'roads' | 'parcels' | 'blocks'> {
  const roads: Road[] = [], parcels: Parcel[] = [], blocks: DistrictInput['blocks'] = []
  for (let x = 0; x <= columns; x++) roads.push({ id: `${prefix}vertical-${x}`, points: Array.from({ length: rows + 1 }, (_, y) => ({ x: offset + x * 300, y: y * 300 })), kind: 'local', width: 6, builtYear: 1700 })
  for (let y = 0; y <= rows; y++) roads.push({ id: `${prefix}horizontal-${y}`, points: Array.from({ length: columns + 1 }, (_, x) => ({ x: offset + x * 300, y: y * 300 })), kind: 'local', width: 6, builtYear: 1700 })
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    blocks.push({ id: `${prefix}block-${x}-${y}`, polygon: rectangle(offset + x * 300, y * 300, 300, 300) })
    for (let i = 0; i < 12; i++) {
      const px = offset + x * 300 + 12 + i % 4 * 45, py = y * 300 + 20 + Math.floor(i / 4) * 55
      parcels.push({ id: `${prefix}title-${x}-${y}-${i}`, polygon: rectangle(px, py, 28, 30), entrance: { x: offset + x * 300, y: py + 15 }, roadId: `${prefix}vertical-${x}`, createdYear: 1700 + y % 3 * 50, developedYear: 1700 + y % 3 * 50, use: 'residential' })
    }
  }
  return { roads, parcels, blocks }
}
const area = (district: ReturnType<typeof buildLayoutFirstDistricts>[number]) => district.regions!.reduce((sum, region) => sum + regionArea(region), 0)

describe('layout-first towns and broad administrative catchments', () => {
  it('preserves named town geometry and founding records while suppressing all upper wards in a4x3km crop', () => {
    const input: DistrictInput = { width: 4000, height: 3000, config, areas: [], ...grid(6, 5) }
    const baseline = buildDistricts({ ...input, config: { ...config, settlement: 'regional-city' } })
    expect(baseline.length).toBeGreaterThan(8)
    expect(buildLayoutFirstDistricts(input)).toEqual(baseline)
    expect(buildLayoutFirstDistricts(input).some(d => d.kind === 'ward')).toBe(false)
  })
  it('forms only2–6 broad road-connected wards from occupied town regions in an8x6km crop', () => {
    const input: DistrictInput = { width: 8000, height: 6000, config, areas: [], ...grid(20, 12) }
    const baseline = buildDistricts({ ...input, config: { ...config, settlement: 'regional-city' } })
    const result = buildLayoutFirstDistricts(input), wards = result.filter(d => d.kind === 'ward'), towns = result.filter(d => d.kind === 'town')
    expect(wards.length).toBeGreaterThanOrEqual(2); expect(wards.length).toBeLessThanOrEqual(6)
    expect(towns.map(({ parentId: _parent, ...town }) => town)).toEqual(baseline)
    expect(towns.every(town => wards.some(ward => ward.id === town.parentId))).toBe(true)
    expect(new Set(result.map(d => d.name)).size).toBe(result.length)
    for (const ward of wards) {
      const children = towns.filter(town => town.parentId === ward.id)
      expect(area(ward)).toBeGreaterThanOrEqual(8_000_000); expect(area(ward)).toBeLessThanOrEqual(30_000_000)
      expect(area(ward)).toBeCloseTo(children.reduce((sum, town) => sum + area(town), 0), 3)
      expect(ward.regions!.some(region => pointInRegion(ward.point, region))).toBe(true)
      expect(ward.regions!.some(region => pointInRegion({ x: 7900, y: 5900 }, region))).toBe(false)
    }
  })
  it('does not join disconnected urban road systems or turn sparse large-map frontage into blanket wards', () => {
    const west = grid(10, 12, 0, 'west-'), east = grid(10, 12, 4000, 'east-')
    const input: DistrictInput = { width: 9000, height: 6000, config, areas: [], roads: [...west.roads, ...east.roads], parcels: [...west.parcels, ...east.parcels], blocks: [...west.blocks, ...east.blocks] }
    const result = buildLayoutFirstDistricts(input)
    expect(result.length).toBeGreaterThan(200)
    expect(result.some(d => d.kind === 'ward')).toBe(false)
    expect(result.every(d => !d.parentId)).toBe(true)
    const sparse: DistrictInput = { width: 12000, height: 9000, config, areas: [], ...grid(4, 4) }
    expect(buildLayoutFirstDistricts(sparse).some(d => d.kind === 'ward')).toBe(false)
  })
})
