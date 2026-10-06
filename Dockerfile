# syntax=docker/dockerfile:1
# Public dependencies only: a clean clone needs no npm or Font Awesome token.
FROM node:24-bookworm-slim AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY webpack.*.js ./
COPY frontend ./frontend
RUN npm run prod

FROM denoland/deno:2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432
WORKDIR /app
COPY package.json deno.lock ./
COPY backend ./backend
COPY skills/apple-localization ./skills/apple-localization
COPY docs/agent-access.md docs/agent-skill.md docs/llms.txt ./docs/
# Only runtime dependencies, not the collection/benchmark toolchain.
COPY scripts/package/occurrence-package.mjs scripts/package/package-ownership.mjs scripts/package/bundle-assignment.mjs scripts/package/bundle-metadata.mjs ./scripts/package/
COPY scripts/extraction/inspect-unlocalized-resources.mjs scripts/extraction/extract-mounted-bundle.mjs ./scripts/extraction/
COPY scripts/shared/localization-jsonl.mjs ./scripts/shared/
COPY scripts/database/context-index-sql.mjs scripts/database/structured-search.mjs scripts/database/database-role.mjs scripts/database/database-name.mjs ./scripts/database/
COPY deploy ./deploy
COPY --from=frontend /build/dist ./dist
RUN deno cache --node-modules-dir=none --frozen backend/main.ts deploy/setup.ts
USER deno
EXPOSE 8080
CMD ["run", "--node-modules-dir=none", "--cached-only", "--frozen", "--allow-read=/app,/release,/run/secrets/db_password", "--allow-env=RELEASE_CONFIG,CONTEXT_INDEX_MODE,RELEASE_MODE,RELEASE_DB_USER,RELEASE_SHA256,PGAPPNAME,PGDATABASE,PGHOST,PGOPTIONS,PGPASSWORD,PGPORT,PGUSER", "--allow-net=db:5432,0.0.0.0:8080", "backend/main.ts"]
