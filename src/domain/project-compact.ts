/** A lossless JSON wire form. Domain validation remains in project.ts after
 * decoding; this layer removes repeated keys/strings and packs long point
 * leaves as their exact two Float64 values. */
export interface CompactProjectEnvelope {
  version: 3
  format: 'city-project-compact-v1' | 'city-project-compact-v2'
  schemas: string[][]
  strings: string[]
  data: EncodedValue
}
export type EncodedValue = number | boolean | null | [2, string] | EncodedValue[]

export const COMPACT_PROJECT_LIMITS = {
  // The completed dense native portable project contains35,027,127 JSON nodes.
  // This finite traversal guard has headroom for that project; the existing
  // project validator still enforces every entity, point and file-size cap.
  nodes: 40_000_000,
  depth: 128,
  schemas: 2048,
  keysPerSchema: 256,
  keyLength: 1024,
  schemaCharacters: 1_000_000,
  // The dense native land checkpoint alone has1,030,495 distinct strings.
  // Domain/entity/geometry budgets still apply after lossless decoding.
  strings: 1_250_000,
  stringLength: 2_000_000,
  stringCharacters: 128_000_000,
  arrayItems: 1_000_000,
} as const
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
const pointSchema = '["x","y"]', pointWireLength = 30
// Sixteen bytes encode as twenty-two characters and two padding characters.
// The last character has four unused zero bits; reject noncanonical aliases.
const pointBlob = /^[A-Za-z0-9+/]{21}[AQgw]==$/
const invalid = (message: string): never => { throw new Error(`圧縮プロジェクト: ${message}`) }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const ownValue = (value: Record<string, unknown>, key: string) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !('value' in descriptor)) return invalid('データのプロパティ形式が不正です。')
  return descriptor.value as unknown
}
const validKey = (key: string) => {
  if (forbiddenKeys.has(key) || key.length > COMPACT_PROJECT_LIMITS.keyLength) invalid('許可されないキーがあります。')
}
const budget = () => {
  let nodes = 0
  return (depth: number) => {
    if (depth > COMPACT_PROJECT_LIMITS.depth || ++nodes > COMPACT_PROJECT_LIMITS.nodes) invalid('データの深さ・要素数が上限を超えています。')
  }
}
export function isCompactProject(value: unknown): value is CompactProjectEnvelope {
  if (!record(value)) return false
  const version = Object.getOwnPropertyDescriptor(value, 'version'), format = Object.getOwnPropertyDescriptor(value, 'format')
  return !!version && 'value' in version && version.value === 3 && !!format && 'value' in format && (format.value === 'city-project-compact-v1' || format.value === 'city-project-compact-v2')
}

