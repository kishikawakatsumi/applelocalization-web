# データ更新

通常のWeb起動に以下のツール実行は不要。年次更新などで新しいデータを作る場合に使用する。
各工程は独立して起動でき、途中成果物を再利用する。公開サービスへは自動デプロイしない。

| 工程 | GitHub Actions | 主な実装 |
| --- | --- | --- |
| 取得・抽出 | localization-release-batch.yml | collect-release-batch.mjs |
| OS別SQL・DBイメージ | localization-candidate-pipeline.yml / localization-build-target.yml | candidate-pipeline.mjs / candidate-bundle-image.mjs |
| 全系列統合イメージ | localization-unified-candidate.yml | compose-release-set.mjs / release-set-image.mjs |
| 成果物の長期保存 | localization-archive.yml | archive-data-release.mjs |
| ReleaseからDBイメージ再生成 | localization-rebuild-release.yml | rebuild-release-image.mjs |
| Webイメージ | release-web.yml | Dockerfile / web-release-receipt.mjs |

1. `scripts/collection-batch-20261002.json` の取得計画を更新する。OS・正式版ビルド、URL・ハッシュ、
   構成要素、必要容量を明示する。日付付きファイル名は検証済み計画の識別子で、最新OSの自動解決ではない。
2. collectionをmainから `allow_download=true` と対象 `targets` で実行する。
   全系列の場合も各コンポーネントは別ジョブ。途中で失敗した系列を黙って完成扱いにしない。
3. 成功した抽出runを `source_run` に指定してcandidate pipelineを実行する。
   `all-ready` は揃った系列だけを選び、全12系列が揃ったという意味ではない。
   SQLとイメージ検証後、明示した場合だけ一意のcandidateタグをPushする。
4. 統合対象のSQLのrun・ハッシュを `scripts/release-set-inputs-20261002.json` に固定し、
   unified workflowを実行する。全系列を1つのDBへ収録するイメージになる。
5. 新しいデータdigestをComposeへ反映し、新しいプロジェクト/ボリュームで検証する。
   既存ボリュームを新しいイメージへそのまま付け替えない。異なるデータの組み合わせは起動時に拒否する。
6. 統合イメージの成功run IDで `localization-archive.yml` を実行し、中間形式・未解析原本・SQL・receiptを
   このリポジトリのReleasesへ保存する。手順は [Data releases](data-retention.md) を参照。

中間形式は出典付きoccurrenceパッケージ。未解析原本と診断証拠を保持する。
SQLは圧縮COPY形式。全体のIPSW/OTAを恒久保存する必要はないが、中間形式・未解析原本・マニフェスト・SQL・
配布receiptを失わないようにする。Actions artifactには期限があるため、長期保管とは区別する。
再取得可能なソースだけでなく、取得不能になる可能性にも注意する。

新しいDBイメージは、初期化時に元SQL→JSON全文検索索引→文脈索引の順に作成し、成功後だけ完了マーカーを付ける。
既に配布した旧イメージを標準Composeで起動する場合は `deploy/setup.ts` が不足分を追加する。
検索高速化だけの更新で原本の再抽出は不要。

監査スクリプトは再抽出の正確性確認に使う。
完了済みの旧形式移行・v4→v5バンドル補正ツールと当時の検証の要約は
[`archive/localization-pre-cleanup-20261005`](https://github.com/kishikawakatsumi/applelocalization-web/tree/archive/localization-pre-cleanup-20261005)
に保存している。通常運用や新規抽出には使用しない。
Font Awesomeの認証は不要。Docker HubへのPushにはGitHub Environmentの承認設定とDocker HubのSecretsが必要。

## ローカルDBの回帰テスト

`context-index-sql.integration.mjs` と `structured-search.integration.ts` は、
`localization_staging` DBとPGroongaを用意した専用ローカルDockerコンテナで実行する。
コンテナ名は `localization-test-` で始め、`LOCALIZATION_TEST_CONTAINER` で明示する。
本番・検証サービスには接続しない。テスト用の行・スキーマはトランザクション終了時に戻す。

```sh
export LOCALIZATION_TEST_CONTAINER=localization-test-search
ALLOW_CONTEXT_INDEX_TEST=1 node tests/context-index-sql.integration.mjs
ALLOW_STRUCTURED_SEARCH_DB_TEST=1 deno test --node-modules-dir=none --frozen --allow-env --allow-read --allow-run tests/structured-search.integration.ts
```
