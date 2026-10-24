import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, generateCity } from './generator';
import { GENERATOR_VERSION } from './land-development';
import { boundedWorldDifferences, worldDigest } from './test-support/world-digest';

// Keep all three worlds independent: this checks the complete production path.
describe('Japanese city generation', { timeout: 1_200_000 }, () => {
  it('is exactly reproducible and gives another layout for another seed', () => {
    console.info('Reproducibility: independent world 1/3');
    const a = generateCity(DEFAULT_CONFIG);
    console.info('Reproducibility: independent world 2/3');
    const b = generateCity({ ...DEFAULT_CONFIG });
    console.info('Reproducibility: canonical comparison of complete worlds');
    const first = worldDigest(a), second = worldDigest(b);
    const changed = first === second ? [] : boundedWorldDifferences(a, b);
    expect(second, `Complete world mismatch at ${changed.join(', ')}`).toBe(first);
    console.info('Reproducibility: independent world 3/3 with another seed');
    const different = generateCity({ ...DEFAULT_CONFIG, seed: 'another-city' });
    expect(worldDigest(different.buildings)).not.toBe(worldDigest(a.buildings));
    expect(a.buildings.length).toBeGreaterThan(0);
    expect(a.generatorVersion).toBe(GENERATOR_VERSION);
  });
});
