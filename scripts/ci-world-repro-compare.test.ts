import { describe, expect, it } from 'vitest'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareWorldReproArtifacts, compareWorldReproDirectory } from './ci-world-repro-compare.mjs'
import { worldReproArtifact } from './ci-world-repro-artifact'
import type { CityMap } from '../src/domain/types'

const commit = 'a'.repeat(40)
function artifacts() {
  const config = { seed: 'minato-2026', name: '水杜市', facilities: ['castle'], density: 65 }
  const first = { schemaVersion: 1, caseId: 'same-a', commit, generatorVersion: '2.3.0', config, buildingCount: 2, worldDigest: '1'.repeat(64), buildingsDigest: '2'.repeat(64), topLevelDigests: { buildings: '2'.repeat(64), terrainSurface: '5'.repeat(64) } }
  return [first, { ...structuredClone(first), caseId: 'same-b' }, { ...structuredClone(first), caseId: 'different', config: { ...config, seed: 'another-city' }, worldDigest: '3'.repeat(64), buildingsDigest: '4'.repeat(64), topLevelDigests: { ...first.topLevelDigests, buildings: '4'.repeat(64) } }]
}
function check(items = artifacts(), expectedCommit = commit) { return compareWorldReproArtifacts(items, { expectedCommit }) }

describe('parallel independent world reproduction comparator', () => {
  it('accepts all three independent cases regardless of artifact order', () => {
    expect(check(artifacts().reverse())).toMatchObject({ commit, generatorVersion: '2.3.0', cases: ['same-a', 'same-b', 'different'] })
  })
  it('loads all three JSON files and rejects an incomplete or unexpected directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'machitsumugi-repro-'))
    const written: string[] = []
    const save = async (name: string, body: unknown) => {
      const path = join(directory, name)
      await writeFile(path, JSON.stringify(body))
      written.push(path)
    }
    try {
      const items = artifacts()
      await save('same-a.json', items[0]); await save('same-b.json', items[1])
      await expect(compareWorldReproDirectory(directory, commit)).rejects.toThrow(/exactly the three/)
      await save('different.json', items[2])
      await expect(compareWorldReproDirectory(directory, commit)).resolves.toMatchObject({ commit })
      await save('unexpected.json', items[0])
      await expect(compareWorldReproDirectory(directory, commit)).rejects.toThrow(/exactly the three/)
    } finally {
      await Promise.all(written.map(path => unlink(path)))
      await rmdir(directory)
    }
  })
  it('hashes every complete-world field and ordered building geometry', () => {
    const world = { generatorVersion: '2.3.0', config: { seed: 'x' }, buildings: [{ footprint: [[1, 2], [3, 4]] }], history: { roads: [1] } } as unknown as CityMap
    const original = worldReproArtifact('same-a', world, commit)
    expect(worldReproArtifact('same-a', structuredClone(world), commit)).toEqual(original)
    const changedHistory = structuredClone(world) as unknown as { history: { roads: number[] } }
    changedHistory.history.roads.push(2)
    expect(worldReproArtifact('same-a', changedHistory as unknown as CityMap, commit).worldDigest).not.toBe(original.worldDigest)
    const changedGeometry = structuredClone(world) as unknown as { buildings: { footprint: number[][] }[] }
    changedGeometry.buildings[0].footprint.reverse()
    const geometry = worldReproArtifact('same-a', changedGeometry as unknown as CityMap, commit)
    expect(geometry.buildingsDigest).not.toBe(original.buildingsDigest)
    expect(geometry.worldDigest).not.toBe(original.worldDigest)
    expect(original.buildingCount).toBe(1)
  })
  it('rejects missing, extra, duplicate or unknown cases', () => {
    expect(() => check(artifacts().slice(0, 2))).toThrow(/three/)
    expect(() => check([...artifacts(), artifacts()[0]])).toThrow(/three/)
    const duplicate = artifacts(); duplicate[2].caseId = 'same-a'
    expect(() => check(duplicate)).toThrow(/Duplicate/)
    const unknown = artifacts(); unknown[2].caseId = 'unknown'
    expect(() => check(unknown)).toThrow(/Unexpected/)
  })
  it.each(['schemaVersion', 'commit', 'generatorVersion', 'config', 'buildingCount', 'worldDigest', 'buildingsDigest', 'topLevelDigests'])('rejects malformed %s metadata', field => {
    const changed = artifacts() as unknown as Record<string, unknown>[]
    changed[1][field] = null
    expect(() => check(changed as unknown as ReturnType<typeof artifacts>)).toThrow()
  })
  it('rejects an invalid or unexpected commit and mismatched generator versions', () => {
    expect(() => check(artifacts(), '')).toThrow(/expected commit/)
    expect(() => check(artifacts(), 'b'.repeat(40))).toThrow(/Commit/)
    const changed = artifacts(); changed[2].generatorVersion = '2.4.0'
    expect(() => check(changed)).toThrow(/versions/)
  })
  it('rejects artifact fields or schema versions it cannot interpret', () => {
    const changed = artifacts(); changed[0].schemaVersion = 2
    expect(() => check(changed)).toThrow(/schema version/)
    expect(() => check(artifacts().map(item => ({ ...item, extra: true })))).toThrow(/schema/)
  })
  it('rejects same-seed config changes and any different-seed setting change', () => {
    const same = artifacts(); same[1].config.density++
    expect(() => check(same)).toThrow(/configs/)
    const different = artifacts(); different[2].config.density++
    expect(() => check(different)).toThrow(/more than the seed/)
    const wrongSeed = artifacts(); wrongSeed[2].config.seed = 'third-seed'
    expect(() => check(wrongSeed)).toThrow(/wrong seed/)
  })
  it('rejects whole-world digest tampering even when buildings match', () => {
    const changed = artifacts(); changed[1].worldDigest = 'f'.repeat(64)
    expect(() => check(changed)).toThrow(/complete worlds/)
  })
  it('limits full-world mismatch diagnostics to eight field names', () => {
    const changed = artifacts()
    changed[1].worldDigest = 'f'.repeat(64)
    for (let i = 0; i < 20; i++) Object.assign(changed[1].topLevelDigests, { [`changed-field-${i.toString().padStart(2, '0')}`]: 'f'.repeat(64) })
    expect(() => check(changed)).toThrow(/changed-field-07/)
    expect(() => check(changed)).toThrow(expect.not.stringContaining('changed-field-08'))
  })
  it('rejects changed field digests even if the claimed full digest is unchanged', () => {
    const changed = artifacts(); changed[1].topLevelDigests.terrainSurface = 'f'.repeat(64)
    expect(() => check(changed)).toThrow(/field digests differ: terrainSurface/)
  })
  it('rejects same-seed building count or digest mismatch', () => {
    const count = artifacts(); count[1].buildingCount++
    expect(() => check(count)).toThrow(/building data/)
    const digest = artifacts(); digest[1].buildingsDigest = 'f'.repeat(64)
    expect(() => check(digest)).toThrow(/building data/)
  })
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid building counts: %s', count => {
    const changed = artifacts(); changed[2].buildingCount = count
    expect(() => check(changed)).toThrow(/contain buildings/)
  })
  it('rejects different seeds that produce identical buildings', () => {
    const changed = artifacts(); changed[2].buildingsDigest = changed[0].buildingsDigest
    changed[2].topLevelDigests.buildings = changed[0].buildingsDigest
    expect(() => check(changed)).toThrow(/identical buildings/)
  })
})
