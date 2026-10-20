// 第3室「万華鏡の間」（金と青）。STUB: rooms-b 担当が本実装に置き換える
import type { RoomModule } from '../../contracts/room';
import { createPlaceholderRoom } from '../placeholder';

export function createKaleidoscopeRoom(): RoomModule {
  return createPlaceholderRoom({
    id: 'kaleidoscope',
    sections: ['kaleidoscope'],
    color: 0x5a8fe0,
    atmosphere: { background: 0x0f1e3a, exposure: 1 },
  });
}
