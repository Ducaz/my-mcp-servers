// End-to-end tests: drive the MCP server through a Client connected via an
// in-memory transport, exercising the tools exactly like a real MCP host.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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

  const gone = await call('jar_list_files', { jarPath: fixture.innerJarPath });
  assert.equal(gone.isError, true);
});

test('jar_close all=true closes everything', async () => {
  await call('jar_open', { jarPath: fixture.jarPath });
  await call('jar_open', { jarPath: fixture.innerJarPath });
  const result = await call('jar_close', { all: true });
  assert.match(text(result), /Closed 2 JAR file/);

  const after = await call('jar_list_files', {});
  assert.equal(after.isError, true);
});
