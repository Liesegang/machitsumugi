import type { Road } from '../domain/types'

/** Widths are world metres. Overview legibility must not promote a narrow
 * access lane into the same screen width as a district collector. */
export function roadStrokeWidths(road: Pick<Road, 'width' | 'kind' | 'role'>, scale: number) {
  const major = road.kind === 'arterial' || road.role === 'expressway'
  const collector = road.role === 'collector'
  const minimum = major ? 3.2 : collector ? 1.4 : road.role === 'access' ? .5 : road.role === 'farm' ? .4 : .55
  const width = Math.max(road.width, minimum / scale)
  return { width, outlinedWidth: width + (major ? 1.3 : collector ? .8 : .55) / scale }
}
