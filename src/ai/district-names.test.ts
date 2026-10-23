import { expect, it } from 'vitest'
import { parseNameProposals } from './district-names'

const districts = [{ id: 'town-1', kind: 'town' as const }, { id: 'ward-1', kind: 'ward' as const }]
const valid = { names: [{ id: 'town-1', name: '湯本町', reason: '温泉宿が集まる区域の命名案。' }, { id: 'ward-1', name: '西山区', reason: '西側の山地に沿う区域の命名案。' }] }
it('accepts checked proposals and preserves identities', () => {
  expect(parseNameProposals(JSON.stringify(valid), districts)).toEqual(valid.names)
  expect(parseNameProposals('```json\n' + JSON.stringify(valid) + '\n```', districts)).toEqual(valid.names)
})
it('rejects missing, invented or repeated IDs and names before modifying a map', () => {
  for (const names of [valid.names.slice(0, 1), [valid.names[0], valid.names[0]], [{ ...valid.names[0], id: 'imaginary' }, valid.names[1]], [{ ...valid.names[0], name: '西山区' }, valid.names[1]], [{ ...valid.names[0], name: '<script>' }, valid.names[1]], [valid.names[0], { ...valid.names[1], name: '山町' }]]) expect(() => parseNameProposals(JSON.stringify({ names }), districts)).toThrow()
  expect(() => parseNameProposals(JSON.stringify(valid), districts, ['湯本町'])).toThrow()
  expect(() => parseNameProposals(JSON.stringify({ names: [{ ...valid.names[0], name: '水杜市' }, valid.names[1]] }), districts)).toThrow()
})
