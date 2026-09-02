// End-to-end tests: drive the MCP server through a Client connected via an
// in-memory transport, exercising the tools exactly like a real MCP host.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../dist/index.js';
import { createFixture } from './helpers/fixture.mjs';

let fixture;
let client;

before(async () => {
  fixture = await createFixture();
  const server = buildServer();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

after(async () => {
  await client.close();
  await fixture.cleanup();
});

async function call(name, args) {
  return client.callTool({ name, arguments: args });
}

function text(result) {
  return result.content[0].text;
}

test('lists all 8 tools', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map(t => t.name).sort(),
    [
      'jar_close', 'jar_find_class', 'jar_get_file_info', 'jar_list_files',
      'jar_open', 'jar_read_file', 'jar_search_content', 'jar_search_files',
    ].sort()
  );
});

test('tools fail cleanly when no JAR is open', async () => {
  const result = await call('jar_list_files', {});
  assert.equal(result.isError, true);
  assert.match(text(result), /No JAR file is currently open/);
});

test('jar_open reports archive statistics', async () => {
  const result = await call('jar_open', { jarPath: fixture.jarPath });
  assert.equal(result.isError, undefined);
  assert.match(text(result), /Opened .*fixture\.jar.*40 files/);
  assert.equal(result.structuredContent.fileCount, 40);
});

test('jar_open reports invalid input as a validation error', async () => {
  const result = await call('jar_open', { wrong: 'shape' });
  assert.equal(result.isError, true);
  assert.match(text(result), /Invalid arguments for tool jar_open/);
});

test('jar_open on a non-ZIP file returns a clear error', async () => {
  const result = await call('jar_open', { jarPath: fixture.notAZipPath });
  assert.equal(result.isError, true);
  assert.match(text(result), /Not a valid JAR\/ZIP file/);
});

test('regression: wildcard file search works end to end', async () => {
  const result = await call('jar_search_files', { pattern: '*Service*.java' });
  assert.equal(result.isError, undefined);
  // Case-insensitive by default: also finds the lowercase service.java.
  assert.deepEqual(result.structuredContent.files, [
    'com/example/Service.java',
    'com/example/service.java',
  ]);

  const sensitive = await call('jar_search_files', {
    pattern: '*Service*.java',
    caseSensitive: true,
  });
  assert.deepEqual(sensitive.structuredContent.files, ['com/example/Service.java']);
});

test('regression: metacharacter filter is an empty result, not a crash', async () => {
  const result = await call('jar_list_files', { filter: 'com/example/(' });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.total, 0);
});

test('regression: content search finds every matching line', async () => {
  const result = await call('jar_search_content', {
    pattern: 'token',
    fileExtensions: ['.java'],
  });
  const lines = result.structuredContent.matches
    .filter(m => m.path === 'com/example/Service.java')
    .map(m => m.lineNumber);
  assert.deepEqual(lines, [3, 4, 5, 6]);
});

test('regression: backslash paths read successfully', async () => {
  const result = await call('jar_read_file', {
    filePath: 'com\\example\\Util.java',
  });
  assert.equal(result.isError, undefined);
  assert.match(text(result), /class Util/);
});

test('jar_read_file returns line ranges with a header', async () => {
  const result = await call('jar_read_file', {
    filePath: 'com/example/Service.java',
    startLine: 3,
    endLine: 4,
  });
  assert.equal(result.isError, undefined);
  assert.match(text(result), /lines 3-4 of 7/);
  assert.match(text(result), /\/\/ token line 1/);
});

test('jar_read_file on a binary file reports it instead of dumping bytes', async () => {
  const result = await call('jar_read_file', { filePath: 'binary/blob.dat' });
  assert.equal(result.isError, undefined);
  assert.match(text(result), /binary file/);
});

test('jar_find_class resolves FQCNs', async () => {
  const result = await call('jar_find_class', { className: 'com.example.Service' });
  assert.deepEqual(
    result.structuredContent.classes.map(c => c.path),
    ['com/example/Service.java', 'com/example/Service$Inner.class']
  );
});

test('jar_get_file_info errors consistently for missing files', async () => {
  const result = await call('jar_get_file_info', { filePath: 'no/such.txt' });
  assert.equal(result.isError, true);
  assert.match(text(result), /File not found/);
});

test('jar_list_files paginates', async () => {
  const result = await call('jar_list_files', {
    filter: 'com/example/Filler*.java',
    offset: 10,
    limit: 5,
  });
  assert.equal(result.structuredContent.total, 30);
  assert.equal(result.structuredContent.entries.length, 5);
  assert.equal(result.structuredContent.entries[0].path, 'com/example/Filler11.java');
});

