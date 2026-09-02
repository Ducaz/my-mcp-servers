// Shared test fixtures: builds JAR files with the zip-builder and writes
// them to a temp directory.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildZip } from './zip-builder.mjs';

/**
 * A JAR-shaped fixture with:
 *  - com/example/Service.java (4 lines containing "token")
 *  - com/example/Util.java, com/example/service.java (lowercase, for
 *    case-insensitive fallback), com/example/Filler1..30.java
 *  - META-INF/MANIFEST.MF, config/app.properties, text with a long line,
 *    a binary file, and a nested JAR (BOOT-INF/lib/inner.jar)
 */
export async function createFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jar-reader-test-'));

  const serviceJava = [
    'package com.example;',
    'public class Service {',
    '  // token line 1',
    '  // token line 2',
    '  // token line 3',
    '  // token line 4',
    '}',
  ].join('\n');

  const utilJava = 'package com.example;\nclass Util {}\n';
  const lowercaseJava = 'package com.example;\nclass service {}\n';

  const filler = (i) => `package com.example;\nclass Filler${i} {}\n`;

  const innerJar = buildZip([
    { name: 'com/inner/Deep.java', data: 'package com.inner;\npublic class Deep {}\n' },
    { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\n' },
  ]);

  const binaryData = Buffer.concat([
    Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x01, 0x02]),
    Buffer.alloc(64, 7),
  ]);

  const entries = [
    { name: 'com/' , isDir: true },
    { name: 'com/example/', isDir: true },
    { name: 'com/example/Service.java', data: serviceJava },
    { name: 'com/example/Util.java', data: utilJava },
    { name: 'com/example/service.java', data: lowercaseJava },
    ...Array.from({ length: 30 }, (_, i) => ({
      name: `com/example/Filler${i + 1}.java`,
      data: filler(i + 1),
    })),
    { name: 'com/example/Service$Inner.class', data: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) },
    { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\nImplementation-Title: fixture\n' },
    { name: 'config/app.properties', data: 'key=value\nother.token=here\n' },
    { name: 'docs/README.md', data: '# readme\nsome token in markdown\n' },
    { name: 'big/long-line.txt', data: `start ${'x'.repeat(2000)} token end\n` },
    { name: 'binary/blob.dat', data: binaryData },
    { name: 'BOOT-INF/lib/inner.jar', data: innerJar },
  ];

  const jarPath = path.join(dir, 'fixture.jar');
  await fs.writeFile(jarPath, buildZip(entries));

  // A copy under a path containing spaces, for URL percent-encoding tests.
  const spacedDir = path.join(dir, 'my libs');
  await fs.mkdir(spacedDir);
  const spacedJarPath = path.join(spacedDir, 'my lib.jar');
  await fs.writeFile(spacedJarPath, buildZip(entries));

  const notAZipPath = path.join(dir, 'not-a-jar.jar');
  await fs.writeFile(notAZipPath, Buffer.from('this is definitely not a zip file'));

  const missingPath = path.join(dir, 'does-not-exist.jar');

  return {
    dir,
    jarPath,
    spacedJarPath,
    innerJarPath: `${jarPath}!/BOOT-INF/lib/inner.jar`,
    notAZipPath,
    missingPath,
    serviceJava,
    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
