// S-30 撮影の下ごしらえを始める時刻の決まり（実装担当が追加）。描画そのものは e2e/photo.spec.ts で測る。
import { describe, expect, it } from 'vitest';
import { CAPTURE_PREPARE_LEAD_SEC, captureToPrepare, type ShotCue } from './rules';

const cues: ShotCue[] = [
  { id: 'photo.capture@48', name: 'photo.capture', t: 160 },
  { id: 'rain.freeze@93', name: 'rain.freeze', t: 310 },
  { id: 'photo.capture@93', name: 'photo.capture', t: 310 },
  { id: 'photo.capture@177', name: 'photo.capture', t: 590 },
];
const ready = () => true;

describe('S-30 撮影の下ごしらえの始め時', () => {
  it('撮影の LEAD 秒前から撮影の時刻までの間だけ、その撮影を返す', () => {
    const done = new Set<string>();
    expect(captureToPrepare(cues, 310 - CAPTURE_PREPARE_LEAD_SEC - 0.01, done, ready)).toBeNull();
    expect(captureToPrepare(cues, 310 - CAPTURE_PREPARE_LEAD_SEC, done, ready)?.id).toBe('photo.capture@93');
    expect(captureToPrepare(cues, 309.9, done, ready)?.id).toBe('photo.capture@93');
    expect(captureToPrepare(cues, 310, done, ready)).toBeNull();
  });

  it('撮影のキュー以外（rain.freeze など）は返さない', () => {
    expect(captureToPrepare([cues[1]!], 305, new Set(), ready)).toBeNull();
  });

  it('済んだ撮影は返さない（毎フレーム呼んでも 1 回だけ始まる）', () => {
    const done = new Set<string>();
    const first = captureToPrepare(cues, 305, done, ready);
    expect(first?.id).toBe('photo.capture@93');
    done.add(first!.id);
    expect(captureToPrepare(cues, 306, done, ready)).toBeNull();
  });

  it('撮影の部屋がまだ見えていなければ待つ（?t= で直前から乗ると、部屋はあとから読み込まれる）', () => {
    expect(captureToPrepare(cues, 305, new Set(), () => false)).toBeNull();
    expect(captureToPrepare(cues, 305, new Set(), (c) => c.id === 'photo.capture@93')?.id).toBe('photo.capture@93');
  });

  it('途中から乗って撮影の時刻を過ぎていれば、その撮影は始めない', () => {
    expect(captureToPrepare(cues, 400, new Set(), ready)).toBeNull();
    expect(captureToPrepare(cues, 585, new Set(), ready)?.id).toBe('photo.capture@177');
  });
});
