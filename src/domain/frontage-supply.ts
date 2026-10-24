/** Equal-area disk approximation for one land integration cell. Only its
 * intersection with the serviced frontage band contributes housing supply;
 * touching the centre does not service the entire hinterland. This is an
 * explicit integration approximation, not a cadastral boundary or road grid. */
export function frontageCapacity(input: { capacity: number; area?: number; frontageDepth: number }, roadDistance: number): number {
  if (!Number.isFinite(roadDistance) || input.capacity <= 0 || input.frontageDepth <= 0) return 0
  const area = input.area ?? input.capacity * 950, radius = Math.sqrt(area / Math.PI)
  if (!(radius > 0) || roadDistance >= radius + input.frontageDepth) return 0
  const integral = (value: number) => { const y = Math.max(-radius, Math.min(radius, value)); return y * Math.sqrt(Math.max(0, radius * radius - y * y)) + radius * radius * Math.asin(y / radius) }
  const fraction = Math.max(0, Math.min(1, (integral(roadDistance + input.frontageDepth) - integral(roadDistance - input.frontageDepth)) / area))
  return Math.min(input.capacity, Math.max(0, Math.floor(input.capacity * fraction)))
}
