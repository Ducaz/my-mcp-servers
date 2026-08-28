// Unit tests for JarReader (runs against dist/jar-reader.js).

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { JarReader, wildcardToRegex, normalizeEntryPath } from '../dist/jar-reader.js';
import { createFixture } from './helpers/fixture.mjs';
import { buildZip } from './helpers/zip-builder.mjs';

/** OS-level handle count for the current process, or null when unsupported. */
function handleCount() {
  if (process.platform === 'win32') {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-Process -Id ${process.pid}).HandleCount"`,
      { encoding: 'utf8' }
    );
    return parseInt(out.trim(), 10);
  }
  if (process.platform === 'linux') {
    return fs.readdirSync('/proc/self/fd').length;
  }
  return null;
}

let fixture;

before(async () => {
  fixture = await createFixture();
});

after(async () => {
  await fixture.cleanup();
});

// ---- pure helpers -----------------------------------------------------

describe('wildcardToRegex', () => {
  test('translates wildcards and escapes metacharacters', () => {
    const re = wildcardToRegex('*Service*.java');
    assert.ok(re.test('com/example/MyService.java'));
    assert.ok(!re.test('com/example/MyService.jav'));
    assert.ok(re.test('Service.java'));
  });

  test('regex metacharacters match literally instead of crashing', () => {
    const re = wildcardToRegex('com/example/(');
    assert.ok(!re.test('com/example/x'));
    // The old implementation threw "SyntaxError: Unterminated group" here.
    assert.doesNotThrow(() => wildcardToRegex('spring(+).xml[v2]'));
  });

  test('? matches exactly one non-slash character', () => {
    const re = wildcardToRegex('com/?/Service.java');
    assert.ok(re.test('com/a/Service.java'));
    assert.ok(!re.test('com/ab/Service.java'));
    assert.ok(!re.test('com//Service.java'));
  });

  test('case sensitivity flag', () => {
    assert.ok(wildcardToRegex('service.java').test('SERVICE.java'));
    assert.ok(!wildcardToRegex('service.java', true).test('SERVICE.java'));
  });

  test('backslashes in patterns are normalized', () => {
    assert.ok(wildcardToRegex('com\\example\\*.java').test('com/example/Util.java'));
  });
});

describe('normalizeEntryPath', () => {
  test('normalizes separators and decorations', () => {
    assert.equal(normalizeEntryPath('com\\example\\Service.java'), 'com/example/Service.java');
    assert.equal(normalizeEntryPath('/com/example/Service.java'), 'com/example/Service.java');
    assert.equal(normalizeEntryPath('./com/example/Service.java'), 'com/example/Service.java');
    assert.equal(normalizeEntryPath('com/example/'), 'com/example');
  });
});

// ---- open / close -----------------------------------------------------

describe('open and close', () => {
  test('reports stats about the archive', async () => {
    const reader = new JarReader(fixture.jarPath);
    const stats = await reader.open();
    // 30 fillers + Service/Util/service + .class + MANIFEST + properties +
    // readme + long line + binary + nested jar = 40 files
    assert.equal(stats.fileCount, 40);
    assert.ok(stats.directoryCount >= 2);
    assert.equal(stats.entryCount, stats.fileCount + stats.directoryCount);
    reader.close();
  });

  test('missing file produces a clear error', async () => {
    const reader = new JarReader(fixture.missingPath);
    await assert.rejects(() => reader.open(), /JAR file not found/);
  });

  test('non-ZIP file produces a clear error', async () => {
    const reader = new JarReader(fixture.notAZipPath);
    await assert.rejects(() => reader.open(), /Not a valid JAR\/ZIP file/);
  });

  test('open is idempotent', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const stats = await reader.open();
    assert.equal(stats.fileCount, 40);
    reader.close();
  });

  test('operations after close fail', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    reader.close();
    await assert.rejects(() => reader.readFile('com/example/Util.java'), /closed/);
  });
});

// ---- bug regressions --------------------------------------------------

describe('regression: wildcard search (old code crashed)', () => {
  test('searchFiles handles the documented "*Service*.java" pattern', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    // The old implementation threw SyntaxError: Nothing to repeat.
    // Case-insensitive matching also finds the lowercase service.java.
    const files = reader.searchFiles('*Service*.java');
    assert.deepEqual(files, ['com/example/Service.java', 'com/example/service.java']);

    const sensitive = reader.searchFiles('*Service*.java', true);
    assert.deepEqual(sensitive, ['com/example/Service.java']);
    reader.close();
  });
});

describe('regression: global-regex flag skipped every other match', () => {
  test('all 4 matching lines are found in one file', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const { matches } = await reader.searchContent('token', { fileExtensions: ['.java'] });
    const inService = matches.filter(m => m.path === 'com/example/Service.java');
    // The old implementation returned only 2 of the 4 lines.
    assert.deepEqual(inService.map(m => m.lineNumber), [3, 4, 5, 6]);
    reader.close();
  });
});

describe('regression: filter metacharacters killed the process', () => {
  test('listFiles with "(" in the filter returns no matches, no crash', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const { entries, total } = reader.listFiles('com/example/(');
    assert.equal(total, 0);
    assert.equal(entries.length, 0);
    reader.close();
  });
});

