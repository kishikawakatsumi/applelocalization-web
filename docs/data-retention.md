# Data releases

Source code, Actions workflows, and retained data belong to
`kishikawakatsumi/applelocalization-web`. The old `applelocalization-tools` and
`applelocalization-data` GitHub repositories are historical references; new
data is not published there. Docker Hub image names remain unchanged.

After a successful unified image push, run **Archive localization data in
Releases** (`localization-archive.yml`) on `main`:

- `unified_run`: the exact successful unified workflow run ID.
- `publish=false`: verify producer lineage, metadata hashes, and availability.
- `publish=true`: additionally copy and hash-check every selected ZIP, upload
  to a draft release, and publish only after every asset matches.

For the current dataset, `unified_run` is `37150025515`. Its upstream collection
and SQL runs are discovered from the retained receipts, not from the latest
workflow run or the working tree's collection plan.

The release tag is `data-r<unified-run>-a<attempt>`. Data releases are marked as
prereleases and are not selected as the application's latest release. This
label separates data retention from a production deployment; it does not alter
the source receipts' verification status.

The Git tag points to the archival workflow's commit on `main`, allowing the
standard Actions token to publish without additional workflow-write credentials.
`archiveCommit` records that commit; `producer` and per-artifact `commit` fields
record the separate, original extraction/SQL/image commits. A resumed release
keeps its original archival commit even if `main` has advanced.

## Contents and recovery

- `intermediate-*.zip`: the original intermediate package, quarantine originals,
  and collection metadata. No additional original IPSW/installer is downloaded.
- `candidate-sql-*.zip`: OS-major-version SQL packages and their original metadata.
- `candidate-plan-*.zip`, `candidate-pushed-*.zip`, and
  `unified-candidate-receipts-*.zip`: source pins, verification/distribution
  receipts, and the exact database image digest.
- `data-manifest.json`: datasets, builds, source run/attempt/commit IDs, artifact
  IDs, SHA-256 digests, and ZIP sizes.
- `SHA256SUMS`: checksums for all retained ZIPs and the manifest.

Download the required release assets, verify their SHA-256 checksums, and unzip
each into its own directory. The contents are byte-for-byte the original Actions
artifact contents, usable by the existing intermediate/SQL tools. The original
collection/candidate pipeline still expects artifact IDs. Use the independent
rebuild workflow below when the source is a retained Release.

Re-run the archival workflow with the same input to resume an interrupted draft.
Matching uploaded files are skipped; conflicting or unexpected files cause a
failure, never an overwrite. Existing Actions artifacts and images are not
deleted. All downloading/uploading happens on GitHub-hosted CI, sequentially,
so only one large ZIP needs temporary disk space at a time.

Archive before upstream artifacts expire. A missing/expired artifact, failed
producer, incomplete catalog, or ZIP of 2 GiB or larger stops publication. The
current dataset fits the per-file limit; larger future packages will require
splitting. Re-extraction is not a substitute for retaining the exact reviewed
data, since original downloads may later become unavailable.

## Rebuild a database image from a Release

Run **Rebuild database image from data Release** (`localization-rebuild-release.yml`)
on `main`. Enter the published `release_tag` and the independently retained
`data-manifest.json` SHA-256. The defaults identify the current 12-series release.
Enable `publish` to push a new, run-specific candidate image to Docker Hub;
otherwise only build and verification run.

The job reads only GitHub Release assets: it needs no Actions artifact IDs,
unexpired artifacts, original IPSW/installer, intermediate data downloads, or
local Mac. It verifies the manifest and ZIP hashes, safely expands the 12 SQL
bundles, checks all 36 component SQL/report hashes and original bundle pins,
and requires the rebuilt catalog and data identity to equal the retained ones.
The current collection plan must match the archived OS versions/builds; a
different release requires its matching plan/tooling, never silent substitution.

The image is built from a digest-pinned PGroonga base. Its payload checksums are
verified inside the container. Tiny synthetic DB initialization/restart tests
also run. The large, full unified database restore is **not** repeated on the
hosted runner; the output explicitly remains `restore-pending`, not a new full
DB validation or production deployment. Use a new dedicated volume with enough
space for a full restore before promoting a new image. Existing production tags,
volumes, and the review service are not changed.

New image and source Release identities are recorded in the run's
`release-rebuild-receipts-*` artifact. These receipts are diagnostic outputs, not
inputs required by a future rebuild; retained Release assets remain the source.
