import { describe, expect, it } from 'vitest'
import { boundedWorldDifferences, worldDigest } from './test-support/world-digest'

describe('bounded complete-world reproducibility diagnostics', () => {
  it('keeps all values and array order while canonicalizing object keys', () => {
    expect(worldDigest({ a: [1, 2], b: { c: undefined } })).toBe(worldDigest({ b: { c: undefined }, a: [1, 2] }))
    for (const other of [[2, 1], [1, 3], [1], [1, 2, undefined]]) expect(worldDigest([1, 2])).not.toBe(worldDigest(other))
    expect(worldDigest({ a: undefined })).not.toBe(worldDigest({}))
    expect(new Set([null, undefined, NaN, Infinity, -Infinity, -0, 0, '0'].map(worldDigest)).size).toBe(8)
    expect(worldDigest(new Float32Array([1, 2]))).not.toBe(worldDigest(new Float64Array([1, 2])))
  })
  it('permits shared geometry but rejects actual cycles', () => {
    const point = { x: 1, y: 2 }
    expect(worldDigest([point, point])).toBe(worldDigest([{ x: 1, y: 2 }, { x: 1, y: 2 }]))
    const cycle: unknown[] = []; cycle.push(cycle)
    expect(() => worldDigest(cycle)).toThrow('cyclic')
  })
  it('reports only a bounded set of changed paths instead of printing worlds', () => {
    const a = Array.from({ length: 100 }, (_, id) => ({ id, point: { x: 0 } }))
    const b = a.map(item => ({ ...item, point: { x: 1 } }))
    const paths = boundedWorldDifferences(a, b, 3)
    expect(paths).toHaveLength(3)
    expect(paths.every(path => path.endsWith('["point"]["x"]'))).toBe(true)
    expect(boundedWorldDifferences({ a: 1 }, { a: 1 })).toEqual([])
    expect(boundedWorldDifferences({ a: 1 }, { b: 1 })).toEqual(['$["a"]', '$["b"]'])
  })
})
