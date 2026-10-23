import { useEffect, useRef } from 'react'
import type { CityMap } from '../domain/types'
import { DEFAULT_LAYERS, renderMap } from '../map/render'
import './RegionalContext.css'

export default function RegionalContext({ map }: { map: CityMap }) {
  const canvas = useRef<HTMLCanvasElement>(null), context = map.regionalContext
  useEffect(() => {
    if (!canvas.current || !context) return
    const size = 164, ratio = Math.min(2, window.devicePixelRatio || 1), ctx = canvas.current.getContext('2d')
    if (!ctx) return
    canvas.current.width = size * ratio; canvas.current.height = size * ratio
    ctx.scale(ratio * size / context.extent, ratio * size / context.extent)
    renderMap(ctx, { ...map, width: context.extent, height: context.extent, terrainSurface: context.surface, previewPhase: 'erosion', previewCrop: context.crop }, { layers: DEFAULT_LAYERS, annotations: [], showSecrets: false, style: 'standard', scale: size / context.extent })
  }, [context, map])
  if (!context) return null
  return <figure className="regional-context" aria-label="広域地形の中の生成区域"><canvas ref={canvas} role="img" aria-label="白い枠がこの地図の生成区域" /><figcaption>広域 {context.extent / 1000} km <span>白枠が表示範囲</span></figcaption></figure>
}
