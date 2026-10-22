import type { CityMap, Point } from '../domain/types'

export type LayerSettings = {
  buildings: boolean
  roads: boolean
  railway: boolean
  labels: boolean
  facilities: boolean
  terrain: boolean
  grid: boolean
}

export type MapStyle = 'standard' | 'mono' | 'night'
export type Annotation = { id: string; point: Point; name: string; note: string; secret: boolean }
export type RenderOptions = {
  layers: LayerSettings
  style: MapStyle
  annotations: Annotation[]
  showSecrets: boolean
  scale: number
}

export const DEFAULT_LAYERS: LayerSettings = {
  buildings: true, roads: true, railway: true, labels: true,
  facilities: true, terrain: true, grid: false,
}

export const PALETTES = {
  standard: {
    ground: '#f2f2ed', residential: '#bbbebb', commercial: '#dfb8ad', public: '#a6afbc', industrial: '#c9c2b4',
    buildingEdge: '#a9aeaa', water: '#a7d5e5', waterEdge: '#90c5d7', forest: '#cadbbd', park: '#d4e2c7',
    field: '#e4e7cc', tree: '#92b487', treeDark: '#85a77d', roadEdge: '#d8d5c9', road: '#ffffff',
    arteryEdge: '#d9be73', artery: '#f7df9a', railway: '#555c58', railwayInner: '#f7f6f1', label: '#5a625d',
    halo: '#ffffff', station: '#2176a7', landmark: '#647761', grid: '#6b8b7d', note: '#bd654d', secret: '#816198',
  },
  mono: {
    ground: '#fafafa', residential: '#c8c8c8', commercial: '#aaa', public: '#9d9d9d', industrial: '#b7b7b7',
    buildingEdge: '#b2b2b2', water: '#e0e0e0', waterEdge: '#b6b6b6', forest: '#ddd', park: '#e8e8e8',
    field: '#eee', tree: '#c2c2c2', treeDark: '#b8b8b8', roadEdge: '#c8c8c8', road: '#fff',
    arteryEdge: '#aaa', artery: '#f3f3f3', railway: '#4d4d4d', railwayInner: '#fff', label: '#454545',
    halo: '#fff', station: '#333', landmark: '#555', grid: '#888', note: '#333', secret: '#777',
  },
  night: {
    ground: '#263331', residential: '#46534f', commercial: '#796759', public: '#647176', industrial: '#59605a',
    buildingEdge: '#53625b', water: '#254d5c', waterEdge: '#376273', forest: '#304b3b', park: '#3e5742',
    field: '#414d37', tree: '#3f6047', treeDark: '#46674b', roadEdge: '#3c4841', road: '#68746a',
    arteryEdge: '#8e8258', artery: '#bbab72', railway: '#c3ccc1', railwayInner: '#31413c', label: '#c9d1c7',
    halo: '#263331', station: '#8bcedc', landmark: '#a7c8a1', grid: '#86a292', note: '#e6ad8e', secret: '#c1a4d9',
  },
} as const

export const FACILITY_SYMBOLS: Record<string, string> = {
  castle: '城', shrine: '社', school: '文', hospital: '+', police: '交', shop: '店', park: '公', port: '港', onsen: '湯',
}

export const MAP_FONT = '"Noto Sans JP", "Yu Gothic", "Hiragino Kaku Gothic ProN", sans-serif'

export function tracePath(ctx: CanvasRenderingContext2D, points: Point[], close = false) {
  if (!points.length) return
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
  if (close) ctx.closePath()
}

function noise(x: number, y: number) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
  return n - Math.floor(n)
}

