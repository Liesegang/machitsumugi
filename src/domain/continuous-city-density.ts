/** A weakly developed fringe needs deeper serviced holdings and fewer local
 * streets. Dense central districts retain their existing walking distances;
 * the transition is continuous and follows the measured demand field. */
export function continuousLocalStreetDepth(intensity: number): number {
  const demand = Math.max(0, Math.min(1, Number.isFinite(intensity) ? intensity : 0))
  const fringe = Math.max(0, (.45 - demand) / .45)
  return 20 + (1 - demand) * 12 + fringe * 24
}
