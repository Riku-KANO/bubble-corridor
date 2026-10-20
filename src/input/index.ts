// 見回すと触れる（PC とスマートフォン）。VR の入力は src/xr が受け持つ。
// 公開の名前と署名は契約（src/contracts/input.ts）のとおり。中身は look.ts（見回し）と touch.ts（触れる）。
export { createLookControl } from './look';
export { createTouchInput } from './touch';
