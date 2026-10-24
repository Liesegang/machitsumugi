import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

export const REPRO_CASE_IDS = Object.freeze(['same-a', 'same-b', 'different'])
export const REPRO_DIFFERENT_SEED = 'another-city'
const fields = ['schemaVersion', 'caseId', 'commit', 'generatorVersion', 'config', 'buildingCount', 'worldDigest', 'buildingsDigest', 'topLevelDigests'].sort()
const sha256 = /^[a-f0-9]{64}$/
const commitSha = /^[a-f0-9]{40}$/
const version = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function jsonData(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(jsonData)
  return record(value) && Object.values(value).every(jsonData)
}

/** Compare only small, independently generated digests. Complete map hashing is
 * performed in each generation job with the same canonical encoder as the
 * retained local generator.test.ts; no map fields are projected away. */
export function compareWorldReproArtifacts(artifacts, { expectedCommit } = {}) {
  assert(commitSha.test(expectedCommit ?? ''), 'An exact expected commit SHA is required')
  assert(Array.isArray(artifacts) && artifacts.length === REPRO_CASE_IDS.length, 'Exactly three independent world artifacts are required')
  const byId = new Map()
  for (const artifact of artifacts) {
    assert(record(artifact) && isDeepStrictEqual(Object.keys(artifact).sort(), fields), 'Invalid reproduction artifact schema')
    assert(artifact.schemaVersion === 1, 'Unsupported reproduction artifact schema version')
    assert(REPRO_CASE_IDS.includes(artifact.caseId), 'Unexpected reproduction case ID')
    assert(!byId.has(artifact.caseId), 'Duplicate reproduction case ID')
    assert(artifact.commit === expectedCommit, `Commit mismatch in ${artifact.caseId}`)
    assert(typeof artifact.generatorVersion === 'string' && version.test(artifact.generatorVersion), 'Invalid generator version')
    assert(record(artifact.config) && jsonData(artifact.config) && typeof artifact.config.seed === 'string' && artifact.config.seed.length > 0, 'Invalid generation config')
    assert(Number.isSafeInteger(artifact.buildingCount) && artifact.buildingCount > 0, 'Each world must contain buildings')
    assert(typeof artifact.worldDigest === 'string' && sha256.test(artifact.worldDigest), 'Invalid complete-world digest')
    assert(typeof artifact.buildingsDigest === 'string' && sha256.test(artifact.buildingsDigest), 'Invalid buildings digest')
    assert(record(artifact.topLevelDigests) && Object.keys(artifact.topLevelDigests).length > 0 && Object.values(artifact.topLevelDigests).every(digest => typeof digest === 'string' && sha256.test(digest)), 'Invalid top-level field digests')
    assert(artifact.topLevelDigests.buildings === artifact.buildingsDigest, 'Inconsistent building data in field digests')
    byId.set(artifact.caseId, artifact)
  }
  assert(REPRO_CASE_IDS.every(id => byId.has(id)), 'Missing reproduction case ID')
  const first = byId.get('same-a'), second = byId.get('same-b'), different = byId.get('different')
  assert(first.generatorVersion === second.generatorVersion && first.generatorVersion === different.generatorVersion, 'Generator versions differ')
  assert(isDeepStrictEqual(first.config, second.config), 'Same-seed generation configs differ')
  assert(different.config.seed === REPRO_DIFFERENT_SEED && different.config.seed !== first.config.seed, 'Different-seed world has the wrong seed')
  assert(isDeepStrictEqual({ ...different.config, seed: first.config.seed }, first.config), 'Different-seed config changed more than the seed')
  const changedFields = [...new Set([...Object.keys(first.topLevelDigests), ...Object.keys(second.topLevelDigests)])]
    .sort().filter(key => first.topLevelDigests[key] !== second.topLevelDigests[key]).slice(0, 8).map(key => key.slice(0, 80))
  assert(first.worldDigest === second.worldDigest, `Same-seed complete worlds differ; fields: ${changedFields.join(', ') || '(no field difference recorded)'}`)
  assert(isDeepStrictEqual(first.topLevelDigests, second.topLevelDigests), `Same-seed field digests differ: ${changedFields.join(', ')}`)
  assert(first.buildingCount === second.buildingCount && first.buildingsDigest === second.buildingsDigest, 'Same-seed building data differ')
  assert(first.buildingsDigest !== different.buildingsDigest, 'Different seeds produced identical buildings')
  return { commit: expectedCommit, generatorVersion: first.generatorVersion, cases: REPRO_CASE_IDS, buildingCounts: artifacts.map(({ caseId, buildingCount }) => ({ caseId, buildingCount })) }
}

export async function compareWorldReproDirectory(directory, expectedCommit) {
  const filenames = (await readdir(directory)).sort()
  assert(isDeepStrictEqual(filenames, REPRO_CASE_IDS.map(id => `${id}.json`).sort()), 'Artifact directory must contain exactly the three expected world files')
  const artifacts = await Promise.all(REPRO_CASE_IDS.map(async id => JSON.parse(await readFile(resolve(directory, `${id}.json`), 'utf8'))))
  return compareWorldReproArtifacts(artifacts, { expectedCommit })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]
  assert(directory, 'Usage: node scripts/ci-world-repro-compare.mjs ARTIFACT_DIRECTORY [EXPECTED_COMMIT]')
  console.log(JSON.stringify(await compareWorldReproDirectory(directory, process.argv[3] ?? process.env.GITHUB_SHA), null, 2))
}
