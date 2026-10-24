import { useMemo } from 'react'
import type { CityMap } from '../domain/types'
import { sliceCityAtYear } from '../domain/timeline'
import { FACILITY_NAMES } from './facility-labels'

function TerrainCalculation({ simulation: s }: { simulation: NonNullable<CityMap['terrainSimulation']> }) {
  const volume = (value: number) => `${value !== 0 && Math.abs(value) < .01 ? value.toExponential(2) : value.toLocaleString('ja-JP', { maximumFractionDigits: 2 })} m³`
  const rows = [
    ['計算格子・反復', `${s.resolution.toLocaleString('ja-JP')} m · ${s.steps.toLocaleString('ja-JP')}回`],
    ['地形形成の相当時間', `${s.elapsedYears.toLocaleString('ja-JP')}年`],
    ['岩盤削剥', volume(s.bedrockErodedVolume)], ['堆積物貯留', volume(s.storedSedimentVolume)],
    ['領域外への土砂排出', volume(s.exportedSedimentVolume)], ['局所河床の掘削', volume(s.localExcavationVolume)],
    ['局所河床への堆積', volume(s.localDepositionVolume)], ['局所処理の土砂排出', volume(s.localExportedVolume)],
    ['土砂収支誤差', volume(s.sedimentBalanceError)], ['地盤収支誤差', volume(s.groundBalanceError)], ['局所処理の収支誤差', volume(s.localBalanceError)],
  ]
  return <div className="terrain-calculation"><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p>運搬長と河道侵食力（stream-power）による簡略モデルです。</p></div>
}

/** The report describes the completed simulation, regardless of the year on screen. */
export function GenerationReport({ map, onSettings }: { map: CityMap; onSettings: () => void }) {
  const complete = useMemo(() => map.timeline ? sliceCityAtYear(map, map.timeline.throughYear) : map, [map])
  const failed = complete.unplacedFacilities ?? []
  const facilities = [...new Set(complete.facilities.map(item => item.kind))].map(kind => ({ kind, items: complete.facilities.filter(item => item.kind === kind) }))
  return <div className="generation-report">
    <p className="report-context">{complete.config.name} · {complete.year ?? 2025}年までの生成結果</p>
    <dl className="report-overview"><div><dt>建物</dt><dd>{complete.buildings.length.toLocaleString('ja-JP')}棟</dd></div><div><dt>道路</dt><dd>{complete.roads.length.toLocaleString('ja-JP')}本</dd></div><div><dt>シード</dt><dd>{complete.config.seed}</dd></div></dl>
    {failed.length > 0 && <section className="report-problems" aria-labelledby="report-problems-title"><h3 id="report-problems-title">配置できなかった施設 {failed.length}種</h3><dl>{failed.map(item => <div key={item.kind}><dt>{FACILITY_NAMES[item.kind]}</dt><dd>{item.reason}</dd></div>)}</dl><button className="secondary" onClick={onSettings}>生成設定へ戻る</button></section>}
    {facilities.length > 0 && <section className="report-facilities"><h3>配置された施設</h3><dl>{facilities.map(({ kind, items }) => <div key={kind}><dt>{FACILITY_NAMES[kind]}</dt><dd>{items.length === 1 ? items[0]!.name : <details><summary>{items.length}か所</summary><ul>{items.map(item => <li key={item.id}>{item.name}</li>)}</ul></details>}</dd></div>)}</dl></section>}
    {complete.growthLog?.length ? <details className="report-detail"><summary>街の発展記録</summary><ol className="report-history">{complete.growthLog.map((stage, index) => <li key={index}><time>{stage.year}年</time><span>{stage.reason ?? `道路${stage.roadsAdded}本を整備`}</span></li>)}</ol></details> : null}
    {complete.terrainSimulation && <details className="report-detail"><summary>地形の計算記録</summary><TerrainCalculation simulation={complete.terrainSimulation} /></details>}
  </div>
}
