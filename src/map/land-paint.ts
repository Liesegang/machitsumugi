import type { Area } from '../domain/types'

const cache = new WeakMap<Area[], Area[][]>()
/** Natural cover is clipped into non-overlapping 400m pieces to bound polygon
 * work. Paint adjacent pieces in ONE fill operation: separate antialiased fills
 * expose their computational tile edges as a pale rectangular grid. Keep plot,
 * woodland and civic draw order, boundaries and holes unchanged. */
export function landPaintGroups(areas: Area[]): Area[][] {
  const cached = cache.get(areas)
  if (cached) return cached
  const groups: Area[][] = []
  let key: string | undefined
  for (const area of areas) {
    if (area.kind === 'water') continue
    const next = area.id.startsWith('land-') ? `${area.kind}:${area.landUse}` : undefined
    if (next !== undefined && next === key) groups.at(-1)!.push(area)
    else groups.push([area])
    key = next
  }
  cache.set(areas, groups)
  return groups
}
