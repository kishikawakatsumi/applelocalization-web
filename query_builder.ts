import { bundles } from "./bundles.ts";

export class QueryBuilder {
  build(
    fields: string[],
    languages: string[],
    searchWord: string | null,
    bundle: string | null,
    offset?: number,
    limit?: number,
  ) {
    const langCondition = languages
      .map((language) => `'${language}'`)
      .join(", ");
    const range = limit !== undefined && offset !== undefined
      ? "LIMIT $limit OFFSET $offset"
      : "";

    const selectStatement = `
      SELECT
        ${fields.join(", ")}
      FROM
        localizations
      WHERE
        language in (${langCondition}) AND
        group_id in (
          SELECT DISTINCT
            group_id FROM localizations
      `;
    const orderBy = fields.includes("id")
      ? "ORDER BY id, group_id, language"
      : "";

    const searchCondition = searchWord ? "AND target &@ $searchWord" : "";
    return `
        ${selectStatement}
          WHERE
            ${bundle ? `bundle_name = $bundle AND` : ""}
            language in (${langCondition})
            ${searchCondition}
          )
        ${orderBy}
        ${range}
        ;
        `;
  }
}
