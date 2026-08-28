#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_SEARCH_EXTENSIONS,
  JarReader,
  JarStats,
} from './jar-reader.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

// Debug logging goes to stderr so it never corrupts the stdio transport.
const DEBUG = ['1', 'true'].includes((process.env.JAR_READER_DEBUG ?? '').toLowerCase());
function debug(message: string): void {
  if (DEBUG) console.error(`[jar_reader_mcp] ${message}`);
}

/** Maximum number of files returned by jar_search_files. */
const MAX_SEARCH_FILES_RESULTS = 1000;
/** Maximum number of matches returned by jar_search_content. */
const MAX_CONTENT_RESULTS = 1000;
/** Maximum number of entries returned by jar_list_files per page. */
const MAX_LIST_PAGE_SIZE = 2000;

// ---- open-JAR registry ------------------------------------------------

/** Open JARs keyed by path, or by "outer.jar!/nested.jar" label for nested JARs. */
const openJars = new Map<string, JarReader>();
/** JAR used when a tool call does not specify jarPath (the most recently opened). */
let currentJarKey: string | null = null;

function resolveReader(jarPath?: string): { reader: JarReader; key: string } {
  const key = jarPath ?? currentJarKey;
  if (!key) {
    throw new Error('No JAR file is currently open. Call jar_open first.');
  }
  const reader = openJars.get(key);
  if (!reader) {
    throw new Error(`No open JAR matches "${key}". Call jar_open first.`);
  }
  return { reader, key };
}

/**
 * Open a JAR from disk, or a JAR nested inside another JAR using the
 * "outer.jar!/path/inner.jar" syntax (multiple nesting levels allowed).
 * Reuses already-open readers, so re-opening is cheap and idempotent.
 */
async function openJar(jarPath: string): Promise<{ label: string; stats: JarStats }> {
  const existing = openJars.get(jarPath);
  if (existing) {
    currentJarKey = jarPath;
    return { label: jarPath, stats: existing.getStats() };
  }

  const segments = jarPath.split('!/');
  if (segments.length === 1) {
    const reader = new JarReader(jarPath);
    const stats = await reader.open();
    openJars.set(jarPath, reader);
    currentJarKey = jarPath;
    return { label: jarPath, stats };
  }

  // Nested JAR: open (or reuse) the outermost JAR, then descend.
  const outerPath = segments[0];
  let reader = openJars.get(outerPath);
  if (!reader) {
    reader = new JarReader(outerPath);
    await reader.open();
    openJars.set(outerPath, reader);
  }
  let label = outerPath;
  for (let i = 1; i < segments.length; i++) {
    const nestedLabel = `${label}!/${segments[i]}`;
    let nested = openJars.get(nestedLabel);
    if (!nested) {
      const bytes = await reader.readRaw(segments[i]);
      nested = new JarReader(bytes, nestedLabel);
      await nested.open();
      openJars.set(nestedLabel, nested);
    }
    reader = nested;
    label = nestedLabel;
  }
  currentJarKey = label;
  return { label, stats: reader.getStats() };
}

function closeJar(jarPath?: string, all?: boolean): string {
  if (all) {
    const count = openJars.size;
    for (const reader of openJars.values()) reader.close();
    openJars.clear();
    currentJarKey = null;
    return count > 0 ? `Closed ${count} JAR file(s)` : 'No JAR files are open';
  }

  const key = jarPath ?? currentJarKey;
  if (!key) return 'No JAR file is currently open';

  const reader = openJars.get(key);
  if (!reader) return `No open JAR matches "${key}"`;

  reader.close();
  openJars.delete(key);
  if (currentJarKey === key) {
    currentJarKey = openJars.size > 0 ? openJars.keys().next().value as string : null;
  }
  return `Successfully closed JAR: ${key}`;
}

// ---- tool helpers -----------------------------------------------------

/** Tool handler with args seen as a loose record (the SDK validates and
 * applies zod defaults before the handler runs). */
type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

/**
 * Wrap a tool handler: converts thrown errors into isError tool results and
 * logs calls/timing when JAR_READER_DEBUG is enabled.
 */
