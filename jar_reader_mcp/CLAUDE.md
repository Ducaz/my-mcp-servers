# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP server that reads source code and other files from third-party JAR files (ZIP archives). Provides 8 tools for exploring, searching, and reading JAR contents, including JARs nested inside other JARs. Designed to work with `-sources.jar` files — does not decompile bytecode.

## Build and Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (tsc)
npm run watch        # Watch mode (tsc --watch)
npm start            # Run the MCP server
npm test             # Build + run the test suite (node:test, no test framework deps)
npm run inspector    # Test with MCP Inspector
```

The test suite runs against `dist/` (plain `.mjs` files), so always build before running tests directly (`node --test "test/**/*.test.mjs"`). Test fixtures are ZIP archives built at runtime by `test/helpers/zip-builder.mjs` — no binary fixtures are committed.

## Architecture

Two source files, both in `src/`:

- **src/index.ts** — MCP server entry point. Uses the high-level `McpServer` API with `registerTool` + zod input schemas. Exports `buildServer()` (used by tests via `InMemoryTransport`); `main()` runs only when the module is executed directly. Tool handlers are wrapped by `withErrors()`, which converts thrown errors into `isError` results and logs when `JAR_READER_DEBUG=1` (stderr only).

- **src/jar-reader.ts** — Core JAR reading logic. Exports `JarReader`, `wildcardToRegex()`, `normalizeEntryPath()`, and related interfaces.

### State Management

Multi-JAR model: `openJars` (Map<string, JarReader>) keyed by JAR path or nested-JAR label (`outer.jar!/BOOT-INF/lib/inner.jar`). Every tool accepts an optional `jarPath` argument; when omitted, `currentJarKey` (most recently opened) is used. `jar_close` closes one JAR, the current one, or all.

`JarReader` keeps one persistent yauzl `ZipFile` handle open for its lifetime (`autoClose: false`); `close()` releases it. All entries are scanned once during `open()` and cached (`entries` array + `entryMap`). Nested JARs are read into a Buffer via `readRaw()` and opened with `yauzl.fromBuffer`.

### Caching

`JarReader.fileCache` is a byte-capped LRU (64 MB total, files ≤ 16 MB cached) keyed by normalized entry path. Cleared on `close()`. Reads are capped at `DEFAULT_MAX_READ_BYTES` (10 MB) as a zip-bomb guard; capped reads are truncated, not cached, and `readRaw()` rejects oversized entries.

### Tool Workflow

```
jar_open → [jar_list_files | jar_read_file | jar_search_files | jar_search_content | jar_get_file_info | jar_find_class]* → jar_close
```

All tools except `jar_open`/`jar_close` fail with "No JAR file is currently open" when no JAR is open.

### Pattern Semantics

- `filter` / `pattern` on path tools: **wildcards only** — `*` (any run, including `/`), `?` (one non-slash char); all other characters literal (regex metacharacters are escaped, never crash). Built by `wildcardToRegex()`.
- `pattern` on `jar_search_content`: a **regular expression**, compiled without the `g` flag (with `g`, `.test()` advances `lastIndex` and silently skips every other matching line).
- Entry paths: `normalizeEntryPath()` converts backslashes, strips leading `/` and `./`; file lookup falls back to case-insensitive matching.

### yauzl Patterns

- One persistent `ZipFile` per open JAR; `openReadStream()` for entry data (concurrent-safe via fd-slicer refcounting).
- The byte-cap truncation path must settle its promise **before** calling `readStream.destroy()`: for stored entries the client-visible stream is fd-slicer's raw `ReadStream`, whose `destroy()` synchronously emits an error; for deflated entries yauzl wraps it with its own clean `destroy()`. Both paths are covered by tests.
- `strictFileNames: false`, `validateEntrySizes` left at default (true).

## Dependencies

- `@modelcontextprotocol/sdk` — MCP SDK for TypeScript (high-level `McpServer` API)
- `yauzl` — ZIP/JAR file parsing (callback-based)
- `zod` — tool input validation (v4; the SDK accepts v3 or v4)

## Gotchas

- `node --test test` (directory form) does not resolve on Windows in Node 24 — use the glob form `node --test "test/**/*.test.mjs"`.
- The server version string is read from `package.json` at runtime via `createRequire`; keep it out of `src/`.
- `@types/yauzl` is 2.x typings against a 3.x runtime; the used surface (open/fromBuffer/openReadStream/close/events) is compatible.
