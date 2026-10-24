export function TimelineControl({ year, generating, available = true, onCommit }: { year: number; generating: boolean; available?: boolean; onCommit: (year: number) => void }) {
  return <section className="timeline-control" aria-label="地図の年代">
    <label htmlFor="map-year">表示年代 <output htmlFor="map-year">{year}年</output></label>
    <input id="map-year" aria-label="地図の表示年代" type="range" min={1650} max={2025} step={1} value={year} disabled={!available && !generating} onChange={event => onCommit(Number(event.target.value))} />
    <div><span>1650</span>{(generating || !available) && <small>{generating ? '計算中 · 完了後の表示年を選択' : '年代履歴なし · 生成して表示'}</small>}<span>2025</span></div>
  </section>
}
