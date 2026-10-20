// 第1室「朝露の温室」。STUB: rooms-a 担当が本実装に置き換える
import type { RoomModule } from '../../contracts/room';
import { createPlaceholderRoom } from '../placeholder';

export function createGreenhouseRoom(): RoomModule {
  return createPlaceholderRoom({
    id: 'greenhouse',
    sections: ['greenhouse'],
    color: 0x9ed68a,
    atmosphere: { background: 0xdfe9d8, fog: { color: 0xdfe9d8, near: 20, far: 120 }, exposure: 1.1 },
  });
}
