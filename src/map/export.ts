import type { CityMap, Point } from '../domain/types'
import { areaColor, buildingColor, FACILITY_SYMBOLS, MAP_FONT, PALETTES, renderMap } from './render'
import type { RenderOptions } from './render'
import { terrainContours } from './contours'
import { waterGeometry } from './water-surfaces'
import { areaLabelPoint } from './area-labels'
import { seaDepthRaster } from './bathymetry'
import { landPaintGroups } from './land-paint'
import { subwayInk, SUBWAY_DASH, SUBWAY_LINE_WIDTH } from './railway-style'
import { woodlandCrowns, WOODLAND_TEXTURE_MIN_SCALE } from './woodland-texture'
import { roadStrokeWidths } from './road-style'

function filename(map: CityMap, extension: string) {
  return `${map.config.name.replace(/[\\/:*?"<>|]/g, '_') || 'machitsumugi'}-${map.config.seed.replace(/[^\w\u3000-\u9fff-]/g, '_').slice(0, 48)}.${extension}`
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1500)
}

export async function exportMapPng(map: CityMap, options: RenderOptions, width = 4096): Promise<void> {
  await document.fonts.ready
  const size = Math.max(1024, Math.min(8192, Math.round(width)))
  const height = Math.round(size * map.height / map.width)
  const margin = Math.round(size * .012)
  const footer = Math.round(size * .022)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('画像の描画領域を作成できませんでした。')
  const colors = PALETTES[options.style]
  ctx.fillStyle = colors.ground
  ctx.fillRect(0, 0, size, canvas.height)
  const scale = (height - footer) / map.height
  const offsetX = (size - map.width * scale) / 2
  ctx.save()
  ctx.translate(offsetX, 0)
  ctx.scale(scale, scale)
  renderMap(ctx, map, { ...options, scale: scale / Math.max(1, size / 2100) })
  ctx.restore()
  ctx.fillStyle = colors.halo
  ctx.globalAlpha = .94
  ctx.fillRect(margin, margin, size * .24, size * .045)
  ctx.globalAlpha = 1
  ctx.fillStyle = colors.label
  ctx.font = `700 ${Math.round(size * .011)}px ${MAP_FONT}`
  ctx.fillText(map.config.name, margin * 1.6, margin + size * .021)
  ctx.font = `${Math.round(size * .0058)}px ${MAP_FONT}`
  ctx.fillText(`${map.width / 1000} km × ${map.height / 1000} km ｜ 架空都市地図`, margin * 1.6, margin + size * .035)
  ctx.fillStyle = colors.halo
  ctx.fillRect(0, height - footer, size, footer)
  ctx.fillStyle = colors.label
  ctx.textBaseline = 'middle'
  ctx.font = `${Math.round(size * .0052)}px ${MAP_FONT}`
  ctx.fillText(`架空日本地図ジェネレーター  ·  ${map.config.seed}  ·  実在しない街の地図`, margin, height - footer / 2)
  const barX = size - margin - 500 * scale
  const barY = height - footer / 2 + size * .002
  ctx.strokeStyle = colors.label
  ctx.lineWidth = Math.max(1, size / 1800)
  ctx.beginPath()
  ctx.moveTo(barX, barY - 5); ctx.lineTo(barX, barY)
  ctx.lineTo(barX + 500 * scale, barY); ctx.lineTo(barX + 500 * scale, barY - 5)
  ctx.stroke()
  ctx.textAlign = 'center'
  ctx.fillText('500 m', barX + 250 * scale, barY - size * .004)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG画像を生成できませんでした。')), 'image/png'))
  downloadBlob(blob, filename(map, 'png'))
}

function escapeXml(value: string) {
  return value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)
}

function path(points: Point[], close = false) {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') + (close ? ' Z' : '')
}

