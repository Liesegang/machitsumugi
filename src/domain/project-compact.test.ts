import { describe, expect, it } from 'vitest'
import { COMPACT_PROJECT_LIMITS, decodeCompactProject, encodeCompactProject, isCompactProject } from './project-compact'

const wire = (value: unknown) => JSON.parse(JSON.stringify(encodeCompactProject(value)))
describe('lossless compact project wire format', () => {
  it('roundtrips all JSON primitives, array tag collisions, repeated strings and nested undefined semantics', () => {
    const tags = [0, 1, -1, 1.25, [1, 0], [-1, 2], null, true, false, undefined, -0]; tags.length++
    const value = { version: 2, absent: undefined, payload: { empty: {}, array: [], tags, names: ['同じ文字列', '同じ文字列', '', '0', '1'], point: { x: 12.3456789012345, y: -4.00000000000001 }, nested: { keep: 0, omit: undefined }, '': 'empty key' } }
    const compact = wire(value)
    expect(isCompactProject(compact)).toBe(true)
    expect(compact.strings.filter((text: string) => text === '同じ文字列')).toHaveLength(1)
    expect(decodeCompactProject(compact)).toEqual(JSON.parse(JSON.stringify(value)))
    expect(encodeCompactProject(value)).toEqual(encodeCompactProject(value))
    expect(compact.schemas.every((keys: string[]) => JSON.stringify(keys) === JSON.stringify([...keys].sort()))).toBe(true)
  })
  it('preserves shared data references by value while rejecting cycles, accessors and non-JSON values', () => {
    const shared = { x: 1, y: 2 }
    expect(decodeCompactProject(wire({ version: 2, a: shared, b: shared }))).toEqual({ version: 2, a: shared, b: shared })
    const cyclic: Record<string, unknown> = { version: 2 }; cyclic.self = cyclic
    expect(() => encodeCompactProject(cyclic)).toThrow()
    expect(() => encodeCompactProject({ version: 2, value: Infinity })).toThrow()
    expect(() => encodeCompactProject({ version: 2, value: BigInt(1) })).toThrow()
    expect(() => encodeCompactProject({ version: 2, get value() { throw new Error('must not execute') } })).toThrow(/プロパティ/)
  })
  it('rejects malformed dictionaries, dangerous keys and invalid string/schema references', () => {
    const valid = wire({ version: 2, name: 'name' })
    for (const bad of [
      { ...valid, format: 'other' }, { ...valid, extra: true }, { ...valid, schemas: [['version', 'name']] },
      { ...valid, schemas: [['constructor', 'version']] }, { ...valid, schemas: [['__proto__', 'version']] }, { ...valid, schemas: [['prototype', 'version']] },
      { ...valid, schemas: [['version', 'version']] }, { ...valid, schemas: [['version'], ['version']] },
      { ...valid, strings: ['same', 'same'] }, { ...valid, data: [1, 999] }, { ...valid, data: [1, -1] },
      { ...valid, data: [1, .5] }, { ...valid, data: [1, 0, 0] }, { ...valid, data: [-999, 2] },
      { ...valid, data: [-1] }, { ...valid, data: [2] }, { ...valid, data: [.5] }, { ...valid, data: [] },
      { ...valid, data: 'raw string' }, { ...valid, data: NaN }, { ...valid, data: [0, 2] },
    ]) expect(() => decodeCompactProject(bad)).toThrow()
    expect(() => encodeCompactProject(JSON.parse('{"version":2,"__proto__":{"polluted":true}}'))).toThrow()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
  it('enforces depth, dictionary and array budgets before allocating decoded trees', () => {
    let nested: unknown = null
    for (let i = 0; i <= COMPACT_PROJECT_LIMITS.depth; i++) nested = [nested]
    expect(() => encodeCompactProject({ version: 2, nested })).toThrow(/深さ/)
    const valid = wire({ version: 2 })
    expect(() => decodeCompactProject({ ...valid, schemas: Array.from({ length: COMPACT_PROJECT_LIMITS.schemas + 1 }, () => []) })).toThrow()
    expect(() => decodeCompactProject({ ...valid, strings: ['x'.repeat(COMPACT_PROJECT_LIMITS.stringLength + 1)] })).toThrow()
    expect(() => decodeCompactProject({ ...valid, data: [0, ...new Array(COMPACT_PROJECT_LIMITS.arrayItems + 1).fill(null)] })).toThrow()
    let encoded: unknown = null
    for (let i = 0; i <= COMPACT_PROJECT_LIMITS.depth; i++) encoded = [0, encoded]
    expect(() => decodeCompactProject({ ...valid, data: [-1, encoded] })).toThrow(/深さ/)
  })
})
