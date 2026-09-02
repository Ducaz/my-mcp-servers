# Gradle Manager MCP Server

MCP (Model Context Protocol) server for downloading and managing Gradle dependency source JARs.

## Features

- **Download sources for entire Gradle projects**: Use Gradle CLI to download all dependency sources at once
- **Download single artifact sources**: Download specific artifact sources via HTTP from Maven repositories
- **Find cached source JARs**: Locate source JARs in Gradle cache
- **List cached sources**: Browse all cached source JARs with optional filtering
- **Cache information**: Get statistics about Gradle cache directory

## Installation

```bash
cd D:/Projects/my-mcp-servers/gradle-manager-mcp
npm install
npm run build
```

## Usage

### MCP Server Configuration

Add this server to your MCP client configuration:

```json
{
  "mcpServers": {
    "gradle-manager-mcp": {
      "command": "node",
      "args": ["D:/Projects/my-mcp-servers/gradle-manager-mcp/dist/index.js"],
      "type": "stdio"
    }
  }
}
```

## Available Tools

### 1. `gradle_download_sources`

Download source JARs for all dependencies in a Gradle project using Gradle CLI.

**Parameters:**
- `projectPath` (optional): Path to Gradle project directory. Defaults to current working directory.
- `gradleUserHome` (optional): Custom Gradle user home directory. Defaults to `~/.gradle` or `GRADLE_USER_HOME` env variable.

**Example:**
```typescript
gradle_download_sources({
  projectPath: "D:/Projects/ccrm-mcore"
})
```

**Note:** This is the recommended method for existing Gradle projects. It executes `./gradlew idea` which automatically downloads all dependency sources.

### 2. `gradle_download_single_source`

Download source JAR for a single artifact from a Maven repository via HTTP.

**Parameters:**
- `coordinate` (required): Maven coordinate in format `groupId:artifactId:version`
- `repositoryUrl` (optional): Maven repository URL. Defaults to Maven Central.
- `gradleUserHome` (optional): Custom Gradle user home directory.

**Example:**
```typescript
gradle_download_single_source({
  coordinate: "com.google.code.gson:gson:2.13.2",
  repositoryUrl: "https://repo1.maven.org/maven2"
})
```

**Use cases:**
- When you don't have a Gradle project
- When you need to download specific artifacts
- When Gradle CLI is not available

### 3. `gradle_find_source`

Find the source JAR file for a given artifact in Gradle cache.

**Parameters:**
- `coordinate` (required): Maven coordinate in format `groupId:artifactId:version`
- `gradleUserHome` (optional): Custom Gradle user home directory.

**Example:**
```typescript
gradle_find_source({
  coordinate: "com.google.code.gson:gson:2.13.2"
})
```

**Returns:** Full path to the source JAR if found, or message indicating not found.

### 4. `gradle_list_cached_sources`

List all cached source JARs in the Gradle cache directory.

**Parameters:**
- `pattern` (optional): Filter pattern for artifact coordinates. Supports simple wildcard matching.
- `gradleUserHome` (optional): Custom Gradle user home directory.

**Examples:**
```typescript
// List all cached source JARs
gradle_list_cached_sources()

// Filter by pattern
gradle_list_cached_sources({ pattern: "gson" })
gradle_list_cached_sources({ pattern: "com.google.*" })
```

### 5. `gradle_get_cache_info`

Get information about the Gradle cache directory structure.

**Parameters:**
- `gradleUserHome` (optional): Custom Gradle user home directory.

**Example:**
```typescript
gradle_get_cache_info()
```

**Returns:**
- Gradle user home path
- Cache directory path
- Statistics (total JARs, source JARs, total size)
- Path format explanation

## Resources

The server also exposes cached source JARs as MCP resources with URI format: `file://<absolute-path-to-jar>`

Resource properties:
- `name`: Maven coordinate (groupId:artifactId)
- `description`: "Source JAR for {coordinate}"
- `mimeType`: "application/java-archive"

## Gradle Cache Path Structure

```
{GRADLE_USER_HOME}/caches/modules-2/files-2.1/{GROUP_PATH}/{ARTIFACT_ID}/{VERSION}/{SHA1_HASH}/{ARTIFACT_ID}-{VERSION}-sources.jar
```

Example:
```
D:\java\gradle_repo\caches\modules-2\files-2.1\com.google.code.gson\gson\2.13.2\e28a0b248e9435c6b6863275b2e5c1569dfac888\gson-2.13.2-sources.jar
```

Components:
- `GRADLE_USER_HOME`: Gradle user home directory (default: `~/.gradle`)
- `GROUP_PATH`: Group ID converted to path (e.g., `com.google.code.gson` → `com/google/code/gson`)
- `ARTIFACT_ID`: Artifact ID (e.g., `gson`)
- `VERSION`: Version (e.g., `2.13.2`)
- `SHA1_HASH`: SHA-1 hash of the source JAR file
- `FILE`: `{ARTIFACT_ID}-{VERSION}-sources.jar`

## Integration with jar-reader-mcp

This MCP server is designed to work with the `jar-reader-mcp` MCP server:

1. Use `gradle_download_sources` or `gradle_download_single_source` to download source JARs
2. Use `gradle_find_source` to locate the downloaded source JAR
3. Use `jar-reader-mcp` to open and read the JAR contents

Example workflow:
```typescript
// Download source
gradle_download_single_source({
  coordinate: "com.google.code.gson:gson:2.13.2"
})

// Find the downloaded JAR
gradle_find_source({
  coordinate: "com.google.code.gson:gson:2.13.2"
})
// Returns: D:\java\gradle_repo\caches\modules-2\files-2.1\com.google.code.gson\gson\2.13.2\e28a0b248e9435c6b6863275b2e5c1569dfac888\gson-2.13.2-sources.jar

// Read the JAR using jar-reader-mcp
jar_open({
  jarPath: "D:\\java\\gradle_repo\\caches\\modules-2\\files-2.1\\com.google.code.gson\\gson\\2.13.2\\e28a0b248e9435c6b6863275b2e5c1569dfac888\\gson-2.13.2-sources.jar"
})
```

## How IntelliJ IDEA Downloads Sources

When you use IntelliJ IDEA to download sources for Gradle dependencies:

1. **Trigger**: User right-clicks on a dependency and selects "Download Sources"
2. **Communication**: IDEA communicates with Gradle via Gradle Tooling API
3. **Download**: Gradle downloads the source JAR from configured Maven repositories
4. **Cache Storage**: Source JAR is stored in the Gradle cache directory
5. **Association**: IDEA associates the source with the corresponding class file

The `gradle_download_sources` tool in this MCP server performs the same operation by executing `./gradlew idea`, which triggers Gradle to download all dependency sources.

## Error Handling

All tools include comprehensive error handling:
- Invalid coordinate format detection
- Network error handling
- File system permission handling
- Clear error messages with actionable suggestions

## Limitations

- HTTP download method may fail for artifacts not available in public repositories
- Gradle CLI method requires a valid Gradle project with `gradlew` wrapper
- Some artifacts may not have published source JARs

## Future Enhancements

Potential improvements:
- Support for downloading Javadoc JARs
- Batch download of multiple coordinates
- Cache invalidation and cleanup
- Integration with multiple Maven repositories
- Support for Ivy/Maven-style classifiers
