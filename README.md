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

The unified build restores all 36 component schemas into one fresh, isolated
PostgreSQL volume, checks occurrence/language/quarantine counts and search indexes,
and repeats search checks after a clean restart. It reuses the successful per-version
full-row audits; it does not re-download originals or claim a new full-row audit or
Web compatibility check. Capacity diagnostics protect a 10 GiB free-space reserve
on both the work and Docker filesystems. Insufficient disk space or restore failure
prevents publication; a hosted runner's ability to hold the complete DB is measured,
not assumed. The owned test volume remains until runner disposal; no existing volume
is modified or removed. Restores may take up to 120 minutes.

`publish` defaults to false. With explicit opt-in, only a successful unified restore
can push `candidate-all12-r<RUN>-a<ATTEMPT>` to the existing Docker Hub repository.
The exact tested local image ID is pushed; an existing/unknown tag is refused.
Only small receipts/catalog/capacity diagnostics are uploaded as artifacts, not
another SQL/image copy. No production tag, database or deployment is changed.

- https://github.com/kishikawakatsumi/applelocalization-data
- https://github.com/kishikawakatsumi/applelocalization-tools
- https://github.com/kishikawakatsumi/applelocalization-citools

## Author

[Kishikawa Katsumi](https://github.com/kishikawakatsumi)

## Supporters & Sponsors

Open source projects thrive on the generosity and support of people like you. If you find this project valuable, please consider extending your support. Contributing to the project not only sustains its growth, but also helps drive innovation and improve its features.

To support this project, you can become a sponsor through [GitHub Sponsors](https://github.com/sponsors/kishikawakatsumi). Your contribution will be greatly appreciated and will help keep the project alive and thriving. Thanks for your consideration! :heart:
