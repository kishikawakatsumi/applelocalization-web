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

The pinned 2026-10-02 plan covers 12 requested series; five have IPSW inputs and seven still need
alternative acquisition routes. The first macOS 27 OS job hit the standard runner disk reserve,
so that incomplete target must not be presented as a verified candidate.

Large IPSW members now use bounded HTTP range reads instead of retaining every
downloaded block in the tool's memory cache. The reader requires coherent strong
ETags and exact ranges, verifies ZIP CRC and SHA-256, and refuses unexpected members
or byte-budget overruns. Existing free-disk reserves remain unchanged. This avoids
an unbounded cache; successful macOS collection still requires an actual CI run.

- https://github.com/kishikawakatsumi/applelocalization-data
- https://github.com/kishikawakatsumi/applelocalization-tools
- https://github.com/kishikawakatsumi/applelocalization-citools

## Author

[Kishikawa Katsumi](https://github.com/kishikawakatsumi)

## Supporters & Sponsors

Open source projects thrive on the generosity and support of people like you. If you find this project valuable, please consider extending your support. Contributing to the project not only sustains its growth, but also helps drive innovation and improve its features.

To support this project, you can become a sponsor through [GitHub Sponsors](https://github.com/sponsors/kishikawakatsumi). Your contribution will be greatly appreciated and will help keep the project alive and thriving. Thanks for your consideration! :heart:
