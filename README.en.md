# My MCP Servers

A collection of custom MCP (Model Context Protocol) servers to enhance AI tools capabilities.

## Project Overview

This project contains two complementary MCP servers:

1. **gradle-manager-mcp** - Download and manage Gradle dependency source JARs
2. **jar_reader_mcp** - Read source code and other files from JAR files

### Key Features

- Download third-party library source code
- Read and analyze code within JAR files
- Search for classes and files in JAR files
- Manage source JARs in local Gradle cache

## Quick Start

### Prerequisites

- Node.js (v20 or higher)
- npm or yarn
- (Optional) Gradle - if using Gradle CLI to download sources

### Installation Steps

1. Clone the repository
```bash
git clone https://github.com/Ducaz/my-mcp-servers.git
cd my-mcp-servers
```

2. Install dependencies and build
```bash
# Install gradle-manager-mcp
cd gradle-manager-mcp
npm install
npm run build

# Install jar_reader_mcp
cd ../jar_reader_mcp
npm install
npm run build
```

## MCP Server Configuration

`jar_reader_mcp` is published on npm and can be registered without cloning this repository:

```bash
codex mcp add jar_reader_mcp -- npx -y jar_reader_mcp@0.2.0
```

For other MCP clients, use `"command": "npx"` with `"args": ["-y", "jar_reader_mcp@0.2.0"]`. On Windows, use `npx.cmd` if the client cannot resolve `npx`.

### Claude Desktop Configuration

Add the following configuration to your Claude Desktop config file:

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "gradle-manager-mcp": {
      "command": "node",
      "args": ["D:/Projects/my-mcp-servers/gradle-manager-mcp/dist/index.js"],
      "type": "stdio"
    },
    "jar_reader_mcp": {
      "command": "npx",
      "args": ["-y", "jar_reader_mcp@0.2.0"],
      "type": "stdio"
    }
  }
}
```

**Note**: Replace the `gradle-manager-mcp` path with your local checkout path. The published `jar_reader_mcp` configuration does not require a checkout.

## Usage Guide

### Workflow

The typical workflow for using these two MCP servers together:

```
1. Use gradle_find_source to locate source JAR
2. If not found, use gradle_download_single_source to download
3. Use jar_open to open the JAR file
4. Use jar_* tools to read, search, and analyze
5. Use jar_close to close the JAR file
```

### Example: Viewing Third-Party Library Source Code

Let's say you want to view the source of `com.google.code.gson:gson:2.13.2`:

1. **Find the source**
```typescript
gradle_find_source({
  coordinate: "com.google.code.gson:gson:2.13.2",
  gradleUserHome: "D:/java/gradle_repo"
})
```

2. **If not found, download the source**
```typescript
gradle_download_single_source({
  coordinate: "com.google.code.gson:gson:2.13.2"
})
```

3. **Open the JAR file**
```typescript
jar_open({
  jarPath: "D:/java/gradle_repo/caches/modules-2/files-2.1/com.google.code.gson/gson/2.13.2/hash/gson-2.13.2-sources.jar"
})
```

4. **Search for files**
```typescript
jar_search_files({
  pattern: "*Gson*.java"
})
```

5. **Read file content**
```typescript
jar_read_file({
  filePath: "com/google/gson/Gson.java"
})
```

6. **Search code content**
```typescript
jar_search_content({
  pattern: "public class Gson",
  fileExtensions: [".java"]
})
```

7. **Close the JAR**
```typescript
jar_close()
```

## Detailed Documentation

### gradle-manager-mcp

See: [gradle-manager-mcp/README.md](gradle-manager-mcp/README.md)

**Available Tools**:
- `gradle_download_sources` - Download all sources for a Gradle project
- `gradle_download_single_source` - Download a single artifact's source
- `gradle_find_source` - Find cached source JAR
- `gradle_list_cached_sources` - List all cached sources
- `gradle_get_cache_info` - Get Gradle cache information

### jar_reader_mcp

See: [jar_reader_mcp/README.md](jar_reader_mcp/README.md)

**Available Tools**:
- `jar_open` - Open JAR file
- `jar_list_files` - List all files in JAR
- `jar_read_file` - Read specific file content
- `jar_search_files` - Search by file name
- `jar_search_content` - Search file content
- `jar_get_file_info` - Get file information
- `jar_close` - Close JAR file

## FAQ

### Q: Why do I need both MCP servers?

A:
- `gradle-manager-mcp` handles downloading and managing Gradle dependency source JARs
- `jar_reader_mcp` handles reading and analyzing contents within JAR files

Together, they allow you to conveniently view and analyze third-party library source code.

### Q: How can I customize the Gradle user directory?

A: Most tools support the `gradleUserHome` parameter to specify a custom Gradle cache path:

```typescript
gradle_find_source({
  coordinate: "com.example:lib:1.0.0",
  gradleUserHome: "/custom/path/to/gradle"
})
```

### Q: Must JAR file paths be absolute?

A: Yes, the `jar_open` tool requires absolute paths to JAR files.

### Q: Can I read compiled .class files?

A: No, `jar_reader_mcp` does not support bytecode decompilation. You need source JAR files (typically ending with `-sources.jar`).

## Tech Stack

- **TypeScript** - Primary development language
- **@modelcontextprotocol/sdk** - MCP SDK
- **axios** - HTTP requests (for downloading sources)
- **yauzl** - ZIP/JAR file parsing

## Development

### Project Structure

```
my-mcp-servers/
├── .gitignore
├── README.md
├── README.en.md
├── gradle-manager-mcp/
│   ├── src/
│   ├── dist/
│   ├── package.json
│   ├── tsconfig.json
│   └── README.md
└── jar_reader_mcp/
    ├── src/
    ├── dist/
    ├── package.json
    ├── tsconfig.json
    └── README.md
```

### Build Steps

Each subproject has its own build process:

```bash
cd gradle-manager-mcp  # or jar_reader_mcp
npm install
npm run build
```

### Testing

Each subproject can be tested independently:

```bash
cd gradle-manager-mcp  # or jar_reader_mcp
npm start
```

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Contact

For questions or suggestions, please submit an Issue or Pull Request.

---

**Note**: Ensure you use the correct absolute path when configuring MCP servers, otherwise they won't work properly.
