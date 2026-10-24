import type { CityMap } from '../src/domain/types.ts'
import { worldDigest } from '../src/domain/test-support/world-digest.ts'

/** Hash the complete production map, including terrain and history. Kept apart
 * from the generation entry so saved worlds can exercise serialization without
 * running another simulation. */
export function worldReproArtifact(caseId: string, world: CityMap, commit: string) {
  return {
    schemaVersion: 1,
    caseId,
    commit,
    generatorVersion: world.generatorVersion,
    config: world.config,
    buildingCount: world.buildings.length,
    worldDigest: worldDigest(world),
    buildingsDigest: worldDigest(world.buildings),
    topLevelDigests: Object.fromEntries(Object.keys(world).sort().map(key => [key, worldDigest(world[key as keyof CityMap])])),
  }
}
