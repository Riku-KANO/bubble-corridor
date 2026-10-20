// 第4室「星の天球」。STUB: rooms-c 担当が本実装に置き換える
import type { RoomModule } from '../../contracts/room';
import { createPlaceholderRoom } from '../placeholder';

export function createCelestialRoom(): RoomModule {
  return createPlaceholderRoom({
    id: 'celestial',
    sections: ['celestial'],
    color: 0xe8eeff,
    atmosphere: { background: 0x0a1030, exposure: 1 },
  });
}