/** A portable vector map; no images, remote resources, scripts, or editor chrome. */
export function exportMapSvg(map: CityMap, options: RenderOptions): void {
  const c = PALETTES[options.style]
  const { layers } = options
  const parts: string[] = []
  const px = Math.max(1, map.width / 2100)
  const text = (name: string, p: Point, color: string, size = 12, weight = 500) => `<text x="${p.x.toFixed(2)}" y="${p.y.toFixed(2)}" text-anchor="middle" dominant-baseline="central" font-size="${size * px}" font-weight="${weight}" fill="${color}" stroke="${c.halo}" stroke-width="${3 * px}" paint-order="stroke" stroke-linejoin="round">${escapeXml(name)}</text>`
  parts.push(`<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="4096" height="${Math.round(4096 * map.height / map.width)}" viewBox="0 0 ${map.width} ${map.height}" font-family="Noto Sans JP,Yu Gothic,Hiragino Kaku Gothic ProN,sans-serif"><title>${escapeXml(map.config.name)} — 架空日本地図ジェネレーター</title><desc>架空都市地図。seed: ${escapeXml(map.config.seed)}</desc><defs><clipPath id="bounds"><rect width="${map.width}" height="${map.height}"/></clipPath></defs><rect width="${map.width}" height="${map.height}" fill="${c.ground}"/><g clip-path="url(#bounds)" stroke-linejoin="round" stroke-linecap="round">`)
  if (layers.terrain) {
    let woodlandSerial = 0
    for (const group of landPaintGroups(map.areas)) {
      if (options.contours && map.terrainSurface) continue
      const area = group[0]!
      const d = group.flatMap(part => [part.polygon, ...part.holes ?? []]).map(ring => path(ring, true)).join(' ')
      parts.push(`<path d="${d}" fill="${areaColor(area, options.style)}" fill-rule="evenodd"/>`)
      if ((area.kind === 'forest' || area.landUse === 'woodland') && 1 / px >= WOODLAND_TEXTURE_MIN_SCALE) {
        const clipId = `woodland-texture-${woodlandSerial++}`
        parts.push(`<defs><clipPath id="${clipId}"><path d="${d}" clip-rule="evenodd"/></clipPath></defs><g clip-path="url(#${clipId})">`)
        for (const crown of woodlandCrowns(group, area.landUse === 'woodland')) parts.push(`<circle cx="${crown.x.toFixed(3)}" cy="${crown.y.toFixed(3)}" r="${crown.radius.toFixed(3)}" fill="${crown.dark ? c.treeDark : c.tree}" opacity="${crown.opacity.toFixed(6)}"/>`)
        parts.push('</g>')
      }
    }
    const water = waterGeometry(map.areas)
    let seaSerial = 0
    for (const area of water.surfaces) {
      const d = [area.polygon, ...(area.holes ?? [])].map(ring => path(ring, true)).join(' ')
      parts.push(`<path d="${d}" fill="${areaColor(area, options.style)}" fill-rule="evenodd"/>`)
      if (map.terrainSurface && (area.id === 'sea' || area.id.startsWith('sea-'))) {
        const surface = map.terrainSurface, id = `sea-depth-${seaSerial++}`
        const canvas = seaDepthRaster(surface, options.style)
        if (!('toDataURL' in canvas)) throw new Error('SVGの書き出しにはブラウザの描画領域が必要です')
        const raster = canvas.toDataURL('image/png')
        parts.push(`<defs><clipPath id="${id}"><path d="${d}" clip-rule="evenodd"/></clipPath></defs><image href="${raster}" x="${-surface.cellSize / 2}" y="${-surface.cellSize / 2}" width="${surface.columns * surface.cellSize}" height="${surface.rows * surface.cellSize}" preserveAspectRatio="none" clip-path="url(#${id})"/>`)
      }
    }
    for (const shoreline of water.shorelines) parts.push(`<path d="${[shoreline.polygon, ...(shoreline.holes ?? [])].map(ring => path(ring, true)).join(' ')}" fill="none" stroke="${c.waterEdge}" stroke-width="1.5"/>`)
  }
  if (options.contours && map.terrainSurface) for (const line of terrainContours(map.terrainSurface, map.areas.some(area => area.id === 'sea' || area.id.startsWith('sea-')))) {
    parts.push(`<path data-elevation="${line.elevation}" d="${path(line.points)}" fill="none" stroke="${options.style === 'mono' ? '#777777' : '#9b8060'}" stroke-width="${(line.index ? 1.15 : .6) * px}" opacity="${line.index ? .85 : .48}"/>`)
    if (line.index && line.points.length > 8) parts.push(text(`${line.elevation}m`, line.points[Math.floor(line.points.length * .43)]!, '#816849', 10))
  }
  if (layers.districts) for (const district of map.districts) for (const region of district.regions ?? []) parts.push(`<path d="${[region.polygon, ...(region.holes ?? [])].map(ring => path(ring, true)).join(' ')}" fill="none" stroke="${options.style === 'night' ? '#b3a6c8' : '#8a8293'}" stroke-width="${(district.kind === 'ward' ? 1.25 : .65) * px}" stroke-dasharray="${4 * px} ${3 * px}" opacity=".65"/>`)
  if (layers.buildings && map.parcels) for (const p of map.parcels.filter(p => p.developedYear && p.retiredYear === undefined)) parts.push(`<path d="${path(p.polygon, true)}" fill="none" stroke="${c.roadEdge}" stroke-width=".6"/>`)
  if (layers.buildings) for (const b of map.buildings) parts.push(`<path d="${path(b.polygon, true)}" fill="${buildingColor(b, options.style)}"/>`)
  if (layers.roads) {
    for (const p of map.parcels ?? []) if (p.developedYear && p.retiredYear === undefined && p.access?.length) parts.push(`<path d="${path(p.access)}" fill="none" stroke="${c.roadEdge}" stroke-width="3.4"/><path d="${path(p.access)}" fill="none" stroke="${c.road}" stroke-width="2.8"/>`)
    for (const kind of ['local', 'arterial'] as const) {
      for (const road of map.roads.filter(r => r.kind === kind)) parts.push(`<path d="${path(road.points)}" fill="none" stroke="${kind === 'arterial' ? c.arteryEdge : c.roadEdge}" stroke-width="${roadStrokeWidths(road, 4096 / map.width).outlinedWidth}"/>`)
      for (const road of map.roads.filter(r => r.kind === kind)) parts.push(`<path d="${path(road.points)}" fill="none" stroke="${kind === 'arterial' ? c.artery : c.road}" stroke-width="${roadStrokeWidths(road, 4096 / map.width).width}"/>`)
    }
  }
  if (layers.railway) for (const rail of map.railways) {
    if (rail.mode === 'subway') {
      parts.push(`<path data-mode="subway" d="${path(rail.points)}" fill="none" stroke="${c.halo}" stroke-width="${(SUBWAY_LINE_WIDTH + 2) * px}"/><path data-mode="subway" d="${path(rail.points)}" fill="none" stroke="${subwayInk(options.style)}" stroke-width="${SUBWAY_LINE_WIDTH * px}" stroke-dasharray="${SUBWAY_DASH.map(value => value * px).join(' ')}"/>`)
      continue
    }
    parts.push(`<path d="${path(rail.points)}" fill="none" stroke="${c.railwayInner}" stroke-width="${5.5 * px}"/><path d="${path(rail.points)}" fill="none" stroke="${c.railway}" stroke-width="${3.1 * px}"/><path d="${path(rail.points)}" fill="none" stroke="${c.railwayInner}" stroke-width="${1.55 * px}" stroke-dasharray="${5 * px} ${4 * px}"/>`)
  }
  if (layers.grid) {
    for (let x = 0; x <= map.width; x += 100) parts.push(`<path d="M${x} 0V${map.height}" stroke="${c.grid}" stroke-width="1" opacity=".3"/>`)
    for (let y = 0; y <= map.height; y += 100) parts.push(`<path d="M0 ${y}H${map.width}" stroke="${c.grid}" stroke-width="1" opacity=".3"/>`)
  }
  if (layers.labels) for (const district of map.districts) parts.push(text(district.name, district.point, c.label))
  if (layers.labels && layers.buildings) for (const building of map.buildings) {
    if (building.use !== 'lodging' || !building.name || !building.polygon.length) continue
    const center = building.polygon.reduce((a, p) => ({ x: a.x + p.x / building.polygon.length, y: a.y + p.y / building.polygon.length }), { x: 0, y: 0 })
    parts.push(text(building.name, center, c.label, 10))
  }
  if (layers.railway) for (const station of map.stations) {
    const { x, y } = station.point
    if (layers.buildings && station.buildingPolygon) parts.push(`<path d="${path(station.buildingPolygon, true)}" fill="${c.public}" stroke="${c.buildingEdge}" stroke-width="${.6 * px}"/>`)
    if (station.mode === 'subway') {
      parts.push(`<circle data-mode="subway" cx="${x}" cy="${y}" r="${6 * px}" fill="${c.halo}" stroke="${subwayInk(options.style)}" stroke-width="${2 * px}"/>`)
      if (layers.labels) parts.push(text(station.name, { x, y: y + 16 * px }, subwayInk(options.style), 11, 700))
      continue
    }
    parts.push(`<rect x="${x - 6 * px}" y="${y - 6 * px}" width="${12 * px}" height="${12 * px}" rx="${px}" fill="${c.station}" stroke="${c.halo}" stroke-width="${px}"/><path d="M${x - 3 * px} ${y - 3 * px}h${6 * px}v${5 * px}h${-6 * px}z M${x - 2.5 * px} ${y + 4 * px}h${5 * px}" stroke="${c.halo}" stroke-width="${px}" fill="none"/>`)
    if (layers.labels) parts.push(text(station.name, { x, y: y + 17 * px }, c.station, 12, 700))
  }
  if (layers.facilities) for (const facility of map.facilities) {
    const { x, y } = facility.point
    parts.push(`<circle cx="${x}" cy="${y}" r="${8 * px}" fill="${c.halo}"/>${text(FACILITY_SYMBOLS[facility.kind] ?? '●', facility.point, c.landmark, 11, 700)}`)
    if (layers.labels) parts.push(text(facility.name, { x, y: y + 18 * px }, c.label, 10))
  }
  if (layers.labels && layers.terrain) for (const area of map.areas) {
    if (!area.name || (layers.facilities && map.facilities.some(facility => facility.name === area.name))) continue
    const point = areaLabelPoint(area, map.areas)
    if (point) parts.push(text(area.name, point, area.kind === 'water' ? c.station : c.landmark, 11))
  }
  for (const annotation of options.annotations) {
    if (annotation.secret && !options.showSecrets) continue
    const { x, y } = annotation.point
    const color = annotation.secret ? c.secret : c.note
    parts.push(`<path d="M${x} ${y}C${x - 22 * px} ${y - 23 * px} ${x - 9 * px} ${y - 31 * px} ${x} ${y - 31 * px}C${x + 9 * px} ${y - 31 * px} ${x + 22 * px} ${y - 23 * px} ${x} ${y}Z" fill="${color}" stroke="${c.halo}" stroke-width="${1.6 * px}"/><circle cx="${x}" cy="${y - 21 * px}" r="${3 * px}" fill="${c.halo}"/>`)
    if (layers.labels) parts.push(text(annotation.name, { x, y: y + 13 * px }, color, 12, 700))
  }
  parts.push(`</g></svg>`)
  downloadBlob(new Blob(parts, { type: 'image/svg+xml;charset=utf-8' }), filename(map, 'svg'))
}