test('nested JARs open with the "!/" syntax', async () => {
  const open = await call('jar_open', { jarPath: fixture.innerJarPath });
  assert.equal(open.isError, undefined);
  assert.equal(open.structuredContent.fileCount, 2);

  const list = await call('jar_list_files', { jarPath: fixture.innerJarPath, filter: '*.java' });
  assert.equal(list.structuredContent.total, 1);
  assert.equal(list.structuredContent.entries[0].path, 'com/inner/Deep.java');

  const read = await call('jar_read_file', {
    jarPath: fixture.innerJarPath,
    filePath: 'com/inner/Deep.java',
  });
  assert.match(text(read), /class Deep/);
});

test('multiple JARs can be open at once and selected per call', async () => {
  // fixture.jar is open from earlier tests; open the nested one too.
  await call('jar_open', { jarPath: fixture.innerJarPath });

  const fromInner = await call('jar_find_class', {
    jarPath: fixture.innerJarPath,
    className: 'Deep',
  });
  assert.deepEqual(
    fromInner.structuredContent.classes.map(c => c.path),
    ['com/inner/Deep.java']
  );

  const fromOuter = await call('jar_find_class', {
    jarPath: fixture.jarPath,
    className: 'Deep',
  });
  assert.deepEqual(fromOuter.structuredContent.classes, []);
});

test('jar_close closes the current JAR and falls back to another open one', async () => {
  // The nested JAR is current (opened last); closing it leaves fixture.jar
  // open, which becomes the new current JAR.
  const result = await call('jar_close', {});
  assert.match(text(result), /Successfully closed/);

  const read = await call('jar_read_file', { filePath: 'com/example/Util.java' });
  assert.equal(read.isError, undefined);

  // Referencing a closed JAR re-opens it on demand (auto-open), but a call
  // with no jarPath still resolves against the current JAR.
  const reopened = await call('jar_list_files', { jarPath: fixture.innerJarPath });
  assert.equal(reopened.isError, undefined);
  assert.equal(reopened.structuredContent.entries.length > 0, true);
});

test('jar_close all=true closes everything', async () => {
  await call('jar_open', { jarPath: fixture.jarPath });
  await call('jar_open', { jarPath: fixture.innerJarPath });
  const result = await call('jar_close', { all: true });
  assert.match(text(result), /Closed 2 JAR file/);

  const after = await call('jar_list_files', {});
  assert.equal(after.isError, true);
});

// ---- IntelliJ MCP interop ----------------------------------------------
// Reference forms as emitted by intellij-index-mcp (jar://<path>!/entry from
// ide_find_class & friends), intellij-native-mcp ("path!/entry", file://
// URLs), and the IDE itself.

/** Forward-slash form of a Windows path, as IntelliJ URLs spell it. */
function toUrlPath(p) {
  return p.replace(/\\/g, '/');
}

test('jar_open accepts a jar:// URL with a trailing entry', async () => {
  const result = await call('jar_open', {
    jarPath: `jar://${toUrlPath(fixture.jarPath)}!/com/example/Util.java`,
  });
  assert.equal(result.isError, undefined);
  assert.match(text(result), /Opened .*fixture\.jar.*40 files/);
  assert.match(text(result), /pointed at entry "com\/example\/Util\.java"/);

  // The JAR is usable afterwards through plain entry paths.
  const read = await call('jar_read_file', { filePath: 'com/example/Util.java' });
  assert.equal(read.isError, undefined);
  assert.match(text(read), /class Util/);
});

test('jar_open accepts percent-encoded and unencoded jar:// URLs with spaces', async () => {
  const encoded = await call('jar_open', {
    jarPath: `jar://${toUrlPath(fixture.spacedJarPath).replace(/ /g, '%20')}`,
  });
  assert.equal(encoded.isError, undefined);
  assert.match(text(encoded), /Opened .*my lib\.jar/);

  // IntelliJ sometimes emits URLs with literal spaces instead of %20.
  const raw = await call('jar_open', {
    jarPath: `jar://${toUrlPath(fixture.spacedJarPath)}!/META-INF/MANIFEST.MF`,
  });
  assert.equal(raw.isError, undefined);
});

test('jar_open accepts file:// URLs', async () => {
  const result = await call('jar_open', {
    jarPath: `file:///${toUrlPath(fixture.spacedJarPath)}`,
  });
  assert.equal(result.isError, undefined);
  assert.match(text(result), /Opened .*my lib\.jar/);
});

