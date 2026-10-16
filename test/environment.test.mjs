import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { supportedNode, sessionEnvironment, dependenciesReady, ensureDependencies, prepareEnvironment } from '../scripts/environment.mjs';
import { selectPort } from '../scripts/launch.mjs';
import net from 'node:net';

async function fixture(t, locked = true) {
  const directory = await mkdtemp(join(tmpdir(), 'thinbook-env-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ dependencies: { fixture: '1.0.0' } }));
  if (locked) await writeFile(join(directory, 'package-lock.json'), '{}');
  return directory;
}
async function installFixture(directory) {
  const path = join(directory, 'node_modules/fixture'); await mkdir(path, { recursive: true });
  await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', main: 'index.js' }));
  await writeFile(join(path, 'index.js'), 'module.exports = {};');
}

test('environment detects Node versions and prepares PATH and proxy bypass for this session', () => {
  assert.equal(supportedNode('22.23.3'), false); assert.equal(supportedNode('24.4.0'), false);
  assert.equal(supportedNode('24.5.0'), true); assert.equal(supportedNode('26.0.0'), true);
  const env = { PATH: '/custom/bin', NO_PROXY: 'example.com', no_proxy: 'internal.local', HTTPS_PROXY: 'http://proxy.invalid:1080' };
  const configured = sessionEnvironment(env);
  assert.equal(configured.PATH.split(delimiter)[0], dirname(process.execPath));
  for (const host of ['example.com', 'internal.local', 'localhost', '127.0.0.1', '::1']) assert.ok(configured.NO_PROXY.split(',').includes(host));
  assert.equal(configured.no_proxy, configured.NO_PROXY); assert.equal(configured.HTTPS_PROXY, env.HTTPS_PROXY);
  assert.equal(env.NO_PROXY, 'example.com'); assert.equal(configured.NODE_USE_ENV_PROXY, '1');
});

for (const locked of [true, false]) {
  test(`missing dependencies install automatically with ${locked ? 'npm ci' : 'npm install for a packaged plugin'}`, async t => {
    const directory = await fixture(t, locked);
    await mkdir(join(directory, '.local'), { recursive: true }); await writeFile(join(directory, '.local/preserve.txt'), 'keep private data');
    assert.equal(await dependenciesReady(directory), false);
    let calls = 0;
    const options = {
      directory, log() {}, locateNpm: async () => ({ command: 'test-npm', args: ['npm-cli.js'] }),
      run: async (command, args, config) => {
        calls++; assert.equal(command, 'test-npm'); assert.equal(args[1], locked ? 'ci' : 'install');
        assert.ok(args.includes('--omit=dev')); assert.equal(config.cwd, directory);
        assert.equal(args.includes('--no-package-lock'), !locked); await installFixture(directory);
      },
    };
    await ensureDependencies(options); assert.equal(await dependenciesReady(directory), true);
    await ensureDependencies(options); assert.equal(calls, 1);
    assert.equal(await readFile(join(directory, '.local/preserve.txt'), 'utf8'), 'keep private data');
    await rm(join(directory, 'node_modules/fixture/index.js'));
    await ensureDependencies(options); assert.equal(calls, 2); // Repair an incomplete install, even when package.json survives.
  });
}

test('failed dependency installation stops startup with an actionable error', async t => {
  const directory = await fixture(t);
  await assert.rejects(ensureDependencies({ directory, log() {}, locateNpm: async () => ({ command: 'test-npm', args: [] }), run: async () => { throw new Error('offline'); } }), /依赖自动配置失败.*offline/);
});

test('preflight creates writable cache and runtime directories and returns a session environment', async t => {
  const directory = await fixture(t); await installFixture(directory);
  const configured = await prepareEnvironment({ directory, log() {} });
  await writeFile(join(directory, '.runtime/probe'), 'ok'); await writeFile(join(directory, '.local/readings/probe'), 'ok');
  assert.equal(configured.NODE_USE_ENV_PROXY, '1');
});

test('an unusable runtime directory stops setup before installing dependencies', async t => {
  const directory = await fixture(t);
  await writeFile(join(directory, '.runtime'), 'existing file');
  await assert.rejects(prepareEnvironment({ directory, log() {}, run: async () => assert.fail('unexpected install') }), /环境目录不可写/);
  assert.equal(await readFile(join(directory, '.runtime'), 'utf8'), 'existing file');
});

test('an occupied port is replaced without disturbing the listening application', async t => {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const preferred = server.address().port, messages = [];
  const selected = await selectPort(preferred, '127.0.0.1', message => messages.push(message));
  assert.notEqual(selected, preferred); assert.equal(server.listening, true); assert.equal(messages.length, 1);
  assert.equal(await selectPort(selected, '127.0.0.1'), selected);
});
