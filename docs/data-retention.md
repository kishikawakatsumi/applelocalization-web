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
artifact contents, usable by the existing intermediate/SQL tools. Actions-only
pipeline inputs still expect artifact IDs: a release archive is a recovery
source, not an automatic replacement for those inputs.

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