describe('regression: file descriptor leak', () => {
  test('30 reads do not grow the OS handle count', async () => {
    if (handleCount() === null) {
      return; // platform without a handle-count source
    }
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    // Warm up (first read may allocate one-off handles), then measure.
    await reader.readFile('com/example/Filler1.java');
    const before = handleCount();
    for (let i = 2; i <= 30; i++) {
      await reader.readFile(`com/example/Filler${i}.java`);
    }
    const after = handleCount();
    // The old implementation leaked one handle per read (+29 here).
    assert.ok(
      after - before < 10,
      `handle count grew by ${after - before} after 29 reads`
    );
    reader.close();
  });
});

describe('regression: Windows-style paths were rejected', () => {
  test('backslash, leading-slash and ./ paths all resolve', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const viaBackslash = await reader.readFile('com\\example\\Service.java');
    const viaLeadingSlash = await reader.readFile('/com/example/Service.java');
    const viaDotSlash = await reader.readFile('./com/example/Service.java');
    assert.equal(viaBackslash.content, fixture.serviceJava);
    assert.equal(viaLeadingSlash.content, fixture.serviceJava);
    assert.equal(viaDotSlash.content, fixture.serviceJava);
    reader.close();
  });
});

// ---- list / search ----------------------------------------------------

describe('listFiles', () => {
  test('wildcard filter matches full paths', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const { total } = reader.listFiles('*.java');
    assert.equal(total, 33); // Service, Util, service, 30 fillers
    const { total: none } = reader.listFiles('com/example/(');
    assert.equal(none, 0);
    reader.close();
  });

  test('pagination via offset and limit', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const page1 = reader.listFiles('com/example/Filler*.java', 0, 10);
    const page2 = reader.listFiles('com/example/Filler*.java', 10, 10);
    assert.equal(page1.entries.length, 10);
    assert.equal(page2.entries.length, 10);
    assert.equal(page1.total, 30);
    assert.notEqual(page1.entries[0].path, page2.entries[0].path);
    assert.equal(page2.entries[0].path, 'com/example/Filler11.java');
    reader.close();
  });
});

describe('searchContent', () => {
  test('case-insensitive by default, case-sensitive on request', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const insensitive = await reader.searchContent('manifest-version', { fileExtensions: ['.mf'] });
    assert.equal(insensitive.matches.length, 1);
    const sensitive = await reader.searchContent('manifest-version', {
      fileExtensions: ['.mf'],
      caseSensitive: true,
    });
    assert.equal(sensitive.matches.length, 0);
    reader.close();
  });

  test('searches default extensions including .md', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const { matches } = await reader.searchContent('token in markdown');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].path, 'docs/README.md');
    reader.close();
  });

  test('extension matching is case-insensitive', async () => {
    const jar = buildZip([{ name: 'A.JAVA', data: 'needle here\n' }]);
    const reader = new JarReader(jar);
    await reader.open();
    const { matches } = await reader.searchContent('needle');
    assert.equal(matches.length, 1);
    reader.close();
  });

  test('empty extensions array searches all text files', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const { matches } = await reader.searchContent('token', { fileExtensions: [] });
    const paths = new Set(matches.map(m => m.path));
    assert.ok(paths.has('config/app.properties'));
    assert.ok(paths.has('docs/README.md'));
    assert.ok(paths.has('big/long-line.txt'));
    reader.close();
  });

  test('binary files are skipped', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const { matches } = await reader.searchContent('\\x00', { fileExtensions: [] });
    assert.ok(!matches.some(m => m.path === 'binary/blob.dat'));
    reader.close();
  });

  test('invalid regex is reported as an error, not a crash', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    await assert.rejects(
      () => reader.searchContent('([unclosed'),
      /Invalid regular expression/
    );
    reader.close();
  });

  test('path filter narrows the search', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const { matches } = await reader.searchContent('token', { filter: 'docs/*' });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].path, 'docs/README.md');
    reader.close();
  });

  test('maxResults caps matches and sets truncated', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const { matches, truncated } = await reader.searchContent('token', { maxResults: 2 });
    assert.equal(matches.length, 2);
    assert.equal(truncated, true);
    reader.close();
  });

  test('very long matched lines are truncated in results', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const { matches } = await reader.searchContent('token', { fileExtensions: ['.txt'] });
    assert.equal(matches.length, 1);
    assert.ok(matches[0].line.length < 400);
    assert.ok(matches[0].line.endsWith('… [line truncated]'));
    reader.close();
  });
});

// ---- readFile ---------------------------------------------------------

