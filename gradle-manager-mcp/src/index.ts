#!/usr/bin/env node

/**
 * Gradle Source Downloader MCP Server
 *
 * This MCP server provides tools for downloading and managing Gradle dependency source JARs.
 * It supports two download methods:
 * 1. Using Gradle command-line interface (recommended for existing projects)
 * 2. Direct HTTP download from Maven repositories (for standalone usage)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Default Gradle user home
const DEFAULT_GRADLE_USER_HOME = path.join(os.homedir(), ".gradle");

/**
 * Parse Gradle coordinate string (format: groupId:artifactId:version)
 */
function parseCoordinate(coordinate: string): { groupId: string; artifactId: string; version: string } | null {
  const parts = coordinate.split(":");
  if (parts.length !== 3) {
    return null;
  }
  return {
    groupId: parts[0],
    artifactId: parts[1],
    version: parts[2],
  };
}

/**
 * Convert groupId to path format (e.g., com.google.code.gson -> com/google/code/gson)
 */
function groupIdToPath(groupId: string): string {
  return groupId.replace(/\./g, "/");
}

/**
 * Get Gradle cache path for a given artifact
 */
function getGradleCachePath(
  gradleUserHome: string,
  groupId: string,
  artifactId: string,
  version: string
): string {
  return path.join(
    gradleUserHome,
    "caches/modules-2/files-2.1",
    groupIdToPath(groupId),
    artifactId,
    version
  );
}

/**
 * Find all JAR files in version directory
 */
function findJarsInVersionDir(versionDir: string): string[] {
  try {
    const entries = fs.readdirSync(versionDir, { withFileTypes: true });
    const jars: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const hashDir = path.join(versionDir, entry.name);
        const files = fs.readdirSync(hashDir);
        for (const file of files) {
          if (file.endsWith(".jar")) {
            jars.push(path.join(hashDir, file));
          }
        }
      }
    }

    return jars;
  } catch (error) {
    return [];
  }
}

/**
 * Find source JAR for a given artifact
 * This function tries multiple strategies to find the source JAR in Gradle cache
 */
function findSourceJar(
  gradleUserHome: string,
  groupId: string,
  artifactId: string,
  version: string
): string | null {
  const parts = groupId.split('.');
  const cacheBase = path.join(gradleUserHome, "caches/modules-2/files-2.1");

  // Try different path patterns
  const strategies = [
    // Strategy 1: Standard Maven format (all segments split)
    // groupId: com.google.code.gson -> com/google/code/gson
    groupIdToPath(groupId),

    // Strategy 2: First two segments combined, rest split
    // groupId: cn.webank.weup -> cn.webank/weup
    parts.length >= 2 ? `${parts.slice(0, 2).join('.')}/${parts.slice(2).join('/')}` : groupIdToPath(groupId),

    // Strategy 3: groupId as single segment (no splitting)
    // groupId: cn.webank.weup -> cn.webank.weup
    groupId,
  ];

  for (const groupPath of strategies) {
    const versionDir = path.join(cacheBase, groupPath, artifactId, version);
    let jars = findJarsInVersionDir(versionDir);
    if (jars.length > 0) {
      for (const jar of jars) {
        if (jar.endsWith("-sources.jar")) {
          return jar;
        }
      }
    }
  }

  // Strategy 4: Search by scanning the cache directory recursively (fallback)
  // This is slower but more reliable when directory structure is unknown
  try {
    const found = searchCacheRecursively(cacheBase, artifactId, version);
    if (found) {
      return found;
    }
  } catch (error) {
    // Ignore search errors
  }

  return null;
}

/**
 * Recursively search cache directory for source JAR matching artifactId and version
 */
function searchCacheRecursively(dir: string, artifactId: string, version: string): string | null {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Check if this directory matches the expected artifactId:version pattern
        if (entry.name === artifactId) {
          // Look for version directory
          const parentEntries = fs.readdirSync(dir, { withFileTypes: true });
          for (const parentEntry of parentEntries) {
            if (parentEntry.isDirectory() && parentEntry.name === version) {
              const versionDir = path.join(dir, version);
              const jars = findJarsInVersionDir(versionDir);
              for (const jar of jars) {
                if (jar.endsWith("-sources.jar")) {
                  return jar;
                }
              }
            }
          }
        }

        // Recursively search subdirectories
        const found = searchCacheRecursively(fullPath, artifactId, version);
        if (found) {
          return found;
        }
      }
    }
  } catch (error) {
    // Ignore permission errors and other issues
  }

  return null;
}

