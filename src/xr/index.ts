// VR（WebXR）。純粋な計算は logic.ts、本体は system.ts、外周の暗さは vignette.ts、メニューは menu.ts。
// 契約は src/contracts/xr.ts。テストと統合担当はここから読む。
export {
  createRayCandidates,
  fingertipHits,
  menuPose,
  menuTextHeight,
  nearestTouchable,
  rayCandidates,
  recenterYaw,
  referenceSpaceFor,
  rigHeightOffset,
  vignetteFor,
  whiteoutOpacity,
  yawFromQuaternion,
  type FingertipHit,
  type MenuPose,
  type Nearest,
  type RayCandidates,
} from './logic';
export { createXRSystem, type XRDebugInfo, type XRSystemExtras } from './system';
