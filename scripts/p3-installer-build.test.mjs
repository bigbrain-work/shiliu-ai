import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/sh.exe' : '/bin/sh';
test('build helpers handle help, reject options and create no output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shiliu-build-args-'));
  try {
    for (const script of ['build-public-site-assets.mjs', 'build-skill-distribution.mjs']) {
      const run = arg => spawnSync(process.execPath, [path.join(repo, 'scripts', script), arg], { cwd: root, encoding: 'utf8', windowsHide: true });
      assert.equal(run('--help').status, 0);
      assert.notEqual(run('--bogus').status, 0);
      assert.deepEqual(await readdir(root), []);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a truncated installer cannot execute its body; EACCES gives user prefix guidance', { skip: !existsSync(shell) }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shiliu-posix-'));
  try {
    const bin = path.join(root, 'bin'); await mkdir(bin);
    for (const [name, script] of Object.entries({ node: 'echo 22.20.0', npm: 'if [ "$1" = --version ]; then echo 10.9.0; else echo EACCES >&2; exit 1; fi' })) {
      const file = path.join(bin, name); await writeFile(file, '#!/bin/sh\n'+script+'\n'); await chmod(file, 0o755);
    }
    const source = await readFile(path.join(repo, 'install.sh'), 'utf8');
    const truncated = path.join(root, 'truncated.sh');
    await writeFile(truncated, source.slice(0, source.lastIndexOf('\nmain "$@"'))+'\n');
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const incomplete = spawnSync(shell, [truncated], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(incomplete.status, 0, incomplete.stderr); assert.equal(incomplete.stdout, '');
    const full = spawnSync(shell, [path.join(repo, 'install.sh')], { env, encoding: 'utf8', windowsHide: true });
    assert.notEqual(full.status, 0);
    assert.match(full.stderr, /user-owned npm prefix/u);
    assert.doesNotMatch(full.stderr, /sudo/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
