import { BUILD_INFO } from '../build-info'
import { GENERATOR_VERSION } from '../domain/land-development'
import { LAYOUT_GENERATOR_VERSION } from '../domain/layout-first-types'
import { CONTINUOUS_GENERATOR_VERSION } from '../domain/continuous-city-types'

export function BuildIdentity({ mapVersion, preview = false, engine }: { mapVersion?: string; preview?: boolean; engine?: 'history' | 'layout' | 'continuous' }) {
  const currentVersion = engine === 'continuous' ? CONTINUOUS_GENERATOR_VERSION : engine === 'layout' ? LAYOUT_GENERATOR_VERSION : GENERATOR_VERSION
  const { commit, dirty, builtAt } = BUILD_INFO
  const title = `${commit ? `Git ${commit}` : 'Git情報を取得できませんでした'}${dirty ? '・未コミット変更あり' : ''}${builtAt ? `\nビルド: ${new Date(builtAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST` : ''}`
  return <span className="build-identity" title={title}>
    {preview ? <span>生成途中</span> : mapVersion && mapVersion !== currentVersion && <span className="saved-map-version">保存地図 {mapVersion}</span>}
    <span>アプリ {currentVersion}</span>
    {commit ? <a href={`https://github.com/Liesegang/machitsumugi/commit/${commit}`} target="_blank" rel="noopener noreferrer" aria-label={`Gitコミット ${commit}`}>Git <code>{commit.slice(0, 7)}</code></a> : <span>Git 情報なし</span>}
    {dirty && <small aria-label="未コミット変更あり">変更あり</small>}
  </span>
}
