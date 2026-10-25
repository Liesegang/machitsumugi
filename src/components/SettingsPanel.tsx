import type { ReactNode } from 'react'
import type { CityConfig, CityType, FacilityKind, Terrain } from '../domain/types'
import { CITY_PRESETS } from '../domain/generator'
import { FACILITY_NAMES } from './facility-labels'
interface Props {
  config: CityConfig
  onChange: (config: CityConfig) => void
  generating: boolean
  dirty: boolean
  onGenerate: () => void
  onCancel: () => void
  unplacedCount?: number
  onReport?: () => void
}

export function SettingsPanel({ config, onChange, generating, dirty, onGenerate, onCancel, unplacedCount = 0, onReport }: Props) {
  function update<K extends keyof CityConfig>(key: K, value: CityConfig[K]) {
    onChange({ ...config, [key]: value, ...(key === 'era' ? { targetYear: undefined } : {}) })
  }
  function selectType(type: CityType) {
    const facilities = config.facilities.filter(kind => !['castle', 'port', 'onsen'].includes(kind))
    const origin: Partial<Record<CityType, FacilityKind>> = { castle: 'castle', temple: 'shrine', port: 'port', onsen: 'onsen' }
    if (origin[type] && !facilities.includes(origin[type]!)) facilities.push(origin[type]!)
    onChange({ ...config, type, facilities, terrain: type === 'port' ? 'coast' : type === 'onsen' ? 'river' : config.terrain })
  }
  return <>
    <div className="panel-scroll settings-scroll">
      <div className="settings-identity">
        <label className="field-row"><span>生成方式</span><select value={config.cityEngine ?? 'history'} onChange={event => update('cityEngine', event.target.value as CityConfig['cityEngine'])}><option value="history">歴史から生成</option><option value="layout">街区から設計（試作）</option></select></label>
        <label className="field-row"><span>街の名前</span><input value={config.name} maxLength={30} onChange={event => update('name', event.target.value)} /></label>
        <label className="field-row"><span>街の種類</span><select value={config.type} onChange={event => selectType(event.target.value as CityType)}>{CITY_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
        <label className="field-row"><span>地図の広さ</span><select value={config.mapSize ?? 'small'} onChange={event => update('mapSize', event.target.value as CityConfig['mapSize'])}><option value="small">4 × 3 km</option><option value="medium">8 × 6 km</option><option value="large">12 × 9 km</option></select></label>
        <label className="field-row"><span>地域の規模</span><select value={config.settlement ?? 'regional-city'} onChange={event => update('settlement', event.target.value as CityConfig['settlement'])}><option value="village">山間・農村集落</option><option value="rural-town">田舎の中心地</option><option value="regional-city">地方都市</option><option value="metropolis">大都市</option></select></label>
        <label className="field-row"><span>人口の推移</span><select value={config.populationTrend ?? 'growing'} onChange={event => update('populationTrend', event.target.value as CityConfig['populationTrend'])}><option value="declining">減少</option><option value="stable">横ばい</option><option value="growing">増加</option></select></label>
        <label className="field-row"><span>シード値</span><div className="seed-field"><input value={config.seed} maxLength={80} onChange={event => update('seed', event.target.value)} /><button title="シードをランダムにする" aria-label="シードをランダムにする" onClick={() => update('seed', Math.random().toString(36).slice(2, 10))}>変更</button></div></label>
      </div>
      <details className="setting-section" open><summary>地形</summary><div className="setting-content">
        <label className="field-row"><span>地形の傾向</span><select aria-label="地形の傾向" value={config.terrain} onChange={event => update('terrain', event.target.value as Terrain)}><option value="river">河川</option><option value="plain" disabled={config.type === 'port'}>平野</option><option value="coast">海岸</option></select></label>
        <label className="field-row"><span>地形の起伏</span><select aria-label="地形の起伏" value={config.relief ?? 'hills'} onChange={event => update('relief', event.target.value as CityConfig['relief'])}><option value="lowland">低地</option><option value="hills">丘陵</option><option value="mountains">山地</option></select></label>
        {config.terrain === 'coast' && <label className="field-row"><span>海岸の形</span><select aria-label="海岸の形" value={config.coastType ?? 'bay'} onChange={event => update('coastType', event.target.value as CityConfig['coastType'])}><option value="bay">河口と湾</option><option value="ria">リアス式海岸</option><option value="delta">河口の堆積低地</option><option value="peninsula">半島と入り江</option></select></label>}
        <Slider label="森林の量" value={config.forest} onChange={value => update('forest', value)} low="少ない" high="多い" />
      </div></details>
      <details className="setting-section" open><summary>市街地</summary><div className="setting-content">
        <Slider label="市街化の需要" value={config.density} onChange={value => update('density', value)} low="小さい" high="大きい" />
      </div></details>
      <details className="setting-section" open><summary>交通</summary><div className="setting-content">
        <Toggle label="鉄道" value={config.railway} onChange={value => update('railway', value)} />
        {config.railway && <Slider label="駅の数" value={config.stations} min={1} max={5} onChange={value => update('stations', value)} low="1駅" high="5駅" />}
        <Toggle label="地下鉄" help="大都市の既存市街地に、複数駅の需要が成立した年代から建設します。" value={config.subway ?? false} onChange={value => update('subway', value)} />
        <Toggle label="国道" value={config.arterial} onChange={value => update('arterial', value)} />
        <Toggle label="バイパス" value={config.bypass ?? false} onChange={value => update('bypass', value)} />
        <Toggle label="高速道路" value={config.expressway ?? false} onChange={value => update('expressway', value)} />
      </div></details>
      <details className="setting-section facility-details"><summary>施設{config.facilities.length > 0 && <span>{config.facilities.length}件</span>}</summary><div className="setting-content facility-choices">{(Object.entries(FACILITY_NAMES) as [FacilityKind, string][]).map(([kind, name]) => <label key={kind}><input type="checkbox" checked={config.facilities.includes(kind)} onChange={event => update('facilities', event.target.checked ? [...config.facilities, kind] : config.facilities.filter(item => item !== kind))} />{name}</label>)}</div></details>
    </div>
    <div className="generate-footer">{!generating && unplacedCount > 0 && <div className="generation-issue"><span>前回の生成では{unplacedCount}種の施設を配置できていません。</span><button className="text-button" onClick={onReport}>結果を確認</button></div>}{(dirty || generating) && <span className="settings-state">{dirty ? '未反映の変更があります' : '生成中も設定を変更できます'}</span>}{generating && <button className="secondary full" onClick={onCancel}>生成を中止</button>}<button className="primary generate" disabled={!config.name.trim() || !config.seed.trim()} onClick={onGenerate}>{generating ? dirty ? '変更して再生成' : '最初から再生成' : '生成'}</button></div>
  </>
}

export function Slider({ label, value, onChange, min = 0, max = 100, low, high }: {
  label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; low: string; high: string
}) {
  return <label className="slider-field"><span>{label}</span><input aria-label={label} title={`${low}〜${high}`} type="range" min={min} max={max} value={value} onChange={event => onChange(Number(event.target.value))} /><output>{value}{max === 5 ? '' : '%'}</output></label>
}

export function Toggle({ label, value, onChange, help }: {
  label: string; value: boolean; onChange: (value: boolean) => void; icon?: ReactNode; help?: string
}) {
  return <label className="toggle-row" title={help}><input type="checkbox" checked={value} aria-description={help} onChange={event => onChange(event.target.checked)} /><span>{label}</span></label>
}
