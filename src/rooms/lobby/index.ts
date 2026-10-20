// 待ち列と入口（ホーム画面の背景）。STUB: rooms-a 担当が本実装に置き換える
import type { RoomModule } from '../../contracts/room';
import { createPlaceholderRoom } from '../placeholder';

export function createLobbyRoom(): RoomModule {
  return createPlaceholderRoom({
    id: 'lobby',
    sections: [],
    color: 0x9fb4c8,
    atmosphere: { background: 0x14181f, exposure: 0.9 },
  });
}
