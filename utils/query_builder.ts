export class QueryBuilder {
  build(
    fields: string[],
    languages: string[],
    groups: string[],
    table: string,
    offset?: number,
    limit?: number,
  ) {
    const langCondition = this.langCondition(languages);

    const selectStatement = `
      SELECT
        ${fields.join(", ")}
      FROM
        ${table}
      WHERE
        language in (${langCondition})
        ${groups.length > 0 ? `AND group_id in (${groups.join(", ")})` : ""}
      `;
    const orderBy = fields.includes("id")
      ? "ORDER BY id, group_id, language"
      : "";
    const range = limit !== undefined && offset !== undefined
      ? "LIMIT $limit OFFSET $offset"
      : "";

    return `
        ${selectStatement}
        ${orderBy}
        ${range}
        ;
        `;
  }

  buildGroups(
    languages: string[],
    searchWord: string | null,
    bundle: string | null,
    table: string,
  ) {
    return `
      SELECT DISTINCT
        group_id FROM ${table}
      WHERE
        ${bundle ? `bundle_name = $bundle AND` : ""}
        language in (${this.langCondition(languages)})
        ${this.searchCondition(searchWord)}
      ;
      `;
  }

  langCondition(languages: string[]) {
    return languages.map((language) => `'${language}'`).join(", ");
  }

  searchCondition(searchWord: string | null) {
    return searchWord ? "AND target &@ $searchWord" : "";
  }
}
