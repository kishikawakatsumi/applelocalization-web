# 運用・デプロイ

## 新規起動

標準はリポジトリ直下の `compose.yml` と `Dockerfile`。
認証設定なしで `docker compose up --build` を実行できる。
通常の `docker compose up` も、Webイメージが未作成ならビルドする。

全データを取得・復元するため、初回はホストとDocker保存領域の両方に200 GiB以上の空きを確保する。
prepareはDocker保存領域を検査するが、Docker Desktopのホスト側の空き容量までは検査できない。
仮想ディスク上限も別途確認する。Webは初回処理の終了まで起動しない。
初期化中は `docker compose logs -f db setup` で確認する。2回目以降は既存データ・索引・認証情報を再利用する。

Webは `127.0.0.1:8080` にだけ公開する。DBは内部ネットワークのみ。
Webのビルド・起動にnpm/Font Awesome/Docker HubのPush用トークンは不要。
DB管理者とWebユーザーのランダムな認証情報は別ボリュームで保持する。
Webコンテナには管理者用ボリュームを渡さない。

## 本番へ移す

1. レビュー済みコミットを固定し、CIのテストと小規模Compose起動試験を通す。
2. 既存サービスのイメージ・データ・公開経路を保存する。新しいプロジェクト名とポートで別環境を起動する。
   例: `WEB_PORT=8085 docker compose -p applelocalization-next up --build -d`
3. healthz、全OSの検索、表示、同時検索時の負荷を本番ホストで確認する。
4. 承認後にHTTPプロキシの転送先を切り替える（下記のVPS向けCI）。
5. 問題があれば転送先を保持済みの旧環境へ戻す。新DBから旧DBへの書き戻しは不要。

VPS前段のCloudflareを維持し、VPS上にはHTTP専用Caddyを独立したComposeプロジェクトで置く。
Linuxのhost networkで動かし、ホストのloopbackで公開する各Webへ転送する。
ポート443やTLS設定には触れない。Cloudflare→VPSもTLSを要求する構成にはこのHTTP専用設定を使わない。
Compose起動やGitHub ActionsからのイメージPushだけでは、公開先の切り替えは行わない。
本番用WebはCIの `release-web.yml` で作り、配布digestを固定して使う方法もある。
既存イメージの `latest` は上書きしない。

## GitHub ActionsからVPSへデプロイ

整理後のソース・Compose・Workflowを同じコミットとしてmainへ反映してから使う。
旧Deploy（`compose down` / `docker system prune` を実行する版）は使用しない。

前提はLinux x86_64、Docker Compose 2.24.4以降（初回移行の`!override`対応）、
Python 3、flock、ss、SSHユーザーからsudoなしで操作できるローカルDocker。
このVPS用CIは、イメージ取得**後**にDocker保存領域に180 GiB以上の空き、
総メモリ3.5 GiB以上・利用可能メモリ2.75 GiB以上を要求する。
180 GiBは全12系列の検証DB（追加索引込み約129 GiB）の実測に余裕を加えた開始条件であり、
成功を保証する最低容量ではない。対象データのidentityを固定しており、別のデータではこの緩和を拒否する。
通常の `docker compose up` の既定条件は引き続き200 GiB。低容量プロファイルはVPS用CIのみで使う。

VPS用の新DBはメモリ2304 MiB・CPU 2コア、setup/Webはそれぞれ384 MiBに制限する。
DBのshared_buffersは128 MiB、work_memは4 MiB、maintenance_work_memは64 MiB、
並列索引作成・並列クエリを無効化する。PGroongaを含めた全体のメモリ上限はコンテナ側で制限する。
Swapの作成やホスト設定の変更は行わない。少量データの試験と全量取り込み成功は別であり、
4 GiB VPSでの全量取り込み・公開負荷試験は別途必要。

GitHub Environment `production` に承認者を設定し、以下のSecretsを登録する。
既存のリポジトリSecretsを使ってもよい。

- `SSH_HOST`、`SSH_USER`、`SSH_KEY`
- `SSH_KNOWN_HOSTS`: 管理下の接続で指紋を確認したVPSのknown_hosts行。
  CI内のssh-keyscanでその場で信用せず、ホスト鍵を固定する。
- ポートが22以外ならEnvironment Variable `SSH_PORT`。

### 最初の一回だけ：プロキシを設置する

プロキシは `~/applelocalization-proxy/`、Composeプロジェクト `al-proxy` に置く。
アプリ・DBとは独立しており、DBの200 GiB条件なしで設置・メンテナンス表示できる。
管理APIはコンテナ内のUnixソケットのみ。TCP 2019は開かない。

現在の旧Webは `80:8080` を占有しているため、初回だけ手元からVPSで次を実施する。
短い停止が発生する。新ソースは旧ディレクトリとは別の場所に配置しておく。

1. 旧Composeファイル・稼働イメージID・DBの保存先を記録する。
   旧プロジェクト名は以下で確認する（環境変数やパスワードは出力しない）。

   ```sh
   docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' applelocalization-web
   docker inspect --format '{{.Image}}' applelocalization-web applelocalization-data
   docker inspect --format '{{json .Mounts}}' applelocalization-data
   ```

2. `deploy/compose.proxy.yml` の固定Caddyイメージを先にpullしておく。
   旧Composeのディレクトリから、旧Webだけをloopbackの8084に変更する。
   `<旧プロジェクト名>` は上で確認した値、`/path/to/new-source` は別に配置した新ソース。

   ```sh
   docker compose -p <旧プロジェクト名> -f docker-compose.yml \
     -f /path/to/new-source/deploy/compose.legacy-loopback.yml \
     up -d --no-deps --no-build --pull never web
   curl --fail http://127.0.0.1:8084/
   ```

   DBは再作成しない。元のComposeは変更しない。以降、旧Webを起動するときは必ずこのoverrideを付ける。

3. Actions → **Deploy to VPS** → `proxy-install`。deployment_idは `proxy` など任意の有効ID。
   Caddyがポート80を受け、旧Webの8084へ転送する。公開URLと `proxy-status` を確認する。
   8084は旧Web専用として予約し、新世代では使用しない。

初回設置に失敗した場合は、ログを確認し、プロキシが起動済みなら `al-proxy` のproxyサービスだけを停止してから、
旧Compose（overrideなし）で旧Webだけを `up -d --no-deps --no-build --pull never web` し、ポート80へ戻す。
失敗したプロキシディレクトリは上書きしない。原因を解決後、VPSで
`python3 ~/applelocalization-proxy/proxy-vps.py proxy-install proxy` を実行して再試行できる
（state.jsonが完成済みなら再設置せずproxy-statusを使う）。

### 通常の世代交代

1. Actions → **Deploy to VPS** → `preflight`。deployment_idに例 `release-20261005` を入力。
   読み取り確認のみで、サービスやデータを変更しない。
2. **Release Web image (no deployment)** を同じmainコミットで `publish=true` にして実行。
   `release-images` EnvironmentのDocker Hub認証を使う。
   出力の `web-release.json` の `digest` を控える。
3. **Deploy to VPS** → `prepare`。新しいdeployment_id、上記digestをweb_imageに指定。
   検証ポートは既定8085。次の世代では8086など未使用ポートを指定する。
   VPSの `~/applelocalization-deployments/<deployment_id>/` に専用構成を置き、
   別Composeプロジェクト `al-next-<deployment_id>` で取り込む。旧環境は稼働したまま。
   DBはcompose.ymlの固定digest、Webは同一コミットの固定digestを使う。
   Workflow成功は**開始成功**であって取り込み完了ではない。
   VPS上のnohupプロセスで継続するため、SSH切断やCI終了では取り込みを中断しない。
   VPS再起動での自動再開は保証しない。
   取り込み・追加索引作成・Web起動完了まで約10秒間隔で容量を監視する。
   空きディスク20 GiB未満、利用可能メモリ256 MiB未満、新コンテナのOOM/予期しない再起動、
   Compose失敗・監視エラー時には、新しい `al-next-<deployment_id>` だけを停止する。
   メトリクスは同ディレクトリの `capacity.jsonl`。ログ・ボリュームは残す。
   監視周期や停止処理の間にも使用量は増え得るため、枯渇・OOMの完全な防止は保証しない。
