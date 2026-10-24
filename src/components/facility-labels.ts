import type { FacilityKind } from '../domain/types'

export const FACILITY_NAMES: Record<FacilityKind, string> = {
  shrine: '寺社', school: '学校', university: '大学', hospital: '病院', police: '警察署', shop: '商店街',
  park: '公園', castle: '城跡', port: '港', onsen: '温泉',
}
