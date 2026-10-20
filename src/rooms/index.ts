// 部屋の一覧。各部屋の担当は src/rooms/<部屋>/ だけを編集し、このファイルは変えない（統合担当）。
import type { RoomId } from '../contracts/ids';
import type { RoomFactory } from '../contracts/room';
import { createCelestialRoom } from './celestial';
import { createDawnRoom } from './dawn';
import { createGreenhouseRoom } from './greenhouse';
import { createKaleidoscopeRoom } from './kaleidoscope';
import { createLobbyRoom } from './lobby';
import { createPlatformRoom } from './platform';
import { createRainRoom } from './rain';

export const ROOM_FACTORIES: Readonly<Record<RoomId, RoomFactory>> = {
  lobby: createLobbyRoom,
  platform: createPlatformRoom,
  greenhouse: createGreenhouseRoom,
  rain: createRainRoom,
  kaleidoscope: createKaleidoscopeRoom,
  celestial: createCelestialRoom,
  dawn: createDawnRoom,
};