4. `check` を同じdeployment_idで実行。未完了は非ゼロ終了。完了後は全12系列の検索を確認する。
   ブラウザ確認は `ssh -L 8085:127.0.0.1:8085 <SSH_USER>@<SSH_HOST>` を接続したまま
   `http://127.0.0.1:8085/` を開く。
5. 確認後、明示的に `publish` を実行。候補の全12系列の検索を再確認してから
   Caddyの設定を検証・reloadし、転送先だけを切り替える。新旧Web・DBは停止しない。
   reloadまたは公開先確認の失敗時は直前の設定を復元し、CIを失敗にする。
6. 公開後に戻す場合は同じIDで `rollback`。直前の転送先を検証してから戻す。
   保持した旧Web・DBが停止・削除されている場合は拒否し、現在の公開を維持する。
   公開URLでの確認も行う。`proxy-status` で現在・直前の転送先が確認できる。

二回目以降も新しいIDと未使用ポートで同じ手順を使う。
アプリ・DBの起動再実行に `public.json` は不要で、検証時と同じComposeを使用する。
プロキシの `pending.json` が残った場合は切り替え途中の中断を示すため自動処理を拒否する。
before/after、Caddyfile、稼働中の転送先を照合し、手動で整合性を確認する。

失敗時は `~/applelocalization-deployments/<deployment_id>/deploy.log` と、同ディレクトリで
以下を確認する。

```sh
docker compose --env-file /dev/null -p al-next-<deployment_id> \
  -f compose.yml -f images.json logs --tail 100 db setup web
```

prepareは既存ディレクトリを上書きしない。失敗した環境を自動削除せず、ログを確認して対処する。
通常操作に `down -v` やpruneは含めない。SSH秘密鍵はVPSへの配布ファイルに含めない。

### 容量不足時：メンテナンスを挟む移行

今回のVPS（空き約201 GiB、RAM約3.8 GiB、Swapなし）では、まず**削除せずメモリを確保する**。
現在の旧サービス稼働中は利用可能メモリが約2.2 GiBで、VPS用CIの開始条件を満たさない。
プロキシ設置後、maintenanceと公開URLの503表示を確認してから、VPSで次を明示的に実行する。

```sh
docker stop applelocalization-web applelocalization-data
```

これは停止のみで、旧DB・イメージ・ボリュームは残る。preflightでメモリの増加を確認してからprepareへ進む。
新環境が失敗した場合は新環境が停止済みであることを確認し、
旧DB/Webを `docker start applelocalization-data applelocalization-web` で再開する。
DBの起動とloopback 8084の応答を確認してから、CIのresumeで旧サービスへ戻す。
停止・再開は容量監視によって自動実行されない。

以下の削除を伴う手順は、実際にディスクが不足した場合だけの代替策。

可能だが、旧DB削除後は即時の切り戻しができない。初回取り込み・索引作成の間、数時間以上の停止を
見込む。VPS性能によって所要時間は変わる。失敗時は復旧までメンテナンス表示を維持する。

1. 新Web/DBの固定digestと取得可能性、ReleaseのSQL、復旧に使う旧世代の保存物を先に確認する。
   新データのReleaseだけでは旧サービスのDBを復元できるとは限らない。
2. 旧Compose・イメージdigest・DBバックアップ・必要な認証情報をVPS外に保存し、復元可能か確認する。
   代替として旧DBを捨てて再構築することを明示的に了承する。バックアップを同じVPSに残すだけでは容量は増えない。
