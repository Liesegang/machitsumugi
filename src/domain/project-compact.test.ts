import { describe, expect, it } from 'vitest'
import { COMPACT_PROJECT_LIMITS, decodeCompactProject, encodeCompactProject, isCompactProject } from './project-compact'

const wire = (value: unknown) => JSON.parse(JSON.stringify(encodeCompactProject(value)))
const longX = Number('1234.1234567890123'), longY = Number('4321.123456789012')
const pointLeaves = (value: unknown): [number, string][] => Array.isArray(value) ? value[0] === 2 && value.length === 2 && typeof value[1] === 'string' ? [value as [number, string]] : value.flatMap(pointLeaves) : []
const pointBytes = (x: number, y: number) => {
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer)
  view.setFloat64(0, x, true); view.setFloat64(8, y, true)
  return btoa(String.fromCharCode(...bytes))
}
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
  it('packs only strictly smaller finite x/y leaves, keeping short and equal-length coordinates numeric', () => {
    const short = { x: 1234.5678, y: 2045.6789 }, tied = { x: 123456789012, y: 123456789012 }, longer = { x: 1234567890123, y: 123456789012 }
    const extended = { x: longX, y: Number('2345.2345678901234'), z: undefined }
    const hidden = Object.defineProperty({ x: extended.x, y: extended.y }, 'metadata', { value: true })
    const input = { version: 2, points: [short, tied, longer, extended, hidden] }, compact = wire(input), leaves = pointLeaves(compact.data)
    expect(compact.format).toBe('city-project-compact-v2')
    expect(leaves).toHaveLength(1)
    expect(leaves[0]![1]).toBe(pointBytes(longer.x, longer.y))
    expect(JSON.stringify(leaves[0]).length).toBeLessThan(JSON.stringify([-2, longer.x, longer.y]).length)
    expect(JSON.stringify([-2, tied.x, tied.y]).length).toBe(JSON.stringify(leaves[0]).length)
    expect(decodeCompactProject(compact)).toEqual(JSON.parse(JSON.stringify(input)))
  })
  it('roundtrips IEEE finite boundaries exactly and normalizes signed zero as JSON does', () => {
    const numbers = [Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE, 2 ** -1022, -(2 ** -1022), Number.EPSILON, -Number.EPSILON, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, -0]
    const input = { version: 2, points: numbers.map(x => ({ x, y: -Number.MAX_VALUE })) }, compact = wire(input)
    expect(pointLeaves(compact.data)).toHaveLength(numbers.length)
    const decoded = decodeCompactProject(compact) as typeof input
    for (let i = 0; i < numbers.length; i++) {
      expect(Object.is(decoded.points[i]!.x, numbers[i] === 0 ? 0 : numbers[i])).toBe(true)
      expect(Object.is(decoded.points[i]!.y, -Number.MAX_VALUE)).toBe(true)
    }
    const envelope = { version: 3, format: 'city-project-compact-v2', schemas: [['point', 'version']], strings: [], data: [-1, [2, 'AAAAAAAA9D8AAAAAAAAEwA=='], 2] }
    expect(decodeCompactProject(envelope)).toEqual({ version: 2, point: { x: 1.25, y: -2.5 } })
  })
  it('retains compact-v1 decoding and rejects the new leaf tag in v1 documents', () => {
    const point = { x: longX, y: Number('-4321.987654321098') }, legacy = { version: 3, format: 'city-project-compact-v1', schemas: [['point', 'version'], ['x', 'y']], strings: [], data: [-1, [-2, point.x, point.y], 2] }
    expect(isCompactProject(legacy)).toBe(true)
    expect(decodeCompactProject(legacy)).toEqual({ version: 2, point })
    expect(() => decodeCompactProject({ ...legacy, data: [-1, [2, pointBytes(point.x, point.y)], 2] })).toThrow(/座標/)
  })
  it('rejects malformed, noncanonical and nonfinite point blobs without executing accessors', () => {
    const valid = { version: 3, format: 'city-project-compact-v2', schemas: [['point', 'version']], strings: [], data: [-1, [2, pointBytes(1, 2)], 2] }
    for (const blob of [null, 1, [], '', 'A'.repeat(23), 'A'.repeat(25), 'A'.repeat(24), `${'A'.repeat(21)}B==`, `${'A'.repeat(21)}!==`, 'A'.repeat(COMPACT_PROJECT_LIMITS.stringLength + 1), pointBytes(Infinity, 0), pointBytes(0, -Infinity), pointBytes(NaN, 0)]) {
      expect(() => decodeCompactProject({ ...valid, data: [-1, [2, blob], 2] })).toThrow(/座標/)
    }
    expect(() => decodeCompactProject({ ...valid, data: [-1, [2, pointBytes(1, 2), 0], 2] })).toThrow(/座標/)
    let executed = false
    const leaf = [2, '']
    Object.defineProperty(leaf, '1', { get() { executed = true; return pointBytes(1, 2) } })
    expect(() => decodeCompactProject({ ...valid, data: [-1, leaf, 2] })).toThrow(/座標/)
    expect(executed).toBe(false)
    expect(() => encodeCompactProject({ version: 2, point: { get x() { executed = true; return longX }, y: longY } })).toThrow(/プロパティ/)
    expect(executed).toBe(false)
  })
  it('counts the two expanded coordinates against the original traversal depth budget', () => {
    const point = { x: longX, y: longY }, blob = [2, pointBytes(point.x, point.y)]
    let allowed: unknown = point, forbidden: unknown = point, encoded: unknown = blob
    for (let i = 0; i < COMPACT_PROJECT_LIMITS.depth - 2; i++) allowed = [allowed]
    for (let i = 0; i < COMPACT_PROJECT_LIMITS.depth - 1; i++) { forbidden = [forbidden]; encoded = [0, encoded] }
    expect(decodeCompactProject(wire({ version: 2, payload: allowed }))).toEqual({ version: 2, payload: allowed })
    expect(() => encodeCompactProject({ version: 2, payload: forbidden })).toThrow(/深さ/)
    expect(() => decodeCompactProject({ version: 3, format: 'city-project-compact-v2', schemas: [['payload', 'version']], strings: [], data: [-1, encoded, 2] })).toThrow(/深さ/)
  })
})
