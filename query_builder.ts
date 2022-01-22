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

    const selecteStatement = `
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

    if (searchWord) {
      return `
        ${selecteStatement}
            WHERE
              ${bundle ? `bundle_name = $bundle AND` : ""}
              language in (${langCondition}) AND
              target &@ $searchWord
            )
            ${orderBy}
        ${range}
        ;
        `;
    } else {
      return `
        ${selecteStatement}
            WHERE
              bundle_name = ${bundle ? "$bundle" : "'UIKitCore.framework'"} AND
              language in (${langCondition})
            )
        ${orderBy}
        ${range}
        ;
        `;
    }
  }
}
