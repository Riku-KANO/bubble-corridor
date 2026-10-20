// S-12 REN-2 品質プリセットと自動判定、動的な解像度（親が作成。実装担当は変更しない）
// S-18 で quality.ts から quality-tier.ts へ移した（quality.ts は案1の QUALITY_PRESETS。CORE-5）
import { describe, expect, it } from 'vitest';
import { DynamicResolution, detectTier, presetFor, type DeviceHints, type QualityTier } from './quality-tier';

const desktop = (extra: Partial<DeviceHints> = {}): DeviceHints => ({ isMobile: false, isXR: false, hardwareConcurrency: 8, deviceMemoryGB: 8, ...extra });

describe('REN-2 自動判定', () => {
  it('スマートフォンと VR は low（速さを優先）', () => {
    expect(detectTier({ isMobile: true, isXR: false, gpu: 'Apple GPU' })).toBe('low');
    expect(detectTier({ isMobile: false, isXR: true, gpu: 'Adreno (TM) 740' })).toBe('low');
  });

  it('PC: 単体 GPU や Apple の M シリーズは high、内蔵 GPU と不明は medium', () => {
    expect(detectTier(desktop({ gpu: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)' }))).toBe('high');
    expect(detectTier(desktop({ gpu: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)' }))).toBe('high');
    expect(detectTier(desktop({ gpu: 'ANGLE (AMD, AMD Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0)' }))).toBe('high');
    expect(detectTier(desktop({ gpu: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)' }))).toBe('medium');
    expect(detectTier(desktop({ gpu: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)' }))).toBe('medium');
    expect(detectTier(desktop())).toBe('medium');
  });

  it('ソフトウェア描画・少ないコア・少ないメモリは low', () => {
    expect(detectTier(desktop({ gpu: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)' }))).toBe('low');
    expect(detectTier(desktop({ gpu: 'llvmpipe (LLVM 15.0.7, 256 bits)' }))).toBe('low');
    expect(detectTier(desktop({ hardwareConcurrency: 2 }))).toBe('low');
    expect(detectTier(desktop({ deviceMemoryGB: 2 }))).toBe('low');
  });
});

describe('REN-2 プリセット', () => {
  const tiers: QualityTier[] = ['low', 'medium', 'high'];

  it('目標の fps: PC 60、スマートフォン 30、VR 72（設計書「性能の目標」）', () => {
    expect(presetFor('high', desktop()).targetFps).toBe(60);
    expect(presetFor('low', { isMobile: true, isXR: false }).targetFps).toBe(30);
    expect(presetFor('low', { isMobile: false, isXR: true }).targetFps).toBe(72);
  });

  it('VR と low では後処理を使わない', () => {
    expect(presetFor('high', { isMobile: false, isXR: true }).postFx).toBe(false);
    expect(presetFor('low', desktop()).postFx).toBe(false);
    expect(presetFor('high', desktop()).postFx).toBe(true);
  });

  it('品質が上がるほど粒子・環境画像が増え、倍率は範囲内', () => {
    const p = tiers.map((t) => presetFor(t, desktop()));
    for (let i = 1; i < p.length; i++) {
      expect(p[i]!.particleScale).toBeGreaterThanOrEqual(p[i - 1]!.particleScale);
      expect(p[i]!.envMapSize).toBeGreaterThanOrEqual(p[i - 1]!.envMapSize);
    }
    for (const x of p) {
      expect(x.particleScale).toBeGreaterThan(0);
      expect(x.particleScale).toBeLessThanOrEqual(1);
      expect(x.minRenderScale).toBeGreaterThan(0.3);
      expect(x.minRenderScale).toBeLessThanOrEqual(x.renderScale);
      expect(x.renderScale).toBeLessThanOrEqual(1);
    }
  });

  it('スマートフォンは画素比の上限を 2 以下にする（発熱を抑える）', () => {
    for (const t of tiers) expect(presetFor(t, { isMobile: true, isXR: false }).maxPixelRatio).toBeLessThanOrEqual(2);
  });
});

describe('REN-2 動的な解像度', () => {
  const feed = (d: DynamicResolution, ms: number, n: number) => {
    let s = d.scale;
    for (let i = 0; i < n; i++) s = d.sample(ms);
    return s;
  };

  it('重いフレームが続くと倍率を下げ、下限で止まる', () => {
    const preset = presetFor('medium', desktop());
    const d = new DynamicResolution(preset);
    const start = d.scale;
    expect(feed(d, 25, 120)).toBeLessThan(start);
    expect(feed(d, 40, 2000)).toBeCloseTo(preset.minRenderScale, 6);
  });

  it('軽いフレームが続くと元の倍率まで戻し、それを超えない', () => {
    const preset = presetFor('medium', desktop());
    const d = new DynamicResolution(preset);
    feed(d, 30, 600);
    expect(d.scale).toBeLessThan(preset.renderScale);
    expect(feed(d, 8, 3000)).toBeCloseTo(preset.renderScale, 6);
  });

  it('目標付近の揺れでは変えない（行ったり来たりしない）', () => {
    const d = new DynamicResolution(presetFor('medium', desktop()));
    const start = d.scale;
    for (let i = 0; i < 600; i++) d.sample(i % 2 === 0 ? 16 : 17.5);
    expect(d.scale).toBe(start);
  });

  it('一度に大きく変えない（1回の変化は 0.1 以下）、毎フレームは変えない', () => {
    const d = new DynamicResolution(presetFor('high', desktop()));
    let prev = d.scale;
    let changes = 0;
    for (let i = 0; i < 300; i++) {
      const s = d.sample(33);
      if (s !== prev) {
        changes++;
        expect(Math.abs(s - prev)).toBeLessThanOrEqual(0.1 + 1e-9);
      }
      prev = s;
    }
    expect(changes).toBeGreaterThan(0);
    expect(changes).toBeLessThan(30);
  });

  it('reset で初期の倍率に戻る', () => {
    const preset = presetFor('medium', desktop());
    const d = new DynamicResolution(preset);
    feed(d, 40, 600);
    d.reset();
    expect(d.scale).toBe(preset.renderScale);
  });
});

describe('REN-2 動的な解像度: 重い状態が続いても行ったり来たりしない（レビュー2巡目の症状をテストにしたもの）', () => {
  /** 倍率 s のときのフレーム時間（画素数に比例する GPU の重さ、垂直同期 60Hz の下限つき） */
  const frameMs = (s: number, heavyAt1: number) => Math.max(1000 / 60, heavyAt1 * s * s);

  function run(d: DynamicResolution, seconds: number, heavyAt1: number) {
    let t = 0;
    let changes = 0;
    let last = d.scale;
    const changeTimes: number[] = [];
    while (t < seconds * 1000) {
      const ms = frameMs(d.scale, heavyAt1);
      t += ms;
      const s = d.sample(ms);
      if (s !== last) {
        changes++;
        changeTimes.push(t / 1000);
        last = s;
      }
    }
    return { changes, changeTimes };
  }

  it('倍率 1.0 で 24ms の重さが150秒続くと、落ち着いた後（20秒以降）の変化は3回以下', () => {
    const d = new DynamicResolution(presetFor('high', desktop()));
    const { changeTimes } = run(d, 150, 24);
    expect(changeTimes.filter((x) => x > 20).length).toBeLessThanOrEqual(3);
  });

  it('スマートフォン（目標 30fps）でも同じ', () => {
    const d = new DynamicResolution(presetFor('low', { isMobile: true, isXR: false }));
    const { changeTimes } = run(d, 150, 48);
    expect(changeTimes.filter((x) => x > 20).length).toBeLessThanOrEqual(3);
  });
});
