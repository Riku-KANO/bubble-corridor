// 第5室「夜明けの岸」。STUB: rooms-c 担当が本実装に置き換える
import type { RoomModule } from '../../contracts/room';
import { createPlaceholderRoom } from '../placeholder';

export function createDawnRoom(): RoomModule {
  return createPlaceholderRoom({
    id: 'dawn',
    sections: ['dawn'],
    color: 0xf3c9a0,
    atmosphere: { background: 0xf3c9a0, fog: { color: 0xf3c9a0, near: 30, far: 200 }, exposure: 1.15 },
  });
}
