import { expect, it } from 'vitest'
import { districtNameCandidates, parseNameProposals, parseNameSelection, parseSingleNameProposal } from './district-names'
import type { CityMap, District } from '../domain/types'

const districts = [{ id: 'town-1', kind: 'town' as const }, { id: 'ward-1', kind: 'ward' as const }]
const valid = { names: [{ id: 'town-1', name: '湯本町', reason: '温泉宿が集まる区域の命名案。' }, { id: 'ward-1', name: '西山区', reason: '西側の山地に沿う区域の命名案。' }] }
it('accepts checked proposals and preserves identities', () => {
  expect(parseNameProposals(JSON.stringify(valid), districts)).toEqual(valid.names)
  expect(parseNameProposals('```json\n' + JSON.stringify(valid) + '\n```', districts)).toEqual(valid.names)
})
it('assigns a single text proposal to the requested map identity', () => {
  expect(parseSingleNameProposal('{"id":"a hallucinated ID","name":"川端町","reason":"川沿いの区域にちなんだ命名案。"}', districts[0]!, [])).toEqual({ id: 'town-1', name: '川端町', reason: '川沿いの区域にちなんだ命名案。' })
})
it('rejects missing, invented or repeated IDs and names before modifying a map', () => {
  for (const names of [valid.names.slice(0, 1), [valid.names[0], valid.names[0]], [{ ...valid.names[0], id: 'imaginary' }, valid.names[1]], [{ ...valid.names[0], name: '西山区' }, valid.names[1]], [{ ...valid.names[0], name: '<script>' }, valid.names[1]], [valid.names[0], { ...valid.names[1], name: '山町' }]]) expect(() => parseNameProposals(JSON.stringify({ names }), districts)).toThrow()
  expect(() => parseNameProposals(JSON.stringify(valid), districts, ['湯本町'])).toThrow()
  expect(() => parseNameProposals(JSON.stringify({ names: [{ ...valid.names[0], name: '水杜市' }, valid.names[1]] }), districts)).toThrow()
})
it('accepts only an in-range integer choice and binds identity to the actual district', () => {
  expect(parseNameSelection('{"choice":2,"id":"invented"}', districts[0]!, ['青葉町', '若葉町'], [], '実測した区域の特徴')).toEqual({ id: 'town-1', name: '若葉町', reason: '実測した区域の特徴' })
  expect(parseNameSelection('{"choice":"2"}', districts[0]!, ['青葉町', '若葉町'], [], '実測した区域の特徴').name).toBe('若葉町')
  for (const choice of [0, 3, -1, 1.5, '01', '1e0', '-1', '1.5', ' 1', '候補1', null]) expect(() => parseNameSelection(JSON.stringify({ choice }), districts[0]!, ['青葉町', '若葉町'], [], '特徴')).toThrow()
  expect(() => parseNameSelection('{"choice":1}', districts[0]!, ['青葉町'], ['青葉町'], '特徴')).toThrow()
})
it('offers stable, distinct names without inventing water or hot springs inland', () => {
  const district = { id: 'town-inland', kind: 'town', name: '仮町', point: { x: 500, y: 500 } } as District
  const map = { config: { seed: 'names', name: '架空市' }, width: 1000, height: 1000, districts: [district], buildings: [], areas: [], facilities: [] } as unknown as CityMap
  const names = districtNameCandidates(map, district)
  expect(names).toHaveLength(16)
  expect(names).toEqual(districtNameCandidates(map, district))
  expect(new Set(names).size).toBe(16)
  expect(names.every(name => name.endsWith('町') && !/[湯泉川河沢津浜浦汐潮渚洲瀬湖池]/.test(name))).toBe(true)
  expect(districtNameCandidates(map, district, names).every(name => !names.includes(name))).toBe(true)
  expect(districtNameCandidates(map, { ...district, kind: 'ward' }).every(name => name.endsWith('区'))).toBe(true)
})
it('keeps supplying distinct valid names after the ordinary vocabulary is exhausted', () => {
  const district = { id: 'town-inland', kind: 'town', name: '仮町', point: { x: 500, y: 500 } } as District
  const map = { config: { seed: 'names', name: '架空市' }, width: 1000, height: 1000, districts: [district], buildings: [], areas: [], facilities: [] } as unknown as CityMap
  const used: string[] = []
  for (let i = 0; i < 300; i++) {
    const candidates = districtNameCandidates(map, district, used)
    expect(candidates).toHaveLength(16)
    const proposal = parseNameSelection('{"choice":1}', district, candidates, used, '観測した特徴')
    used.push(proposal.name)
  }
  expect(new Set(used).size).toBe(300)
  expect(used.some(name => name.endsWith('丁目'))).toBe(true)
  const largeBatch = used.map((name, index) => ({ id: `town-${index}`, name, reason: '観測値'.repeat(80) }))
  const text = JSON.stringify({ names: largeBatch })
  expect(text.length).toBeGreaterThan(30_000)
  expect(parseNameProposals(text, largeBatch.map(row => ({ id: row.id, kind: 'town' })))).toHaveLength(300)
  expect(parseNameProposals(JSON.stringify({ names: [{ id: district.id, name: '青葉1丁目', reason: '利用者が編集', source: 'edited' }] }), [district])[0]?.source).toBe('edited')
})
