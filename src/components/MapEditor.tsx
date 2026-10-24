import type { Building, Point, Road } from '../domain/types'
import { featureTitle } from '../map/inspect'
import type { EditableEntityKind } from '../domain/map-edits'
import type { EditorCover, EditorSelection, EditorTool, EditorValues } from '../map/editor-tools'
const targetNames: Record<EditableEntityKind, string> = { building: '建物', road: '道路', area: '土地', district: '町・区', facility: '施設', railway: '路線', station: '駅' }

export function MapEditor({ year, tool, onTool, targetKind, onTargetKind, selection, points, values, onValues, onFinish, onCancel, onBack, onDelete, onRename, onRedraw, onUndo, onRedo, canUndo, canRedo, disabled }: {
  year: number; tool: EditorTool; onTool: (tool: EditorTool) => void
  targetKind: EditableEntityKind; onTargetKind: (kind: EditableEntityKind) => void
  selection: EditorSelection | null; points: Point[]; values: EditorValues; onValues: (values: EditorValues) => void
  onFinish: () => void; onCancel: () => void; onBack: () => void; onDelete: () => void; onRename: () => void; onRedraw: () => void
  onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean; disabled: boolean
}) {
  const update = <K extends keyof EditorValues>(key: K, value: EditorValues[K]) => onValues({ ...values, [key]: value })
  return <div className="panel-scroll map-editor">
    <div className="edit-history"><button className="secondary" onClick={onUndo} disabled={!canUndo || disabled}>元に戻す</button><button className="secondary" onClick={onRedo} disabled={!canRedo || disabled}>やり直す</button></div>
    <p className="muted">{year}年以降の地図を編集します。生成した歴史は保持されます。</p>
    <label className="stack-field">操作<select aria-label="地図の編集操作" value={tool} disabled={disabled} onChange={e => onTool(e.target.value as EditorTool)}><option value="select">選択・変更・削除</option><option value="road">道路を描く</option><option value="building">建物を描く</option><option value="area">土地利用を描く</option></select></label>
    {tool === 'select' ? <>
      <label className="stack-field">選択対象<select value={targetKind} disabled={disabled} onChange={e => onTargetKind(e.target.value as EditableEntityKind)}>{Object.entries(targetNames).map(([kind, name]) => <option key={kind} value={kind}>{name}</option>)}</select></label>
      {!selection ? <p className="muted">地図上の対象をクリックしてください。</p> : <section className="edit-selection"><h2>{selection.type === 'station' ? selection.item.name : featureTitle(selection)}</h2>
        {selection.type !== 'road' && <><label className="stack-field">名前<input aria-label="選択した対象の名前" maxLength={80} value={values.name} onChange={e => update('name', e.target.value)} /></label><button className="secondary full" disabled={!values.name.trim() || disabled} onClick={onRename}>名前を変更</button></>}
        {['building', 'road', 'area'].includes(selection.type) && !(selection.type === 'area' && selection.item.kind === 'water') && <button className="text-button full" disabled={disabled} onClick={onRedraw}>形を描き直す</button>}
        <button className="text-button full danger" disabled={disabled || selection.type === 'area' && selection.item.kind === 'water'} onClick={onDelete}>{selection.type === 'facility' ? '施設ラベルを削除' : selection.type === 'railway' ? '路線と所属駅を削除' : '選択した対象を削除'}</button>
        {selection.type === 'facility' && <p className="muted">建物・敷地は残ります。</p>}
        {selection.type === 'area' && selection.item.kind === 'water' && <p className="muted">水域の形は編集できません。</p>}
      </section>}
    </> : <>
      {tool === 'building' && <><label className="stack-field">建物の種類<select value={values.buildingKind} onChange={e => update('buildingKind', e.target.value as Building['kind'])}><option value="residential">住宅</option><option value="commercial">商業施設</option><option value="public">公共施設</option><option value="industrial">工場・倉庫</option></select></label><label className="stack-field">階数<input type="number" min={1} max={60} value={values.floors} onChange={e => update('floors', Number(e.target.value))} /></label></>}
      {tool === 'road' && <><label className="stack-field">道路の種類<select value={values.roadKind} onChange={e => update('roadKind', e.target.value as Road['kind'])}><option value="local">街路</option><option value="arterial">主要道路</option></select></label><label className="stack-field">幅員（m）<input type="number" min={2} max={40} step={.5} value={values.width} onChange={e => update('width', Number(e.target.value))} /></label><label className="toggle-row"><input type="checkbox" checked={values.bridge} onChange={e => update('bridge', e.target.checked)} />渡河する橋として描く</label></>}
      {tool === 'area' && <label className="stack-field">土地利用<select value={values.cover} onChange={e => update('cover', e.target.value as EditorCover)}><option value="forest">森林</option><option value="woodland">林</option><option value="park">公園</option><option value="meadow">草地</option><option value="paddy">水田</option><option value="dry-field">畑</option></select></label>}
      {tool !== 'road' && <label className="stack-field">名前（任意）<input maxLength={80} value={values.name} onChange={e => update('name', e.target.value)} /></label>}
      <p className="muted">{tool === 'road' ? '経路を順にクリックしてください。' : '輪郭の角を順にクリックしてください。'} ドラッグで地図を移動できます。</p>
      <div className="edit-point-count">{points.length}点<button className="text-button" disabled={!points.length} onClick={onBack}>直前の点を戻す</button></div>
      <div className="edit-actions"><button className="secondary" onClick={onCancel}>キャンセル</button><button className="primary" onClick={onFinish} disabled={disabled || points.length < (tool === 'road' ? 2 : 3)}>確定</button></div>
    </>}
    <p className="panel-footnote">編集は保存・画像出力・3Dにも反映します。地形や人口の再計算は行いません。</p>
  </div>
}
