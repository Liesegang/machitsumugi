export interface BuildInfo { commit: string | null; dirty: boolean; builtAt: string | null }
declare const __BUILD_INFO__: BuildInfo

export const BUILD_INFO: BuildInfo = typeof __BUILD_INFO__ === 'undefined'
  ? { commit: null, dirty: false, builtAt: null }
  : __BUILD_INFO__