function withErrors(name: string, fn: ToolHandler): ToolHandler {
  return async (args: Record<string, unknown>) => {
    const startedAt = Date.now();
    try {
      const result = await fn(args);
      debug(`${name} ok in ${Date.now() - startedAt}ms`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debug(`${name} failed in ${Date.now() - startedAt}ms: ${message}`);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  };
}

function textResult(text: string, structured?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function formatBytes(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- server -----------------------------------------------------------

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'jar_reader_mcp', version },
    { capabilities: { tools: {} } }
  );

  server.registerTool('jar_open', {
    title: 'Open JAR',
    description:
      'Open a JAR (ZIP) file for reading. Must be called before other jar_* tools. ' +
      'JARs nested inside another JAR (e.g. Spring Boot BOOT-INF/lib/*.jar) can be opened ' +
      'directly with the "outer.jar!/BOOT-INF/lib/inner.jar" syntax. ' +
      'Re-opening an already-open JAR is cheap and just selects it as the current one.',
    inputSchema: {
      jarPath: z.string().describe(
        'Absolute path to the JAR file. For a nested JAR, use "outer.jar!/path/inner.jar".'
      ),
    },
    outputSchema: {
      jarPath: z.string(),
      entryCount: z.number(),
      fileCount: z.number(),
      directoryCount: z.number(),
      totalUncompressedSize: z.number(),
    },
  }, withErrors('jar_open', async ({ jarPath }) => {
    const { label, stats } = await openJar(String(jarPath));
    return textResult(
      `Opened ${label}: ${stats.fileCount} files, ${stats.directoryCount} directories, ` +
      `${formatBytes(stats.totalUncompressedSize)} uncompressed`,
      { jarPath: label, ...stats }
    );
  }));

  server.registerTool('jar_close', {
    title: 'Close JAR',
    description:
      'Close open JAR(s) and release file handles and caches. Without arguments, closes ' +
      'the current JAR. Pass jarPath to close a specific one, or all=true to close every open JAR.',
    inputSchema: {
      jarPath: z.string().optional().describe('JAR to close (defaults to the current one)'),
      all: z.boolean().optional().describe('Close every open JAR'),
    },
  }, withErrors('jar_close', async (args) => {
    return textResult(closeJar(
      args.jarPath === undefined ? undefined : String(args.jarPath),
      args.all === true
    ));
  }));

  server.registerTool('jar_list_files', {
    title: 'List JAR entries',
    description:
      'List entries in the open JAR, optionally filtered by a wildcard path pattern ' +
      '("*" matches anything including "/", "?" matches one non-slash character; all other ' +
      'characters match literally). Returns a page of results; use offset/limit for paging ' +
      'when the JAR has many entries.',
    inputSchema: {
      jarPath: z.string().optional().describe('Open JAR to use (defaults to the current one)'),
      filter: z.string().optional().describe('Wildcard path filter, e.g. "com/example/*.java"'),
      offset: z.number().int().min(0).default(0).describe('First entry to return (0-based)'),
      limit: z.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(500)
        .describe(`Maximum entries to return (max ${MAX_LIST_PAGE_SIZE})`),
    },
    outputSchema: {
      total: z.number(),
      offset: z.number(),
      limit: z.number(),
      entries: z.array(z.object({
        path: z.string(),
        size: z.number(),
        isDirectory: z.boolean(),
      })),
    },
  }, withErrors('jar_list_files', async (args) => {
    const { reader } = resolveReader(args.jarPath === undefined ? undefined : String(args.jarPath));
    const offset = Number(args.offset ?? 0);
    const limit = Number(args.limit ?? 500);
    const { entries, total } = reader.listFiles(
      args.filter === undefined ? undefined : String(args.filter),
      offset,
      limit
    );

    const lines = entries
      .map(f => `${f.isDirectory ? '[DIR]  ' : '[FILE] '} ${f.path}${f.isDirectory ? '' : ` (${formatBytes(f.size)})`}`)
      .join('\n');
    const header = `Showing ${entries.length} of ${total} matching entries` +
      (offset > 0 || entries.length < total ? ` (offset ${offset}; use offset/limit for more)` : '');

    return textResult(`${header}\n\n${lines || '(no entries)'}`, {
      total, offset, limit,
      entries: entries.map(f => ({ path: f.path, size: f.size, isDirectory: f.isDirectory })),
    });
  }));

  server.registerTool('jar_read_file', {
    title: 'Read file from JAR',
    description:
      'Read the text content of one file in the open JAR. Paths use forward slashes but ' +
      'backslashes are also accepted, and lookup falls back to case-insensitive matching. ' +
      'Use startLine/endLine (1-based, inclusive) to read a slice of large files. ' +
      'Binary files are detected and reported instead of returned.',
    inputSchema: {
      jarPath: z.string().optional().describe('Open JAR to use (defaults to the current one)'),
      filePath: z.string().describe('Path inside the JAR, e.g. "com/example/Service.java"'),
      startLine: z.number().int().min(1).optional().describe('First line to return (1-based)'),
      endLine: z.number().int().min(1).optional().describe('Last line to return (1-based, inclusive)'),
      maxBytes: z.number().int().min(1).max(50 * 1024 * 1024).optional()
        .describe(`Byte cap for the read (default ${DEFAULT_MAX_READ_BYTES})`),
    },
    outputSchema: {
      path: z.string(),
      size: z.number(),
      binary: z.boolean(),
      truncated: z.boolean(),
      totalLines: z.number(),
      startLine: z.number(),
      endLine: z.number(),
      content: z.string(),
    },
  }, withErrors('jar_read_file', async (args) => {
    const { reader } = resolveReader(args.jarPath === undefined ? undefined : String(args.jarPath));
    const result = await reader.readFile(String(args.filePath), {
      startLine: args.startLine === undefined ? undefined : Number(args.startLine),
      endLine: args.endLine === undefined ? undefined : Number(args.endLine),
      maxBytes: args.maxBytes === undefined ? undefined : Number(args.maxBytes),
    });

    if (result.binary) {
      return textResult(
        `"${result.path}" is a binary file (${formatBytes(result.size)}); not returning raw content.`,
        { ...result }
      );
    }

    const rangeInfo = result.startLine !== 1 || result.endLine !== result.totalLines
      ? `, lines ${result.startLine}-${result.endLine} of ${result.totalLines}`
      : `, ${result.totalLines} lines`;
    const truncation = result.truncated ? ' [truncated at byte cap]' : '';
    const header = `# ${result.path} (${formatBytes(result.size)}${rangeInfo}${truncation})`;

    return textResult(`${header}\n${result.content}`, { ...result });
  }));

  server.registerTool('jar_search_files', {
    title: 'Search file names',
    description:
      'Search file paths in the open JAR by wildcard pattern: "*" matches any run of ' +
      'characters (including "/"), "?" matches one non-slash character, everything else ' +
      'matches literally. Matching is case-insensitive unless caseSensitive=true.',
    inputSchema: {
      jarPath: z.string().optional().describe('Open JAR to use (defaults to the current one)'),
      pattern: z.string().describe('Wildcard pattern, e.g. "*Service*.java" or "com/example/*"'),
      caseSensitive: z.boolean().default(false),
      limit: z.number().int().min(1).max(MAX_SEARCH_FILES_RESULTS).default(200)
        .describe(`Maximum files to return (max ${MAX_SEARCH_FILES_RESULTS})`),
    },
    outputSchema: {
      files: z.array(z.string()),
      total: z.number(),
      truncated: z.boolean(),
    },
  }, withErrors('jar_search_files', async (args) => {
    const { reader } = resolveReader(args.jarPath === undefined ? undefined : String(args.jarPath));
    const limit = Number(args.limit ?? 200);
    const all = reader.searchFiles(
      String(args.pattern),
      args.caseSensitive === true
    );
    const files = all.slice(0, limit);
    const truncated = all.length > files.length;

    const body = files.length > 0
      ? files.join('\n')
      : 'No files found matching the pattern';
    const header = `Found ${all.length} matching file(s)` +
      (truncated ? ` (showing first ${files.length})` : '');

    return textResult(`${header}\n\n${body}`, {
      files,
      total: all.length,
      truncated,
    });
  }));

  server.registerTool('jar_search_content', {
    title: 'Search file contents',
    description:
      'Search file contents line by line in the open JAR using a regular expression. ' +
      'By default searches source/config files (.java, .kt, .scala, .groovy, .xml, .properties, ' +
      '.yml, .yaml, .json, .gradle, .sql, .md, .txt); pass fileExtensions: [] to search every ' +
      'file (binaries are skipped automatically). Extension matching is case-insensitive.',
    inputSchema: {
      jarPath: z.string().optional().describe('Open JAR to use (defaults to the current one)'),
      pattern: z.string().describe('Regular expression to match against each line'),
      fileExtensions: z.array(z.string()).optional()
        .describe(`Extensions to search (default: ${DEFAULT_SEARCH_EXTENSIONS.join(', ')}); [] = all files`),
      caseSensitive: z.boolean().default(false),
      maxResults: z.number().int().min(1).max(MAX_CONTENT_RESULTS).default(100)
        .describe(`Maximum matches to return (max ${MAX_CONTENT_RESULTS})`),
      filter: z.string().optional().describe('Optional wildcard filter on file paths'),
    },
    outputSchema: {
      matches: z.array(z.object({
        path: z.string(),
        lineNumber: z.number(),
        line: z.string(),
      })),
      filesSearched: z.number(),
      truncated: z.boolean(),
    },
  }, withErrors('jar_search_content', async (args) => {
    const { reader } = resolveReader(args.jarPath === undefined ? undefined : String(args.jarPath));
    const { matches, filesSearched, truncated } = await reader.searchContent(String(args.pattern), {
      fileExtensions: args.fileExtensions === undefined
        ? undefined
        : (args.fileExtensions as string[]),
      caseSensitive: args.caseSensitive === true,
      maxResults: args.maxResults === undefined ? undefined : Number(args.maxResults),
      filter: args.filter === undefined ? undefined : String(args.filter),
    });

    if (matches.length === 0) {
      return textResult(`No matches found (searched ${filesSearched} files)`, {
        matches, filesSearched, truncated,
      });
    }

    const body = matches.map(m => `${m.path}:${m.lineNumber}: ${m.line}`).join('\n');
    const header = `Found ${matches.length} match(es) across ${filesSearched} searched file(s)` +
      (truncated ? ' (result limit reached; raise maxResults for more)' : '');

    return textResult(`${header}\n\n${body}`, {
      matches, filesSearched, truncated,
    });
  }));

  server.registerTool('jar_get_file_info', {
    title: 'Get file info',
    description:
      'Get metadata (path, size, type) for one entry in the open JAR. Accepts the same ' +
      'path forms as jar_read_file.',
    inputSchema: {
      jarPath: z.string().optional().describe('Open JAR to use (defaults to the current one)'),
      filePath: z.string().describe('Path inside the JAR'),
    },
    outputSchema: {
      path: z.string(),
      size: z.number(),
      isDirectory: z.boolean(),
    },
  }, withErrors('jar_get_file_info', async (args) => {
    const { reader } = resolveReader(args.jarPath === undefined ? undefined : String(args.jarPath));
    const info = reader.getFileInfo(String(args.filePath));
    if (!info) {
      throw new Error(`File not found in JAR: ${args.filePath}`);
    }
    return textResult(
      `Path: ${info.path}\nSize: ${formatBytes(info.size)} (${info.size} bytes)\nType: ${info.isDirectory ? 'Directory' : 'File'}`,
      { path: info.path, size: info.size, isDirectory: info.isDirectory }
    );
  }));

  server.registerTool('jar_find_class', {
    title: 'Find class by name',
    description:
      'Resolve a Java/Kotlin class name to its file(s) in the open JAR. Accepts a fully ' +
      'qualified name ("com.example.Service"), a simple name ("Service"), a nested class ' +
      '("com.example.Service$Inner"), or an entry path ("com/example/Service.java"). ' +
      'Returns matching source files (.java/.kt/...) and .class files with their sizes.',
    inputSchema: {
      jarPath: z.string().optional().describe('Open JAR to use (defaults to the current one)'),
      className: z.string().describe('Class name to resolve, e.g. "com.example.UserService"'),
    },
    outputSchema: {
      classes: z.array(z.object({
        path: z.string(),
        size: z.number(),
      })),
    },
  }, withErrors('jar_find_class', async (args) => {
    const { reader } = resolveReader(args.jarPath === undefined ? undefined : String(args.jarPath));
    const classes = reader.findClass(String(args.className));

    if (classes.length === 0) {
      return textResult(`No class found matching "${args.className}"`, { classes });
    }

    const body = classes
      .map(c => `${c.path} (${formatBytes(c.size)})`)
      .join('\n');
    return textResult(`Found ${classes.length} file(s) for "${args.className}":\n\n${body}`, {
      classes: classes.map(c => ({ path: c.path, size: c.size })),
    });
  }));

  return server;
}

// ---- entry point ------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
  debug('server started');
  console.error('jar_reader_mcp MCP server running on stdio');
}

// Run only when executed directly (node dist/index.js), not when imported
// by tests.
const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url.toLowerCase() ===
  pathToFileURL(resolve(process.argv[1])).href.toLowerCase();

if (invokedDirectly) {
  main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
  });
}
