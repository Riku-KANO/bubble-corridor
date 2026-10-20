// 乗り場「泡の発着場」（乗り場と降車で同じホールを、光だけ変えて使う）。STUB: rooms-a 担当が本実装に置き換える
import type { RoomModule } from '../../contracts/room';
import { createPlaceholderRoom } from '../placeholder';

export function createPlatformRoom(): RoomModule {
  return createPlaceholderRoom({
    id: 'platform',
    sections: ['platform', 'departure'],
    color: 0x9fb4c8,
    atmosphere: { background: 0x2a3340, fog: { color: 0x2a3340, near: 10, far: 60 }, exposure: 1 },
  });
}
