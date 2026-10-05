# Agent skill

`skills/apple-localization` provides a review workflow and a dependency-free
Node.js 22+ client for the existing Apple Localization API. It does not change
the database, Web UI or server, and does not require MCP or an LLM API key.

## Try the client

From the repository root:

```sh
node skills/apple-localization/scripts/search.mjs datasets
node skills/apple-localization/scripts/search.mjs search --platform macos --version 27 --query 'tab' --bundle Terminal.app --language English --language Japanese --limit 20
```

Use the platform, version and languages appropriate for your app. Each invocation
performs at most one read-only request. Search terms and filters are sent to
`https://applelocalization.com`; use only information appropriate to disclose.
For a local service append `--base-url http://127.0.0.1:8084` (or its actual port).

See the bundled [API reference](../skills/apple-localization/references/api.md)
for flags, response semantics, pagination and limitations.

## Use with an agent

For a first trial, ask a file-reading agent to read
`skills/apple-localization/SKILL.md` and review a few specified strings. No global
installation is necessary. For example:

> Read skills/apple-localization/SKILL.md and review these five Japanese strings
> for macOS 27, using English and Japanese Apple examples. Report suggestions
> with their sources; do not modify the files. These strings may be sent to the
> public glossary for lookup.

Include source values, current translations, target locale, UI usage/comments and
any project terminology rules when available. Opaque keys alone do not establish
what the user sees. The skill supplies evidence for an existing translation
workflow rather than managing languages or replacing its editing tools. Locally
available language style guides may inform a review; Apple's exported guides are
not bundled or required.

For repeated use, install/copy the **entire** `apple-localization` directory via
your agent's skill installation mechanism, preserving the `scripts/` and
`references/` subdirectories. The repository is
`https://github.com/kishikawakatsumi/applelocalization-web` and the skill path is
`skills/apple-localization`. Review the code and pin a reviewed revision when
distributing it. Installing the skill does not require running a local database.

The package uses `SKILL.md`, relative references and a plain Node.js script;
actual discovery, shell execution and network permission depend on the host.
It is not automatically loaded merely because the service is online.
See [official skill documentation](https://learn.chatgpt.com/docs/build-skills).

## Verification

```sh
node --test tests/localization-skill.test.mjs
```

Tests use synthetic HTTP responses and do not call the public service. Check a
small representative review manually before broad use: reserved characters,
same key in different bundles, regional locales, structured values, split pages,
no matches and service failures. In particular, no-match/partial results must not
be called mistranslations and suggestions must be distinguished from Apple text.

For the review instructions themselves, try these synthetic cases (not Apple
quotations). These are manual acceptance scenarios, not assertions covered by the
client's automated tests:

| Input/context | Expected behavior |
| --- | --- |
| Two entries have source value `Open`; one is a button, one a connection status | Inspect each use and evaluate independently; do not transfer the same translation solely because the English matches. If usage is absent, qualify the advice. |
| An approved project glossary specifies a term different from a returned Apple example | Respect the project decision, explain the difference if useful, and do not label it an error merely for differing. |
| Target locale is `en-AU`, but the search uses the `English` group | Retain `en-AU` in the project; distinguish the returned locales and disclose any mapping to stored codes. Do not pass off a different region's wording as Australian evidence. |
| `%@ sent a file to %@`, with sender first and recipient second | Keep the two argument roles even if the target reorders them; propose supported positional markers rather than swapping values. Missing argument context remains unresolved. |
| A plural/device-varied entry has only one branch represented in the retrieved examples | Do not flatten or overwrite other branches, and report the evidence as partial. |
| A style guide recommends one form while an older OS resource contains another | Attribute each separately, preserve the resource quote, and label the final recommendation as a proposal. |

For remote MCP access and the published OpenAPI/discovery documents, see
[Agent access](agent-access.md). The skill does not require MCP and does not
provide an automatic project-wide batch reviewer or context-detail endpoint.
Its client limits are separate from the server-side MCP capacity limits.
