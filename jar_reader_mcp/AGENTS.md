# Repository Guidelines

## Scope and Project Structure

This package is a Node.js 20+ TypeScript MCP server for exploring source and resource files in JAR/ZIP archives. It provides eight `jar_*` tools, supports multiple and nested JARs, and intentionally does not decompile bytecode.

- `src/index.ts` registers MCP tools, validates inputs with zod, formats tool results, and owns the open-JAR registry.
- `src/jar-reader.ts` implements archive opening, reads, search, path normalization, caching, and class lookup.
- `test/jar-reader.test.mjs` covers reader behavior; `test/server.test.mjs` drives the server through `InMemoryTransport`.
- `test/helpers/` builds ZIP fixtures in memory and temporary directories. Keep binary fixtures out of Git.
- `dist/` is generated and ignored. `mcp_config_template.json` is an example stdio-host configuration.

## Architecture Invariants

`buildServer()` creates the high-level `McpServer` used by tests; `main()` connects one `StdioServerTransport` only when `dist/index.js` is executed directly. `withErrors()` converts handler exceptions into MCP `isError` results. Diagnostics belong on stderr because stdout is reserved for the MCP protocol.

The multi-JAR registry is keyed by disk path or a nested label such as `outer.jar!/BOOT-INF/lib/inner.jar`. Each tool accepts an optional `jarPath`; omission selects `currentJarKey`, the most recently opened archive. Keep `jar_close` able to close one archive, the current archive, or all archives.

Each `JarReader` holds one yauzl `ZipFile` with `autoClose: false`. `open()` scans entries once into an array and lookup map; `close()` must release the handle and clear cached bytes. Nested archives are loaded through `readRaw()` and `yauzl.fromBuffer()`.

The per-reader LRU cache is capped at 64 MB and caches only files up to 16 MB. Normal reads default to a 10 MB cap; truncated reads are not cached, and `readRaw()` rejects oversized entries. Preserve these limits as zip-bomb and memory safeguards.

## Tool and Pattern Semantics

The expected lifecycle is:

```text
jar_open → [list | read | search | info | find class]* → jar_close
```

All tools except `jar_open` and `jar_close` require an open archive. Path filters use safe wildcards: `*` matches any run including `/`, `?` matches one non-slash character, and every other character is literal. Content search uses a regular expression compiled without `g`; a global regex advances `lastIndex` and can skip matching lines. `normalizeEntryPath()` converts backslashes, strips leading `/` and `./`, and removes a trailing slash. Exact lookup falls back to case-insensitive matching.

## Build, Test, and Development Commands

- `npm install` installs the locked dependencies.
- `npm run build` runs strict TypeScript compilation and emits `dist/`.
- `npm test` builds first, then runs `node:test` against `test/**/*.test.mjs`.
- `npm run watch` recompiles while editing.
- `npm start` runs the compiled stdio server.
- `npm run inspector` launches MCP Inspector against `dist/index.js`.

Tests import `dist/`, so build before invoking Node directly. On Windows use `node --test "test/**/*.test.mjs"`; the directory form `node --test test` is unreliable.

## Coding and Naming Conventions

Use two-space indentation, single quotes, semicolons, multiline trailing commas, and explicit exported types. Name functions and variables in `camelCase`, classes and interfaces in `PascalCase`, and constants in `UPPER_SNAKE_CASE`. Keep MCP schemas and handlers in `src/index.ts`; keep archive mechanics in `JarReader`. No formatter or linter is configured, so `npm run build` is the static check.

## Testing Guidelines

Use `node:test` with `node:assert/strict`. Name files `*.test.mjs`, group related cases with `describe`, and describe observable behavior. Add focused coverage for malformed archives, wildcard and regex semantics, path variants, nested JARs, byte caps, cache cleanup, and handle cleanup. Exercise both stored and deflated entries for stream changes. Clean temporary directories in hooks.

For capped streams, settle the read promise before calling `readStream.destroy()`. Stored entries expose fd-slicer's raw stream, whose `destroy()` may synchronously emit an error; deflated entries use yauzl's wrapper. Keep regression coverage for both paths. Retain `strictFileNames: false` and yauzl's default entry-size validation unless a tested compatibility change requires otherwise.

## Compatibility and Configuration

The server version is read from `package.json` at runtime with `createRequire`; keep package metadata out of `src/`. `@types/yauzl` 2.x describes the yauzl 3.x surface used here and is intentionally compatible for the current calls. Use `JAR_READER_DEBUG=1` only for stderr diagnostics. Keep secrets and machine-specific paths out of committed configuration.

## Commit and Pull Request Guidelines

Use concise imperative subjects such as `Fix capped reads for stored entries`, and keep commits focused. Pull requests should explain behavior, list meaningful verification, and link relevant issues. Highlight schema, limit, cache, stream, or compatibility changes. Include MCP Inspector output for tool-contract changes; screenshots are useful only for external UI behavior.
