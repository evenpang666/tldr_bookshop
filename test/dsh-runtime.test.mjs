import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureDsh as ensureRuntime, findDsh, installDsh as installRuntime, latestDshVersion, readDshVersion } from '../scripts/dsh-runtime.mjs';

const latestVersion = '1.2.3';
const ensureDsh = options => ensureRuntime({ latest: async () => latestVersion, ...options });
const installDsh = (directory, options) => installRuntime(directory, { version: latestVersion, ...options });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'thinbook-runtime-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function fakeDsh(directory, version = latestVersion) {
  const bin = join(directory, 'node_modules/@deepseek-ai/dsh/lib');
  await mkdir(bin, { recursive: true });
  const entry = join(bin, 'bin.js');
  await writeFile(entry, `console.log(${JSON.stringify(version)});\n`);
  return { command: process.execPath, args: [entry] };
}

test('latest DSH is reused without running an installer', async () => {
  const existing = { command: 'existing-dsh', args: [] };
  assert.equal(await ensureDsh({ locate: async () => existing, versionOf: async () => latestVersion, install: async () => assert.fail('unexpected install'), log() {} }), existing);
});

test('an already managed latest DSH is reused when system DSH is older', async t => {
  const directory = await fixture(t);
  await fakeDsh(directory);
  const runtime = await ensureDsh({ directory, locate: async () => ({ command: process.execPath, args: ['-e', "console.log('0.1.0')"] }), install: async () => assert.fail('unexpected install'), log() {} });
  assert.equal(await readDshVersion(runtime), latestVersion);
  assert.equal(runtime.args[0], join(directory, 'node_modules/@deepseek-ai/dsh/lib/bin.js'));
});

for (const detected of [null, '0.1.0', 'broken']) {
  test(`missing, older or broken DSH (${detected}) installs, verifies and reuses a managed runtime`, async t => {
    const base = await fixture(t), directory = join(base, latestVersion), messages = [];
    const env = { ...process.env, DSH_HOME: base, DEEPSEEK_API_KEY: 'test-key-must-not-be-rewritten' };
    await writeFile(join(base, '.credentials.yaml'), 'keep existing credentials');
    const existing = detected === null ? null : detected === 'broken' ? { command: join(base, 'nonexistent-dsh'), args: [] } : await fakeDsh(join(base, 'system'), detected);
    let installs = 0;
    const install = async (target, options) => installDsh(target, {
      ...options,
      locateNpm: async passed => { assert.equal(passed, env); return { command: 'test-npm', args: ['npm-cli.js'] }; },
      run: async (command, args, options) => {
        installs++;
        assert.equal(command, 'test-npm'); assert.equal(args[0], 'npm-cli.js');
        assert.ok(args.includes(`@deepseek-ai/dsh@${latestVersion}`)); assert.ok(args.includes('--no-save')); assert.ok(args.includes('--no-package-lock'));
        assert.equal(options.env, env);
        const staging = args[args.indexOf('--prefix') + 1];
        assert.notEqual(staging, target); assert.equal(options.cwd, staging);
        await fakeDsh(staging);
      },
    });
    const options = { env, directory, locate: async () => existing, install, log: message => messages.push(message) };
    const runtime = await ensureDsh(options);
    assert.equal(installs, 1); assert.equal(await readDshVersion(runtime), latestVersion);
    assert.ok(messages.some(message => message.includes('安装或升级完成')));
    assert.deepEqual(await ensureDsh(options), runtime); assert.equal(installs, 1);
    assert.equal(await readFile(join(base, '.credentials.yaml'), 'utf8'), 'keep existing credentials');
    assert.ok((await readdir(base)).every(name => !name.startsWith('.install-')));
    if (detected === '0.1.0') assert.equal(await readDshVersion(existing), detected);
  });
}

test('failed installation keeps the old managed runtime and removes temporary downloads', async t => {
  const base = await fixture(t), directory = join(base, latestVersion);
  const old = await fakeDsh(directory, '0.1.0');
  const options = {
    locateNpm: async () => ({ command: 'test-npm', args: [] }),
    run: async () => { throw new Error('offline'); },
  };
  await assert.rejects(ensureDsh({ directory, locate: async () => null, install: target => installDsh(target, options), log() {} }), /自动安装或升级失败.*offline.*重新启动/);
  assert.equal(await readDshVersion(old), '0.1.0');
  assert.deepEqual(await readdir(base), [latestVersion]);
});

test('wrong downloaded version is rejected before replacing an old runtime', async t => {
  const base = await fixture(t), directory = join(base, latestVersion);
  const old = await fakeDsh(directory, '0.1.0');
  await assert.rejects(installDsh(directory, {
    locateNpm: async () => ({ command: 'test-npm', args: [] }),
    run: async (_command, args) => { await fakeDsh(args[args.indexOf('--prefix') + 1], '0.0.0'); },
  }), /版本校验失败/);
  assert.equal(await readDshVersion(old), '0.1.0'); assert.deepEqual(await readdir(base), [latestVersion]);
});

test('a broken managed runtime can be repaired after the replacement passes verification', async t => {
  const base = await fixture(t), directory = join(base, latestVersion);
  await fakeDsh(directory, '0.1.0');
  await installDsh(directory, {
    locateNpm: async () => ({ command: 'test-npm', args: [] }),
    run: async (_command, args) => { await fakeDsh(args[args.indexOf('--prefix') + 1]); },
  });
  assert.equal(await readDshVersion(await findDsh({ DSH_BIN: join(directory, 'node_modules/@deepseek-ai/dsh/lib/bin.js') })), latestVersion);
  assert.deepEqual(await readdir(base), [latestVersion]);
});


test('latest version is queried from npm latest tag without a compatibility range', async () => {
  const version = await latestDshVersion({
    locateNpm: async () => ({ command: 'test-npm', args: ['npm-cli.js'] }),
    run: async (command, args) => {
      assert.equal(command, 'test-npm');
      assert.deepEqual(args, ['npm-cli.js', 'view', '@deepseek-ai/dsh@latest', 'version', '--json', '--prefer-online']);
      return { stdout: JSON.stringify('9.0.0-rc.1') };
    },
  });
  assert.equal(version, '9.0.0-rc.1');
});

test('offline update check reuses an installed runtime and explains the fallback', async () => {
  const existing = { command: 'existing-dsh', args: [] }, messages = [];
  const runtime = await ensureRuntime({ locate: async () => existing, versionOf: async runtime => runtime === existing ? '1.0.0' : null, latest: async () => { throw new Error('offline'); }, install: async () => assert.fail('unexpected install'), log: message => messages.push(message) });
  assert.equal(runtime, existing); assert.ok(messages.some(message => message.includes('无法检查 DSH 更新')));
});

test('a fresh install reports network failure when the latest version cannot be queried', async () => {
  await assert.rejects(ensureRuntime({ locate: async () => null, versionOf: async () => null, latest: async () => { throw new Error('offline'); }, log() {} }), /无法查询 DSH 最新版本/);
});
