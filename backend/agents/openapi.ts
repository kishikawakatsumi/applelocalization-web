// Describes the existing GET API, not a second search implementation.
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const string = { type: "string" };
const nullableString = { type: ["string", "null"] };
const count = { type: "integer", minimum: 0 };
const strings = { type: "array", items: string };
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});
const parameter = (
  name: string,
  description: string,
  schema: unknown,
  required = false,
) => ({
  name,
  in: "query",
  description,
  required,
  schema,
});
const scope = [
  {
    name: "platform",
    in: "path",
    required: true,
    schema: { enum: ["ios", "macos"], type: "string" },
  },
  {
    name: "major",
    in: "path",
    required: true,
    schema: { type: "integer", minimum: 1 },
  },
  parameter(
    "component",
    "Optional component of this dataset, discovered from its catalog.",
    string,
  ),
];
const selection = [
  parameter(
    "q",
    "Input is not trimmed. Normal search needs nonempty q, b or bundle_path; advanced search needs nonempty q.",
    {
      type: "string",
      maxLength: 4096,
      description: "Server limit is 4096 UTF-16 code units.",
    },
  ),
  {
    ...parameter(
      "l",
      "Repeat for language display groups or stored codes. Union with locale; omit both for all languages. Do not send the UI-only empty l marker.",
      strings,
    ),
    style: "form",
    explode: true,
  },
  {
    ...parameter(
      "locale",
      "Repeat for exact stored codes (no group expansion). Unknown selections match nothing. Preserve spelling from catalog.",
      strings,
    ),
    style: "form",
    explode: true,
  },
  parameter(
    "bundle_path",
    "Exact effective bundle path from catalog; valid in both search modes.",
    string,
  ),
  parameter("page", "One-based page. Pages can split resource contexts.", {
    type: "integer",
    minimum: 1,
    default: 1,
  }),
  parameter(
    "size",
    "Rows per page, not contexts. Values above 200 are clamped to 200. Prefer 20; does not bound COUNT work.",
    { type: "integer", minimum: 1, default: 200 },
  ),
];
const jsonResponse = (schema: unknown, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const errors: Record<string, unknown> = Object.fromEntries([
  [400, "Invalid conditions, component, query or pagination."],
  [404, "Unknown dataset or route."],
  [500, "Search failed. Do not interpret as no matches."],
  [
    503,
    "Search unavailable, including database statement timeout. Narrow the query before retrying.",
  ],
].map((
  [status, description],
) => [String(status), jsonResponse(ref("Error"), String(description))]));
errors["405"] = { description: "Only GET is supported (empty response body)." };

export const openapi = {
  openapi: "3.1.1",
  info: {
    title: "Apple Localization Terms Glossary API",
    version: "1.0.0",
    description:
      "Unofficial, read-only examples of Apple localization. GET URL compatibility is preserved. Pin a platform/major and retain returned version/build/provenance. Key is a resource identifier, not necessarily English. Results are evidence, not translation rules. Do not submit confidential text without permission. llms.txt and MCP instructions: /docs/agent-access.md. Legacy /api/{platform}/catalog and /search[/advanced] aliases choose the latest dataset; prefer explicit major routes below.",
  },
  servers: [{
    url: "/",
    description: "This deployment (also works with local Compose).",
  }],
  security: [],
  paths: {
    "/api/datasets": {
      get: {
        operationId: "listDatasets",
        summary: "Discover available OS releases and components",
        responses: {
          "200": jsonResponse(
            ref("Datasets"),
            "Available datasets; not hardcoded by clients.",
          ),
        },
      },
    },
    "/api/{platform}/{major}/catalog": {
      get: {
        operationId: "getCatalog",
        summary:
          "Discover stored locales, language groups and full bundle paths",
        description:
          "Does not scan occurrences per request. An optional component scopes languages, bundles and total; the components list still describes the entire dataset.",
        parameters: scope,
        responses: {
          "200": jsonResponse(
            ref("Catalog"),
            "Catalog for exactly one platform/major.",
          ),
          ...errors,
        },
      },
    },
    "/api/{platform}/{major}/search": {
      get: {
        operationId: "searchTranslations",
        summary:
          "Full-text search of localization values with context expansion",
        description:
          "Searches text and serialized structured JSON, then returns selected-language rows sharing the same resource table and exact key. Not every returned row matches q. Not relevance-ranked. Does not search resource keys. Matching and output language filters are the same; include both source and target languages if needed. Components remain distinct. Omit q only when a bundle filter is supplied.",
        parameters: [
          ...scope,
          ...selection,
          parameter(
            "b",
            "Bundle basename. May match multiple full paths.",
            string,
          ),
        ],
        responses: {
          "200": jsonResponse(
            ref("Search"),
            "One page of rows; total counts expanded rows, not translations or keys.",
          ),
          ...errors,
        },
      },
    },
    "/api/{platform}/{major}/search/advanced": {
      get: {
        operationId: "compareTranslations",
        summary:
          "Compare a key, text localization, raw locale, file or bundle name",
        description:
          "Only matching rows, without normal search's context expansion. Localization compares text-kind values only. File and Bundle compare basenames; Language compares stored codes. startsWith is a literal prefix, not a user wildcard. Legacy b is ignored: use bundle_path. A key match does not imply an English source value.",
        parameters: [
          ...scope,
          ...selection.map((p) =>
            p.name === "q"
              ? {
                ...p,
                required: true,
                schema: { type: "string", minLength: 1, maxLength: 4096 },
              }
              : p
          ),
          parameter("c", "Comparison field.", {
            type: "string",
            enum: ["key", "localization", "language", "file", "bundle"],
          }, true),
          parameter("o", "Comparison operation.", {
            type: "string",
            enum: ["equal", "notEqual", "startsWith"],
          }, true),
        ],
        responses: {
          "200": jsonResponse(ref("Search"), "One page of matching rows."),
          ...errors,
        },
      },
    },
  },
  components: {
    schemas: {
      Error: object({ error: string }, ["error"]),
      Component: object({
        key: string,
        schema: string,
        packageManifest: string,
      }, ["key"]),
      Dataset: object({
        id: string,
        platform: { type: "string", enum: ["iOS", "macOS"] },
        version: string,
        build: string,
        components: { type: "array", items: ref("Component") },
      }, ["id", "platform", "version", "build", "components"]),
      Datasets: object({
        validationOnly: { type: "boolean" },
        datasets: { type: "array", items: ref("Dataset") },
      }, ["datasets"]),
      Catalog: object({
        validationOnly: { type: "boolean" },
        target: ref("Dataset"),
        total: count,
        languages: strings,
        languageGroups: { type: "object", additionalProperties: strings },
        bundles: strings,
        components: {
          type: "array",
          items: object({ key: string, rows: count, sourceId: string }, [
            "key",
            "rows",
            "sourceId",
          ]),
        },
      }, [
        "target",
        "total",
        "languages",
        "languageGroups",
        "bundles",
        "components",
      ]),
      Provenance: object({
        source_id: string,
        table_id: nullableString,
        resource_id: string,
        resource_status: string,
        image_path: string,
        resource_path: nullableString,
        bundle_path: nullableString,
        bundle_assignment: nullableString,
        sha256: string,
        language: object({
          raw: nullableString,
          basis: nullableString,
          status: nullableString,
        }),
        bundle_evidence: {},
        original: {},
        ownership_correction: {},
        language_evidence: {},
      }, ["source_id", "table_id", "resource_id", "image_path", "language"]),
      Row: object({
        id: {
          ...count,
          description: "Component-local identifier, not a global ID.",
        },
        dataset: string,
        component: string,
        group_id: {
          ...string,
          description:
            "Table/key grouping inside a component. Also retain dataset, build and component.",
        },
        source: {
          ...string,
          description:
            "Resource key; not necessarily the source-language value.",
        },
        target: {
          ...string,
          description: "Display string; structured values are serialized JSON.",
        },
        target_kind: { type: "string", enum: ["text", "structured"] },
        target_value: {
          description:
            "Unaltered JSON value. Text remains a string; plural/structured values must not be flattened.",
        },
        language: string,
        file_name: string,
        bundle_name: string,
        provenance: ref("Provenance"),
      }, [
        "id",
        "dataset",
        "component",
        "source",
        "target",
        "target_kind",
        "target_value",
        "language",
        "provenance",
      ]),
      Search: object({
        data: { type: "array", items: ref("Row") },
        total: count,
        last_page: count,
        meta: object({
          validationOnly: { type: "boolean" },
          dataset: string,
          version: string,
          build: string,
          components: { type: "object", additionalProperties: count },
          sourceField: string,
          grouping: string,
        }, ["dataset", "version", "build"]),
      }, ["data", "total", "last_page", "meta"]),
    },
  },
};
