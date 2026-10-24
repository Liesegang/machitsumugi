/// <reference types="node" />
import { createHash } from 'node:crypto'

/** Stream canonical map data without constructing a giant JSON string or diff.
 * Object keys are sorted; array order, undefined, nonfinite numbers and -0 stay
 * distinct. Shared geometry is data, not a cycle, and is visited at each use. */
export function worldDigest(value: unknown): string {
  const hash = createHash('sha256'), chunks: string[] = [], ancestors = new Set<object>()
  const emit = (text: string) => {
    chunks.push(text)
    if (chunks.length >= 4096) { hash.update(chunks.join('')); chunks.length = 0 }
  }
  const visit = (item: unknown): void => {
    if (item === null) { emit('null;'); return }
    if (typeof item === 'number') { emit(`number:${Object.is(item, -0) ? '-0' : String(item)};`); return }
    if (typeof item === 'string') { emit(`string:${JSON.stringify(item)};`); return }
    if (typeof item === 'boolean' || typeof item === 'undefined' || typeof item === 'bigint') { emit(`${typeof item}:${String(item)};`); return }
    if (typeof item !== 'object') throw new Error(`Unsupported world value: ${typeof item}`)
    if (ancestors.has(item)) throw new Error('A generated world contains a cyclic reference')
    ancestors.add(item)
    if (Array.isArray(item)) {
      emit('array[')
      for (const child of item) visit(child)
      emit('];')
    } else if (ArrayBuffer.isView(item) && !(item instanceof DataView)) {
      emit(`${item.constructor.name}[`)
      for (const child of item as unknown as Iterable<number | bigint>) visit(child)
      emit('];')
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('A generated world contains a non-data object')
      emit('object{')
      for (const key of Object.keys(item).sort()) { emit(JSON.stringify(key)); visit((item as Record<string, unknown>)[key]) }
      emit('};')
    }
    ancestors.delete(item)
  }
  visit(value)
  hash.update(chunks.join(''))
  return hash.digest('hex')
}

/** Diagnostics are bounded in both output size and traversal work. Hash
 * mismatch is the assertion; this only points a reviewer to changed fields. */
export function boundedWorldDifferences(a: unknown, b: unknown, limit = 8): string[] {
  const differences: string[] = [], seen = new WeakMap<object, WeakSet<object>>()
  let remaining = 50_000
  const visit = (left: unknown, right: unknown, path: string): void => {
    if (differences.length >= limit || remaining-- <= 0 || Object.is(left, right)) return
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right) || left.constructor !== right.constructor) { differences.push(path); return }
    let pairs = seen.get(left)
    if (!pairs) { pairs = new WeakSet(); seen.set(left, pairs) }
    if (pairs.has(right)) return
    pairs.add(right)
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) differences.push(`${path}.length`)
      for (let i = 0; i < Math.min(left.length, right.length) && differences.length < limit && remaining > 0; i++) visit(left[i], right[i], `${path}[${i}]`)
      return
    }
    const leftKeys = Object.keys(left), rightKeys = Object.keys(right), keys = [...new Set([...leftKeys, ...rightKeys])].sort()
    for (const key of keys) {
      if (differences.length >= limit || remaining <= 0) break
      const childPath = `${path}[${JSON.stringify(key)}]`
      if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) differences.push(childPath)
      else visit((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], childPath)
    }
  }
  visit(a, b, '$')
  if (remaining <= 0 && differences.length < limit) differences.push('$ (diagnostic traversal limit reached)')
  return differences
}
