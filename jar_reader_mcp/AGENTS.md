# Repository Guidelines

## Project Structure & Module Organization

This Node.js 18+ TypeScript package is an MCP server. `src/index.ts` registers the eight `jar_*` tools and owns server state; `src/jar-reader.ts` contains archive reading, search, normalization, and caching. TypeScript compiles to ignored `dist/`. Tests are ESM under `test/`: `jar-reader.test.mjs` covers the reader, `server.test.mjs` exercises MCP transport, and `test/helpers/` creates temporary ZIP fixtures. `mcp_config_template.json` is an example host configuration. Read `CLAUDE.md` before changing streams, nested JARs, caching, or tool semantics.

## Build, Test, and Development Commands

- `npm install` installs the locked dependencies.
- `npm run build` runs strict TypeScript compilation and emits `dist/`.
- `npm test` builds first, then runs all `test/**/*.test.mjs` files with `node:test`.
- `npm run watch` recompiles TypeScript while editing.
- `npm start` starts the compiled stdio MCP server.
- `npm run inspector` opens the MCP Inspector against `dist/index.js`.

Tests import compiled files, so build before invoking `node --test` directly. On Windows, use `node --test "test/**/*.test.mjs"`; the directory form is unreliable.

## Coding Style & Naming Conventions

Use two-space indentation, single quotes, semicolons, multiline trailing commas, and explicit exported types. Name functions and variables in `camelCase`, classes and interfaces in `PascalCase`, and limits in `UPPER_SNAKE_CASE`. Keep MCP schemas and handlers in `src/index.ts`; keep archive mechanics in `JarReader`. No formatter or linter is configured, so `npm run build` is the static check. Send diagnostics to stderr; stdout is reserved for MCP.

## Testing Guidelines

Use `node:test` with `node:assert/strict`. Name files `*.test.mjs`, group cases with `describe`, and describe observable behavior. Cover malformed archives, path variants, byte caps, handle cleanup, and stored versus deflated entries when relevant. Build fixtures in memory or temporary directories and clean them in hooks; do not commit binary JARs. No coverage threshold is configured, but behavior changes require focused unit or end-to-end tests.

## Commit & Pull Request Guidelines

Use concise, imperative subjects such as `Fix capped reads for stored entries`; keep commits focused. Pull requests should explain behavior, list verification commands, and link the issue. Highlight schema, limit, cache, or compatibility changes. Include MCP Inspector output for tool-contract changes; screenshots are needed only for external UI behavior.

## Security & Configuration

Preserve read-size limits and binary detection. Avoid logging contents or protocol messages. Use `JAR_READER_DEBUG=1` only for stderr diagnostics, and keep local paths and secrets out of committed configuration.
