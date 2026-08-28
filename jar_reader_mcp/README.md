# jar_reader_mcp

An MCP (Model Context Protocol) server that enables AI tools to read source code and other files from third-party JAR files, similar to how you read local source code.

## Features

- **Open and explore JAR files**: List entries with wildcard filters and pagination
- **Read file contents**: Full contents or line ranges of large files, with binary detection
- **Search files by name**: Safe wildcard patterns (`*Service*.java`, `com/example/*`)
- **Search file contents**: Line-by-line regex search with result caps
- **Find classes by name**: Resolve `com.example.Service` (FQCN), simple names, or nested classes to their files
- **Multiple JARs at once**: Open several JARs and address each by path in every tool call
- **Nested JAR support**: Open JARs inside JARs (e.g. Spring Boot `BOOT-INF/lib/*.jar`) with the `outer.jar!/inner.jar` syntax
- **Robustness**: Byte caps on reads (zip-bomb guard), LRU content cache, bounded file handles, clear errors for invalid patterns

Designed for `-sources.jar` files; does not decompile bytecode.

## Requirements

- Node.js 20 or newer
- An MCP client with local stdio-server support

## Installation

The recommended setup uses `npx`, so no global installation is required. Pin the version for reproducible agent configuration:

```bash
npx -y jar_reader_mcp@0.2.0
```

The command starts an MCP stdio server and waits for its client; configure it in an MCP host instead of running it as an interactive CLI. A global installation is also available:

```bash
npm install -g jar_reader_mcp
```

## Build and Test

```bash
npm run build       # Compile TypeScript (tsc)
npm test            # Build + run the test suite (node:test, no extra deps)
npm run watch       # Watch mode (tsc --watch)
npm start           # Run the MCP server
npm run inspector   # Test with MCP Inspector
```

## MCP Client Setup

### Codex

Register the published package directly:

```bash
codex mcp add jar_reader_mcp -- npx -y jar_reader_mcp@0.2.0
codex mcp list
```

Restart Codex or begin a new task after registration.

### Other MCP Clients

Add this stdio server to the client's MCP configuration:

```json
{
  "mcpServers": {
    "jar_reader_mcp": {
      "command": "npx",
      "args": ["-y", "jar_reader_mcp@0.2.0"]
    }
  }
}
```

On Windows, use `"command": "npx.cmd"` if the client cannot resolve `npx`. With a global installation, use `"command": "jar_reader_mcp"` and an empty `args` array.

Set the `JAR_READER_DEBUG=1` environment variable to log tool calls and timing to stderr.

## Available Tools

All tools accept an optional `jarPath` argument to target a specific open JAR; without it, the most recently opened JAR is used.

### jar_open

Open a JAR file for reading. Must be called before other operations.

- `jarPath` (string, required): Absolute path to the JAR. Nested JARs use the `outer.jar!/BOOT-INF/lib/inner.jar` syntax (multiple levels allowed).

### jar_close

Close open JAR(s) and release handles and caches.

- `jarPath` (string, optional): JAR to close (defaults to the current one)
- `all` (boolean, optional): Close every open JAR

### jar_list_files

List entries, optionally filtered by wildcard pattern. Returns a page of results.

- `filter` (string, optional): Wildcard path filter, e.g. `"com/example/*.java"` — `*` matches anything (including `/`), `?` matches one non-slash character, everything else matches literally
- `offset` (number, optional, default 0): First entry to return (0-based)
- `limit` (number, optional, default 500): Maximum entries to return (max 2000)

### jar_read_file

Read the content of a file in the JAR. Backslash paths are accepted and lookup falls back to case-insensitive matching.

- `filePath` (string, required): Path inside the JAR, e.g. `"com/example/Service.java"`
- `startLine` / `endLine` (number, optional): 1-based inclusive line range for reading slices of large files
- `maxBytes` (number, optional): Byte cap for the read (default 10 MB)

Binary files are detected and reported instead of dumped.

### jar_search_files

Search file paths by wildcard pattern.

