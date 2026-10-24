import { expect, it } from 'vitest'
import { placeNameChoices, provisionalPlaceName, readableProvisionalNames } from './place-names'
import type { CityMap } from './types'

it('gives hundreds of towns readable, unique names without ordinal placeholders', () => {
  const used = new Set(['水杜市'])
  for (let i = 0; i < 400; i++) {
    const input = { seed: 'names', id: `town-${i}`, kind: 'town' as const, direction: '北' }
    const name = provisionalPlaceName(input, used)
    expect(name).toMatch(/町$/)
    expect(name).not.toMatch(/[0-9０-９第]|丁$|[湯泉川河沢津浜浦汐潮渚洲瀬湖池]/)
    expect(used.has(name)).toBe(false)
    expect(provisionalPlaceName(input, used)).toBe(name)
    used.add(name)
  }
})
it('keeps wards and geothermal/waterside names in their proper context', () => {
  const plain = placeNameChoices({ seed: 'x', id: 'x', kind: 'ward' })
  expect(plain.every(name => name.endsWith('区') && !/[0-9第湯泉川河沢津浜浦汐潮渚洲瀬湖池]/.test(name))).toBe(true)
  const waterside = placeNameChoices({ seed: 'x', id: 'x', nearWater: true, onsen: true })
  expect(waterside).toContain('湯本町')
  expect(waterside).toContain('水明町')
})
it('repairs a saved ordinal label without rewriting user names or physical geometry', () => {
  const map = { width: 4000, height: 3000, config: { seed: 'old', name: '旧市' }, districts: [
    { id: 'a', point: { x: 100, y: 100 }, name: '第1町', kind: 'town', namingSource: 'provisional' },
    { id: 'b', point: { x: 300, y: 100 }, name: '第2町', kind: 'town', namingSource: 'edited' },
  ], roads: [{ id: 'real-road' }] } as CityMap
  const result = readableProvisionalNames(map)
  expect(result.districts[0]!.name).not.toBe('第1町')
  expect(result.districts[1]!.name).toBe('第2町')
  expect(result.roads).toBe(map.roads)
  expect(map.districts[0]!.name).toBe('第1町')
})
