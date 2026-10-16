import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { REQUIRED_DSH, compareVersions, ensureDshVersion, registrationCurrent, rememberRegistration } from '../scripts/dsh-version.mjs';

test('minimum comparison handles rc ordering, releases, build metadata and newer versions', () => {
  for (const [left, right, expected] of [
    ['0.1.5-rc.1', REQUIRED_DSH, -1], ['0.2.0-rc.1', REQUIRED_DSH, -1],
    [REQUIRED_DSH, REQUIRED_DSH, 0], ['0.2.0-rc.10', REQUIRED_DSH, 1],
    ['0.2.0', REQUIRED_DSH, 1], ['0.2.1-alpha.5', REQUIRED_DSH, 1],
    ['0.2.0+build.1', '0.2.0', 0], ['0.2.0-1', '0.2.0-alpha', -1],
  ]) assert.equal(compareVersions(left, right), expected);
  assert.throws(() => compareVersions('broken', REQUIRED_DSH), /版本/);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'managed', REQUIRED_DSH), old = join(root, 'old.mjs');
  writeFileSync(old, 'original installation');
  const calls = [];
  const entry = prefix => join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  const put = (prefix, version) => {
    mkdirSync(dirname(entry(prefix)), { recursive: true });
    writeFileSync(entry(prefix), version);
  };
  const run = (_command, args) => {
    calls.push(args);
    if (args.includes('install')) { put(args[args.indexOf('--prefix') + 1], REQUIRED_DSH); return { status: 0 }; }
    return { status: 0, stdout: readFileSync(args[0], 'utf8') };
  };
  return { root, directory, cli: old, version: '0.1.5-rc.1', npm: 'npm-cli.js', env: { DSH_HOME: root }, log() {}, calls, run, entry, put };
}

test('satisfied versions are never downgraded or installed', () => {
  for (const version of [REQUIRED_DSH, '0.2.0', '1.0.0']) {
    const checked = ensureDshVersion({ cli: 'existing', version, run() { assert.fail('no command expected'); } });
    assert.deepEqual(checked, { cli: 'existing', version, upgraded: false });
  }
});

test('old or missing DSH installs once, verifies before publishing, then reuses the shared runtime', t => {
  const f = fixture(t);
  const checked = ensureDshVersion(f);
  assert.equal(checked.version, REQUIRED_DSH); assert.equal(checked.cli, f.entry(f.directory));
  assert.equal(readFileSync(f.cli, 'utf8'), 'original installation');
  assert.equal(f.calls.filter(args => args.includes('install')).length, 1);
  assert.ok(f.calls[0].includes(`@deepseek-ai/dsh@${REQUIRED_DSH}`));
  assert.equal(f.calls.some(args => args.includes('view')), false);
  assert.deepEqual(readdirSync(dirname(f.directory)), [REQUIRED_DSH]);
  assert.equal(ensureDshVersion({ ...f, cli: undefined, version: undefined }).cli, checked.cli);
  assert.equal(f.calls.filter(args => args.includes('install')).length, 1);
});

test('failed download or wrong version preserves the old runtime and cleans partial installations', t => {
  const f = fixture(t);
  for (const wrongVersion of [false, true]) {
    assert.throws(() => ensureDshVersion({ ...f, run(command, args) {
      if (args.includes('install')) {
        if (!wrongVersion) return { status: 1 };
        f.put(args[args.indexOf('--prefix') + 1], '0.1.0'); return { status: 0 };
      }
      return f.run(command, args);
    } }), /升级失败|版本校验失败/);
    assert.equal(readFileSync(f.cli, 'utf8'), 'original installation');
    assert.equal(existsSync(f.directory), false);
    assert.deepEqual(readdirSync(dirname(f.directory)), []);
  }
});

test('an invalid managed installation is replaced only after the download passes verification', t => {
  const f = fixture(t); f.put(f.directory, '0.1.0');
  assert.equal(ensureDshVersion(f).version, REQUIRED_DSH);
  assert.equal(readFileSync(f.entry(f.directory), 'utf8'), REQUIRED_DSH);
  assert.deepEqual(readdirSync(dirname(f.directory)), [REQUIRED_DSH]);
});

test('registration records success per plugin and becomes stale when the runtime changes', t => {
  const f = fixture(t), name = 'test-plugin';
  assert.equal(registrationCurrent(f.root, name, REQUIRED_DSH), false);
  rememberRegistration(f.root, name, REQUIRED_DSH);
  assert.equal(registrationCurrent(f.root, name, REQUIRED_DSH), true);
  assert.equal(registrationCurrent(f.root, name, '0.2.0'), false);
  assert.equal(registrationCurrent(f.root, 'other-plugin', REQUIRED_DSH), false);
});
