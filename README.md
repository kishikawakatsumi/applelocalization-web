# Apple Localization Terms Glossary

An unofficial Apple localization terms glossary that allows you to search for
standard localization texts provided by the Apple platform.

https://applelocalization.com/

## Release Note

### [iOS 18, iOS 26, macOS 26] - 2025-11-16

#### Added

- iOS 18.1, iOS 26.2, macOS 15.6, macOS 26.1

#### Removed

- macOS 15.2

### [macOS 15] - 2025-01-14

#### Added

- macOS 15.2

### [iOS 17] - 2024-10-24

#### Added

- iOS 17

### [macOS 14] - 2023-10-03

#### Added

- macOS 14

### [iOS 16, macOS 13] - 2023-09-24

#### Added

- iOS 16
- macOS 13

### [macOS 12] - 2022-01-31

#### Added

- macOS 12

### [iOS 15] - 2022-01-26

#### Added

- iOS 15

## Related Repository

### Candidate data pipeline (manual, no production deployment)

Run `Localization latest release collection batch` on main with `allow_download=true`
and `targets=ios18` (or a comma-separated list / `all-ready`). SQL generation on the
macOS collector is optional; the independent Linux pipeline consumes its intermediate artifacts.

Then run `Localization per-version candidate pipeline` with the exact `source_run`,
`targets=ios18` (or `all-ready`), and optionally `publish=true`.
SQL, image verification, and Docker Hub push are separate jobs; versions run in parallel.
`all-ready` explicitly reports unavailable targets and processes only versions whose required
extraction and intermediate-upload steps succeeded (a later optional SQL failure is retriable).
It does not mean that all 12 requested series were acquired.

The image contains every selected component in a separate schema within `localization_staging`.
Its first boot imports verified compressed SQL and builds indexes into a **new empty volume**;
wait for the container to become healthy. Existing/different/incomplete database volumes are refused.
The image job checks every restored row and quarantined original, source-specific search probes,
and a clean restart. The push job uses the existing `DOCKERHUB_USERNAME` and `DOCKERHUB_PASSWORD`
secrets only after rechecking the successful image artifact. Tags are unique:
`kishikawakatsumi/applelocalization-data:candidate-<target>-<version>-<build>-r<run>-a<attempt>`.
Neither `latest`, the production database, nor the deployed Web service is changed.

These occurrence schemas are **not drop-in replacements for the legacy Web API tables**;
DB verification is not a claim of full Web/API compatibility. Application integration remains a
separate validation step. Artifacts retain intermediate/quarantine data and SQL for 14 days;
the registry retains pushed candidate images. No routine Mac download, IPSW/DMG retention,
cross-repository Release publication, scheduled annual run, or automatic production deployment occurs.

The pinned 2026-10-02 plan covers all 12 requested series: five IPSW targets and seven full-OTA
targets (macOS 12/13/14/15/26 and iOS 17/26), with 36 independent components. iOS 26.7.1
uses an encrypted full OTA; CI run 36986903666 verified decryption, AA01/YOP normalization,
internal release metadata and all three component paths. Acquisition, decrypted and derived
ZIP hashes are pinned. Keys stay in private temporary CI files and are removed; raw archives
are not uploaded. Native conversion processes one chunk at a time with the 10 GiB reserve
unchanged. Metadata-only fixups cannot add files, data, links or unknown attributes.
Full-OTA archives and internal metadata are hash-pinned; only full
payloads with the exact stable release build are accepted. macOS OTA builds are cross-checked
against Apple's stable installer distribution definitions, even when OTA documentation IDs
retain an RC suffix. Intel and arm64 SystemOS components remain separate schemas in one image.

Set `publish_candidates=true` on the collection workflow to trigger the independent candidate
pipeline after collection, with that exact run ID and `all-ready`. A failed sibling does not
block complete targets; an incomplete target is never pushed. This opt-in changes no production
tag or deployment. It avoids waiting for manual Web acceptance between extraction and candidate
SQL/image generation. Ordinary OTA resources use a BOM-checked regular-file projection;
cryptex patches use read-only image extraction. Auxiliary/recovery assets remain out of scope.

Large IPSW members now use bounded HTTP range reads instead of retaining every
downloaded block in the tool's memory cache. The reader requires coherent strong
ETags and exact ranges, verifies ZIP CRC and SHA-256, and refuses unexpected members
or byte-budget overruns. Existing free-disk reserves remain unchanged. This avoids
an unbounded cache; successful macOS collection still requires an actual CI run.

#### One-database release-set assembly (not deployed)

Per-version candidate images are build/verification units, not a requirement to run
one PostgreSQL server per OS version. `scripts/compose-release-set.mjs` assembles
their existing SQL bundles into one Docker build context for one database, preserving
all component schemas and byte-identical SQL. It does not extract data, re-run full
raw-data audits, connect to a database, build/push an image, or deploy anything.

