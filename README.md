# Apple Localization Terms Glossary

An unofficial Apple localization terms glossary that allows you to search for
standard localization texts provided by the Apple platform.

https://applelocalization.com/

## Getting Started

Requires Docker with Docker Compose v2.

```sh
git clone https://github.com/kishikawakatsumi/applelocalization-web.git
cd applelocalization-web
docker compose up
```

Open http://127.0.0.1:8080/ after initialization completes.
The first startup imports the full dataset and builds search indexes; allow
at least 200 GiB of free space on both the host and Docker's data disk.
Subsequent starts reuse the database stored in Docker volumes.

See [Deployment](docs/deployment.md) for configuration and update instructions.

For API, MCP and AI-assisted localization reviews, see [Agent access](docs/agent-access.md)
and the [Agent skill](docs/agent-skill.md).

## Release Note

### [iOS 27, macOS 27] - 2026-10-05

#### Added

- iOS 27.0.1, macOS 27.0.1

#### Updated

- iOS 15.8.8, iOS 16.7.16, iOS 17.7.2, iOS 18.7.10, iOS 26.7.1
- macOS 12.7.6, macOS 13.7.8, macOS 14.8.9, macOS 15.8.1, macOS 26.7.1

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

- https://github.com/kishikawakatsumi/applelocalization-data
- https://github.com/kishikawakatsumi/applelocalization-tools
- https://github.com/kishikawakatsumi/applelocalization-citools

## Author

[Kishikawa Katsumi](https://github.com/kishikawakatsumi)

## Supporters & Sponsors

Open source projects thrive on the generosity and support of people like you. If you find this project valuable, please consider extending your support. Contributing to the project not only sustains its growth, but also helps drive innovation and improve its features.

To support this project, you can become a sponsor through [GitHub Sponsors](https://github.com/sponsors/kishikawakatsumi). Your contribution will be greatly appreciated and will help keep the project alive and thriving. Thanks for your consideration! :heart:
