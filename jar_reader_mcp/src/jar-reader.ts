import * as fs from 'fs/promises';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';

export interface JarFileInfo {
  path: string;
  size: number;
  isDirectory: boolean;
}

export interface JarStats {
  entryCount: number;
  fileCount: number;
  directoryCount: number;
  totalUncompressedSize: number;
}

export interface ReadFileOptions {
  /** 1-based first line to return (inclusive). */
  startLine?: number;
  /** 1-based last line to return (inclusive). */
  endLine?: number;
  /** Maximum number of bytes to read from the entry. */
  maxBytes?: number;
}

export interface ReadResult {
  /** Actual entry path (may differ from the requested path by case or slashes). */
  path: string;
  /** Total uncompressed size of the entry in bytes. */
  size: number;
  content: string;
  /** True when the read was cut short by the maxBytes cap. */
  truncated: boolean;
  binary: boolean;
  /** Number of lines in the (possibly truncated) content; -1 when binary. */
  totalLines: number;
  startLine: number;
  endLine: number;
}

export interface ContentMatch {
  path: string;
  lineNumber: number;
  line: string;
}

export interface SearchContentOptions {
  /** Extensions to search; [] means every file (binaries are skipped). */
  fileExtensions?: string[];
  caseSensitive?: boolean;
  maxResults?: number;
  /** Optional wildcard filter on file paths, applied before content search. */
  filter?: string;
}

export interface SearchContentResult {
  matches: ContentMatch[];
  filesSearched: number;
  truncated: boolean;
}

/** File extensions searched by jar_search_content when none are specified. */
export const DEFAULT_SEARCH_EXTENSIONS = [
  '.java', '.kt', '.scala', '.groovy', '.xml', '.properties',
  '.yml', '.yaml', '.json', '.gradle', '.sql', '.md', '.txt',
];

export const DEFAULT_MAX_READ_BYTES = 10 * 1024 * 1024;

/** Upper bound for the LRU file cache shared by all reads of one JAR. */
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
/** Files larger than this are never cached (they would evict most of the cache). */
const MAX_CACHEABLE_FILE_BYTES = MAX_CACHE_BYTES / 4;
/** Matched lines longer than this are truncated in search output. */
const MAX_MATCH_LINE_LENGTH = 300;
/** Upper bound for findClass results. */
const MAX_FIND_CLASS_RESULTS = 50;
/** Extensions tried when resolving a class name to a source or class file. */
const CLASS_SOURCE_EXTENSIONS = ['.java', '.kt', '.scala', '.groovy', '.class'];

/**
 * Normalize a path used to address an entry inside the JAR: forward slashes,
 * no leading slash, no "./" prefix, no trailing slash.
 */
export function normalizeEntryPath(p: string): string {
  let s = p.replace(/\\/g, '/');
  s = s.replace(/^\/+/, '');
  if (s.startsWith('./')) s = s.slice(2);
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * Translate a wildcard pattern (`*` and `?`) into an anchored RegExp.
 * Every other character is matched literally, so patterns containing regex
 * metacharacters (e.g. "v2(", "spring(+).xml") can neither crash the server
 * nor be silently reinterpreted.
 */
export function wildcardToRegex(pattern: string, caseSensitive = false): RegExp {
  let source = '';
  for (const ch of pattern.replace(/\\/g, '/')) {
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, caseSensitive ? '' : 'i');
}

/** Heuristic binary detection: a NUL byte in the first 8 KB means binary. */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

function truncateLine(line: string): string {
  return line.length <= MAX_MATCH_LINE_LENGTH
    ? line
    : line.slice(0, MAX_MATCH_LINE_LENGTH) + ' … [line truncated]';
}

interface EntryRead {
  buffer: Buffer;
  truncated: boolean;
}

export class JarReader {
  /** Human-readable identifier used in messages (may include nested "!/" segments). */
  readonly label: string;
  private readonly sourcePath: string | null;
  private readonly sourceBuffer: Buffer | null;
  private zipfile: ZipFile | null = null;
  private entries: JarFileInfo[] = [];
  private readonly entryMap = new Map<string, Entry>();
  private readonly fileCache = new Map<string, Buffer>();
  private cacheBytes = 0;
  private closed = false;
  private stats: JarStats = {
    entryCount: 0, fileCount: 0, directoryCount: 0, totalUncompressedSize: 0,
  };

  /**
   * @param source absolute path to a JAR file, or an in-memory JAR (Buffer,
   *        used for JARs nested inside another JAR).
   * @param label display name; defaults to the path or "(in-memory JAR)".
   */
  constructor(source: string | Buffer, label?: string) {
    if (typeof source === 'string') {
      this.sourcePath = source;
      this.sourceBuffer = null;
      this.label = label ?? source;
    } else {
      this.sourcePath = null;
      this.sourceBuffer = source;
      this.label = label ?? '(in-memory JAR)';
    }
  }

  /**
   * Validate the source and scan the central directory. The zipfile handle
   * stays open for the lifetime of the reader; call close() to release it.
   */
  async open(): Promise<JarStats> {
    if (this.zipfile) return this.stats;
    if (this.closed) throw new Error(`JAR reader for ${this.label} is closed`);

    if (this.sourcePath !== null) {
      let stat;
      try {
        stat = await fs.stat(this.sourcePath);
      } catch {
        throw new Error(`JAR file not found: ${this.sourcePath}`);
      }
      if (!stat.isFile()) {
        throw new Error(`Not a file: ${this.sourcePath}`);
      }
    }

    const zipfile = await this.openZip();
    try {
      await this.scanEntries(zipfile);
    } catch (err) {
      this.close();
      throw err;
    }
    this.zipfile = zipfile;
    // A late error on the persistent handle (I/O failure) must not leak the fd.
    zipfile.on('error', () => this.close());
    return this.stats;
  }

  getStats(): JarStats {
    return this.stats;
  }

  /**
   * List entries, optionally filtered by a wildcard pattern.
   * Returns a window of the full list plus the total match count.
   */
  listFiles(
    filter?: string,
    offset = 0,
    limit?: number
  ): { entries: JarFileInfo[]; total: number } {
    this.assertUsable();
    const matched = filter
      ? this.entries.filter(f => wildcardToRegex(filter).test(normalizeEntryPath(f.path)))
      : this.entries;
    const start = Math.max(0, offset);
    const end = limit == null ? matched.length : Math.min(matched.length, start + Math.max(0, limit));
    return { entries: matched.slice(start, end), total: matched.length };
  }

  /**
   * Search file paths by wildcard pattern. Supports `*` and `?`; all other
   * characters match literally.
   */
  searchFiles(pattern: string, caseSensitive = false): string[] {
    this.assertUsable();
    const regex = wildcardToRegex(pattern, caseSensitive);
    return this.entries
      .filter(f => !f.isDirectory && regex.test(normalizeEntryPath(f.path)))
      .map(f => f.path);
  }

  /**
   * Read one file. Accepts Windows-style backslash paths and performs a
   * case-insensitive fallback when the exact path is not found.
   */
  async readFile(filePath: string, options: ReadFileOptions = {}): Promise<ReadResult> {
    this.assertUsable();
    const { entry, path } = this.resolveFileEntry(filePath);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_READ_BYTES;
    const { buffer, truncated } = await this.readEntryBuffer(entry, maxBytes);
    const size = entry.uncompressedSize;

    if (looksBinary(buffer)) {
      return {
        path, size, content: '', truncated, binary: true,
        totalLines: -1, startLine: 0, endLine: 0,
      };
    }

    const lines = buffer.toString('utf-8').split('\n');
    const totalLines = lines.length;
    let startLine = Math.max(1, options.startLine ?? 1);
    let endLine = Math.min(totalLines, options.endLine ?? totalLines);
    endLine = Math.max(endLine, startLine - 1);

    const selected = lines
      .slice(startLine - 1, endLine)
      .map(l => l.replace(/\r$/, ''))
      .join('\n');

    return {
      path, size, content: selected, truncated, binary: false,
      totalLines, startLine, endLine,
    };
  }

  /**
   * Read a file's raw bytes (used to extract nested JARs and by tests).
   * Throws when the entry exceeds maxBytes instead of returning a truncated
   * buffer, which would only fail later during ZIP parsing.
   */
  async readRaw(filePath: string, maxBytes = 256 * 1024 * 1024): Promise<Buffer> {
    this.assertUsable();
    const { entry } = this.resolveFileEntry(filePath);
    const { buffer, truncated } = await this.readEntryBuffer(entry, maxBytes);
    if (truncated) {
      throw new Error(
        `Entry "${filePath}" is larger than the ${maxBytes}-byte read limit`
      );
    }
    return buffer;
  }

  /**
   * Search file contents line by line. `searchPattern` is a regular
   * expression; invalid patterns are reported as errors instead of crashing.
   */
  async searchContent(
    searchPattern: string,
    options: SearchContentOptions = {}
  ): Promise<SearchContentResult> {
    this.assertUsable();
    const {
      fileExtensions = DEFAULT_SEARCH_EXTENSIONS,
      caseSensitive = false,
      maxResults = 100,
      filter,
    } = options;

    let regex: RegExp;
    try {
      // No 'g' flag: with it, .test() advances lastIndex and silently
      // skips every other matching line.
      regex = new RegExp(searchPattern, caseSensitive ? '' : 'i');
    } catch (err) {
      throw new Error(
        `Invalid regular expression "${searchPattern}": ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const extensions = fileExtensions.map(e => e.toLowerCase());
    const filterRegex = filter ? wildcardToRegex(filter) : null;

    const candidates = this.entries.filter(f => {
      if (f.isDirectory) return false;
      if (f.size > DEFAULT_MAX_READ_BYTES) return false;
      if (filterRegex && !filterRegex.test(normalizeEntryPath(f.path))) return false;
      if (extensions.length > 0) {
        const lower = f.path.toLowerCase();
        return extensions.some(ext => lower.endsWith(ext));
      }
      return true;
    });

    const matches: ContentMatch[] = [];
    let filesSearched = 0;

    for (const file of candidates) {
      if (matches.length >= maxResults) break;
      filesSearched++;

      let buffer: Buffer;
      try {
        buffer = await this.readEntryBuffer(this.requireEntry(file.path), DEFAULT_MAX_READ_BYTES)
          .then(r => r.buffer);
      } catch {
        continue; // skip unreadable entries
      }
      if (looksBinary(buffer)) continue;

      const lines = buffer.toString('utf-8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i].replace(/\r$/, ''))) {
          matches.push({
            path: file.path,
            lineNumber: i + 1,
            line: truncateLine(lines[i].replace(/\r$/, '')),
          });
          if (matches.length >= maxResults) break;
        }
      }
    }

    return {
      matches,
      filesSearched,
      truncated: matches.length >= maxResults,
    };
  }

  /**
   * Get metadata for one entry (file or directory); null when not found.
   */
  getFileInfo(filePath: string): JarFileInfo | null {
    this.assertUsable();
    if (typeof filePath !== 'string' || filePath.length === 0) return null;
    const normalized = normalizeEntryPath(filePath);
    let match = this.entries.find(f => normalizeEntryPath(f.path) === normalized);
    if (!match) {
      const lower = normalized.toLowerCase();
      match = this.entries.find(f => normalizeEntryPath(f.path).toLowerCase() === lower);
    }
    return match ?? null;
  }

  /**
   * Resolve a class name to source/class files inside the JAR.
   * Accepts FQCNs ("com.example.Service"), simple names ("Service"),
   * nested classes ("com.example.Service$Inner"), and entry paths
   * ("com/example/Service.java").
   */
  findClass(className: string): JarFileInfo[] {
    this.assertUsable();
    let query = className.trim().replace(/\\/g, '/');
    query = query.replace(/\.(java|kt|scala|groovy|class)$/, '');
    if (query.length === 0) return [];

    const basePath = query.includes('/') ? query : query.replace(/\./g, '/');
    const isFqcn = !query.includes('/');
    const results: JarFileInfo[] = [];
    const seen = new Set<string>();

    const add = (info: JarFileInfo) => {
      if (results.length < MAX_FIND_CLASS_RESULTS && !seen.has(info.path)) {
        seen.add(info.path);
        results.push(info);
      }
    };

    // Direct candidates: base + known source extensions, plus nested classes.
    for (const ext of CLASS_SOURCE_EXTENSIONS) {
      const entry = this.entryMap.get(basePath + ext);
      if (entry) {
        add({
          path: entry.fileName,
          size: entry.uncompressedSize,
          isDirectory: false,
        });
      }
    }
    // Nested/inner classes of a top-level class: Base$Inner.class etc.
    for (const [p, entry] of this.entryMap) {
      if (p.startsWith(basePath + '$')) {
        add({ path: entry.fileName, size: entry.uncompressedSize, isDirectory: false });
      }
    }
    // Simple class name: match any file whose basename stem equals the query.
    if (isFqcn) {
      const stem = basePath;
      for (const [p, entry] of this.entryMap) {
        const slash = p.lastIndexOf('/');
        const base = p.slice(slash + 1);
        const dot = base.lastIndexOf('.');
        if (dot > 0 && base.slice(0, dot) === stem) {
          add({ path: entry.fileName, size: entry.uncompressedSize, isDirectory: false });
        }
      }
    }

    return results;
  }

  /**
   * Cache statistics (for tests and debugging).
   */
  cacheStats(): { entries: number; bytes: number } {
    return { entries: this.fileCache.size, bytes: this.cacheBytes };
  }

  /**
   * Close the zipfile handle and drop all caches. Idempotent.
   */
  close(): void {
    this.closed = true;
    if (this.zipfile) {
      try {
        this.zipfile.close();
      } catch {
        // already closed or fd already reclaimed
      }
      this.zipfile = null;
    }
    this.fileCache.clear();
    this.cacheBytes = 0;
    this.entryMap.clear();
  }

  // ---- internals -------------------------------------------------------

  /** All state-dependent operations go through this guard so a closed or
   * unopened reader fails with a clear message instead of "not found". */
  private assertUsable(): void {
    if (this.closed) {
      throw new Error(`JAR reader for ${this.label} is closed`);
    }
    if (!this.zipfile) {
      throw new Error(`JAR ${this.label} is not open`);
    }
  }

  private requireZipfile(): ZipFile {
    this.assertUsable();
    return this.zipfile!;
  }

  private requireEntry(path: string): Entry {
    const entry = this.entryMap.get(normalizeEntryPath(path));
    if (!entry) {
      throw new Error(`File not found in JAR: ${path}`);
    }
    return entry;
  }

  /**
   * Resolve a user-supplied path to a file entry: exact match first, then a
   * case-insensitive fallback (JAR paths are case-sensitive, but callers
   * frequently get the casing wrong). Directory entries are rejected with a
   * specific message.
   */
  private resolveFileEntry(filePath: string): { entry: Entry; path: string } {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('filePath is required');
    }
    const normalized = normalizeEntryPath(filePath);
    const entry = this.entryMap.get(normalized);
    if (entry) return { entry, path: entry.fileName };

    const lower = normalized.toLowerCase();
    for (const [p, e] of this.entryMap) {
      if (p.toLowerCase() === lower) return { entry: e, path: e.fileName };
    }
    if (this.getFileInfo(filePath)?.isDirectory) {
      throw new Error(`"${filePath}" is a directory, not a file`);
    }
    throw new Error(`File not found in JAR: ${filePath}`);
  }

  private openZip(): Promise<ZipFile> {
    return new Promise((resolve, reject) => {
      const options = { lazyEntries: true, autoClose: false, strictFileNames: false };
      const callback = (err: Error | null, zipfile?: ZipFile) => {
        if (err || !zipfile) {
          const message = err?.message ?? 'unknown error';
          const friendly = /central directory/i.test(message)
            ? `Not a valid JAR/ZIP file: ${this.label}`
            : `Failed to open JAR file ${this.label}: ${message}`;
          reject(new Error(friendly));
          return;
        }
        resolve(zipfile);
      };
      if (this.sourceBuffer !== null) {
        yauzl.fromBuffer(this.sourceBuffer, options, callback);
      } else {
        yauzl.open(this.sourcePath!, options, callback);
      }
    });
  }

  private scanEntries(zipfile: ZipFile): Promise<void> {
    return new Promise((resolve, reject) => {
      const infos: JarFileInfo[] = [];
      const map = new Map<string, Entry>();
      let fileCount = 0;
      let directoryCount = 0;
      let totalSize = 0;

      zipfile.on('error', (err: Error) => {
        reject(new Error(`Error reading JAR ${this.label}: ${err.message}`));
      });
      zipfile.on('entry', (entry: Entry) => {
        const isDirectory = entry.fileName.endsWith('/');
        infos.push({
          path: entry.fileName,
          size: entry.uncompressedSize,
          isDirectory,
        });
        if (isDirectory) {
          directoryCount++;
        } else {
          fileCount++;
          totalSize += entry.uncompressedSize;
          map.set(normalizeEntryPath(entry.fileName), entry);
        }
        zipfile.readEntry();
      });
      zipfile.on('end', () => {
        this.entries = infos;
        this.entryMap.clear();
        for (const [p, e] of map) this.entryMap.set(p, e);
        this.stats = {
          entryCount: infos.length,
          fileCount,
          directoryCount,
          totalUncompressedSize: totalSize,
        };
        resolve();
      });
      zipfile.readEntry();
    });
  }

  /**
   * Read one entry, capped at maxBytes. Capped reads are not cached.
   */
  private async readEntryBuffer(entry: Entry, maxBytes: number): Promise<EntryRead> {
    const cacheKey = normalizeEntryPath(entry.fileName);
    const cached = this.fileCache.get(cacheKey);
    if (cached) {
      // Refresh LRU recency.
      this.fileCache.delete(cacheKey);
      this.fileCache.set(cacheKey, cached);
      // Cached buffers are complete, but a caller's maxBytes still applies.
      if (cached.length > maxBytes) {
        return { buffer: cached.subarray(0, maxBytes), truncated: true };
      }
      return { buffer: cached, truncated: false };
    }

    const zipfile = this.requireZipfile();
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      zipfile.openReadStream(entry, (err, readStream) => {
        if (err || !readStream) {
          reject(new Error(
            `Failed to read "${entry.fileName}" from ${this.label}: ${err?.message ?? 'no stream'}`
          ));
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        let truncated = false;
        let settled = false;

        const finish = () => {
          if (settled) return;
          settled = true;
          const full = Buffer.concat(chunks);
          resolve(truncated && full.length > maxBytes ? full.subarray(0, maxBytes) : full);
        };

        // Stop at the byte cap. Settling must happen BEFORE destroy(): for
        // stored entries the client-visible stream is fd-slicer's raw
        // ReadStream, whose destroy() synchronously emits an "error" that
        // must not turn a capped read into a rejection.
        const stop = () => {
          truncated = true;
          settled = true;
          readStream.destroy();
          const full = Buffer.concat(chunks);
          resolve(full.length > maxBytes ? full.subarray(0, maxBytes) : full);
        };

        readStream.on('data', (chunk: Buffer) => {
          if (received < maxBytes) {
            chunks.push(chunk);
            received += chunk.length;
            // A single chunk can overshoot the cap; only stop early when the
            // entry is known (from the central directory) to be larger.
            if (received >= maxBytes && entry.uncompressedSize > maxBytes) {
              stop();
            }
          } else {
            // Defensive: should not happen when the cap check above is exact.
            stop();
          }
        });
        readStream.on('end', finish);
        readStream.on('close', finish);
        readStream.on('error', (err: Error) => {
          if (settled) return; // expected: stream already destroyed at the cap
          settled = true;
          reject(new Error(`Error reading "${entry.fileName}": ${err.message}`));
        });
      });
    });

    if (buffer.length >= entry.uncompressedSize && buffer.length <= MAX_CACHEABLE_FILE_BYTES) {
      this.cachePut(cacheKey, buffer);
    }
    return { buffer, truncated: buffer.length < entry.uncompressedSize };
  }

  private cachePut(key: string, buffer: Buffer): void {
    this.fileCache.delete(key);
    this.fileCache.set(key, buffer);
    this.cacheBytes += buffer.length;
    while (this.cacheBytes > MAX_CACHE_BYTES && this.fileCache.size > 1) {
      const oldest = this.fileCache.keys().next().value as string;
      const evicted = this.fileCache.get(oldest);
      this.fileCache.delete(oldest);
      this.cacheBytes -= evicted?.length ?? 0;
    }
  }
}
