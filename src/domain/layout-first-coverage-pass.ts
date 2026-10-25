import type { Point, Road } from './types'
import type { LayoutCoverageMask, LayoutCoverageProposal } from './layout-first-coverage-blocks'
import { measureLayoutStreetCoverage, proposeLayoutCoverageBlocks } from './layout-first-coverage-blocks'
import type { LayoutCoveragePrioritySite } from './layout-first-coverage-priority'

export interface LayoutCoveragePassNetwork { roads: readonly Road[]; faces: readonly Point[][] }
export interface LayoutCoveragePassInput {
  builtYear: number
  mask: LayoutCoverageMask
  phase: 'before-fallback' | 'after-fallback'
  maximumAttempts: number
  cellSize: number
  prioritySites?: readonly LayoutCoveragePrioritySite[]
  readNetwork: () => LayoutCoveragePassNetwork
  canAnchor: (point: Point) => boolean
  /** The integration owns the physical survey and atomic graph fork. It must
   * stage real faces, require actual dry enclosure/usable-face gain, then adopt
   * exactly that pavement. Oversized new enclosures may receive local cuts. */
  tryAdoptWithFaceGain: (proposal: LayoutCoverageProposal, beforeFaces: readonly Point[][]) => boolean
}

/** New coarse enclosures are physical progress even before local streets cut
 * them below 60ha. An unchanged oversized face or a lone link earns neither. */
export const layoutCoverageHasPhysicalGain = (gain: { coveredGain: number; enclosedGain: number }) => gain.coveredGain > 100 || gain.enclosedGain > 10000

const proposalKey = (proposal: LayoutCoverageProposal) => {
  const anchor = (endpoint: LayoutCoverageProposal['from']) => `${endpoint.roadId}:${Math.round(endpoint.point.x)}:${Math.round(endpoint.point.y)}`
  return `${[anchor(proposal.from), anchor(proposal.to)].sort().join('|')}|${Math.round(proposal.through.x / 10)}:${Math.round(proposal.through.y / 10)}`
}
const gapRoundRobin = (proposals: LayoutCoverageProposal[]) => {
  const groups = new Map<string, LayoutCoverageProposal[]>()
  for (const proposal of proposals) {
    const key = `${Math.round(proposal.through.x / 10)}:${Math.round(proposal.through.y / 10)}`
    const group = groups.get(key) ?? []; group.push(proposal); groups.set(key, group)
  }
  const result: LayoutCoverageProposal[] = []
  for (let index = 0; index < 2; index++) for (const group of groups.values()) if (group[index]) result.push(group[index]!)
  return result
}

/** Re-read real roads and real faces ONLY after adoption. Failed proposals
 * consume the finite budget without repeatedly extracting the whole graph.
 * Calling this again after fallback admits those new public contacts and
 * remeasures the remaining demand instead of reusing early virtual anchors. */
export function runLayoutCoveragePass(input: LayoutCoveragePassInput) {
  const maximumAttempts = Math.max(0, Math.min(8, Math.floor(input.maximumAttempts)))
  let network = input.readNetwork(), coverage = measureLayoutStreetCoverage({ faces: network.faces, mask: input.mask })
  const record = { builtYear: input.builtYear, phase: input.phase, before: coverage.coveredArea, after: coverage.coveredArea, attempted: 0, accepted: 0, proposalRounds: 0, coveredGain: 0, enclosedGain: 0, prioritySites: 0, priorityGaps: 0 }
  const attempted = new Set<string>()
  while (record.attempted < maximumAttempts) {
    const candidates = proposeLayoutCoverageBlocks({ roads: network.roads, faces: network.faces, mask: input.mask, builtYear: input.builtYear, canAnchor: input.canAnchor, cellSize: input.cellSize, maximumProposals: 8, prioritySites: input.prioritySites })
    record.proposalRounds++
    record.prioritySites = Math.max(record.prioritySites, candidates.diagnostics.activePrioritySites)
    record.priorityGaps = Math.max(record.priorityGaps, candidates.diagnostics.priorityGaps)
    let changed = false
    // Spend the small budget on one candidate in each gap before trying the
    // second pair in the same gap. One awkward largest gap cannot consume the
    // entire late pass before a station-side gap receives an attempt.
    for (const proposal of gapRoundRobin(candidates.proposals)) {
      const key = proposalKey(proposal)
      if (attempted.has(key)) continue
      attempted.add(key); record.attempted++
      if (input.tryAdoptWithFaceGain(proposal, network.faces)) {
        const next = input.readNetwork(), nextCoverage = measureLayoutStreetCoverage({ faces: next.faces, mask: input.mask })
        const actualGain = { coveredGain: nextCoverage.coveredArea - coverage.coveredArea, enclosedGain: nextCoverage.enclosedArea - coverage.enclosedArea }
        if (!layoutCoverageHasPhysicalGain(actualGain)) throw new Error('Coverage adoption changed no physical dry street face')
        record.accepted++; record.coveredGain += actualGain.coveredGain; record.enclosedGain += actualGain.enclosedGain; record.after = nextCoverage.coveredArea
        network = next; coverage = nextCoverage; changed = true
        break
      }
      if (record.attempted >= maximumAttempts) break
    }
    if (!changed) break
  }
  return record
}