- `pattern` (string, required): e.g. `"*Service*.java"`
- `caseSensitive` (boolean, optional, default false)
- `limit` (number, optional, default 200): Maximum files to return (max 1000)

### jar_search_content

Search file contents line by line with a regular expression.

- `pattern` (string, required): Regex matched against each line
- `fileExtensions` (string[], optional, default `[".java", ".kt", ".scala", ".groovy", ".xml", ".properties", ".yml", ".yaml", ".json", ".gradle", ".sql", ".md", ".txt"]`): Extensions to search; `[]` searches all files (binaries are skipped). Matching is case-insensitive.
- `caseSensitive` (boolean, optional, default false)
- `maxResults` (number, optional, default 100): Maximum matches (max 1000)
- `filter` (string, optional): Wildcard filter on file paths, applied before searching

### jar_get_file_info

Get metadata (path, size, type) for one entry.

- `filePath` (string, required): Path inside the JAR

### jar_find_class

Resolve a class name to its source/class files.

- `className` (string, required): FQCN (`"com.example.Service"`), simple name (`"Service"`), nested class (`"com.example.Service$Inner"`), or entry path (`"com/example/Service.java"`)

## Usage Examples

### Reading Java source code from a sources.jar

```
jar_open: { "jarPath": "/path/to/library-1.0.0-sources.jar" }
jar_find_class: { "className": "com.example.UserService" }
jar_read_file: { "filePath": "com/example/UserService.java" }
jar_search_content: { "pattern": "@Override", "filter": "com/example/*" }
jar_close: {}
```

### Exploring a Spring Boot fat JAR

```
jar_open: { "jarPath": "/path/to/application.jar" }
jar_list_files: { "filter": "BOOT-INF/lib/*.jar" }
jar_open: { "jarPath": "/path/to/application.jar!/BOOT-INF/lib/spring-core-6.1.0.jar" }
jar_find_class: { "className": "org.springframework.core.env.Environment", "jarPath": "/path/to/application.jar!/BOOT-INF/lib/spring-core-6.1.0.jar" }
jar_close: { "all": true }
```

### Reading a slice of a large file

```
jar_open: { "jarPath": "/path/to/big-sources.jar" }
jar_read_file: { "filePath": "com/example/Generated.java", "startLine": 100, "endLine": 150 }
```

## Use Cases

1. **Understanding third-party libraries**: Explore source code of libraries you use in your project
2. **Debugging**: Read source code when stepping through third-party code
3. **API exploration**: Find classes and endpoints in library sources
4. **Configuration analysis**: Examine configuration files in third-party JARs

## Limitations

- **Read-only**: Cannot modify files in JAR archives
- **Source code required**: For Java files, you need `-sources.jar` files. Regular `.jar` files contain compiled bytecode, not source code.
- **No decompilation**: This server does not decompile bytecode (`.class` files are reported as binary). Use a decompiler first if needed.

## Troubleshooting

- **"No JAR file is currently open"** — call `jar_open` before other tools.
- **"File not found in JAR"** — paths must match how they are stored; use `jar_list_files` to see exact paths. Backslash paths and different casing are tolerated.
- **"Not a valid JAR/ZIP file"** — the path exists but is not a ZIP/JAR archive.
- **Empty search results** — try broader patterns; for content search check the `fileExtensions` list (or pass `[]` for all files).
- **Large JARs are slow to search** — narrow the search with `filter`, lower `maxResults`, or raise `JAR_READER_DEBUG=1` to see timing.

## Development

### Project Structure

```
jar_reader_mcp/
├── src/
│   ├── index.ts        # MCP server entry point (tool registration)
│   └── jar-reader.ts   # JAR reading, searching, caching
├── test/
│   ├── jar-reader.test.mjs   # Unit tests
│   ├── server.test.mjs       # End-to-end tests via in-memory transport
│   └── helpers/              # Test fixture ZIP builder
├── package.json
├── tsconfig.json
└── README.md
```

### Dependencies

- `@modelcontextprotocol/sdk` — MCP SDK for TypeScript
- `yauzl` — ZIP/JAR file parsing
- `zod` — tool input validation

## License

MIT
