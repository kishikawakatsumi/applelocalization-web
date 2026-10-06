// Read-only occurrence search. All schemas are selected by verified metadata.
import { languageMapping } from "../models/languages.ts";
import {
  effectiveResource,
  validateOccurrencePackage,
} from "../../scripts/package/occurrence-package.mjs";

export type Query = (
  sql: string,
  args?: unknown[],
) => Promise<Record<string, unknown>[]>;
export type Snapshot = <T>(work: (query: Query) => Promise<T>) => Promise<T>;
type Language = {
  id: number;
  code: string;
  raw: string;
  basis: string;
  status: string;
  rows: number;
};
export type Catalog = {
  manifest: string;
  sourceId: string;
  languages: Language[];
  languageGroups?: Record<string, string[]>;
  bundles: { id: number; path: string | null }[];
  total: number;
  formatVersion?: 2;
  searchPolicy?: {
    version: 1;
    mode: "strict-word";
    targetIndex: string;
    jsonIndex: string;
  };
  // Internal startup binding, never selected from HTTP parameters.
  durableSchema?: string;
  contextIndex?: { version: 1; schema: string; manifest: string };
};

// Optional additive sidecar; never placed inside the ten-table source schema.
export function contextIndexSchema(schema: string) {
  validateDurableSchema(schema);
  return schema.replace(/^localization_/, "context_");
}

export async function loadContextIndex(
  query: Query,
  schema: string,
  catalog: Catalog,
) {
  validateCatalogSchema(schema, catalog);
  const sidecar = contextIndexSchema(schema);
  const [exists] = await query("SELECT to_regnamespace($1)::text AS name", [
    sidecar,
  ]);
  if (!exists?.name) return undefined;
  const fail = () => {
    throw new Error(`Invalid or unverified context index: ${sidecar}`);
  };
  const tables = await query(
    `SELECT c.relname AS name,c.relpersistence AS persistence
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('r','p','f') ORDER BY c.relname`,
    [sidecar],
  );
  if (
    tables.length !== 2 || tables[0].name !== "member" ||
    tables[1].name !== "metadata" ||
    tables.some((t) => t.persistence !== "p")
  ) fail();
  const rows = await query(
    `SELECT version,source_schema,manifest_sha256,source_id,source_rows::text,member_rows::text,status FROM ${sidecar}.metadata`,
  );
  const m = rows[0];
  if (
    rows.length !== 1 || m.version !== 1 || m.source_schema !== schema ||
    m.manifest_sha256 !== catalog.manifest ||
    m.source_id !== catalog.sourceId ||
    Number(m.source_rows) !== catalog.total || m.status !== "verified" ||
    !Number.isSafeInteger(Number(m.member_rows)) || Number(m.member_rows) < 0 ||
    Number(m.member_rows) > catalog.total
  ) fail();
  const indexes = await query(
    `SELECT c.relname AS name,i.indisprimary AS primary_key,
    pg_get_indexdef(i.indexrelid,1,true) AS first,
    pg_get_indexdef(i.indexrelid,2,true) AS second,
    pg_get_indexdef(i.indexrelid,3,true) AS third,i.indnkeyatts AS keys
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_am a ON a.oid=c.relam
    WHERE n.nspname=$1 AND t.relname='member' AND a.amname='btree'
    AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL`,
    [sidecar],
  );
  if (
    !indexes.some((i) =>
      i.primary_key && Number(i.keys) === 1 && i.first === "occurrence_id"
    ) ||
    !indexes.some((i) =>
      Number(i.keys) === 3 && i.first === "context_id" &&
      i.second === "language_id" && i.third === "occurrence_id"
    )
  ) fail();
  return { version: 1 as const, schema: sidecar, manifest: catalog.manifest };
}

export async function loadStrictSearchPolicy(
  query: Query,
  schema: string,
  catalog?: Catalog,
): Promise<NonNullable<Catalog["searchPolicy"]>> {
  validateCatalogSchema(schema, catalog);
  const indexes = await query(
    `SELECT c.relname AS name, pg_get_indexdef(i.indexrelid,1,true) AS column_name FROM pg_index i
    JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_am a ON a.oid=c.relam
    WHERE n.nspname=$1 AND t.relname='occurrence' AND a.amname='pgroonga'
    AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
    AND i.indnkeyatts=1 AND pg_get_indexdef(i.indexrelid,1,true) IN ('target_text','target_json')`,
    [schema],
  );
  const indexFor = (column: string) => {
    const found = indexes.filter((i) => i.column_name === column);
    if (
      found.length !== 1 ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(String(found[0].name))
    ) {
      throw new Error(
        `Expected exactly one valid ${column} full-text index; apply structured-search migration before starting the API`,
      );
    }
    return String(found[0].name);
  };
  return {
    version: 1,
    mode: "strict-word",
    targetIndex: indexFor("target_text"),
    jsonIndex: indexFor("target_json"),
  };
}

