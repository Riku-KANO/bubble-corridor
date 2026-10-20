// 第2室「雨の回廊」。STUB: rooms-b 担当が本実装に置き換える
import type { RoomModule } from '../../contracts/room';
import { createPlaceholderRoom } from '../placeholder';

export function createRainRoom(): RoomModule {
  return createPlaceholderRoom({
    id: 'rain',
    sections: ['rain'],
    color: 0x8fa3b8,
    atmosphere: { background: 0x5d6b78, fog: { color: 0x5d6b78, near: 6, far: 40 }, exposure: 0.95 },
  });
}
