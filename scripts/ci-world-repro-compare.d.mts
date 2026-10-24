export const REPRO_CASE_IDS: readonly ['same-a', 'same-b', 'different']
export const REPRO_DIFFERENT_SEED: 'another-city'

export interface WorldReproSummary {
  commit: string
  generatorVersion: string
  cases: typeof REPRO_CASE_IDS
  buildingCounts: { caseId: string; buildingCount: number }[]
}

export function compareWorldReproArtifacts(artifacts: unknown, options?: { expectedCommit?: string }): WorldReproSummary
export function compareWorldReproDirectory(directory: string, expectedCommit?: string): Promise<WorldReproSummary>
