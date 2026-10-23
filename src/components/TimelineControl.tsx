import { useRef, useState } from 'react'

export function TimelineControl({ year, generating, onCommit }: { year: number; generating: boolean; onCommit: (year: number) => void }) {
  const [value, setValue] = useState(year)
  const requested = useRef(year)
  function commit() {
    if (value === requested.current) return
    requested.current = value
    onCommit(value)
  }
  return <section className="timeline-control" aria-label="地図の年代">
    <label htmlFor="map-year">表示年代 <output htmlFor="map-year">{value}年</output></label>
    <input id="map-year" aria-label="地図の表示年代" type="range" min={1650} max={2025} step={1} value={value} onChange={event => setValue(Number(event.target.value))} onPointerUp={commit} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commit() }} onBlur={commit} />
    <div><span>1650</span><small>{generating ? '選んだ年代を計算中' : '離すとその年の地図を表示'}</small><span>2025</span></div>
  </section>
}