export function encodeCompactProject(value: unknown): CompactProjectEnvelope {
  if (!record(value) || ownValue(value, 'version') !== 2) invalid('version2のプロジェクトが必要です。')
  const schemas: string[][] = [], strings: string[] = [], schemaIds = new Map<string, number>(), stringIds = new Map<string, number>(), ancestors = new WeakSet<object>(), visit = budget()
  const pointBytes = new Uint8Array(16), pointView = new DataView(pointBytes.buffer)
  let schemaCharacters = 0, stringCharacters = 0
  const encode = (input: unknown, depth: number): EncodedValue => {
    visit(depth)
    if (input === null || typeof input === 'boolean') return input
    if (typeof input === 'number') { if (!Number.isFinite(input)) invalid('有限な数値が必要です。'); return Object.is(input, -0) ? 0 : input }
    if (typeof input === 'string') {
      let index = stringIds.get(input)
      if (index === undefined) {
        if (strings.length >= COMPACT_PROJECT_LIMITS.strings || input.length > COMPACT_PROJECT_LIMITS.stringLength || (stringCharacters += input.length) > COMPACT_PROJECT_LIMITS.stringCharacters) invalid('文字列辞書が上限を超えています。')
        index = strings.length; strings.push(input); stringIds.set(input, index)
      }
      return [1, index]
    }
    if (typeof input !== 'object' || input === null) return invalid('JSONに保存できない値です。')
    if (ancestors.has(input)) invalid('循環するデータは保存できません。')
    ancestors.add(input)
    try {
      if (Array.isArray(input)) {
        if (input.length > COMPACT_PROJECT_LIMITS.arrayItems) invalid('配列が上限を超えています。')
        const result: EncodedValue[] = [0]
        for (let i = 0; i < input.length; i++) result.push(encode(input[i] === undefined ? null : input[i], depth + 1))
        return result
      }
      if (!record(input)) return invalid('通常のJSONオブジェクトが必要です。')
      const keys = Object.keys(input).sort()
      for (const key of keys) validKey(key)
      const values: unknown[] = [], presentKeys: string[] = []
      for (const key of keys) { const current = ownValue(input, key); if (current !== undefined) { presentKeys.push(key); values.push(current) } }
      if (presentKeys.length > COMPACT_PROJECT_LIMITS.keysPerSchema) invalid('オブジェクトのキー数が上限を超えています。')
      if (keys.length === 2 && keys[0] === 'x' && keys[1] === 'y' && Reflect.ownKeys(input).length === 2 && typeof values[0] === 'number' && typeof values[1] === 'number' && Number.isFinite(values[0]) && Number.isFinite(values[1])) {
        const x = values[0] === 0 ? 0 : values[0], y = values[1] === 0 ? 0 : values[1], schema = schemaIds.get(pointSchema) ?? schemas.length
        // Compare the complete leaf forms, including the current schema tag.
        // Short survey-lattice coordinates keep their smaller numeric schema.
        if (pointWireLength < String(-schema - 1).length + String(x).length + String(y).length + 4) {
          visit(depth + 1); visit(depth + 1)
          pointView.setFloat64(0, x, true); pointView.setFloat64(8, y, true)
          return [2, btoa(String.fromCharCode(...pointBytes))]
        }
      }
      const signature = JSON.stringify(presentKeys)
      let schema = schemaIds.get(signature)
      if (schema === undefined) {
        if (schemas.length >= COMPACT_PROJECT_LIMITS.schemas || (schemaCharacters += presentKeys.reduce((sum, key) => sum + key.length, 0)) > COMPACT_PROJECT_LIMITS.schemaCharacters) invalid('キー辞書が上限を超えています。')
        schema = schemas.length; schemas.push(presentKeys); schemaIds.set(signature, schema)
      }
      return [-schema - 1, ...values.map(current => encode(current, depth + 1))]
    } finally { ancestors.delete(input) }
  }
  return { version: 3, format: 'city-project-compact-v2', schemas, strings, data: encode(value, 0) }
}

export function decodeCompactProject(value: unknown): unknown {
  if (!isCompactProject(value) || !record(value)) return invalid('保存形式に対応していません。')
  const supportsPointBlob = ownValue(value, 'format') === 'city-project-compact-v2'
  const envelopeKeys = Object.keys(value).sort()
  if (JSON.stringify(envelopeKeys) !== JSON.stringify(['data', 'format', 'schemas', 'strings', 'version'])) invalid('保存データの項目が不正です。')
  const rawSchemas = ownValue(value, 'schemas'), rawStrings = ownValue(value, 'strings')
  if (!Array.isArray(rawSchemas) || rawSchemas.length > COMPACT_PROJECT_LIMITS.schemas || !Array.isArray(rawStrings) || rawStrings.length > COMPACT_PROJECT_LIMITS.strings) return invalid('辞書の形式・件数が不正です。')
  const schemas = rawSchemas as string[][], strings = rawStrings as string[]
  const signatures = new Set<string>(), knownStrings = new Set<string>()
  let schemaCharacters = 0, stringCharacters = 0
  for (const schema of schemas) {
    if (!Array.isArray(schema) || schema.length > COMPACT_PROJECT_LIMITS.keysPerSchema) invalid('キー辞書が不正です。')
    let previous: string | undefined
    for (const key of schema) {
      if (typeof key !== 'string') invalid('キーは文字列で指定してください。')
      validKey(key)
      if (previous !== undefined && previous >= key) invalid('キー辞書が重複・未整列です。')
      previous = key; schemaCharacters += key.length
    }
    const signature = JSON.stringify(schema)
    if (signatures.has(signature) || schemaCharacters > COMPACT_PROJECT_LIMITS.schemaCharacters) invalid('キー辞書が重複・上限超過です。')
    signatures.add(signature)
  }
  for (const text of strings) {
    if (typeof text !== 'string' || text.length > COMPACT_PROJECT_LIMITS.stringLength || knownStrings.has(text)) invalid('文字列辞書が不正です。')
    stringCharacters += text.length
    if (stringCharacters > COMPACT_PROJECT_LIMITS.stringCharacters) invalid('文字列辞書が上限を超えています。')
    knownStrings.add(text)
  }
  const visit = budget(), ancestors = new WeakSet<object>()
  const pointBytes = new Uint8Array(16), pointView = new DataView(pointBytes.buffer)
  const decode = (input: unknown, depth: number): unknown => {
    visit(depth)
    if (input === null || typeof input === 'boolean') return input
    if (typeof input === 'number') { if (!Number.isFinite(input)) invalid('有限な数値が必要です。'); return input }
    if (!Array.isArray(input) || !input.length) return invalid('値の形式が不正です。')
    if (ancestors.has(input)) invalid('循環するデータは読み込めません。')
    if (!Number.isSafeInteger(input[0])) invalid('型タグが不正です。')
    const tag = input[0] as number
    if (tag === 1) {
      if (input.length !== 2 || !Number.isSafeInteger(input[1]) || input[1] < 0 || input[1] >= strings.length) invalid('文字列参照が範囲外です。')
      return strings[input[1]]
    }
    if (tag === 2) {
      const descriptor = Object.getOwnPropertyDescriptor(input, '1'), blob = descriptor && 'value' in descriptor ? descriptor.value as unknown : undefined
      if (!supportsPointBlob || input.length !== 2 || typeof blob !== 'string' || blob.length !== 24 || !pointBlob.test(blob)) invalid('座標データの形式が不正です。')
      // A point expands to one object and two numbers, exactly like v1.
      visit(depth + 1); visit(depth + 1)
      const bytes = atob(blob as string)
      for (let i = 0; i < 16; i++) pointBytes[i] = bytes.charCodeAt(i)
      const x = pointView.getFloat64(0, true), y = pointView.getFloat64(8, true)
      if (!Number.isFinite(x) || !Number.isFinite(y)) invalid('有限な座標が必要です。')
      return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y }
    }
    if (tag > 1 || tag < -schemas.length) invalid('型タグ・キー参照が範囲外です。')
    if (tag === 0 && input.length - 1 > COMPACT_PROJECT_LIMITS.arrayItems) invalid('配列が上限を超えています。')
    if (tag < 0 && input.length !== schemas[-tag - 1]!.length + 1) invalid('オブジェクトの値数が不正です。')
    ancestors.add(input)
    try {
      if (tag === 0) { const result: unknown[] = []; for (let i = 1; i < input.length; i++) result.push(decode(input[i], depth + 1)); return result }
      const result: Record<string, unknown> = {}, schema = schemas[-tag - 1] as string[]
      for (let i = 0; i < schema.length; i++) Object.defineProperty(result, schema[i]!, { value: decode(input[i + 1], depth + 1), enumerable: true, writable: true, configurable: true })
      return result
    } finally { ancestors.delete(input) }
  }
  const decoded = decode(ownValue(value, 'data'), 0)
  if (!record(decoded) || ownValue(decoded, 'version') !== 2) invalid('復元されたプロジェクトがversion2ではありません。')
  return decoded
}