function validateSearchPolicy(catalog: Catalog) {
  const p = catalog.searchPolicy;
  if (
    p &&
    (p.version !== 1 || p.mode !== "strict-word" ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(p.targetIndex) ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(p.jsonIndex))
  ) {
    throw new Error("Invalid search policy");
  }
}

export function validateSchema(schema: string) {
  if (!/^ipsw_trial_[a-z0-9_]{1,40}$/.test(schema)) {
    throw new Error("Invalid trial schema");
  }
  return schema;
}

function validateDurableSchema(schema: string) {
  if (!/^localization_[a-z0-9_]{1,40}$/.test(schema)) {
    throw new Error("Invalid durable schema");
  }
  return schema;
}

export function validateCatalogSchema(
  schema: string,
  catalog?: Pick<Catalog, "durableSchema">,
) {
  if (catalog?.durableSchema !== undefined) {
    if (catalog.durableSchema !== schema) {
      throw new Error("Durable catalog/schema mismatch");
    }
    return validateDurableSchema(schema);
  }
  return validateSchema(schema);
}

export async function loadCatalog(
  query: Query,
  schema: string,
  options: { durableManifest?: string } = {},
): Promise<Catalog> {
  const durable = options.durableManifest !== undefined;
  if (durable) {
    validateDurableSchema(schema);
    if (!/^[a-f0-9]{64}$/.test(options.durableManifest!)) {
      throw new Error("Invalid pinned package manifest");
    }
    const tables = await query(
      `SELECT c.relname AS name,c.relpersistence AS persistence
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind IN ('r','p','f') ORDER BY c.relname`,
      [schema],
    );
    const expected = [
      "bundle",
      "issue",
      "language",
      "occurrence",
      "package",
      "quarantine",
      "resource",
      "resource_table",
      "source",
      "symlink",
    ];
    if (
      tables.length !== expected.length ||
      tables.some((t, i) => t.name !== expected[i] || t.persistence !== "p")
    ) {
      throw new Error(
        "Durable schema must contain exactly the ten logged occurrence tables",
      );
    }
  } else validateSchema(schema);
  const [pkg] = await query(
    `SELECT manifest_sha256, report_json, catalog_json FROM ${schema}.package WHERE id=1`,
  );
  if (!pkg) throw new Error("Missing occurrence package");
  if (durable && pkg.manifest_sha256 !== options.durableManifest) {
    throw new Error("Pinned package manifest mismatch");
  }
  const catalog = JSON.parse(String(pkg.catalog_json));
  const report = JSON.parse(String(pkg.report_json));
  validateOccurrencePackage(report);
  if (report.sourceId !== catalog.sourceId) {
    throw new Error("Source catalog mismatch");
  }
  const languages = await query(
    `SELECT id, code, raw, basis, status, expected_rows::text AS rows FROM ${schema}.language ORDER BY id`,
  );
  const bundles = await query(
    `SELECT id, path FROM ${schema}.bundle ORDER BY id`,
  );
  return {
    ...(durable ? { durableSchema: schema } : {}),
    manifest: String(pkg.manifest_sha256),
    sourceId: catalog.sourceId,
    ...(report.formatVersion === 2 ? { formatVersion: 2 as const } : {}),
    languages: languages.map((l) => ({
      ...l,
      rows: Number(l.rows),
    })) as Language[],
    bundles: bundles as Catalog["bundles"],
    total: languages.reduce((n, l) => n + Number(l.rows), 0),
  };
}

class BadRequest extends Error {}
function integer(value: string | null, fallback: number) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new BadRequest("Invalid pagination");
  }
  return Math.max(1, Number(value));
}
function plainText(value: string) {
  return !value.includes("\0") && value.isWellFormed();
}
function basename(path: string | null) {
  return path?.split("/").at(-1) ?? "";
}

export type GroupSelection = (
  parts: { selected: string; from: string; scope: string; schema?: string },
) => string;