describe('readFile', () => {
  test('case-insensitive fallback resolves differently-cased paths', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const result = await reader.readFile('COM/EXAMPLE/UTIL.JAVA');
    assert.equal(result.path, 'com/example/Util.java');
    assert.match(result.content, /class Util/);
    reader.close();
  });

  test('line ranges are 1-based and inclusive', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const full = await reader.readFile('com/example/Service.java');
    assert.equal(full.totalLines, 7);
    assert.equal(full.startLine, 1);
    assert.equal(full.endLine, 7);

    const slice = await reader.readFile('com/example/Service.java', { startLine: 3, endLine: 4 });
    assert.equal(slice.content, '  // token line 1\n  // token line 2');
    assert.equal(slice.startLine, 3);
    assert.equal(slice.endLine, 4);
    reader.close();
  });

  test('byte cap marks the result truncated', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const result = await reader.readFile('com/example/Service.java', { maxBytes: 30 });
    assert.equal(result.truncated, true);
    assert.equal(result.content.length, 30);
    assert.equal(result.size, fixture.serviceJava.length);
    reader.close();
  });

  test('binary files are detected', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const result = await reader.readFile('binary/blob.dat');
    assert.equal(result.binary, true);
    assert.equal(result.content, '');
    reader.close();
  });

  test('directories and missing files produce specific errors', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    await assert.rejects(() => reader.readFile('com/example'), /is a directory/);
    await assert.rejects(() => reader.readFile('no/such/File.java'), /File not found/);
    reader.close();
  });
});

// ---- getFileInfo / findClass ------------------------------------------

describe('getFileInfo', () => {
  test('resolves files and directories, null for missing', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const file = reader.getFileInfo('com\\example\\Service.java');
    assert.equal(file.path, 'com/example/Service.java');
    assert.equal(file.isDirectory, false);
    assert.equal(file.size, fixture.serviceJava.length);

    const dir = reader.getFileInfo('com/example/');
    assert.equal(dir.isDirectory, true);

    assert.equal(reader.getFileInfo('nope.txt'), null);
    reader.close();
  });
});

describe('findClass', () => {
  test('resolves FQCN to source file', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const found = reader.findClass('com.example.Service');
    assert.deepEqual(found.map(f => f.path), [
      'com/example/Service.java',
      'com/example/Service$Inner.class',
    ]);
    reader.close();
  });

  test('resolves simple names and entry paths', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    const bySimple = reader.findClass('Util');
    assert.deepEqual(bySimple.map(f => f.path), ['com/example/Util.java']);

    const byPath = reader.findClass('com/example/Util.java');
    assert.deepEqual(byPath.map(f => f.path), ['com/example/Util.java']);

    const byFqcnClass = reader.findClass('com.example.Service$Inner');
    assert.deepEqual(byFqcnClass.map(f => f.path), ['com/example/Service$Inner.class']);

    assert.deepEqual(reader.findClass('com.example.NoSuch'), []);
    reader.close();
  });
});

// ---- nested JARs ------------------------------------------------------

describe('nested JARs', () => {
  test('a JAR stored inside a JAR can be opened from its bytes', async () => {
    const outer = new JarReader(fixture.jarPath);
    await outer.open();
    const bytes = await outer.readRaw('BOOT-INF/lib/inner.jar');
    const inner = new JarReader(bytes, 'fixture.jar!/BOOT-INF/lib/inner.jar');
    const stats = await inner.open();
    assert.equal(stats.fileCount, 2);

    const { matches } = await inner.searchContent('Deep');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].path, 'com/inner/Deep.java');
    inner.close();
    outer.close();
  });

  test('readRaw rejects entries above the size limit', async () => {
    const jar = buildZip([{ name: 'big.bin', data: 'x'.repeat(100) }]);
    const reader = new JarReader(jar);
    await reader.open();
    await assert.rejects(() => reader.readRaw('big.bin', 50), /larger than/);
    reader.close();
  });
});

// ---- cache ------------------------------------------------------------

describe('deflated entries (real-world JAR compression)', () => {
  const bigContent = 'package com.deflate;\n' + 'padding line\n'.repeat(200) + 'needle at the end\n';

  test('reads, searches and caps deflated entries', async () => {
    const jar = buildZip([
      { name: 'com/deflate/Big.java', data: bigContent, deflate: true },
      { name: 'com/deflate/Small.java', data: 'small file\n', deflate: true },
    ]);
    const reader = new JarReader(jar);
    const stats = await reader.open();
    assert.equal(stats.fileCount, 2);

    const full = await reader.readFile('com/deflate/Big.java');
    assert.equal(full.content, bigContent);
    assert.equal(full.truncated, false);

    const { matches } = await reader.searchContent('needle at the end');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].lineNumber, 202);

    // The cap goes through yauzl's inflate wrapper rather than the raw
    // fd-slicer stream, exercising the other truncation path.
    const capped = await reader.readFile('com/deflate/Big.java', { maxBytes: 40 });
    assert.equal(capped.truncated, true);
    assert.equal(capped.content.length, 40);
    reader.close();
  });
});

describe('file cache', () => {
  test('repeated reads are cached and close() clears the cache', async () => {
    const reader = new JarReader(fixture.jarPath);
    await reader.open();
    await reader.readFile('com/example/Service.java');
    await reader.readFile('com/example/Service.java');
    assert.equal(reader.cacheStats().entries, 1);
    assert.equal(reader.cacheStats().bytes, fixture.serviceJava.length);
    reader.close();
    assert.equal(reader.cacheStats().entries, 0);
  });
});
