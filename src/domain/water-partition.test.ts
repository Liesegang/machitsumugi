import { describe, expect, it } from 'vitest'
import type { Area } from './types'
import { pointInRegion, regionArea } from './geometry'
import { partitionWaterAreas } from './water-partition'

const box = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
describe('mutually exposed marine and inland waters', () => {
  it('drowns a negative lake in connected sea without mutating an old saved map', () => {
    const sea: Area = { id: 'sea', kind: 'water', polygon: box(0, 0, 100, 100), waterLevel: 0 }
    const lake: Area = { id: 'lake-123955-0', name: '湖', kind: 'water', polygon: box(20, 20, 50, 50), waterLevel: -2.3234 }
    const before = structuredClone([lake, sea]), result = partitionWaterAreas([lake, sea])
    expect(result.map(a => a.id)).toEqual(['sea'])
    expect([lake, sea]).toEqual(before)
  })
  it('retains an inland lagoon remainder and real island holes, rather than deleting a touching lake', () => {
    const sea: Area = { id: 'sea', kind: 'water', polygon: box(0, 0, 100, 100), holes: [box(30, 30, 20, 20)], waterLevel: 0 }
    const lake: Area = { id: 'lake', kind: 'water', polygon: box(20, 20, 120, 60), waterLevel: 2 }
    const result = partitionWaterAreas([lake, sea]), lakes = result.filter(a => a.id.startsWith('lake'))
    expect(lakes.reduce((sum, a) => sum + regionArea(a), 0)).toBeCloseTo(2800)
    expect(lakes.some(a => pointInRegion({ x: 40, y: 40 }, a))).toBe(true)
    expect(lakes.some(a => pointInRegion({ x: 80, y: 40 }, a))).toBe(false)
    expect(lakes.some(a => pointInRegion({ x: 120, y: 40 }, a))).toBe(true)
    expect(result.find(a => a.id === 'sea')!.holes).toEqual(sea.holes)
  })
  it('keeps submerged hydraulic paths but exposes only the channel outside lake and sea', () => {
    const river: Area = { id: 'river', kind: 'water', polygon: box(0, 40, 300, 20) }
    const sea: Area = { id: 'sea', kind: 'water', polygon: box(200, 0, 100, 100), waterLevel: 0 }
    const lake: Area = { id: 'lake', kind: 'water', polygon: box(50, 20, 100, 60), waterLevel: 3 }
    const result = partitionWaterAreas([river, lake, sea]), exposed = result.filter(a => a.id.startsWith('river'))
    expect(exposed.reduce((sum, a) => sum + regionArea(a), 0)).toBeCloseTo(2000)
    expect(exposed.some(a => pointInRegion({ x: 20, y: 50 }, a))).toBe(true)
    expect(exposed.some(a => pointInRegion({ x: 100, y: 50 }, a))).toBe(false)
    expect(exposed.some(a => pointInRegion({ x: 250, y: 50 }, a))).toBe(false)
    expect(partitionWaterAreas(result)).toEqual(result)
  })
})
