import { lazy, startTransition, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Download, Eye, EyeOff, FolderOpen, HelpCircle, Image, LoaderCircle, MapPin, Menu, MousePointer2, PanelLeftClose, Pencil, Save, Trash2, X } from 'lucide-react'
import type { CityConfig, CityMap, Point } from './domain/types'
import type { MapFeature } from './map/inspect'
import { DEFAULT_CONFIG } from './domain/generator'
import { downloadProject, loadProjectArchive, MAX_PROJECT_FILE_BYTES, parseProject, persistProjectArchive, persistRecoveryArchive } from './domain/project'
import type { Project } from './domain/project'
import { areaColor, DEFAULT_LAYERS, PALETTES } from './map/render'
import type { Annotation, RenderOptions } from './map/render'
import { exportMapPng, exportMapSvg } from './map/export'
import { MapCanvas } from './components/MapCanvas'
import type { MapHandle } from './components/MapCanvas'
import { SettingsPanel, Toggle } from './components/SettingsPanel'
import { GenerationReport } from './components/GenerationReport'
import { Dialog } from './components/Dialog'
import { FeatureDetails } from './components/FeatureDetails'
import { TimelineControl } from './components/TimelineControl'
import { DistrictNaming } from './components/DistrictNaming'
import { BuildIdentity } from './components/BuildIdentity'
import { SavedMapNotice } from './components/SavedMapNotice'
import { previewStockLabel } from './components/map-preview-status'
import { MapEditor } from './components/MapEditor'
import { DEFAULT_EDITOR_VALUES, findEditorTarget } from './map/editor-tools'
import type { EditorSelection, EditorTool, EditorValues } from './map/editor-tools'
import { applyMapEdits, editingError, getMapEditIssues, validateMapEdits } from './domain/map-edits'
import type { EditableEntityKind, MapEdit } from './domain/map-edits'
import { parseNameProposals } from './ai/district-names'
import type { NameProposal } from './ai/district-names'
import { renameTimelineDistricts, sliceCityAtYear } from './domain/timeline'
import RegionalContext from './components/RegionalContext'
import './App.css'

const Map3D = lazy(() => import('./components/Map3D'))
type ViewMode = 'map' | 'contour' | '3d'
const DRAFT_KEY = 'machitsumugi.draft.v1'
function rememberDraft(config: CityConfig) {
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(config)) } catch { /* Optional tab-local draft; completed maps use the archive. */ }
}
function sessionDraft(fallback: CityConfig): CityConfig {
  try {
    const text = sessionStorage.getItem(DRAFT_KEY)
    if (!text || text.length > 10_000) return fallback
    const input = JSON.parse(text) as CityConfig
    if (!input || typeof input !== 'object') return fallback
    const name = typeof input.name === 'string' ? input.name.slice(0, 80) : fallback.name, seed = typeof input.seed === 'string' ? input.seed.slice(0, 128) : fallback.seed
    // Empty text fields are legitimate unfinished edits, while the remaining
    // parameters still pass the same bounded validation as imported settings.
    const checked = parseProject(JSON.stringify({ version: 2, config: { ...fallback, ...input, name: name.trim() || '仮', seed: seed.trim() || '仮' }, layers: DEFAULT_LAYERS, annotations: [], style: 'standard' })).config
    return { ...checked, name, seed }
  } catch { return fallback }
}
const normalizeConfig = (config: CityConfig): CityConfig => ({ ...config, era: config.era ?? 'present', relief: config.relief ?? 'hills', terrain: (config.type === 'port' || config.facilities.includes('port')) && config.terrain === 'plain' ? 'coast' : config.terrain })
const newProject = (): Project => {
  const config: CityConfig = { ...DEFAULT_CONFIG, cityEngine: 'continuous' }
  return { version: 2, config: livePreview ? sessionDraft(config) : config, layers: DEFAULT_LAYERS, annotations: [], style: 'standard' }
}
const layerNames = { terrain: '地形・水域・緑地', buildings: '建物・住宅', roads: '道路', railway: '線路・駅', labels: '地名・ラベル', districts: '町域・区境', facilities: '施設', grid: '100 m グリッド' }
// A disposable development preview must never replace a saved TRPG world.
const livePreview = import.meta.env.DEV && new URLSearchParams(location.search).get('preview') === 'latest'