/**
 * Get Gradle user home directory
 */
function getGradleUserHome(): string {
  return process.env.GRADLE_USER_HOME || DEFAULT_GRADLE_USER_HOME;
}

// Create MCP server
const server = new Server(
  {
    name: "gradle-manager-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

/**
 * List available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "gradle_download_sources",
        description:
          "Download source JARs for all dependencies in a Gradle project using the Gradle command-line interface. This is the recommended method for existing Gradle projects.",
        inputSchema: {
          type: "object",
          properties: {
            projectPath: {
              type: "string",
              description: "Path to the Gradle project directory (absolute or relative to current working directory)",
            },
            gradleUserHome: {
              type: "string",
              description:
                "Custom Gradle user home directory (optional, defaults to ~/.gradle or GRADLE_USER_HOME env variable)",
            },
          },
        },
      },
      {
        name: "gradle_download_single_source",
        description:
          "Download source JAR for a single artifact from a Maven repository via HTTP. Use this method when you don't have a Gradle project or need to download specific artifacts.",
        inputSchema: {
          type: "object",
          properties: {
            coordinate: {
              type: "string",
              description: "Maven coordinate in format groupId:artifactId:version (e.g., com.google.code.gson:gson:2.13.2)",
            },
            repositoryUrl: {
              type: "string",
              description:
                "Maven repository URL (e.g., https://repo1.maven.org/maven2). Defaults to Maven Central.",
            },
            gradleUserHome: {
              type: "string",
              description:
                "Custom Gradle user home directory (optional, defaults to ~/.gradle or GRADLE_USER_HOME env variable)",
            },
          },
          required: ["coordinate"],
        },
      },
      {
        name: "gradle_find_source",
        description: "Find the source JAR file for a given artifact in Gradle cache",
        inputSchema: {
          type: "object",
          properties: {
            coordinate: {
              type: "string",
              description: "Maven coordinate in format groupId:artifactId:version (e.g., com.google.code.gson:gson:2.13.2)",
            },
            gradleUserHome: {
              type: "string",
              description:
                "Custom Gradle user home directory (optional, defaults to ~/.gradle or GRADLE_USER_HOME env variable)",
            },
          },
          required: ["coordinate"],
        },
      },
      {
        name: "gradle_list_cached_sources",
        description: "List all cached source JARs in the Gradle cache directory (optional filtering by pattern)",
        inputSchema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description:
                "Filter pattern for artifact coordinates (e.g., 'gson', 'com.google.*'). Supports simple wildcard matching.",
            },
            gradleUserHome: {
              type: "string",
              description:
                "Custom Gradle user home directory (optional, defaults to ~/.gradle or GRADLE_USER_HOME env variable)",
            },
          },
        },
      },
      {
        name: "gradle_get_cache_info",
        description: "Get information about the Gradle cache directory structure",
        inputSchema: {
          type: "object",
          properties: {
            gradleUserHome: {
              type: "string",
              description:
                "Custom Gradle user home directory (optional, defaults to ~/.gradle or GRADLE_USER_HOME env variable)",
            },
          },
        },
      },
    ],
  };
});

/**
 * Handle tool calls
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Type guard to ensure args is not undefined
  if (!args) {
    throw new Error("Tool arguments are required");
  }

  // Type assertion for arguments object
  const toolArgs = args as {
    projectPath?: string;
    gradleUserHome?: string;
    coordinate?: string;
    repositoryUrl?: string;
    pattern?: string;
  };

  try {
    switch (name) {
      case "gradle_download_sources": {
        const projectPath = toolArgs.projectPath || process.cwd();
        const gradleUserHome = toolArgs.gradleUserHome || getGradleUserHome();

        // Detect OS and use appropriate gradlew command
        const isWindows = process.platform === "win32";
        const gradlewCommand = isWindows ? "gradlew.bat" : "./gradlew";

        // Execute Gradle idea task to download sources
        const { stdout, stderr } = await execAsync(`cd "${projectPath}" && ${gradlewCommand} idea`, {
          cwd: projectPath,
          env: {
            ...process.env,
            GRADLE_USER_HOME: gradleUserHome,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: `Successfully downloaded source JARs for Gradle project at ${projectPath}\n\nGradle User Home: ${gradleUserHome}\n\nGradle Output:\n${stdout}`,
            },
          ],
        };
      }

      case "gradle_download_single_source": {
        const coordinate = toolArgs.coordinate;
        const repositoryUrl = toolArgs.repositoryUrl || "https://repo1.maven.org/maven2";
        const gradleUserHome = toolArgs.gradleUserHome || getGradleUserHome();

        if (typeof coordinate !== "string") {
          throw new Error(`Coordinate must be a string`);
        }

        const parsed = parseCoordinate(coordinate);
        if (!parsed) {
          throw new Error(`Invalid Maven coordinate format: ${coordinate}. Expected format: groupId:artifactId:version`);
        }

        const { groupId, artifactId, version } = parsed;

        // Construct download URL
        const url = `${repositoryUrl}/${groupIdToPath(groupId)}/${artifactId}/${version}/${artifactId}-${version}-sources.jar`;

        // Create target directory
        const targetDir = path.join(gradleUserHome, "caches/modules-2/files-2.1", groupIdToPath(groupId), artifactId, version);
        await fs.promises.mkdir(targetDir, { recursive: true });

        // Download file to temp location
        const tempPath = path.join(os.tmpdir(), `${artifactId}-${version}-sources.jar`);
        const response = await axios({
          method: "GET",
          url: url,
          responseType: "arraybuffer",
        });

        await fs.promises.writeFile(tempPath, response.data);

        // Calculate SHA-1 hash of downloaded file
        const crypto = await import("crypto");
        const fileBuffer = await fs.promises.readFile(tempPath);
        const hash = crypto.createHash("sha1");
        hash.update(fileBuffer);
        const sha1 = hash.digest("hex");

        // Create hash directory and move file
        const hashDir = path.join(targetDir, sha1);
        await fs.promises.mkdir(hashDir, { recursive: true });
        const finalPath = path.join(hashDir, `${artifactId}-${version}-sources.jar`);
        await fs.promises.rename(tempPath, finalPath);

        return {
          content: [
            {
              type: "text",
              text: `Successfully downloaded source JAR for ${coordinate}\n\nDownload URL: ${url}\nSaved to: ${finalPath}\nSHA-1: ${sha1}`,
            },
          ],
        };
      }

      case "gradle_find_source": {
        const coordinate = toolArgs.coordinate;
        const gradleUserHome = toolArgs.gradleUserHome || getGradleUserHome();

        if (typeof coordinate !== "string") {
          throw new Error(`Coordinate must be a string`);
        }

        const parsed = parseCoordinate(coordinate);
        if (!parsed) {
          throw new Error(`Invalid Maven coordinate format: ${coordinate}. Expected format: groupId:artifactId:version`);
        }

        const { groupId, artifactId, version } = parsed;
        const sourceJar = findSourceJar(gradleUserHome, groupId, artifactId, version);

        if (sourceJar) {
          return {
            content: [
              {
                type: "text",
                text: `Source JAR found: ${sourceJar}`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: `Source JAR not found for ${coordinate}`,
              },
            ],
          };
        }
      }

      case "gradle_list_cached_sources": {
        const pattern = toolArgs.pattern || "";
        const gradleUserHome = toolArgs.gradleUserHome || getGradleUserHome();

        const cacheBase = path.join(gradleUserHome, "caches/modules-2/files-2.1");
        const sources: string[] = [];

        // Recursive function to find source JARs
        async function findSources(dir: string): Promise<void> {
          try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                await findSources(fullPath);
              } else if (entry.name.endsWith("-sources.jar")) {
                // Extract coordinate from path
                // Path format: group/groupId1/groupId2/artifactId/version/hash/artifactId-version-sources.jar
                const relativePath = path.relative(cacheBase, fullPath);
                const parts = relativePath.split(path.sep);
                if (parts.length >= 5) {
                  // Last 3 parts are: hash, artifactId-version-sources.jar
                  // We need: groupId (all except last 4 parts), artifactId (4th from last)
                  const groupId = parts.slice(0, parts.length - 4).join(".");
                  const artifactId = parts[parts.length - 4];
                  const coordinate = `${groupId}:${artifactId}`;

                  // Apply pattern filter
                  if (!pattern || coordinate.includes(pattern) || new RegExp(pattern.replace(/\*/g, ".*")).test(coordinate)) {
                    sources.push(`${coordinate} -> ${fullPath}`);
                  }
                }
              }
            }
          } catch (error) {
            // Ignore permission errors
          }
        }

        await findSources(cacheBase);

        return {
          content: [
            {
              type: "text",
              text: `Cached source JARs${pattern ? ` (filter: ${pattern})` : ""}:\n\n${sources.length > 0 ? sources.join("\n") : "No source JARs found"}`,
            },
          ],
        };
      }

      case "gradle_get_cache_info": {
        const gradleUserHome = toolArgs.gradleUserHome || getGradleUserHome();
        const cacheBase = path.join(gradleUserHome, "caches/modules-2/files-2.1");

        let stats = {
          totalJars: 0,
          sourceJars: 0,
          totalSize: 0,
        };

        try {
          // Count JARs and calculate total size
          async function countJars(dir: string): Promise<void> {
            try {
              const entries = await fs.promises.readdir(dir, { withFileTypes: true });
              for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                  await countJars(fullPath);
                } else if (entry.name.endsWith(".jar")) {
                  stats.totalJars++;
                  if (entry.name.endsWith("-sources.jar")) {
                    stats.sourceJars++;
                  }
                  const fileStats = await fs.promises.stat(fullPath);
                  stats.totalSize += fileStats.size;
                }
              }
            } catch (error) {
              // Ignore permission errors
            }
          }

          await countJars(cacheBase);
        } catch (error) {
          // Cache directory might not exist
        }

        return {
          content: [
            {
              type: "text",
              text: `Gradle Cache Information\n\n` +
                `Gradle User Home: ${gradleUserHome}\n` +
                `Cache Directory: ${cacheBase}\n\n` +
                `Statistics:\n` +
                `- Total JAR files: ${stats.totalJars}\n` +
                `- Source JAR files: ${stats.sourceJars}\n` +
                `- Total size: ${(stats.totalSize / 1024 / 1024).toFixed(2)} MB\n\n` +
                `Path Format:\n` +
                `{GRADLE_USER_HOME}/caches/modules-2/files-2.1/{GROUP_PATH}/{ARTIFACT_ID}/{VERSION}/{SHA1_HASH}/{ARTIFACT_ID}-{VERSION}-sources.jar`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

/**
 * List available resources
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const gradleUserHome = getGradleUserHome();
  const cacheBase = path.join(gradleUserHome, "caches/modules-2/files-2.1");

  let resources: { uri: string; name: string; description: string; mimeType: string }[] = [];

  try {
    // Find all source JARs
    async function findSourceJars(dir: string, basePath: string = ""): Promise<void> {
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relativePath = path.join(basePath, entry.name);
          if (entry.isDirectory()) {
            await findSourceJars(fullPath, relativePath);
          } else if (entry.name.endsWith("-sources.jar")) {
            const parts = relativePath.split(path.sep);
            if (parts.length >= 5) {
              // Same logic as gradle_list_cached_sources
              const groupId = parts.slice(0, parts.length - 4).join(".");
              const artifactId = parts[parts.length - 4];
              resources.push({
                uri: `file://${fullPath}`,
                name: `${groupId}:${artifactId}`,
                description: `Source JAR for ${groupId}:${artifactId}`,
                mimeType: "application/java-archive",
              });
            }
          }
        }
      } catch (error) {
        // Ignore permission errors
      }
    }

    await findSourceJars(cacheBase);
  } catch (error) {
    // Cache directory might not exist
  }

  return { resources };
});

/**
 * Read a resource
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const filePath = uri.replace("file://", "");

  try {
    const content = await fs.promises.readFile(filePath);
    return {
      contents: [
        {
          uri,
          mimeType: "application/java-archive",
          blob: Buffer.from(content).toString("base64"),
        },
      ],
    };
  } catch (error) {
    throw new Error(`Failed to read resource: ${error instanceof Error ? error.message : String(error)}`);
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Gradle Source Downloader MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