// Match the complete identity as a set, rather than testing every key in a table.
// The null flag distinguishes ordinary JSON-looking text from JSON-encoded text.
export const groupIdentitySelection: GroupSelection = (
  { selected, from, scope, schema },
) => {
  // Materialize before membership testing: otherwise the planner can place the
  // group comparison inside a repeated resource index lookup and repeat it per key.
  const broad = `SELECT ${selected} ${from} WHERE ${scope}
       AND r.table_id IN (SELECT table_id FROM matched)`;
  const identity = `EXISTS (SELECT 1 FROM matched)
       AND EXISTS (SELECT 1 FROM matched g WHERE g.table_id = o.table_id
       AND (g.key_text IS NULL) = (o.key_text IS NULL)
       AND COALESCE(g.key_text, g.key_json) COLLATE "C" = COALESCE(o.key_text, o.key_json) COLLATE "C")`;
  if (!schema) {
    return `WITH candidates AS MATERIALIZED (${broad})
       SELECT o.* FROM candidates o WHERE ${identity}`;
  }
  // Row counts only select an access path; they never determine the answer.
  // For a small resource set, use the existing (resource_id, resource_ordinal)
  // index. OFFSET 0 keeps the resource-correlated lookup from being flattened
  // back into a full occurrence scan. Large sets retain the broad scan plan.
  const resources = `candidate_resources AS MATERIALIZED (
       SELECT r.id, r.table_id, r.bundle_id, r.expected_rows FROM ${schema}.resource r
       WHERE r.table_id IN (SELECT table_id FROM matched)),
       lookup_strategy AS MATERIALIZED (
       SELECT COALESCE(sum(expected_rows), 0) <= 20000 AS narrow FROM candidate_resources),`;
  const narrow = `SELECT ${selected}
       FROM candidate_resources r JOIN LATERAL (
         SELECT o.id, o.resource_id, o.language_id, o.key_text, o.key_json
         FROM ${schema}.occurrence o WHERE o.resource_id = r.id OFFSET 0
       ) o ON true JOIN ${schema}.language l ON l.id = o.language_id
       WHERE (SELECT narrow FROM lookup_strategy) AND ${scope}`;
  // Union only the final matching rows, not millions of broad candidates.
  return `WITH ${resources}
       narrow_candidates AS MATERIALIZED (${narrow}),
       candidates AS MATERIALIZED (${broad} AND NOT (SELECT narrow FROM lookup_strategy))
       SELECT o.* FROM narrow_candidates o WHERE ${identity}
       UNION ALL
       SELECT o.* FROM candidates o WHERE ${identity}`;
};

