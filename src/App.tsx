import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Eye, EyeOff, FileJson, HelpCircle, Image, LoaderCircle, MapPin, Menu, MousePointer2, PanelLeftClose, Save, Trash2, Upload, X } from 'lucide-react'
import type { Building, CityConfig, CityMap, Facility, Point } from './domain/types'
import { CITY_PRESETS, DEFAULT_CONFIG } from './domain/generator'
import { GENERATOR_VERSION } from './domain/land-development'
import { downloadProject, loadProjectArchive, MAX_PROJECT_FILE_BYTES, parseProject, persistProjectArchive } from './domain/project'
import type { Project } from './domain/project'
import { DEFAULT_LAYERS, PALETTES } from './map/render'
import type { Annotation, RenderOptions } from './map/render'
import { exportMapPng, exportMapSvg } from './map/export'
import { MapCanvas } from './components/MapCanvas'
import type { MapHandle } from './components/MapCanvas'
import { FACILITY_NAMES, SettingsPanel, Toggle } from './components/SettingsPanel'
import { Dialog } from './components/Dialog'
import './App.css'

const normalizeConfig = (config: CityConfig): CityConfig => ({ ...config, era: config.era ?? 'present', terrain: (config.type === 'port' || config.facilities.includes('port')) && config.terrain === 'plain' ? 'coast' : config.terrain })
const newProject = (): Project => ({ version: 2, config: DEFAULT_CONFIG, layers: DEFAULT_LAYERS, annotations: [], style: 'standard' })
const layerNames = { terrain: '地形・水域・緑地', buildings: '建物・住宅', roads: '道路', railway: '線路・駅', labels: '地名・ラベル', facilities: '施設', grid: '100 m グリッド' }
const buildingNames = { residential: '住宅', commercial: '商業施設', public: '公共施設', industrial: '工業・倉庫' }
const eraNames = { historic: '近世の街', railway: '鉄道開通後', present: '郊外拡大後' }
function App() {
  const [project, setProject] = useState<Project>(newProject)
  const [draft, setDraft] = useState<CityConfig>(project.config)
  const [map, setMap] = useState<CityMap | null>(project.snapshot ?? null)
  const [generating, setGenerating] = useState(!project.snapshot)
  const [restoring, setRestoring] = useState(true)
  const [generationLabel, setGenerationLabel] = useState('地形と水系を計算中…')
  const [tab, setTab] = useState<'create' | 'layers' | 'pins'>('create')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [pinMode, setPinMode] = useState(false)
  const [showSecrets, setShowSecrets] = useState(true)
  const [selected, setSelected] = useState<Annotation | null>(null)
  const [feature, setFeature] = useState<{ point: Point; item: Building | Facility } | null>(null)
  const [dialog, setDialog] = useState<'export' | 'help' | null>(null)
  const [format, setFormat] = useState<'png' | 'svg'>('png')
  const [exportWidth, setExportWidth] = useState(4096)
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')
  const [saveAvailable, setSaveAvailable] = useState(true)
  const sequence = useRef(0)
  const importSequence = useRef(0)
  const restoreSequence = useRef(0)
  const saveFailureNotified = useRef(false)
  const mapRef = useRef<MapHandle>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(project.config)
  const palette = PALETTES[project.style]
  const options = useMemo<RenderOptions>(() => ({ layers: project.layers, style: project.style, annotations: project.annotations, showSecrets, scale: 1 }), [project.layers, project.style, project.annotations, showSecrets])
  useEffect(() => {
    const request = ++restoreSequence.current
    void loadProjectArchive().then(saved => {
      if (request !== restoreSequence.current) return
      if (saved) {
        const restored = saved.snapshot ? saved : { ...saved, config: normalizeConfig(saved.config) }
        setProject(restored); setDraft(restored.config); setMap(restored.snapshot ?? null); setGenerating(!restored.snapshot)
      }
      setRestoring(false)
    })
    return () => { restoreSequence.current += 1 }
  }, [])
  useEffect(() => {
    if (restoring || project.snapshot) return
    const id = ++sequence.current
    const instance = new Worker(new URL('./domain/generator.worker.ts', import.meta.url), { type: 'module' })
    instance.onmessage = (event: MessageEvent<{ id: number; map?: CityMap; error?: string; progress?: string }>) => {
      if (event.data.id !== sequence.current) return
      if (typeof event.data.progress === 'string') { setGenerationLabel(event.data.progress); return }
      if (event.data.error) { setGenerating(false); setError(event.data.error) }
      else if (event.data.map) {
        const generated = event.data.map
        setGenerating(false)
        setMap(generated)
        setProject(old => ({ ...old, config: generated.config, snapshot: generated }))
        setError('')
      }
    }
    instance.onerror = () => { if (id !== sequence.current) return; setGenerating(false); setError('地図を生成できませんでした。ページを再読み込みしてください。') }
    instance.postMessage({ id, config: project.config })
    // Importing a saved map also cancels any unfinished generation of the previous map.
    return () => instance.terminate()
  }, [project.config, project.snapshot, restoring])
  useEffect(() => {
    // Keep the last completed map in storage if a new generation fails or is interrupted.
    if (restoring || !project.snapshot) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void persistProjectArchive(project).then(saved => {
        if (cancelled) return
        setSaveAvailable(saved)
        if (!saved && !saveFailureNotified.current) setToast('自動保存できません。「設定を保存」で地図ファイルを保存してください。')
        saveFailureNotified.current = !saved
      })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [project, restoring])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer) }, [toast])
  function generate() {
    if (restoring || !draft.name.trim() || !draft.seed.trim()) return
    const config = normalizeConfig({ ...draft, name: draft.name.trim(), seed: draft.seed.trim() })
    sequence.current += 1
    importSequence.current += 1
    if (importRef.current) importRef.current.value = ''
    setGenerating(true)
    setGenerationLabel('地形と水系を計算中…')
    setProject(old => ({ ...old, config, annotations: [], snapshot: undefined }))
    setDraft(config); setSelected(null); setFeature(null); setPinMode(false); setError('')
    if (window.innerWidth < 850) setSidebarOpen(false)
  }
  function saveProject() {
    if (!project.snapshot || generating) return
    try { downloadProject(project); setToast(dirty ? '表示中の地図・設定・ピンを保存しました。未反映の設定は含まれません。' : '地図・設定・ピンを保存しました') }
    catch (err) { setError(err instanceof Error ? err.message : '設定を保存できませんでした') }
  }
  function addPin(point: Point) {
    if (generating || !project.snapshot) { setToast('地図の生成が完了してからピンを追加してください'); return }
    if (project.annotations.length >= 200) { setToast('ピンは200個まで配置できます'); return }
    setSelected({ id: crypto.randomUUID(), point, name: '', note: '', secret: false }); setFeature(null)
  }
  function pick(point: Point, item?: Building | Facility) {
    if (generating || !project.snapshot) return
    if (pinMode) { addPin(point); return }
    const existing = project.annotations.find(pin => (showSecrets || !pin.secret) && Math.hypot(pin.point.x - point.x, pin.point.y - point.y) < 45)
    if (existing) { setSelected(existing); return }
    setFeature(item ? { point, item } : null)
  }
  function savePin() {
    if (!selected?.name.trim()) return
    const pin = { ...selected, name: selected.name.trim() }
    setProject(old => ({ ...old, annotations: old.annotations.some(item => item.id === pin.id) ? old.annotations.map(item => item.id === pin.id ? pin : item) : [...old.annotations, pin] }))
    setSelected(null); setPinMode(false); setToast('ピンを保存しました')
  }
  async function importFile(file?: File) {
    if (!file) return
    const request = ++importSequence.current
    try {
      if (file.size > MAX_PROJECT_FILE_BYTES) throw new Error('40 MB以下の設定ファイルを選んでください')
      const text = await file.text()
      if (request !== importSequence.current) return
      const parsed = parseProject(text), next = parsed.snapshot ? parsed : { ...parsed, config: normalizeConfig(parsed.config) }
      sequence.current += 1
      restoreSequence.current += 1
      setRestoring(false)
      setProject(next); setDraft(next.config); setSelected(null); setFeature(null); setPinMode(false); setError('')
      setGenerating(!next.snapshot)
      setGenerationLabel('地形と水系を計算中…')
      if (next.snapshot) setMap(next.snapshot)
      setToast(next.snapshot ? '保存済みの地図・設定・ピンを読み込みました' : '旧形式の設定を読み込みました。現在のエンジンで地図を生成します。')
    } catch (err) { if (request === importSequence.current) setError(err instanceof Error ? err.message : '設定を読み込めませんでした') }
    if (request === importSequence.current && importRef.current) importRef.current.value = ''
  }
  async function exportImage() {
    if (!map || !project.snapshot || generating) return
    setExporting(true)
    try {
      const exportOptions = { ...options, showSecrets: includeSecrets }
      if (format === 'svg') await exportMapSvg(map, exportOptions)
      else await exportMapPng(map, exportOptions, exportWidth)
      setDialog(null); setToast('画像を書き出しました')
    } catch { setError('画像を書き出せませんでした。解像度を下げて再度お試しください。') }
    finally { setExporting(false) }
  }
  return <div className="app-shell">
    <a className="skip-link" href="#city-map">地図へ移動</a>
    <header className="app-header"><div className="brand"><h1>街紡ぎ</h1></div><div className="header-actions"><button className="icon-button help-button" title="使い方" aria-label="使い方" onClick={() => setDialog('help')}><HelpCircle size={19} /></button><button className="secondary save-project" disabled={!project.snapshot || generating} onClick={saveProject}><Save size={17} /><span>設定を保存</span></button><button className="primary" disabled={!map || !project.snapshot || generating} onClick={() => setDialog('export')}><Image size={17} /><span>画像を書き出す</span></button></div></header>
    <div className="workspace">
      {sidebarOpen && <button className="sidebar-scrim" aria-label="設定パネルを閉じる" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`} aria-label="街の設定"><nav className="panel-tabs" aria-label="編集パネル"><button className={tab === 'create' ? 'active' : ''} aria-current={tab === 'create' ? 'page' : undefined} onClick={() => setTab('create')}>街をつくる</button><button className={tab === 'layers' ? 'active' : ''} aria-current={tab === 'layers' ? 'page' : undefined} onClick={() => setTab('layers')}>レイヤー</button><button className={tab === 'pins' ? 'active' : ''} aria-current={tab === 'pins' ? 'page' : undefined} onClick={() => setTab('pins')}>ピン</button><button className="close-sidebar icon-button" aria-label="設定パネルを閉じる" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={18} /></button></nav>
        {tab === 'create' && <SettingsPanel config={draft} onChange={setDraft} generating={generating} dirty={dirty} onGenerate={generate} />}
        {tab === 'layers' && <div className="panel-scroll"><section><h2>地図の表示</h2><p className="muted">書き出す画像にも反映されます。</p>{Object.entries(layerNames).map(([key, name]) => <Toggle key={key} label={name} value={project.layers[key as keyof typeof layerNames]} onChange={value => setProject(old => ({ ...old, layers: { ...old.layers, [key]: value } }))} />)}</section><section><h2>地図のスタイル</h2><div className="style-options">{([{ id: 'standard', name: '標準' }, { id: 'mono', name: 'モノクロ' }, { id: 'night', name: '夜間' }] as const).map(style => <button key={style.id} className={project.style === style.id ? 'selected' : ''} aria-pressed={project.style === style.id} onClick={() => setProject(old => ({ ...old, style: style.id }))}><span className={`style-sample ${style.id}`} />{style.name}</button>)}</div></section><section><h2>設定ファイル</h2><p className="muted">地図の形・設定・ピンをJSONに保存します。更新後も同じ地図を復元できます。</p><button className="secondary full" onClick={() => importRef.current?.click()}><Upload size={16} />設定を読み込む</button><button className="text-button full" disabled={!project.snapshot || generating} onClick={saveProject}><FileJson size={16} />設定を保存</button><p className="panel-footnote">{generating ? '生成が完了すると地図を自動保存します。' : saveAvailable ? 'このブラウザに地図とピンを自動保存しています。' : '地図の容量またはブラウザの制限により、自動保存できません。「設定を保存」でファイルを保存してください。'}</p></section></div>}
        {tab === 'pins' && <div className="panel-scroll"><section><h2>ピン</h2><p className="muted">地図に場所とメモを登録できます。</p><button className={`secondary full ${pinMode ? 'selected' : ''}`} disabled={generating || !project.snapshot} onClick={() => { setPinMode(!pinMode); if (window.innerWidth < 850) setSidebarOpen(false) }}><MapPin size={17} />{pinMode ? '配置をキャンセル' : '地図をクリックして追加'}</button><button className="text-button full" disabled={generating || !project.snapshot} onClick={() => { const p = mapRef.current?.getCenter() || { x: 2000, y: 1500 }; addPin({ x: Math.max(0, Math.min(map?.width ?? 4000, p.x)), y: Math.max(0, Math.min(map?.height ?? 3000, p.y)) }) }}>画面の中央に追加</button><Toggle label="GM用ピンを表示" value={showSecrets} onChange={setShowSecrets} icon={showSecrets ? <Eye size={17} /> : <EyeOff size={17} />} /></section><div className="pin-list">{project.annotations.length ? project.annotations.map(pin => <button className="pin-row" key={pin.id} disabled={generating || !project.snapshot} onClick={() => { setSelected(pin); mapRef.current?.center(pin.point) }}><MapPin size={19} /><span><b>{pin.name}</b><small>{pin.secret ? 'GMのみ' : '公開'}{pin.note ? ` · ${pin.note.slice(0, 22)}` : ''}</small></span></button>) : <div className="empty-pins"><MapPin size={30} strokeWidth={1} /><p>ピンは登録されていません。</p><span>地図上の建物からも追加できます。</span></div>}</div><p className="panel-footnote">街を生成し直すと、ピンはリセットされます。先に設定を保存しておくと復元できます。</p></div>}
      </aside>
      <main id="city-map" className="map-workspace"><div className="map-area">
        {map && <MapCanvas ref={mapRef} map={map} options={options} pinMode={pinMode} onPick={pick} onAnnotationPick={pin => { if (!generating && project.snapshot) setSelected(pin) }} />}
        <div className="map-title"><button className="mobile-menu icon-button" aria-label="街の設定を開く" onClick={() => setSidebarOpen(true)}><Menu size={21} /></button><div><h2>{map?.config.name || project.config.name}</h2><span>{CITY_PRESETS.find(preset => preset.id === (map?.config.type || project.config.type))?.name} · {map ? `${map.width / 1000} km × ${map.height / 1000} km` : '4 km × 3 km'}{map?.year !== undefined ? ` · ${map.year}年` : ''}</span></div></div>
        <div className="map-tools"><div className="map-style-switch">{([{ id: 'standard', name: '標準' }, { id: 'mono', name: 'モノクロ' }] as const).map(style => <button key={style.id} className={project.style === style.id ? 'active' : ''} aria-pressed={project.style === style.id} onClick={() => setProject(old => ({ ...old, style: style.id }))}>{style.name}</button>)}</div><div className="drawing-tools"><button className={!pinMode ? 'active' : ''} aria-label="地図を移動・建物を選択" title="地図を移動・建物を選択" aria-pressed={!pinMode} onClick={() => setPinMode(false)}><MousePointer2 size={20} /></button><button className={pinMode ? 'active' : ''} aria-label="地図にピンを追加" title="地図にピンを追加" disabled={generating || !project.snapshot} aria-pressed={pinMode} onClick={() => setPinMode(!pinMode)}><MapPin size={20} /></button></div></div>
        {pinMode && <div className="mode-notice"><MapPin size={15} />ピンを置く場所をクリック<button aria-label="ピン配置をやめる" onClick={() => setPinMode(false)}><X size={15} /></button></div>}
        <div className="map-legend">{[{ name: '住宅', color: palette.residential }, { name: '商業', color: palette.commercial }, { name: '公共施設', color: palette.public }, { name: '緑地', color: palette.park }, { name: '水域', color: palette.water }].map(item => <span key={item.name}><i style={{ background: item.color }} />{item.name}</span>)}</div>
        {(restoring || generating) && <div className={`generation-overlay ${map ? 'regenerating' : ''}`} role="status"><LoaderCircle className="spin" size={25} /><span>{restoring ? '保存済みの地図を読み込み中…' : generationLabel}</span></div>}
        {feature && <div className="feature-popover"><button className="icon-button popover-close" aria-label="建物情報を閉じる" onClick={() => setFeature(null)}><X size={16} /></button><span className="field-caption">この場所について</span><h3>{'name' in feature.item ? feature.item.name : buildingNames[feature.item.kind]}</h3><p>{'height' in feature.item ? `地上${feature.item.height}階 · ${Math.round(Math.abs(feature.item.polygon.reduce((area, p, i, a) => area + p.x * a[(i + 1) % a.length].y - a[(i + 1) % a.length].x * p.y, 0)) / 2)} m²` : FACILITY_NAMES[feature.item.kind]}{'builtYear' in feature.item && feature.item.builtYear !== undefined ? ` · ${feature.item.builtYear}年建築` : ''}</p><button className="secondary full" onClick={() => addPin(feature.point)}><MapPin size={15} />ここにピンを追加</button></div>}
      </div><footer className="map-status"><span>{map ? `建物 ${map.buildings.length.toLocaleString()}棟` : '生成中'}<i />シード {map?.config.seed || project.config.seed}</span><span title={`生成エンジン ${map?.generatorVersion ?? '版情報なし'} · 現行 ${GENERATOR_VERSION}`}>{map ? `${eraNames[map.config.era ?? 'present']}${map.year !== undefined ? ` · ${map.year}年` : ''} · エンジン ${map.generatorVersion ?? '版情報なし'}` : 'ドラッグで移動 · スクロールで拡大'}</span></footer></main>
    </div>
    <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={event => void importFile(event.target.files?.[0])} />
    {toast && <div className="toast" role="status">{toast}</div>}
    {error && <div className="error-toast" role="alert"><span>{error}</span><button aria-label="エラーを閉じる" onClick={() => setError('')}><X size={17} /></button></div>}
    {selected && <Dialog title="ピンを編集" onClose={() => setSelected(null)}><div className="dialog-body"><label className="stack-field">場所の名前<input autoFocus value={selected.name} maxLength={60} placeholder="例：古書店「月読堂」" onChange={event => setSelected({ ...selected, name: event.target.value })} /></label><label className="stack-field">メモ<textarea value={selected.note} maxLength={2000} rows={4} placeholder="この場所にある手がかりや、登場人物など" onChange={event => setSelected({ ...selected, note: event.target.value })} /></label><Toggle label="GM用ピンにする" value={selected.secret} onChange={value => setSelected({ ...selected, secret: value })} icon={<EyeOff size={17} />} /><p className="muted">GM用ピンは、画像の書き出し時に隠せます。</p></div><div className="dialog-footer">{project.annotations.some(item => item.id === selected.id) ? <button className="text-button danger" onClick={() => { setProject(old => ({ ...old, annotations: old.annotations.filter(item => item.id !== selected.id) })); setSelected(null) }}><Trash2 size={16} />削除</button> : <span />}<button className="primary" disabled={!selected.name.trim()} onClick={savePin}>ピンを保存</button></div></Dialog>}
    {dialog === 'export' && <Dialog title="画像を書き出す" onClose={() => { if (!exporting) setDialog(null) }}><div className="dialog-body"><p className="muted">表示中のレイヤーとスタイルで、街全体を書き出します。</p><label className="stack-field">ファイル形式<select value={format} onChange={e => setFormat(e.target.value as 'png' | 'svg')}><option value="png">PNG画像</option><option value="svg">SVG（拡大しても鮮明）</option></select></label>{format === 'png' && <label className="stack-field">画像サイズ<select value={exportWidth} onChange={e => setExportWidth(Number(e.target.value))}>{[2048, 4096, 8192].map(width => <option key={width} value={width}>{width} × {Math.round(width * (map?.height ?? 3000) / (map?.width ?? 4000))} px</option>)}</select></label>}<Toggle label="GM用ピンを含める" value={includeSecrets} onChange={setIncludeSecrets} icon={<EyeOff size={17} />} /><p className="export-note">実在の地図画像は使用していません。セッション資料や配信などに自由にお使いいただけます。</p></div><div className="dialog-footer"><span className="muted">{map?.config.name}</span><button className="primary" disabled={exporting} onClick={() => void exportImage()}>{exporting ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}{exporting ? '書き出し中…' : 'ダウンロード'}</button></div></Dialog>}
    {dialog === 'help' && <Dialog title="街紡ぎの使い方" onClose={() => setDialog(null)}><div className="dialog-body help-content"><p>街の成り立ちと地形を選び、「生成」で地図を作成します。</p><p><b>地図を探索</b>ドラッグで移動、ホイールや＋／−で拡大縮小。建物をクリックすると種類や面積を確認できます。キーボードの矢印キーでも移動できます。</p><p><b>ピンを追加</b>ピンのツールで場所をクリックし、名前・メモを保存できます。GM用ピンは公開画像から除けます。</p><p><b>画像と設定を保存</b>PNG・SVGで地図全体を書き出せます。設定ファイルには地図の形・シード・表示・ピンを保存し、「レイヤー」から読み込めます。保存済みの地図は再生成せず復元します。旧形式（バージョン1）は設定とピンのみのため、現在のエンジンで生成します。</p><p><b>街の成り立ち</b>成立期から鉄道整備、郊外拡大までの成長過程を、地形・道路への接続・需要に基づく簡略モデルで扱います。「発展段階」で各時点の地図を生成できます。現実の人口動態・土地所有・水利・制度を網羅するものではなく、実在都市の再現や都市計画の検証には使えません。</p><p><b>生成エンジン</b>現行 {GENERATOR_VERSION}。表示中の地図：{map?.generatorVersion ?? '版情報なし'}{map?.year !== undefined ? `、${map.year}年` : ''}。再生成すると現在の規則で作り直し、ピンをリセットします。</p>{Boolean(map?.growthLog?.length) && <p><b>この地図の発展記録</b>{map!.growthLog!.map((stage, index) => <span key={`${stage.phase}-${index}`} style={{ display: 'block' }}>{stage.year !== undefined ? `${stage.year}年 · ` : ''}{({ regional: '街道の成立', oldtown: '旧市街の発展', railway: '鉄道開通と駅前の発展', suburban: '郊外への拡大', industrial: '産業地の発展' } as Record<string, string>)[stage.phase] ?? stage.phase}：道路 {stage.roadsAdded}本{stage.reason ? `（${stage.reason}）` : ''}</span>)}</p>}<a href="https://github.com/Liesegang/machitsumugi" target="_blank" rel="noreferrer">ソースコード・生成ルールについて</a></div></Dialog>}
  </div>
}
export default App