3. CIの `maintenance` を実行。DBと無関係なHTMLを503で返し、`Retry-After: 300` と
   `Cache-Control: no-store, max-age=0` を付ける。`proxy-status` とCloudflare経由の公開URLの両方で確認する。
   Cloudflareの独自キャッシュルールやAlways Onlineが古い画面を返す場合は、そちらの設定も別途確認する。
4. 実際のコンテナID・ボリューム名・イメージと解放可能量を読み取り調査する。
   **削除対象と復旧方法を明示して承認してから**旧アプリ/DBの対象だけを停止・削除する。
   プロキシ `al-proxy` と `~/applelocalization-proxy/` は残す。
   コンテナを消すだけではボリュームやイメージの容量は解放されない。
   共有イメージや無関係なボリュームを巻き込む `system prune` / `volume prune` は使わない。
5. `preflight` を再実行。十分な空きができたら通常どおり `prepare` → `check` → ブラウザ確認 → `publish`。
   VPS用CIではイメージ取得後も180 GiB未満、または利用可能メモリ不足なら取り込みは開始しない。
   メンテナンスは解除されない。

削除処理はCIに組み込んでいない。容量不足を検知して勝手に環境を削除することはない。
旧環境が残っていれば `resume` でメンテナンス開始前の転送先へ戻せる。
メンテナンスから新環境をpublishした場合のrollback先は**メンテナンス画面**。
削除済みかもしれない旧DBを自動で再利用しない。

## 既に復元・検証済みの専用DBを使う場合

再インポートを避けるための管理者向けの経路だけを `scripts/production-release.mjs` と
`deploy/compose.existing.yml` に残している。標準起動の必須手順ではない。
復元は `verify-release-set-local.mjs` の出力・receiptが必要で、任意の稼働DBを流用する機能ではない。
公開中または検証UIで使用中のボリュームは共有しない。

```sh
node scripts/production-release.mjs prepare \
  --verified-root /path/to/verified-root --output /path/to/new-release \
  --web-receipt /path/to/web-release.json \
  --web-receipt-sha256 <SHA256> --port 8085 --allow-prepare
node scripts/production-release.mjs config --output /path/to/new-release
node scripts/production-release.mjs up --output /path/to/new-release
node scripts/production-release.mjs check --output /path/to/new-release
```

新WebにはJSON全文検索索引が必要。既存ボリューム経路では不足分を自動追加しないため、
索引込みで復元したイメージか、別途索引の適用を確認した専用DBを使う。
文脈索引は任意で、準備時に `--context-index-mode off` を選べる。
準備したファイルはハッシュで固定するので手編集せず、新しい準備ディレクトリを作る。
停止は `node scripts/production-release.mjs stop --output /path/to/new-release`。

## 障害時・データ更新

- DBの取り込み途中で失敗した場合、完了マーカーがないボリュームでは起動しない。
  ログとボリュームを保持し、原因を解消してから別プロジェクトで作り直す。
- setupの索引追加はコンポーネント単位で確定する。再実行時は完成済み索引を検査して再利用する。
  壊れた索引を自動削除・上書きしない。
- DBデータだけでなくmetadata/admin-secret/app-secretボリュームも同じ世代でバックアップする。
  秘密情報が失われた既存DBでは、別パスワードを勝手に生成せず停止する。
- 新しいデータへ更新する場合は、旧環境を保持して別プロジェクトで復元する。
  `docker compose down -v`、`docker volume prune` は通常の更新手順に含めない。

今回のソース整理は、既存の検証MacのDBや公開環境を停止・変更していない。

## 公開前の確認事項

整理後のDockerビルド、144件の模擬データによる全12系列のCompose初回起動・再起動・検索・
読み取り専用権限・異なるreleaseの拒否をローカルで確認した。
これは全データの再復元や本番ホストの負荷試験を代替しない。GitHubへの反映とCI本実行も別途必要。

2026-10-05のnpm監査では、実行時依存（omit=dev）は0件だったが、ビルド用依存には
10件（critical 1 / high 7 / moderate 1 / low 1）の警告が残っている。
今回、無関係な一括アップグレードは行っていない。公開前に互換性を確認して更新する。