test('jar_open accepts native file URLs from pathToFileURL', async () => {
  await call('jar_close', { all: true });
  const result = await call('jar_open', {
    jarPath: pathToFileURL(fixture.spacedJarPath).href,
  });
  assert.equal(result.isError, undefined);
  assert.match(text(result), /Opened .*my lib\.jar/);
});

test('jrt:// URLs get a targeted hint from every reference path', async () => {
  const calls = [
    ['jar_open', { jarPath: 'jrt://java.base/java/util/ArrayList.java' }],
    ['jar_list_files', { jarPath: 'jrt://java.base/java/util/ArrayList.java' }],
    ['jar_read_file', { filePath: 'jrt://java.base/java/util/ArrayList.java' }],
    ['jar_find_class', { className: 'jrt://java.base/java/util/ArrayList.java' }],
  ];

  for (const [name, args] of calls) {
    const result = await call(name, args);
    assert.equal(result.isError, true, name);
    assert.match(text(result), /jrt:\/\//, name);
    assert.match(text(result), /src\.zip/, name);
  }
});

test('jar_read_file auto-opens the JAR from a full jar:// reference', async () => {
  await call('jar_close', { all: true });
  const result = await call('jar_read_file', {
    filePath: `jar://${toUrlPath(fixture.jarPath)}!/com/example/Util.java`,
  });
  assert.equal(result.isError, undefined);
  assert.match(text(result), /class Util/);

  // The auto-opened JAR became the current one.
  const list = await call('jar_list_files', { filter: '*.java' });
  assert.equal(list.isError, undefined);
});

test('jar_read_file auto-opens from a bare "path!/entry" reference', async () => {
  await call('jar_close', { all: true });
  const result = await call('jar_read_file', {
    filePath: `${fixture.spacedJarPath}!/com/example/Service.java`,
  });
  assert.equal(result.isError, undefined);
  assert.match(text(result), /class Service/);
});

test('full nested references auto-open the nested JAR', async () => {
  await call('jar_close', { all: true });
  const result = await call('jar_read_file', {
    filePath: `jar://${toUrlPath(fixture.jarPath)}!/BOOT-INF/lib/inner.jar!/com/inner/Deep.java`,
  });
  assert.equal(result.isError, undefined);
  assert.match(text(result), /class Deep/);
});

test('a jar-only reference in filePath fails with guidance', async () => {
  const result = await call('jar_read_file', {
    filePath: `jar://${toUrlPath(fixture.jarPath)}`,
  });
  assert.equal(result.isError, true);
  assert.match(text(result), /without an entry/);
});

test('jarPath lookups tolerate slash direction and (on win32) case variants', async () => {
  await call('jar_close', { all: true });
  // Open via forward-slash path, reference via backslashes.
  await call('jar_open', { jarPath: toUrlPath(fixture.jarPath) });
  const viaBackslash = await call('jar_list_files', { jarPath: fixture.jarPath });
  assert.equal(viaBackslash.isError, undefined);

  if (process.platform === 'win32') {
    const viaCase = await call('jar_search_files', {
      jarPath: fixture.jarPath.toUpperCase(),
      pattern: '*Service*.java',
    });
    assert.equal(viaCase.isError, undefined);
  }
});

test('jar_close accepts jar:// URL references', async () => {
  await call('jar_open', { jarPath: fixture.jarPath });
  const result = await call('jar_close', {
    jarPath: `jar://${toUrlPath(fixture.jarPath)}!/com/example/Util.java`,
  });
  assert.match(text(result), /Successfully closed/);
});

test('jar_close does not auto-open a closed JAR reference', async () => {
  await call('jar_close', { all: true });
  const result = await call('jar_close', {
    jarPath: `jar://${toUrlPath(fixture.jarPath)}!/com/example/Util.java`,
  });
  assert.equal(result.isError, undefined);
  assert.match(text(result), /No open JAR matches/);

  const list = await call('jar_list_files', {});
  assert.equal(list.isError, true);
  assert.match(text(list), /No JAR file is currently open/);
});

test('jar_find_class ignores a trailing "#member" and accepts full references', async () => {
  await call('jar_open', { jarPath: fixture.jarPath });
  const member = await call('jar_find_class', { className: 'com.example.Service#doWork' });
  assert.deepEqual(
    member.structuredContent.classes.map(c => c.path),
    ['com/example/Service.java', 'com/example/Service$Inner.class']
  );

  const ref = await call('jar_find_class', {
    className: `jar://${toUrlPath(fixture.spacedJarPath)}!/com/example/Service.java`,
  });
  assert.deepEqual(
    ref.structuredContent.classes.map(c => c.path),
    ['com/example/Service.java', 'com/example/Service$Inner.class']
  );
});