export function buildSearch(
  schema: string,
  catalog: Catalog,
  params: URLSearchParams,
  advanced: boolean,
  // Internal SQL-comparison seam; never selected by an HTTP parameter.
  groupSelection: GroupSelection = groupIdentitySelection,
  options: { countOnly?: boolean } = {},
) {
  validateCatalogSchema(schema, catalog);
  validateSearchPolicy(catalog);
  if (
    catalog.contextIndex && (catalog.contextIndex.version !== 1 ||
      catalog.contextIndex.schema !== contextIndexSchema(schema) ||
      catalog.contextIndex.manifest !== catalog.manifest)
  ) throw new Error("Invalid context index binding");
  const args: unknown[] = [];
  const bind = (value: unknown) => {
    args.push(value);
    return `$${args.length}`;
  };
  const page = integer(params.get("page"), 1),
    size = Math.min(200, integer(params.get("size"), 200));
  const offset = (page - 1) * size;
  if (!Number.isSafeInteger(offset)) throw new BadRequest("Page is too large");
  const names = params.getAll("l");
  // Optional exact codes are separate from legacy group aliases (English, etc.).
  const exactCodes = params.getAll("locale");
  const groups = catalog.languageGroups ?? languageMapping;
  const codes = new Set(
    names.flatMap((name) =>
      Object.hasOwn(groups, name) ? groups[name] : [name]
    ),
  );
  for (const code of exactCodes) codes.add(code);
  const languages = catalog.languages.filter((l) =>
    (!names.length && !exactCodes.length) || codes.has(l.code)
  ).map((l) => l.id);
  let emptyScope = languages.length === 0;
  const languageFilter = `o.language_id = ANY(${bind(languages)}::smallint[])`;
  const conditions = [languageFilter];
  const scope = [languageFilter];
  let fullTextMatch: string | undefined;
  const q = params.get("q") ?? "",
    bundle = params.get("b"),
    bundlePath = params.get("bundle_path");
  if (q.length > 4096) throw new BadRequest("Query is too long");
  // The old advanced endpoint ignores b. A new bundle_path filter is explicit in both modes.
  if ((!advanced && bundle) || bundlePath) {
    const ids = catalog.bundles.filter((b) =>
      (!bundlePath || b.path === bundlePath) &&
      (advanced || !bundle || basename(b.path) === bundle)
    ).map((b) => b.id);
    emptyScope ||= ids.length === 0;
    const bundleFilter = `r.bundle_id = ANY(${bind(ids)}::integer[])`;
    conditions.push(bundleFilter);
    scope.push(bundleFilter);
  }
  if (advanced) {
    if (!q) throw new BadRequest("q is required");
    const field = params.get("c"), operator = params.get("o");
    if (!["equal", "notEqual", "startsWith"].includes(operator ?? "")) {
      throw new BadRequest("Invalid operator");
    }
    if (field === "key" || field === "localization") {
      const column = field === "key" ? "key" : "target";
      if (field === "localization") conditions.push("o.target_kind = 'text'");
      if (operator === "startsWith") {
        if (!plainText(q)) {
          throw new BadRequest(
            "Prefix search requires PostgreSQL-compatible text",
          );
        }
        conditions.push(
          `o.${column}_text LIKE ${bind(q.replace(/[\\%_]/g, "\\$&") + "%")}`,
        );
      } else {
        const op = operator === "equal" ? "=" : "<>";
        const normal = plainText(q);
        // Fallback text contains NUL/unpaired surrogates, so it cannot equal a normal query.
        // Keeping normal equality on the text column alone preserves its index access path.
        if (normal) {
          const text = `o.${column}_text ${op} ${bind(q)}`;
          conditions.push(
            operator === "equal"
              ? text
              : `(${text} OR o.${column}_text IS NULL)`,
          );
        } else {
          const fallback =
            `(o.${column}_text IS NULL AND o.${column}_json ${op} ${
              bind(JSON.stringify(q))
            })`;
          conditions.push(
            operator === "equal"
              ? fallback
              : `(o.${column}_text IS NOT NULL OR ${fallback})`,
          );
        }
      }
    } else {
      const fields: Record<string, string> = {
        language: "l.code",
        file:
          "regexp_replace(r.metadata_json::json->'original'->>'imagePath', '^.*/', '')",
        bundle: `COALESCE(r.metadata_json::json->'${
          catalog.formatVersion === 2 ? "effective" : "original"
        }'->>'bundleName', '')`,
      };
      if (!field || !Object.hasOwn(fields, field) || !plainText(q)) {
        throw new BadRequest("Invalid field or text");
      }
      const op = operator === "equal"
        ? "="
        : operator === "notEqual"
        ? "<>"
        : "LIKE";
      conditions.push(
        `${fields[field]} ${op} ${
          bind(
            operator === "startsWith" ? q.replace(/[\\%_]/g, "\\$&") + "%" : q,
          )
        }`,
      );
    }
  } else {
    if (!q && !bundle && !bundlePath) {
      throw new BadRequest("q or a bundle filter is required");
    }
    if (q) {
      if (!plainText(q)) {
        throw new BadRequest(
          "Full-text search requires PostgreSQL-compatible text",
        );
      }
      const keyword = bind(q);
      const match = (column: string, index?: string) =>
        catalog.searchPolicy
          ? `o.${column} &@ pgroonga_condition(${keyword}, index_name => ${
            bind(index)
          })`
          : `o.${column} &@ ${keyword}`;
      // Each storage column has its own index. Do not COALESCE/cast per row:
      // that would bypass existing indexes and can reject lossless JSON values.
      fullTextMatch = `(${
        match("target_text", catalog.searchPolicy?.targetIndex)
      } OR ${match("target_json", catalog.searchPolicy?.jsonIndex)})`;
      // An unrestricted FTS result can be large. Keep its original parallel
      // plan unless a resource filter risks repeating the bitmap per resource.
      if (!bundle && !bundlePath) {
        conditions.push(fullTextMatch);
        fullTextMatch = undefined;
      }
    }
  }
  const from =
    `FROM ${schema}.occurrence o JOIN ${schema}.resource r ON r.id=o.resource_id JOIN ${schema}.language l ON l.id=o.language_id`;
  const order =
    'table_id, key_text COLLATE "C" NULLS LAST, key_json COLLATE "C" NULLS LAST, language COLLATE "C", id';
  const selected =
    "o.id, r.table_id, o.key_text, o.key_json, l.code AS language";
  const context = !advanced && groupSelection === groupIdentitySelection
    ? catalog.contextIndex
    : undefined;
  // Context is table + exact key, not merely key text. A table already scopes bundle, source and format.
  const eligible = advanced
    ? `SELECT ${selected} ${from} WHERE ${conditions.join(" AND ")}`
    : context
    ? `SELECT ${selected}
      FROM matched g JOIN ${context.schema}.member m ON m.context_id=g.context_id
      JOIN LATERAL (
        SELECT o.id,o.resource_id,o.language_id,o.key_text,o.key_json
        FROM ${schema}.occurrence o WHERE o.id=m.occurrence_id OFFSET 0
      ) o ON true
      JOIN ${schema}.resource r ON r.id=o.resource_id
      JOIN ${schema}.language l ON l.id=o.language_id
      WHERE ${scope.join(" AND ").replaceAll("o.language_id", "m.language_id")}`
    : groupSelection({ selected, from, scope: scope.join(" AND "), schema });
  // Evaluate fulltext once, before joining resources. Without this boundary a
  // bundle-filtered plan can rebuild the same FTS bitmap for every resource.
  const matchedFrom = fullTextMatch
    ? `FROM search_hits o JOIN ${schema}.resource r ON r.id=o.resource_id JOIN ${schema}.language l ON l.id=o.language_id`
    : from;
  const sql = `WITH ${
    fullTextMatch
      ? `search_hits AS MATERIALIZED (
    SELECT o.id, o.resource_id, o.language_id, o.key_text, o.key_json
    FROM ${schema}.occurrence o WHERE ${languageFilter} AND ${fullTextMatch}
  ),`
      : ""
  }${
    advanced ? "" : `matched AS MATERIALIZED (
    SELECT DISTINCT ${
      context
        ? `(SELECT m.context_id FROM ${context.schema}.member m WHERE m.occurrence_id=o.id) AS context_id`
        : "r.table_id, o.key_text, o.key_json"
    } ${matchedFrom} WHERE ${conditions.join(" AND ")}
  ),`
  } eligible AS MATERIALIZED (${eligible}),
  page AS MATERIALIZED (SELECT * FROM eligible ORDER BY ${order} LIMIT ${
    bind(options.countOnly ? 0 : size)
  } OFFSET ${bind(offset)})
  SELECT (SELECT count(*)::text FROM eligible) AS total,
    COALESCE((SELECT json_agg(detail ORDER BY detail.table_id, detail.key_text COLLATE "C" NULLS LAST,
      detail.key_json COLLATE "C" NULLS LAST, detail.language COLLATE "C", detail.id)
      FROM (SELECT p.*, o.target_kind, o.target_text, o.target_json,
        r.resource_id, r.status AS resource_status, r.metadata_json,
        l.raw AS language_raw, l.basis AS language_basis, l.status AS language_status,
        b.path AS bundle_path, t.table_id AS table_identity
        FROM page p JOIN ${schema}.occurrence o ON o.id=p.id
        JOIN ${schema}.resource r ON r.id=o.resource_id
        JOIN ${schema}.language l ON l.id=o.language_id
        JOIN ${schema}.bundle b ON b.id=r.bundle_id
        LEFT JOIN ${schema}.resource_table t ON t.id=r.table_id) detail), '[]'::json)::text AS rows_json`;
  // Expose an impossible scope only after all request validation has succeeded.
  return { sql, args, size, emptyScope, offsetArgumentIndex: args.length - 1 };
}

