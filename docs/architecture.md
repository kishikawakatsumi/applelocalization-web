# アーキテクチャ

新しく生成するデータは、1つのPostgreSQLデータベース `applelocalization` に格納する。
接続先は配布メタデータに従う。既存の配布データは `localization_staging` のまま利用でき、既存DBの改名は行わない。
配布用テーブルはUNLOGGEDではなく通常の永続テーブル。
各OS・ビルド・構成要素は `localization_<OS系列>_<build>_<component>` スキーマで分離する。
同じ版のOS/AppOS/SystemOSは検索時に束ね、別OSや別版とは混ぜない。

| テーブル | 用途 |
| --- | --- |
| occurrence | ファイル内の各エントリー。キー・値・言語・出典・順序 |
| resource | 個々のリソースファイルと出典メタデータ |
| resource_table | 言語をまたいで対応するリソースのまとまり |
| bundle | バンドルのパス |
| language | 言語コード・元表記・判定根拠・状態 |
| source | OS・ビルド・取得範囲などの出典 |
| package | 取り込みパッケージのハッシュ・報告・カタログ |
| issue / symlink | 診断・リンクの記録 |
| quarantine | 未解析などで保留した原本バイト列 |

文字列は `target_text`、構造化された値と通常のPostgreSQL文字列で表現できない値は
JSON表現のtext列 `target_json` に保持する。jsonbへの変換で原本の値を失わないようにしている。
キーは英語とは限らない。英語も他言語もそれぞれのエントリーとして保存し、訳文一致だけでは統合しない。

検索はPGroongaでtext/JSONを検索し、同じresource_tableと完全に一致するキーを持つ選択言語の行を集める。
詳細検索は指定した列・比較条件で検索する。言語の地域差はデータに保持し、UIのグループだけで束ねる。
ページURLの `l=` は未選択の復元用で、APIでは言語条件なし＝全言語になる。

`context_…` スキーマの `member(occurrence_id, language_id, context_id)` は高速化用の対応表。
`metadata` に元パッケージのハッシュ・行数・検証状態を保存する。
元の値は変更しない。存在しない場合は従来の検索SQLに戻るが、不完全・不一致な索引は起動時に拒否する。
全体件数は取り込み時のメタデータを使用し、毎リクエストで全コーパスを数え直さない。

Web起動時にrelease-setと各bundleのハッシュ、全コンポーネントの存在・出典を検査する。
URLから任意のスキーマを指定できない。通常運用のDB接続は専用の読み取り専用ユーザー。

## ソース構成

`scripts/` は処理の段階ごとに分ける。

| ディレクトリ | 役割 |
| --- | --- |
| `collection/` | IPSW・OTAの取得、マウント、収集ジョブの実行 |
| `extraction/` | リソースの解析・抽出、原本との照合 |
| `package/` | 出典・バンドル情報を保持する中間形式の作成・検証・転送 |
| `database/` | SQL出力・監査、検索索引・権限、ローカルDB検証 |
| `release/` | SQLの統合、DBイメージの生成、GitHub Releasesへの保存・復元 |
| `release/templates/` | DBイメージのDockerfile・初期化処理 |
| `deploy/` | CI側のデプロイ処理（VPS側の設定・処理はルートの `deploy/`） |
| `plans/` | 取得対象・ビルド・成果物の固定済み計画 |
| `shared/` | JSONL、ハッシュ、チェックポイントなどの共通処理 |

入口は `npm run data:collect`・`npm run data:sql`・`npm run data:image`。
具体的な実行手順は [データ更新](data-pipeline.md) を参照。

`tests/` も同じ役割のディレクトリに分類し、画面は `frontend/`、APIは `backend/`、
Skill・MCPは `agents/`、構成の整合性は `project/` に置く。
ブラウザテストは `browser/`、DB・Docker・起動済みサービスを使うテストは `integration/`、
共通補助コードと固定データは `helpers/`・`fixtures/` に分ける。

- `npm test`：各分類のNodeテスト（外部サービス不要）。
- `npm run test:web`：Denoによる検索API・Web・MCPテスト。
- `npm run test:browser`：フロントエンドをビルドし、専用のテストサーバーで検索UIを確認。

`integration/` のテストは通常のテストには含めず、各ファイルの実行条件・許可フラグを確認して起動する。
コマンドの実行位置はリポジトリのルートとする。