Pass `--inputs <pins.json> --output <fresh-directory>`. The input JSON is an array of
`{ "target": "ios15", "sql": "/ci/downloaded/sql-ios15", "bundleSha256": "<64 hex characters>" }`.
Use only verified CI SQL artifacts; pins must come from their trusted producer.
The default `--targets all` requires **all 12 planned series** and all required
components at their pinned versions/builds. An explicit `--targets ios15,macos15`
can prepare a partial integration context; omitted series are listed and it is
never labelled complete or production-ready. All acquisition inputs are now pinned;
the full release set still requires successfully generated SQL for every target.

`context/payload/release-set.json` maps each public ID (for example `ios27` or
`macos27`) to only that OS/version's component schemas. `resolveReleaseScope`
requires an explicit ID and refuses unknown IDs, all-version searches and fallback.
It is a scope resolver for the forthcoming Web integration, not a live API yet.
The catalog is checksummed with the payload; a different release set requires a
fresh database volume. The existing initializer imports every component into the
same `localization_staging` database. Web/API integration remains separate;
per-version verification alone is not a claim that the assembled multi-version
image has already been restored.

`localization-unified-candidate.yml` is the manually dispatched CI-only integration
workflow. `scripts/release-set-inputs-20261002.json` fixes all 12 successful producer
runs, attempts, commits, SQL artifact IDs, digests and sizes (about 4 GiB total).
The intake gate requires successful SQL/image/push jobs from the expected main-branch
workflow and refuses expired, replaced or rerun-mixed artifacts. Downloads happen
only on the hosted runner, with digest mismatch treated as an error. Expired inputs
must be regenerated and explicitly re-pinned, never silently replaced with latest.

The standard hosted runner builds the unified image but **does not restore the whole
database**. Run 37006178004 reached the 10 GiB free-disk reserve during `macos26-os`,
after restoring all iOS series and macOS 27. Assembly itself succeeded. The workflow
therefore uses `--mode assemble`, retaining the same SQL/hash/lineage checks and the
prior successful per-version full-row audits. It does not re-download originals.

`publish` defaults to false. Explicit opt-in pushes only a fresh
`candidate-all12-r<RUN>-a<ATTEMPT>` tag, with status
`unified-candidate-pushed-restore-pending` and `unifiedRestoreVerified: false`.
`assembled.json` and `pushed.json` bind the image ID, registry digest, catalog and
producer. An existing/unknown tag is refused. Only small receipts/catalog/capacity
diagnostics are uploaded, not another SQL/image copy. No production tag, database
or deployment is changed. A successful Push is **not** a successful unified restore.

#### Final local verification

Use Node.js 24 and a running local Linux Docker engine. On macOS, ensure Docker's
VM has at least 6 GiB RAM and at least **200 GiB available disk space**, in addition
to 200 GiB free on the Mac filesystem. This is a conservative preflight budget, not
a measured final DB size. The image is `linux/amd64`; Apple Silicon needs Docker's
amd64 emulation. SSH login PATH may need `/usr/local/bin` and the Node version manager.
Do not delete existing images/volumes to make space automatically.

Download the small `unified-candidate-receipts-<run>-<attempt>` artifact from the
successful trusted workflow. Pin the SHA-256 of `unified/pushed.json`, then run:

```sh
node scripts/verify-release-set-local.mjs \
  --receipt /path/to/receipts/unified/pushed.json \
  --receipt-sha256 <trusted-pushed-json-sha256> \
  --assembled /path/to/receipts/unified/assembled.json \
  --output /path/to/new-validation-directory \
  --allow-pull --allow-local-restore
```

Only the pinned image is downloaded, not IPSW/OTA or another SQL archive. Metadata
and every packaged file checksum are checked before creating a fresh dedicated DB
volume. No ports are published, no external network is attached, and no existing
container/volume is changed. The verifier checks all 36 schemas, row/language/quarantine
counts, fulltext search and clean restart. It retains a 10 GiB reserve on both host
and Docker disks and allows four hours for initialization. Failure stops only its
own container and retains the volume and bounded diagnostics; it never removes data.
Success writes local `verified.json` and leaves the container stopped with its volume
intact. Web/API compatibility and production deployment remain separate tasks.

Candidate initialization disables autovacuum **only on the socket-only temporary
server**. PGroonga 4.0.4 can otherwise remove another component's uncommitted index
during VACUUM. No SQL payload or persistent PostgreSQL setting is changed. The
normal server and clean restart must have autovacuum on; health checks and the
local verifier enforce this. Failed initialization still refuses to reuse its
partial volume. Tiny, isolated Docker regression (retains stopped test volumes):

```sh
ALLOW_INITIALIZATION_TEST=1 node tests/candidate-initialization.integration.mjs
```

- https://github.com/kishikawakatsumi/applelocalization-data
- https://github.com/kishikawakatsumi/applelocalization-tools
- https://github.com/kishikawakatsumi/applelocalization-citools

## Author

[Kishikawa Katsumi](https://github.com/kishikawakatsumi)

## Supporters & Sponsors

Open source projects thrive on the generosity and support of people like you. If you find this project valuable, please consider extending your support. Contributing to the project not only sustains its growth, but also helps drive innovation and improve its features.

To support this project, you can become a sponsor through [GitHub Sponsors](https://github.com/sponsors/kishikawakatsumi). Your contribution will be greatly appreciated and will help keep the project alive and thriving. Thanks for your consideration! :heart:
