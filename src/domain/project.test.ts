import { describe, expect, it, vi, afterEach } from 'vitest'
import { loadProject, parseProject, persistProject, STORAGE_KEY, validateProject } from './project'
import type { Project } from './project'

const sample = (): Project => ({
  version: 1,
  config: {
    name: '水杜市', seed: 'minato-2026', type: 'castle', terrain: 'river', density: 65, forest: 30,
    railway: true, stations: 3, arterial: true, facilities: ['school', 'hospital', 'park'],
  },
  annotations: [{ id: 'pin-1', point: { x: 100, y: 200 }, name: '探索地点', note: 'GMのメモ\n二行目', secret: true }],
  layers: { buildings: true, roads: true, railway: true, labels: true, facilities: true, terrain: true, grid: false },
  style: 'standard',
})

afterEach(() => vi.unstubAllGlobals())

describe('saved projects', () => {
  it('roundtrips Japanese names, multiline notes and secrets without DOM APIs', () => {
    expect(parseProject(JSON.stringify(sample()))).toEqual(sample())
  })

  it('reconstructs independent values and strips unknown imported properties', () => {
    const input = { ...sample(), extra: 'ignore' }
    const output = validateProject(input)
    expect(output).not.toHaveProperty('extra')
    expect(output.config).not.toBe(input.config)
    expect(output.annotations[0].point).not.toBe(input.annotations[0].point)
  })

  it.each([null, [], 'text', 1, {}, { version: 2 }])('rejects an invalid root or version: %j', (value) => {
    expect(() => validateProject(value)).toThrow()
  })

  it.each([
    { density: -1 }, { density: 101 }, { density: Number.NaN }, { forest: Infinity },
    { railway: 'true' }, { stations: 0 }, { stations: 6 }, { stations: 1.5 },
    { type: 'city' }, { terrain: 'ocean' }, { name: '' }, { seed: 'x'.repeat(129) },
    { facilities: ['park', 'park'] }, { facilities: ['unknown'] },
  ])('rejects malformed or out-of-range configuration: %j', (change) => {
    const data = sample()
    Object.assign(data.config, change)
    expect(() => validateProject(data)).toThrow()
  })

  it('rejects malformed layers, styles, annotations and duplicate IDs', () => {
    expect(() => validateProject({ ...sample(), layers: { buildings: true } })).toThrow('レイヤー')
    expect(() => validateProject({ ...sample(), style: 'satellite' })).toThrow('配色')
    const data = sample()
    data.annotations[0].point.x = Number.NaN
    expect(() => validateProject(data)).toThrow('横位置')
    data.annotations = [...sample().annotations, ...sample().annotations]
    expect(() => validateProject(data)).toThrow('重複')
    expect(() => validateProject({ ...sample(), annotations: 'pins' })).toThrow('メモ')
  })

  it('provides useful errors for invalid JSON and oversized files', () => {
    expect(() => parseProject('{')).toThrow('JSONを読み取れません')
    expect(() => parseProject(' '.repeat(5_000_001))).toThrow('大きすぎます')
  })

  it('uses a versioned storage key and validates data on restore', () => {
    const memory = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
    })
    expect(loadProject()).toBeNull()
    expect(persistProject(sample())).toBe(true)
    expect(memory.has(STORAGE_KEY)).toBe(true)
    expect(loadProject()).toEqual(sample())
    memory.set(STORAGE_KEY, '{broken')
    expect(loadProject()).toBeNull()
  })

  it('survives storage permission and quota failures', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('QuotaExceededError') },
    })
    expect(loadProject()).toBeNull()
    expect(persistProject(sample())).toBe(false)
  })
})
