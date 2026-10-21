// 起動時の端末の手がかり（品質の自動判定の入力）。DOM に触らない純粋な関数にして、テストできるようにする。
import type { DeviceHints } from '../core/quality';

/** 起動時に読む環境（app が navigator・matchMedia・screen から集めて渡す） */
export interface DeviceEnv {
  readonly userAgent: string;
  /** 指で触る画面（pointer: coarse）か */
  readonly coarsePointer: boolean;
  readonly hardwareConcurrency?: number;
  /** navigator.deviceMemory（GB。Chrome 系だけ） */
  readonly deviceMemoryGB?: number;
  /** 画面の画素数（width × height × dpr²） */
  readonly screenPixels?: number;
  readonly gpu?: string;
  /** immersive-vr が使えるか。PC に VR 機器をつないだだけでも真になるので、一体型かどうかの判定には使わない */
  readonly xrCapable?: boolean;
}

/**
 * 一体型のヘッドセット（Meta Quest の OculusBrowser、Pico の PicoBrowser、Wolvic）のブラウザか。
 * ここでは「VR のための低めの品質で最初から読み込む」かどうかだけを決める。PC のブラウザは対象外。
 */
export function isStandaloneHeadset(userAgent: string): boolean {
  return /OculusBrowser|PicoBrowser|Wolvic|\bMobile VR\b/i.test(userAgent);
}

/**
 * 起動時の手がかり。isXR は一体型のヘッドセットのときだけ真（VR 向けの低めの品質。fps の目標も VR の値になる）。
 * PC で xrCapable なだけの環境を isXR にすると、VR を使わない人の画面まで低くなってしまう。
 */
export function deviceHints(env: DeviceEnv): DeviceHints {
  return {
    isMobile: env.coarsePointer,
    isXR: isStandaloneHeadset(env.userAgent),
    ...(env.gpu !== undefined ? { gpu: env.gpu } : {}),
    ...(env.hardwareConcurrency !== undefined ? { hardwareConcurrency: env.hardwareConcurrency } : {}),
    ...(env.deviceMemoryGB !== undefined ? { deviceMemoryGB: env.deviceMemoryGB } : {}),
    ...(env.screenPixels !== undefined ? { screenPixels: env.screenPixels } : {}),
  };
}
