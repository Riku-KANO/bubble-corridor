# src/core — 案1と共有する部品

設計書「案1との共有、判断記録と未決事項 › 共通の部品」の表に対応する。

| 部品 | ファイル | 状態 |
|---|---|---|
| ガラスの材質ライブラリ | materials/glass.ts | STUB（M0） |
| 曇りと指の文字の効果 | fog/condensation.ts | STUB（M0） |
| 遷移の仕組み（動きの曲線） | easing.ts | 実装済み |
| 音の仕組み（音階・拍・立体音響・残響） | sound/scale.ts, sound/grid.ts, sound/space.ts | STUB（M0） |
| ガラスの音源 | sound/voices.ts | STUB（実録音の代わりに合成。ADR-0003） |
| 品質プリセットと自動判定 | quality.ts | STUB（M0） |
| 型つきイベント、保存 | events.ts, storage.ts | 実装済み |

## 決まり

- **core の外を import しない**（`three` などの外部パッケージは可）。`scripts/check-core.ts` が検査する。
- 案2固有の名前（区間、部屋、キュー）を持ち込まない。必要なら引数で受け取る。
- 変更したら VERSION と CHANGELOG.md を更新する。相手のリポジトリへは `pnpm core:sync` でコピーする。
