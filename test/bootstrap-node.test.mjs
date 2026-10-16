import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function fixture(t, { old = false, corrupt = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'thinbook-node-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bin = join(base, 'tools'), project = join(base, 'project'), payload = join(base, 'payload');
  await mkdir(bin); await mkdir(project); await mkdir(payload);
  for (const tool of ['uname', 'mkdir', 'mktemp', 'rm', 'tar', 'gzip', 'awk', 'sha256sum', 'mv', 'dirname']) await symlink(`/usr/bin/${tool}`, join(bin, tool));
  if (old) await writeFile(join(bin, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64', name = `node-v24.99.0-linux-${arch}`;
  const nodeRoot = join(payload, name);
  await mkdir(join(nodeRoot, 'bin'), { recursive: true }); await mkdir(join(nodeRoot, 'lib/node_modules/npm/bin'), { recursive: true });
  await writeFile(join(nodeRoot, 'bin/node'), `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
  await writeFile(join(nodeRoot, 'bin/npm'), `#!/bin/sh\nexec ${quote(process.execPath)} "$(dirname "$0")/../lib/node_modules/npm/bin/npm-cli.js" "$@"\n`, { mode: 0o755 });
  await writeFile(join(nodeRoot, 'lib/node_modules/npm/bin/npm-cli.js'), 'console.log("10.9.9");');
  const archive = join(base, `${name}.tar.gz`);
  await execute('/usr/bin/tar', ['-czf', archive, '-C', payload, name]);
  const hash = corrupt ? '0'.repeat(64) : createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(join(base, 'SHASUMS256.txt'), `${hash}  ${name}.tar.gz\n`);
  await writeFile(join(bin, 'curl'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n case "$1" in --output) out=$2; shift 2 ;; *) url=$1; shift ;; esac\ndone\nprintf "%s\\n" "$url" >> "$THINBOOK_DOWNLOAD_LOG"\ncase "$url" in */SHASUMS256.txt) /bin/cp "$THINBOOK_FIXTURE/SHASUMS256.txt" "$out" ;; *) /bin/cp "$THINBOOK_ARCHIVE" "$out" ;; esac\n', { mode: 0o755 });
  const log = join(base, 'downloads.log');
  const env = { ...process.env, PATH: bin, THINBOOK_FIXTURE: base, THINBOOK_ARCHIVE: archive, THINBOOK_DOWNLOAD_LOG: log };
  const code = `set -eu; THINBOOK_ROOT=${quote(project)}; . ${quote(join(root, 'scripts/bootstrap-node.sh'))}; thinbook_prepare_node; "$THINBOOK_NODE" --version; npm --version`;
  return { base, project, bin, log, run: () => execute('/bin/sh', ['-c', code], { env }) };
}

for (const old of [false, true]) {
  test(`portable Node and npm are installed automatically with ${old ? 'an old Node' : 'no Node or npm'} and reused offline`, { skip: process.platform !== 'linux' }, async t => {
    const setup = await fixture(t, { old });
    const first = await setup.run(); assert.match(first.stdout, /Preparing Node.js/); assert.match(first.stdout, /10\.9\.9/);
    const downloads = (await readFile(setup.log, 'utf8')).trim().split('\n'); assert.equal(downloads.length, 2);
    const second = await setup.run(); assert.doesNotMatch(second.stdout, /Preparing Node.js/);
    assert.equal((await readFile(setup.log, 'utf8')).trim().split('\n').length, 2);
    assert.deepEqual(await readdir(join(setup.project, '.runtime/node')), ['current']);
  });
}

test('a checksum mismatch prevents Node execution and cleans the incomplete installation', { skip: process.platform !== 'linux' }, async t => {
  const setup = await fixture(t, { corrupt: true });
  await assert.rejects(setup.run(), /checksum mismatch/);
  assert.deepEqual(await readdir(join(setup.project, '.runtime/node')), []);
});