export function presentRow(row: Record<string, unknown>, formatVersion = 1) {
  const metadata = JSON.parse(String(row.metadata_json));
  const resource = effectiveResource(metadata, {
    formatVersion,
    sourceId: metadata.sourceId,
  });
  if (
    formatVersion === 2 &&
    (resource.bundlePath !== row.bundle_path ||
      metadata.resourceId !== row.resource_id)
  ) {
    throw new Error("Corrected resource/source join mismatch");
  }
  const source = row.key_text ?? JSON.parse(String(row.key_json));
  const value = row.target_text ?? JSON.parse(String(row.target_json));
  return {
    id: Number(row.id),
    group_id: JSON.stringify([row.table_identity, source]),
    source,
    target: row.target_kind === "text" ? value : JSON.stringify(value),
    language: row.language,
    file_name: basename(metadata.original.imagePath),
    bundle_name: resource.bundleName ?? "",
    target_kind: row.target_kind,
    target_value: value,
    provenance: {
      source_id: metadata.sourceId,
      table_id: row.table_identity,
      resource_id: row.resource_id,
      resource_status: row.resource_status,
      image_path: metadata.original.imagePath,
      resource_path: resource.resourcePath,
      bundle_path: row.bundle_path,
      bundle_assignment: resource.bundleAssignment ?? null,
      bundle_evidence: resource.bundleEvidence ?? null,
      ...(formatVersion === 2
        ? {
          original: metadata.original,
          ownership_correction: metadata.ownershipCorrection,
        }
        : {}),
      sha256: metadata.original.sha256,
      language: {
        raw: row.language_raw,
        basis: row.language_basis,
        status: row.language_status,
      },
      language_evidence: metadata.supplement?.languageEvidence ?? null,
    },
  };
}