function terrainTexture(ctx: CanvasRenderingContext2D, polygon: Point[], color: string, dark: string, scale: number) {
  if (!polygon.length) return
  const minX = Math.min(...polygon.map(p => p.x))
  const maxX = Math.max(...polygon.map(p => p.x))
  const minY = Math.min(...polygon.map(p => p.y))
  const maxY = Math.max(...polygon.map(p => p.y))
  ctx.save()
  tracePath(ctx, polygon, true)
  ctx.clip()
  // Tree crowns are fixed in world space, so panning and exporting keep the same woodland.
  const spacing = scale < .12 ? 40 : 25
  for (let x = Math.floor(minX / spacing) * spacing; x < maxX; x += spacing) {
    for (let y = Math.floor(minY / spacing) * spacing; y < maxY; y += spacing) {
      const v = noise(x, y)
      ctx.fillStyle = v > .5 ? color : dark
      ctx.globalAlpha = .3 + v * .22
      ctx.beginPath()
      ctx.arc(x + noise(x + 5, y) * spacing, y + noise(x, y + 7) * spacing, 5 + v * 9, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.restore()
}

type LabelBox = { x: number; y: number; width: number; height: number }

export function renderMap(ctx: CanvasRenderingContext2D, map: CityMap, options: RenderOptions): void {
  const { layers, style, annotations, showSecrets } = options
  const scale = Math.max(.01, options.scale)
  const colors = PALETTES[style]
  ctx.save()
  ctx.fillStyle = colors.ground
  ctx.fillRect(0, 0, map.width, map.height)
  ctx.beginPath()
  ctx.rect(0, 0, map.width, map.height)
  ctx.clip()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  if (layers.terrain) {
    for (const area of map.areas) {
      tracePath(ctx, area.polygon, true)
      ctx.fillStyle = colors[area.kind]
      ctx.fill()
      if (area.kind === 'water') {
        ctx.lineWidth = .6 / scale
        ctx.strokeStyle = colors.waterEdge
        ctx.stroke()
      } else if (area.kind === 'forest') {
        terrainTexture(ctx, area.polygon, colors.tree, colors.treeDark, scale)
      }
    }
  }

  if (layers.buildings) {
    ctx.lineWidth = Math.min(.6 / scale, 1.1)
    for (const building of map.buildings) {
      tracePath(ctx, building.polygon, true)
      ctx.fillStyle = colors[building.kind]
      ctx.fill()
      if (scale > .3) {
        ctx.strokeStyle = colors.buildingEdge
        ctx.stroke()
      }
    }
  }

  if (layers.roads) {
    // Draw every casing before its road interior, preserving open junctions.
    for (const kind of ['local', 'arterial'] as const) {
      for (const road of map.roads) {
        if (road.kind !== kind) continue
        tracePath(ctx, road.points)
        ctx.lineWidth = Math.max(road.width, kind === 'local' ? 1.3 / scale : 3.2 / scale) + 1.3 / scale
        ctx.strokeStyle = kind === 'arterial' ? colors.arteryEdge : colors.roadEdge
        ctx.stroke()
      }
      for (const road of map.roads) {
        if (road.kind !== kind) continue
        tracePath(ctx, road.points)
        ctx.lineWidth = Math.max(road.width, kind === 'local' ? 1.3 / scale : 3.2 / scale)
        ctx.strokeStyle = kind === 'arterial' ? colors.artery : colors.road
        ctx.stroke()
      }
    }
  }

  if (layers.railway) {
    for (const rail of map.railways) {
      tracePath(ctx, rail.points)
      ctx.strokeStyle = colors.railwayInner
      ctx.lineWidth = 5.5 / scale
      ctx.stroke()
      ctx.strokeStyle = colors.railway
      ctx.lineWidth = 3.1 / scale
      ctx.stroke()
      ctx.strokeStyle = colors.railwayInner
      ctx.lineWidth = 1.55 / scale
      ctx.setLineDash([5 / scale, 4 / scale])
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  if (layers.grid) {
    ctx.strokeStyle = colors.grid
    ctx.globalAlpha = .3
    ctx.lineWidth = .6 / scale
    for (let x = 0; x <= map.width; x += 100) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, map.height); ctx.stroke()
    }
    for (let y = 0; y <= map.height; y += 100) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(map.width, y); ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  const occupied: LabelBox[] = []
  function label(text: string, point: Point, color: string, size = 12, weight = 500, force = false, dy = 0) {
    ctx.font = `${weight} ${size / scale}px ${MAP_FONT}`
    const width = ctx.measureText(text).width
    const height = (size + 5) / scale
    const box = { x: point.x - width / 2 - 4 / scale, y: point.y + dy - height / 2, width: width + 8 / scale, height }
    if (!force && occupied.some(b => box.x < b.x + b.width && box.x + box.width > b.x && box.y < b.y + b.height && box.y + box.height > b.y)) return
    occupied.push(box)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.strokeStyle = colors.halo
    ctx.lineWidth = 3.8 / scale
    ctx.strokeText(text, point.x, point.y + dy)
    ctx.fillStyle = color
    ctx.fillText(text, point.x, point.y + dy)
  }

  if (layers.railway) {
    for (const station of map.stations) {
      const p = station.point
      const w = 11 / scale
      ctx.fillStyle = colors.halo
      ctx.fillRect(p.x - w / 2 - 1 / scale, p.y - w / 2 - 1 / scale, w + 2 / scale, w + 2 / scale)
      ctx.fillStyle = colors.station
      ctx.fillRect(p.x - w / 2, p.y - w / 2, w, w)
      ctx.strokeStyle = colors.halo
      ctx.lineWidth = 1 / scale
      ctx.strokeRect(p.x - 3 / scale, p.y - 3 / scale, 6 / scale, 5 / scale)
      ctx.beginPath(); ctx.moveTo(p.x - 2.5 / scale, p.y + 4 / scale); ctx.lineTo(p.x + 2.5 / scale, p.y + 4 / scale); ctx.stroke()
      if (layers.labels) label(station.name, p, colors.station, 12, 700, true, 16 / scale)
    }
  }

  if (layers.facilities) {
    for (const facility of map.facilities) {
      const p = facility.point
      const prominent = facility.kind === 'castle' || facility.kind === 'shrine' || facility.kind === 'port' || facility.kind === 'onsen'
      const radius = (prominent ? 9 : 6) / scale
      ctx.fillStyle = colors.halo
      ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = facility.kind === 'hospital' ? (style === 'night' ? '#d39d93' : '#a6746b') : colors.landmark
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.font = `600 ${(prominent ? 12 : 9) / scale}px ${MAP_FONT}`
      ctx.fillText(FACILITY_SYMBOLS[facility.kind] ?? '●', p.x, p.y)
      if (layers.labels && (prominent || scale > .35)) label(facility.name, p, colors.label, 10, 500, prominent, 18 / scale)
    }
  }

  if (layers.labels) {
    for (const district of map.districts) label(district.name, district.point, colors.label, 12)
    if (layers.terrain) {
      for (const area of map.areas) {
        if (!area.name || !area.polygon.length || (layers.facilities && map.facilities.some(f => f.name === area.name))) continue
        const center = area.polygon.reduce((a, p) => ({ x: a.x + p.x / area.polygon.length, y: a.y + p.y / area.polygon.length }), { x: 0, y: 0 })
        label(area.name, center, area.kind === 'water' ? colors.station : colors.landmark, 11, 500)
      }
    }
  }

  for (const note of annotations) {
    if (note.secret && !showSecrets) continue
    const p = note.point
    const r = 6 / scale
    ctx.fillStyle = note.secret ? colors.secret : colors.note
    ctx.strokeStyle = colors.halo
    ctx.lineWidth = 1.6 / scale
    ctx.beginPath()
    ctx.moveTo(p.x, p.y)
    ctx.bezierCurveTo(p.x - r * 2, p.y - r * 2, p.x - r, p.y - r * 3.7, p.x, p.y - r * 3.7)
    ctx.bezierCurveTo(p.x + r, p.y - r * 3.7, p.x + r * 2, p.y - r * 2, p.x, p.y)
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = colors.halo
    ctx.beginPath(); ctx.arc(p.x, p.y - r * 2.6, r * .48, 0, Math.PI * 2); ctx.fill()
    if (layers.labels) label(note.name, p, note.secret ? colors.secret : colors.note, 12, 700, true, 10 / scale)
  }
  ctx.restore()
}
