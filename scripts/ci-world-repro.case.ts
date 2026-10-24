/// <reference types="node" />
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { DEFAULT_CONFIG, generateCity } from '../src/domain/generator'
import { GENERATOR_VERSION } from '../src/domain/land-development'
import { REPRO_CASE_IDS, REPRO_DIFFERENT_SEED } from './ci-world-repro-compare.mjs'
import { worldReproArtifact } from './ci-world-repro-artifact'

// Deliberately not *.test.ts: only vitest.repro.config.ts collects this costly
// entry. The original local generator.test.ts still performs all three worlds.
it('generates one independent complete production world', async () => {
  const caseId = process.env.REPRO_CASE
  const output = process.env.REPRO_OUTPUT_DIR
  expect(REPRO_CASE_IDS).toContain(caseId)
  expect(output, 'REPRO_OUTPUT_DIR is required').toBeTruthy()
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  expect(commit).toMatch(/^[a-f0-9]{40}$/)
  expect(commit).toBe(process.env.GITHUB_SHA ?? commit)
  const config = caseId === 'different' ? { ...DEFAULT_CONFIG, seed: REPRO_DIFFERENT_SEED } : { ...DEFAULT_CONFIG }
  // Each fresh CI job starts with a fresh process and no saved-world fixture.
  const world = generateCity(config)
  expect(world.config).toEqual(config)
  expect(world.generatorVersion).toBe(GENERATOR_VERSION)
  expect(world.buildings.length).toBeGreaterThan(0)
  const artifact = worldReproArtifact(caseId!, world, commit)
  await mkdir(output!, { recursive: true })
  await writeFile(resolve(output!, `${caseId}.json`), JSON.stringify(artifact) + '\n')
}, 1_200_000)
