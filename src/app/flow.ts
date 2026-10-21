// 画面の流れ（純粋な状態遷移）。本物のアトラクションの順序をなぞる:
// 並ぶ（待ち列）→ 切符を切る（入口）→ 案内を聞く → 乗る → 写真を受け取る。
// 副作用（カメラの移動、音、VR の開始）は app.ts が遷移を見て起こす。
import type { ViewMode } from '../contracts/ids';
import type { ScreenId } from '../contracts/ui';

export type FlowAction =
  | { readonly type: 'loaded' }
  | { readonly type: 'enterHome' }
  | { readonly type: 'ride'; readonly mode: ViewMode }
  | { readonly type: 'guideDone' }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'alight' }
  | { readonly type: 'rideEnd' }
  | { readonly type: 'rideAgain' }
  | { readonly type: 'toHome' }
  | { readonly type: 'open'; readonly screen: 'shelf' | 'settings' | 'howto' | 'credits' }
  | { readonly type: 'back' }
  | { readonly type: 'xrEnded' };

export interface FlowState {
  readonly screen: ScreenId;
  /** 待ち列の読み込みが終わったか */
  readonly loaded: boolean;
  readonly viewMode: ViewMode;
  /** 設定などのサブ画面から戻る先 */
  readonly returnTo: ScreenId | null;
}

export interface FlowContext {
  /** 乗車前の案内を見たことがあるか（2回目以降は出さない） */
  readonly seenGuide: boolean;
}

export const INITIAL_FLOW: FlowState = { screen: 'queue', loaded: false, viewMode: 'screen', returnTo: null };

const SUB_SCREENS: readonly ScreenId[] = ['shelf', 'settings', 'howto', 'credits'];

/** 遷移できない組み合わせは同じ state を返す（呼び出し側は参照の一致で「何も起きない」を判定できる） */
export function reduceFlow(state: FlowState, action: FlowAction, ctx: FlowContext): FlowState {
  switch (action.type) {
    case 'loaded':
      return state.loaded ? state : { ...state, loaded: true };
    case 'enterHome':
      return state.screen === 'queue' && state.loaded ? { ...state, screen: 'home' } : state;
    case 'ride':
      if (state.screen !== 'home') return state;
      // VR では乗車前の案内（画面の DOM）を飛ばす: ヘッドセットの中からは見えない（触れ方は VR の中で、自分で鳴る合図と縁の光が教える）
      return { ...state, screen: ctx.seenGuide || action.mode === 'vr' ? 'riding' : 'guide', viewMode: action.mode };
    case 'guideDone':
      return state.screen === 'guide' ? { ...state, screen: 'riding' } : state;
    case 'pause':
      return state.screen === 'riding' ? { ...state, screen: 'pause' } : state;
    case 'resume':
      return state.screen === 'pause' ? { ...state, screen: 'riding' } : state;
    case 'alight':
      return state.screen === 'pause' ? { ...state, screen: 'home', viewMode: 'screen' } : state;
    case 'rideEnd':
      return state.screen === 'riding' || state.screen === 'pause' ? { ...state, screen: 'photo' } : state;
    case 'rideAgain':
      // 待ち列と案内を飛ばして乗り場から始める
      return state.screen === 'photo' ? { ...state, screen: 'riding' } : state;
    case 'toHome':
      return state.screen === 'photo' ? { ...state, screen: 'home', viewMode: 'screen' } : state;
    case 'open':
      if (state.screen !== 'home' && state.screen !== 'photo') return state;
      return { ...state, screen: action.screen, returnTo: state.screen };
    case 'back':
      if (!SUB_SCREENS.includes(state.screen)) return state;
      return { ...state, screen: state.returnTo ?? 'home', returnTo: null };
    case 'xrEnded': {
      // ヘッドセットを外した（セッションが終わった）。乗車中ならポーズにして画面で続けられるようにする。
      // 乗車前の案内の途中なら入口へ戻す（VR では案内を飛ばすので、いまは通らない。残しておいても害はない）
      if (state.viewMode !== 'vr') return state;
      const screen = state.screen === 'riding' ? 'pause' : state.screen === 'guide' ? 'home' : state.screen;
      return { ...state, viewMode: 'screen', screen };
    }
  }
}