function App() {
  const [project, setProject] = useState<Project>(newProject)
  const [draft, setDraft] = useState<CityConfig>(() => sessionDraft(project.config))
  const [map, setMap] = useState<CityMap | null>(project.snapshot ?? null)
  const [previewMap, setPreviewMap] = useState<CityMap | null>(project.snapshot?.previewPhase ? project.snapshot : null)
  const latestPreview = useRef<CityMap | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('map')
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [generating, setGenerating] = useState(!project.snapshot)
  const [restoring, setRestoring] = useState(!livePreview)
  const [generationLabel, setGenerationLabel] = useState('地形と水系を計算中…')
  const [tab, setTab] = useState<'create' | 'layers' | 'pins' | 'edit'>('create')
  const [editorTool, setEditorTool] = useState<EditorTool>('select')
  const [editorTargetKind, setEditorTargetKind] = useState<EditableEntityKind>('building')
  const [editorSelection, setEditorSelection] = useState<EditorSelection | null>(null)
  const [editPoints, setEditPoints] = useState<Point[]>([])
  const [editTargetId, setEditTargetId] = useState<string | null>(null)
  const [editorValues, setEditorValues] = useState<EditorValues>(DEFAULT_EDITOR_VALUES)
  const [redoEdits, setRedoEdits] = useState<MapEdit[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [pinMode, setPinMode] = useState(false)
  const [showSecrets, setShowSecrets] = useState(true)
  const [selected, setSelected] = useState<Annotation | null>(null)
  const [feature, setFeature] = useState<{ point: Point; feature: MapFeature } | null>(null)
  const [dialog, setDialog] = useState<'export' | 'help' | 'report' | null>(null)
  const [format, setFormat] = useState<'png' | 'svg'>('png')
  const [exportWidth, setExportWidth] = useState(4096)
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')
  const [saveAvailable, setSaveAvailable] = useState(true)
  const sequence = useRef(0)
  const activeWorker = useRef<Worker | null>(null)
  const workerBusy = useRef(false)
  const completedProject = useRef<Project | null>(null)
  const [displayYear, setDisplayYear] = useState(project.config.targetYear ?? ({ historic: 1800, railway: 1930, present: 2025 }[project.config.era ?? 'present']))
  const requestedDisplayYear = useRef(displayYear)
  const importSequence = useRef(0)
  const restoreSequence = useRef(0)
  const saveFailureNotified = useRef(false)
  const mapRef = useRef<MapHandle>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(project.config)
  const palette = PALETTES[project.style]
  const displayedMap = useMemo(() => previewMap ?? (map ? applyMapEdits(map, project.edits ?? []) : null), [previewMap, map, project.edits])
  const editIssues = displayedMap ? getMapEditIssues(displayedMap) : []
  const editing = tab === 'edit' && !generating && !!project.snapshot
  const plannedMapFactor = project.config.mapSize === 'large' ? 3 : project.config.mapSize === 'medium' ? 2 : 1
  const mapWidthKm = displayedMap ? displayedMap.width / 1000 : 4 * plannedMapFactor
  const mapHeightKm = displayedMap ? displayedMap.height / 1000 : 3 * plannedMapFactor
  const options = useMemo<RenderOptions>(() => ({ layers: project.layers, style: project.style, annotations: project.annotations, showSecrets, scale: 1, contours: viewMode === 'contour' }), [project.layers, project.style, project.annotations, showSecrets, viewMode])
  useEffect(() => {
    if (livePreview) return
    const request = ++restoreSequence.current
    void loadProjectArchive().then(saved => {
      if (request !== restoreSequence.current) return
      if (saved) {
        const restored = saved.snapshot ? saved : { ...saved, config: normalizeConfig(saved.config) }
        requestedDisplayYear.current = restored.config.targetYear ?? restored.snapshot?.year ?? 2025
        setDisplayYear(requestedDisplayYear.current)
        setProject(restored); setDraft(sessionDraft(restored.config)); setMap(restored.snapshot ?? null); setPreviewMap(restored.snapshot?.previewPhase ? restored.snapshot : null); setGenerating(!restored.snapshot)
      }
      setRestoring(false)
    })
    return () => { restoreSequence.current += 1 }
  }, [])
  useEffect(() => {
    if (!restoring) rememberDraft(draft)
  }, [draft, restoring])
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const notify = () => setUpdateAvailable(true)
    window.addEventListener('machitsumugi:update-available', notify)
    window.dispatchEvent(new Event('machitsumugi:check-for-update'))
    return () => window.removeEventListener('machitsumugi:update-available', notify)
  }, [])
  useEffect(() => {
    // Keep a completed worker's terrain cache between parameter changes. A
    // component unmount, import, or interrupted request still releases it.
    return () => {
      sequence.current += 1
      activeWorker.current?.terminate(); activeWorker.current = null
      workerBusy.current = false
    }
  }, [])
  useEffect(() => {
    if (restoring || project.snapshot || !generating) return
    const id = ++sequence.current
    const instance = activeWorker.current ?? new Worker(new URL('./domain/generator.worker.ts', import.meta.url), { type: 'module' })
    activeWorker.current = instance
    workerBusy.current = true
    const handleMessage = (event: MessageEvent<{ id: number; map?: CityMap; preview?: CityMap; error?: string; progress?: string }>) => {
      if (id !== sequence.current || event.data.id !== id) return
      if (typeof event.data.progress === 'string') { setGenerationLabel(event.data.progress); return }
      if (event.data.preview) { latestPreview.current=event.data.preview; setPreviewMap(event.data.preview); return }
      workerBusy.current = false
      if (event.data.error) {
        if(latestPreview.current)setPreviewMap(latestPreview.current)
        const reason=/SweepLine|Unable to find segment/.test(event.data.error)?'土地境界の計算を完了できませんでした。':event.data.error
        setGenerating(false); setError(latestPreview.current ? `${reason} 途中の地図は残しています。「途中保存」で保存できます。` : reason)
        if (completedProject.current) { setProject(completedProject.current); setMap(completedProject.current.snapshot ?? null); const year = completedProject.current.snapshot?.year ?? 2025; requestedDisplayYear.current = year; setDisplayYear(year) }
      }
      else if (event.data.map) {
        const generated = event.data.map.timeline ? sliceCityAtYear(event.data.map, requestedDisplayYear.current) : event.data.map
        setGenerating(false)
        setMap(generated)
        setPreviewMap(null)
        setProject(old => ({ ...old, config: generated.config, snapshot: generated }))
        setDraft(old => ({ ...old, targetYear: generated.year ?? requestedDisplayYear.current }))
        setError('')
        if (generated.unplacedFacilities?.length) setToast(`施設${generated.unplacedFacilities.length}種を配置できませんでした。「生成結果」で確認できます。`)
      }
    }
    const handleError = () => {
      if (id !== sequence.current) return
      workerBusy.current = false; instance.terminate()
      if (activeWorker.current === instance) activeWorker.current = null
      if(latestPreview.current)setPreviewMap(latestPreview.current)
      setGenerating(false); setError(latestPreview.current ? '処理が停止しました。途中の地図は残しています。「途中保存」で保存してから再試行できます。' : '処理が停止しました。再試行できます。')
      if (completedProject.current) { setProject(completedProject.current); setMap(completedProject.current.snapshot ?? null); const year = completedProject.current.snapshot?.year ?? 2025; requestedDisplayYear.current = year; setDisplayYear(year) }
    }
    instance.addEventListener('message', handleMessage)
    instance.addEventListener('error', handleError)
    instance.postMessage({ id, config: project.config })
    return () => {
      instance.removeEventListener('message', handleMessage)
      instance.removeEventListener('error', handleError)
      if (workerBusy.current && activeWorker.current === instance) {
        instance.terminate(); activeWorker.current = null; workerBusy.current = false
      }
    }
  }, [project.config, project.snapshot, restoring, generating])
  useEffect(() => { if (project.snapshot && !project.snapshot.previewPhase) completedProject.current = project }, [project])
  useEffect(() => {
    if (!previewMap || generating || restoring || livePreview) return
    let cancelled=false
    void persistRecoveryArchive({ ...project, config: previewMap.config, snapshot: previewMap, annotations: [], edits: [] }).then(saved => {
      if(!cancelled)setToast(saved ? '途中の地図を退避保存しました。' : '途中の地図を自動保存できません。「途中保存」で保存してください。')
    })
    return ()=>{cancelled=true}
  }, [previewMap, generating, restoring, project])
  useEffect(() => {
    // Keep the last completed map in storage if a new generation fails or is interrupted.
    if (livePreview || restoring || !project.snapshot || project.snapshot.previewPhase || previewMap) return
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
  }, [project, restoring, previewMap])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer) }, [toast])
  function generate() {
    if (restoring || !draft.name.trim() || !draft.seed.trim()) return
    latestPreview.current=previewMap ?? (map?.previewPhase ? map : null)
    const config = normalizeConfig({ ...draft, name: draft.name.trim(), seed: draft.seed.trim() })
    requestedDisplayYear.current = config.targetYear ?? ({ historic: 1800, railway: 1930, present: 2025 }[config.era ?? 'present'])
    setDisplayYear(requestedDisplayYear.current)
    sequence.current += 1
    if (workerBusy.current) { activeWorker.current?.terminate(); activeWorker.current = null; workerBusy.current = false }
    importSequence.current += 1
    if (importRef.current) importRef.current.value = ''
    setGenerating(true)
    setPreviewMap(null)
    setGenerationLabel('地形と水系を計算中…')
    setProject(old => ({ ...old, config, annotations: [], edits: undefined, snapshot: undefined }))
    setEditPoints([]); setEditorSelection(null); setRedoEdits([]); setEditTargetId(null)
    setDraft(config); setSelected(null); setFeature(null); setPinMode(false); setError('')
    if (window.innerWidth < 850) setSidebarOpen(false)
  }
  function applyUpdate() {
    if (generating || restoring) return
    rememberDraft(draft)
    location.reload()
  }
  function showYear(targetYear: number) {
    if (!generating && !map?.timeline) return
    requestedDisplayYear.current = targetYear
    setDisplayYear(targetYear)
    // A date request during the initial full simulation changes only the
    // requested view. It never cancels, restarts or reconfigures that worker.
    if (generating) return
    if (!map?.timeline) return
    setFeature(null); setSelected(null); setPinMode(false); setPreviewMap(null); setError('')
    setEditPoints([]); setEditorSelection(null); setEditTargetId(null)
    startTransition(() => {
      const restored = sliceCityAtYear(map, targetYear)
      setMap(restored)
      setProject(old => ({ ...old, config: restored.config, snapshot: restored }))
    })
    setDraft(old => ({ ...old, targetYear }))
  }
  function applyDistrictNames(proposals: NameProposal[]) {
    if (!map || !project.snapshot || generating) return false
    try {
      const checked = parseNameProposals(JSON.stringify({ names: proposals }), map.districts)
      const names = new Map(checked.map(p => [p.id, p]))
      const renamed = renameTimelineDistricts(map, district => { const name = names.get(district.id); return name ? { ...district, name: name.name, nameOrigin: name.reason, namingSource: name.source ?? 'llm' as const } : district })
      setMap(renamed); setProject(old => ({ ...old, snapshot: renamed })); setFeature(null)
      setError('')
      setToast('確認した地名を地図に反映しました。')
      return true
    } catch (err) { setError(err instanceof Error ? err.message : '地名を反映できませんでした。'); return false }
  }
  function cancelGeneration() {
    sequence.current += 1
    activeWorker.current?.terminate(); activeWorker.current = null
    workerBusy.current = false
    setGenerating(false)
    setPreviewMap(null)
    if (completedProject.current) {
      setProject(completedProject.current); setMap(completedProject.current.snapshot ?? null); setPreviewMap(null)
      const year = completedProject.current.snapshot?.year ?? 2025
      requestedDisplayYear.current = year; setDisplayYear(year)
    }
    setToast('生成を中止しました。設定を変えて生成できます。')
  }
  function saveProject() {
    if ((!project.snapshot && !previewMap) || generating) return
    try { downloadProject(previewMap ? { ...project, config: previewMap.config, snapshot: previewMap, annotations: [], edits: [] } : project); setToast(previewMap ? '生成途中の地図を保存しました。' : dirty ? '表示中の地図・設定・ピンを保存しました。未反映の設定は含まれません。' : '地図・設定・ピンを保存しました') }
    catch (err) { setError(err instanceof Error ? err.message : '設定を保存できませんでした') }
  }
  function addPin(point: Point) {
    if (generating || !project.snapshot || !!previewMap) { setToast('地図の生成が完了してからピンを追加してください'); return }
    if (project.annotations.length >= 200) { setToast('ピンは200個まで配置できます'); return }
    setViewMode('map')
    setSelected({ id: crypto.randomUUID(), point, name: '', note: '', secret: false }); setFeature(null)
  }
  function changeView(mode: ViewMode) {
    setViewMode(mode); setPinMode(false); setFeature(null)
  }
  function pick(point: Point, item?: MapFeature) {
    if (generating || !project.snapshot || !!previewMap) return
    if (editing && displayedMap) {
      if (editorTool === 'select') {
        const selected = findEditorTarget(displayedMap, point, editorTargetKind)
        setEditorSelection(selected)
        if (selected) { setEditorValues(old => ({ ...old, name: 'name' in selected.item ? selected.item.name ?? '' : '' })); if (window.innerWidth < 850) setSidebarOpen(true) }
      } else if (editPoints.length < 256) setEditPoints(old => [...old, point])
      else setError('輪郭は256点以内で描いてください。')
      return
    }
    if (pinMode) { addPin(point); return }
    const existing = project.annotations.find(pin => (showSecrets || !pin.secret) && Math.hypot(pin.point.x - point.x, pin.point.y - point.y) < 45)
    if (existing) { setSelected(existing); return }
    setFeature(item ? { point, feature: item } : null)
  }
  function startEditorTool(tool: EditorTool) {
    setEditorTool(tool); setEditPoints([]); setEditTargetId(null); setEditorSelection(null)
    setViewMode('map'); setPinMode(false); setFeature(null)
    if (tool !== 'select' && window.innerWidth < 850) setSidebarOpen(false)
  }
  function cancelEdit() { setEditPoints([]); setEditTargetId(null); setEditorSelection(null); setEditorTool('select') }
  function commitEdit(command: MapEdit) {
    if (!displayedMap || generating) return
    try {
      const edits = validateMapEdits([...project.edits ?? [], command], displayedMap.width, displayedMap.height), checked = edits.at(-1)!
      const issue = editingError(displayedMap, checked!)
      if (issue) { setError(issue); return }
      setProject(old => ({ ...old, edits }))
      setRedoEdits([]); cancelEdit(); setError(''); setToast('編集を反映しました')
    } catch (err) { setError(err instanceof Error ? err.message : '編集を反映できませんでした。') }
  }
  function finishEdit() {
    const base = { id: `edit-${crypto.randomUUID()}`, year: displayYear }, id = editTargetId ?? `manual-${crypto.randomUUID()}`
    const name = editorValues.name.trim()
    if (editorTool === 'road') {
      const original = displayedMap?.roads.find(r => r.id === editTargetId)
      commitEdit({ ...base, operation: 'upsert', targetKind: 'road', value: { ...original, id, points: editPoints, kind: editorValues.roadKind, width: editorValues.width, builtYear: original?.builtYear ?? displayYear, modifiedYear: displayYear, bridge: editorValues.bridge, role: original?.role ?? (editorValues.bridge ? 'bridge' : 'collector') } })
    }
    if (editorTool === 'building') {
      const original = displayedMap?.buildings.find(b => b.id === editTargetId)
      commitEdit({ ...base, operation: 'upsert', targetKind: 'building', value: { ...original, id, polygon: editPoints, kind: editorValues.buildingKind, height: editorValues.floors, builtYear: original?.builtYear ?? displayYear, ...(name ? { name } : {}) } })
    }
    if (editorTool === 'area') {
      const original = displayedMap?.areas.find(a => a.id === editTargetId)
      commitEdit({ ...base, operation: 'upsert', targetKind: 'area', value: { ...original, id, polygon: editPoints, holes: undefined, kind: editorValues.cover === 'forest' ? 'forest' : editorValues.cover === 'park' ? 'park' : 'field', landUse: ['forest', 'park'].includes(editorValues.cover) ? undefined : editorValues.cover as 'meadow' | 'woodland' | 'paddy' | 'dry-field', ...(name ? { name } : {}) } })
    }
  }
  function changeSelectedEdit(operation: 'delete' | 'rename') {
    if (!editorSelection) return
    const base = { id: `edit-${crypto.randomUUID()}`, year: displayYear, targetId: editorSelection.item.id }
    if (operation === 'delete') commitEdit({ ...base, operation, targetKind: editorSelection.type })
    else if (editorSelection.type !== 'road') commitEdit({ ...base, operation, targetKind: editorSelection.type, name: editorValues.name.trim() })
  }
  function redrawSelectedEdit() {
    if (!editorSelection || !['building', 'road', 'area'].includes(editorSelection.type)) return
    const selected = editorSelection
    setEditorTool(selected.type as EditorTool); setEditTargetId(selected.item.id); setEditPoints([]); setViewMode('map')
    if (selected.type === 'building') setEditorValues(old => ({ ...old, buildingKind: selected.item.kind, floors: selected.item.height, name: selected.item.name ?? '' }))
    if (selected.type === 'road') setEditorValues(old => ({ ...old, roadKind: selected.item.kind, width: selected.item.width, bridge: selected.item.bridge ?? false }))
    if (selected.type === 'area') setEditorValues(old => ({ ...old, cover: selected.item.kind === 'forest' ? 'forest' : selected.item.kind === 'park' ? 'park' : selected.item.landUse === 'paddy' || selected.item.landUse === 'dry-field' || selected.item.landUse === 'woodland' ? selected.item.landUse : 'meadow', name: selected.item.name ?? '' }))
    if (window.innerWidth < 850) setSidebarOpen(false)
  }
  function undoEdit() {
    const last = project.edits?.at(-1)
    if (!last) return
    setRedoEdits(old => [...old, last]); setProject(old => ({ ...old, edits: old.edits?.slice(0, -1) })); cancelEdit()
  }
  function redoEdit() {
    const last = redoEdits.at(-1)
    if (!last) return
    setProject(old => ({ ...old, edits: [...old.edits ?? [], last] })); setRedoEdits(old => old.slice(0, -1)); cancelEdit()
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
      if (file.size > MAX_PROJECT_FILE_BYTES) throw new Error(`${MAX_PROJECT_FILE_BYTES / 1_000_000} MB以下の設定ファイルを選んでください`)
      const text = await file.text()
      if (request !== importSequence.current) return
      const parsed = parseProject(text), next = parsed.snapshot ? parsed : { ...parsed, config: normalizeConfig(parsed.config) }
      sequence.current += 1
      activeWorker.current?.terminate(); activeWorker.current = null
      workerBusy.current = false
      restoreSequence.current += 1
      requestedDisplayYear.current = next.config.targetYear ?? next.snapshot?.year ?? 2025
      setDisplayYear(requestedDisplayYear.current)
      setRestoring(false)
      setProject(next); setDraft(next.config); setSelected(null); setFeature(null); setPinMode(false); setError(''); cancelEdit(); setRedoEdits([])
      setGenerating(!next.snapshot)
      setPreviewMap(next.snapshot?.previewPhase ? next.snapshot : null)
      setGenerationLabel('地形と水系を計算中…')
      if (next.snapshot) setMap(next.snapshot)
      setToast(next.snapshot ? '保存済みの地図・設定・ピンを読み込みました' : '旧形式の設定を読み込みました。現在のエンジンで地図を生成します。')
    } catch (err) { if (request === importSequence.current) setError(err instanceof Error ? err.message : '設定を読み込めませんでした') }
    if (request === importSequence.current && importRef.current) importRef.current.value = ''
  }
  async function exportImage() {
    if (!displayedMap || generating) return
    setExporting(true)
    try {
      const exportOptions = { ...options, showSecrets: includeSecrets }
      if (format === 'svg') await exportMapSvg(displayedMap, exportOptions)
      else await exportMapPng(displayedMap, exportOptions, exportWidth)
      setDialog(null); setToast('画像を書き出しました')
    } catch { setError('画像を書き出せませんでした。解像度を下げて再度お試しください。') }
    finally { setExporting(false) }
  }
  return <div className="app-shell">
    <a className="skip-link" href="#city-map">地図へ移動</a>
    <header className="app-header">
      <div className="brand"><h1 title="架空日本地図ジェネレーター">架空日本地図</h1></div>
      <div className="header-actions">
        <button className="icon-button help-button" title="使い方" aria-label="使い方" onClick={() => setDialog('help')}><HelpCircle size={19} /></button>
        <button className="secondary open-project" aria-label="地図ファイルを開く" onClick={() => importRef.current?.click()}><FolderOpen size={17} /><span>開く</span></button>
        <button className="secondary save-project" aria-label="設定を保存" disabled={(!project.snapshot && !previewMap) || generating} onClick={saveProject}><Save size={17} /><span>{previewMap && !generating ? '途中保存' : '保存'}</span></button>
        <button className="primary" aria-label="画像を書き出す" disabled={!displayedMap || generating} onClick={() => setDialog('export')}><Image size={17} /><span>画像出力</span></button>
      </div>
    </header>
    <div className="workspace">
      {sidebarOpen && <button className="sidebar-scrim" aria-label="設定パネルを閉じる" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`} aria-label="街の設定"><nav className="panel-tabs" aria-label="編集パネル"><button className={tab === 'create' ? 'active' : ''} aria-current={tab === 'create' ? 'page' : undefined} onClick={() => setTab('create')}>生成</button><button className={tab === 'layers' ? 'active' : ''} aria-current={tab === 'layers' ? 'page' : undefined} onClick={() => setTab('layers')}>表示</button><button className={tab === 'edit' ? 'active' : ''} aria-current={tab === 'edit' ? 'page' : undefined} onClick={() => { setTab('edit'); setViewMode('map'); setPinMode(false); setFeature(null) }}>編集</button><button className={tab === 'pins' ? 'active' : ''} aria-current={tab === 'pins' ? 'page' : undefined} onClick={() => setTab('pins')}>ピン</button><button className="close-sidebar icon-button" aria-label="設定パネルを閉じる" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={18} /></button></nav>
        {tab === 'create' && <SettingsPanel config={draft} onChange={setDraft} generating={generating} dirty={dirty} onGenerate={generate} onCancel={cancelGeneration} unplacedCount={project.snapshot?.unplacedFacilities?.length} onReport={() => setDialog('report')} />}
        {tab === 'edit' && <MapEditor year={displayYear} tool={editorTool} onTool={startEditorTool} targetKind={editorTargetKind} onTargetKind={kind => { setEditorTargetKind(kind); setEditorSelection(null) }} selection={editorSelection} points={editPoints} values={editorValues} onValues={setEditorValues} onFinish={finishEdit} onCancel={cancelEdit} onBack={() => setEditPoints(old => old.slice(0, -1))} onDelete={() => changeSelectedEdit('delete')} onRename={() => changeSelectedEdit('rename')} onRedraw={redrawSelectedEdit} onUndo={undoEdit} onRedo={redoEdit} canUndo={!!project.edits?.length} canRedo={!!redoEdits.length} disabled={generating || !project.snapshot || !!previewMap} />}
        {tab === 'layers' && <div className="panel-scroll">
          <section><h2>レイヤー</h2>{Object.entries(layerNames).map(([key, name]) => <Toggle key={key} label={name} value={project.layers[key as keyof typeof layerNames] ?? false} onChange={value => setProject(old => ({ ...old, layers: { ...old.layers, [key]: value } }))} />)}</section>
          <section><h2>配色</h2><div className="style-options">{([{ id: 'standard', name: '標準' }, { id: 'mono', name: 'モノクロ' }, { id: 'night', name: '夜間' }] as const).map(style => <button key={style.id} className={project.style === style.id ? 'selected' : ''} aria-pressed={project.style === style.id} onClick={() => setProject(old => ({ ...old, style: style.id }))}>{style.name}</button>)}</div></section>
          {map && <DistrictNaming key={JSON.stringify(map.config)} map={map} disabled={generating} onApply={applyDistrictNames} />}
        </div>}
        {tab === 'pins' && <div className="panel-scroll"><section><h2>ピン</h2><p className="muted">地図に場所とメモを登録できます。</p><button className={`secondary full ${pinMode ? 'selected' : ''}`} disabled={generating || !project.snapshot || !!previewMap} onClick={() => { setViewMode('map'); setPinMode(!pinMode); if (window.innerWidth < 850) setSidebarOpen(false) }}><MapPin size={17} />{pinMode ? '配置をキャンセル' : '地図をクリックして追加'}</button><button className="text-button full" disabled={generating || !project.snapshot || !!previewMap} onClick={() => { const p = mapRef.current?.getCenter() || { x: (map?.width ?? 4000) / 2, y: (map?.height ?? 3000) / 2 }; addPin({ x: Math.max(0, Math.min(map?.width ?? 4000, p.x)), y: Math.max(0, Math.min(map?.height ?? 3000, p.y)) }) }}>画面の中央に追加</button><Toggle label="GM用ピンを表示" value={showSecrets} onChange={setShowSecrets} icon={showSecrets ? <Eye size={17} /> : <EyeOff size={17} />} /></section><div className="pin-list">{project.annotations.length ? project.annotations.map(pin => <button className="pin-row" key={pin.id} disabled={generating || !project.snapshot || !!previewMap} onClick={() => { setViewMode('map'); setSelected(pin); mapRef.current?.center(pin.point) }}><MapPin size={19} /><span><b>{pin.name}</b><small>{pin.secret ? 'GMのみ' : '公開'}{pin.note ? ` · ${pin.note.slice(0, 22)}` : ''}</small></span></button>) : <div className="empty-pins"><MapPin size={30} strokeWidth={1} /><p>ピンは登録されていません。</p><span>地図上の建物からも追加できます。</span></div>}</div><p className="panel-footnote">街を生成し直すと、ピンはリセットされます。先に設定を保存しておくと復元できます。</p></div>}
      </aside>
      <main id="city-map" className="map-workspace">
        {updateAvailable && <div className="saved-map-notice" role="status"><span>{generating ? '更新があります。生成完了後に反映できます。' : '更新があります。'}</span><button className="secondary" disabled={generating || restoring} onClick={applyUpdate}>更新を反映</button></div>}
        {!saveAvailable && <div className="saved-map-notice" role="alert">自動保存できません。上部の「保存」で地図ファイルを保存してください。</div>}
        {!!editIssues.length && <details className="edit-issues"><summary>この年代では{editIssues.length}件の編集が既存の地物と重なり、表示できません。</summary><ul>{editIssues.map(issue => <li key={issue.id}>{issue.reason}</li>)}</ul></details>}
        {!generating && <SavedMapNotice map={displayedMap} onOpenSettings={() => { setTab('create'); setSidebarOpen(true) }} />}
        <div className="map-area" data-view-mode={viewMode}>
        {displayedMap && <div className={`map-view-2d ${viewMode === '3d' ? 'view-hidden' : ''}`} aria-hidden={viewMode === '3d'}><MapCanvas ref={mapRef} map={displayedMap} options={options} pinMode={pinMode || editing} editPoints={editing ? editPoints : undefined} editPolygon={editorTool !== 'road'} onPick={pick} onAnnotationPick={pin => { if (!generating && project.snapshot) setSelected(pin) }} /></div>}
        {displayedMap && viewMode === '3d' && <div className="map-view-3d"><Suspense fallback={<div className="map-view-loading" role="status">3D表示を読み込み中…</div>}><Map3D map={displayedMap} /></Suspense></div>}
        {displayedMap && <RegionalContext map={displayedMap} />}
        {(map || generating) && <TimelineControl key={project.config.seed} year={displayYear} generating={generating} available={!!map?.timeline} onCommit={showYear} />}
        <div className="map-title"><button className="mobile-menu icon-button" aria-label="街の設定を開く" onClick={() => setSidebarOpen(true)}><Menu size={21} /></button><div><h2>{displayedMap?.config.name || project.config.name}</h2><span>{`${mapWidthKm} × ${mapHeightKm} km`}</span></div></div>
        <div className="map-tools"><div className="map-view-switch" role="group" aria-label="地図の表示方法">{([{ id: 'map', name: '地図' }, { id: 'contour', name: '等高線' }, { id: '3d', name: '3D' }] as const).map(mode => <button key={mode.id} className={viewMode === mode.id ? 'active' : ''} aria-pressed={viewMode === mode.id} onClick={() => changeView(mode.id)}>{mode.name}</button>)}</div>{viewMode !== '3d' && <div className="drawing-tools"><button className={!pinMode && !editing ? 'active' : ''} aria-label="地図を移動・建物を選択" title="地図を移動・建物を選択" aria-pressed={!pinMode && !editing} onClick={() => { setPinMode(false); if (editing) setTab('create') }}><MousePointer2 size={20} /></button><button className={editing ? 'active' : ''} aria-label="地図を編集" title="地図を編集" disabled={generating || !project.snapshot || !!previewMap} aria-pressed={editing} onClick={() => { setTab('edit'); setSidebarOpen(true); setPinMode(false); setFeature(null) }}><Pencil size={20} /></button><button className={pinMode ? 'active' : ''} aria-label="地図にピンを追加" title="地図にピンを追加" disabled={generating || !project.snapshot || !!previewMap} aria-pressed={pinMode} onClick={() => { if (editing) setTab('pins'); setPinMode(!pinMode) }}><MapPin size={20} /></button></div>}</div>
        {editing && editorTool !== 'select' && <div className="edit-map-actions"><span>{editorTool === 'road' ? '道路' : editorTool === 'building' ? '建物' : '土地利用'} {editPoints.length}点</span><button className="text-button" onClick={() => setEditPoints(old => old.slice(0, -1))} disabled={!editPoints.length}>戻す</button><button className="secondary" onClick={cancelEdit}>取消</button><button className="primary" onClick={finishEdit} disabled={editPoints.length < (editorTool === 'road' ? 2 : 3)}>確定</button></div>}
        {pinMode && <div className="mode-notice"><MapPin size={15} />ピンを置く場所をクリック<button aria-label="ピン配置をやめる" onClick={() => setPinMode(false)}><X size={15} /></button></div>}
        {viewMode !== '3d' && <details className="map-legend"><summary>凡例</summary><div>{[{ name: '住宅', color: palette.residential }, { name: '商業', color: palette.commercial }, { name: '公共施設', color: palette.public }, { name: '田', color: areaColor({ id: '', polygon: [], kind: 'field', landUse: 'paddy' }, project.style) }, { name: '畑', color: areaColor({ id: '', polygon: [], kind: 'field', landUse: 'dry-field' }, project.style) }, { name: '森林', color: palette.forest }, { name: '林', color: areaColor({ id: '', polygon: [], kind: 'field', landUse: 'woodland' }, project.style) }, { name: '草地', color: areaColor({ id: '', polygon: [], kind: 'field', landUse: 'meadow' }, project.style) }, { name: '公園', color: palette.park }, { name: '水域', color: palette.water }].map(item => <span key={item.name}><i style={{ background: item.color }} />{item.name}</span>)}</div></details>}
        {viewMode === 'contour' && displayedMap && !displayedMap.terrainSurface && <div className="mode-notice" role="note">この保存地図には標高データがありません。</div>}
        {(restoring || generating) && <div className={`generation-overlay ${displayedMap ? 'regenerating' : ''}`} role="status"><LoaderCircle className="spin" size={25} /><span>{restoring ? '保存済みの地図を読み込み中…' : generationLabel}</span>{generating && !restoring && <button className="text-button" onClick={cancelGeneration}>中止</button>}</div>}
        {feature && displayedMap && <FeatureDetails map={displayedMap} feature={feature.feature} point={feature.point} onClose={() => setFeature(null)} onPin={addPin} />}
      </div><footer className="map-status"><span className="map-stock">{previewMap ? previewStockLabel(previewMap) : displayedMap ? `建物 ${displayedMap.buildings.length.toLocaleString()}棟` : '生成中'}</span>{project.snapshot && !generating && !previewMap && <button className="map-report-button" onClick={() => setDialog('report')}>生成結果</button>}<BuildIdentity mapVersion={displayedMap?.generatorVersion} preview={!!previewMap} engine={displayedMap?.config.cityEngine ?? project.config.cityEngine} /></footer></main>
    </div>
    <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={event => void importFile(event.target.files?.[0])} />
    {toast && <div className="toast" role="status">{toast}</div>}
    {error && <div className="error-toast" role="alert"><span>{error}</span><button aria-label="エラーを閉じる" onClick={() => setError('')}><X size={17} /></button></div>}
    {selected && <Dialog title="ピンを編集" onClose={() => setSelected(null)}><div className="dialog-body"><label className="stack-field">場所の名前<input autoFocus value={selected.name} maxLength={60} placeholder="例：古書店「月読堂」" onChange={event => setSelected({ ...selected, name: event.target.value })} /></label><label className="stack-field">メモ<textarea value={selected.note} maxLength={2000} rows={4} placeholder="この場所にある手がかりや、登場人物など" onChange={event => setSelected({ ...selected, note: event.target.value })} /></label><Toggle label="GM用ピンにする" value={selected.secret} onChange={value => setSelected({ ...selected, secret: value })} icon={<EyeOff size={17} />} /><p className="muted">GM用ピンは、画像の書き出し時に隠せます。</p></div><div className="dialog-footer">{project.annotations.some(item => item.id === selected.id) ? <button className="text-button danger" onClick={() => { setProject(old => ({ ...old, annotations: old.annotations.filter(item => item.id !== selected.id) })); setSelected(null) }}><Trash2 size={16} />削除</button> : <span />}<button className="primary" disabled={!selected.name.trim()} onClick={savePin}>ピンを保存</button></div></Dialog>}
    {dialog === 'export' && <Dialog title="画像を書き出す" onClose={() => { if (!exporting) setDialog(null) }}><div className="dialog-body"><p className="muted">2D地図を、現在のレイヤーとスタイルで書き出します。等高線表示時は等高線も含みます。</p><label className="stack-field">ファイル形式<select value={format} onChange={e => setFormat(e.target.value as 'png' | 'svg')}><option value="png">PNG画像</option><option value="svg">SVG（拡大しても鮮明）</option></select></label>{format === 'png' && <label className="stack-field">画像サイズ<select value={exportWidth} onChange={e => setExportWidth(Number(e.target.value))}>{[2048, 4096, 8192].map(width => <option key={width} value={width}>{width} × {Math.round(width * (map?.height ?? 3000) / (map?.width ?? 4000))} px</option>)}</select></label>}<Toggle label="GM用ピンを含める" value={includeSecrets} onChange={setIncludeSecrets} icon={<EyeOff size={17} />} /><p className="export-note">実在の地図画像は使用していません。セッション資料や配信などに自由にお使いいただけます。</p></div><div className="dialog-footer"><span className="muted">{map?.config.name}</span><button className="primary" disabled={exporting} onClick={() => void exportImage()}>{exporting ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}{exporting ? '書き出し中…' : 'ダウンロード'}</button></div></Dialog>}
    {dialog === 'report' && project.snapshot && <Dialog title="生成結果" onClose={() => setDialog(null)}><GenerationReport map={project.snapshot} onSettings={() => { setDialog(null); setTab('create'); setSidebarOpen(true) }} /></Dialog>}
    {dialog === 'help' && <Dialog title="使い方" onClose={() => setDialog(null)}><div className="dialog-body help-content"><p>街の成り立ちと地形を選び、「生成」で地図を作成します。</p><p><b>地図を探索</b>ドラッグで移動、ホイールや＋／−で拡大縮小。建物をクリックすると種類や面積を確認できます。キーボードの矢印キーでも移動できます。</p><p><b>等高線と3D</b>地図上部で表示を切り替えます。等高線は保存された標高から描画し、3Dは同じ地形と建物を立体表示します。3Dではドラッグで回転、右ドラッグで移動できます。建物の高さは階数からの仮定で、標高がない旧地図は平面地形で表示します。画像出力は2D地図です。</p><p><b>ピンを追加</b>ピンのツールで場所をクリックし、名前・メモを保存できます。GM用ピンは公開画像から除けます。</p><p><b>画像と地図を保存</b>PNG・SVGで地図全体を書き出せます。「保存」で地図の形・シード・表示・ピンをファイルに保存し、「開く」から読み込めます。地図はこのブラウザにも自動保存します。保存済みの地図は再生成せず復元します。旧形式（バージョン1）は設定とピンのみのため、現在のエンジンで生成します。</p><p><b>街の成り立ち</b>成立期から鉄道整備、郊外拡大までの成長過程を、地形・道路への接続・需要に基づく簡略モデルで扱います。一度の生成で建替えや道路・農地の変更を記録し、年代スライダーで保存済みの歴史を表示します。履歴のない旧地図は「生成」で履歴を作成できます。現実の人口動態・土地所有・水利・制度を網羅するものではなく、実在都市の再現や都市計画の検証には使えません。</p><a href="https://github.com/Liesegang/machitsumugi" target="_blank" rel="noreferrer">ソースコード・生成ルールについて</a></div></Dialog>}
  </div>
}
export default App
