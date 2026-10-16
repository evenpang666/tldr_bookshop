import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { isDshWebCommand, profilePatch, installProfilePatch, runningDsh, startupLock } from '../scripts/dsh-host.mjs';
import { readHealth } from '../scripts/launch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fragment = '- insert:\n    - id: thinbook\n      name: thinbook\n';
const waitFor = async (condition, detail, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await condition()) return; await new Promise(done => setTimeout(done, 50)); }
  throw new Error(`Timed out: ${detail()}`);
};
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'thinbook-existing-dsh-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
async function freePort() {
  const server = net.createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}
function launch(file, args, env) {
  const child = spawn(process.execPath, [file, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
  const exited = new Promise((done, reject) => { child.once('exit', code => done(code)); child.once('error', reject); });
  return { child, exited, output: () => output };
}

test('process discovery distinguishes DSH Web from SDK, package commands and ordinary scripts', () => {
  const cli = '/prefix/node_modules/@deepseek-ai/dsh/lib/bin.js';
  for (const options of [[], ['web'], ['--profile', 'web', '--no-open'], ['--profile=web']]) assert.equal(isDshWebCommand(['node', cli, ...options]), true);
  for (const options of [['sdk'], ['headless'], ['--profile', 'sdk'], ['plugin', '--profile', 'web'], ['--dump-default-config']]) assert.equal(isDshWebCommand(['node', cli, ...options]), false);
  assert.equal(isDshWebCommand(['node', '/project/scripts/launch.mjs']), false);
  assert.equal(isDshWebCommand(['node.exe', 'C:\\prefix\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', 'web']), true);
});

test('managed profile edits preserve user YAML and replace only the ThinBook block', async t => {
  const home = await directory(t), original = '# User settings\n- id: whereto\n  config:\n    port: 3789\n';
  const next = profilePatch(original, fragment);
  assert.ok(next.startsWith(original)); assert.equal(profilePatch(next, fragment), next);
  assert.equal(profilePatch('# Default profile\n[]\n', fragment).includes('\n[]\n'), false);
  assert.ok(profilePatch('[{"id":"whereto","disabled":false}]', fragment).includes('"id":"whereto"'));
  assert.throws(() => profilePatch('# >>> thinbook launcher >>>\n', fragment), /标记不完整/);
  await mkdir(join(home, 'profiles/web'), { recursive: true }); await writeFile(join(home, 'profiles/web/cordis.patch.yml'), original);
  await installProfilePatch(home, fragment); assert.equal(await readFile(join(home, 'profiles/web/cordis.patch.yml'), 'utf8'), next);
});

test('startup lock serializes two launchers', async t => {
  const home = await directory(t), release = await startupLock(home);
  let acquired = false;
  const waiting = startupLock(home).then(release => { acquired = true; return release; });
  await new Promise(done => setTimeout(done, 150)); assert.equal(acquired, false);
  await release(); const releaseSecond = await waiting; assert.equal(acquired, true); await releaseSecond();
});

for (const hmr of [true, false]) test(`existing DSH Web is reused without reloading an exclusive-port plugin (HMR: ${hmr})`, { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const home = await directory(t), profile = join(home, 'profiles/web'), log = join(home, 'plugin-activations.log');
  const port = await freePort(), pluginPort = await freePort();
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
  const userPatch = `# Existing third-party plugin; keep unchanged\n${hmr ? '' : '- id: hmr\n  disabled: true\n'}- insert:\n    - id: whereto\n      name: ${JSON.stringify(pathToFileURL(join(root, 'scripts/fixtures/listening-plugin.mjs')).href)}\n      config:\n        port: ${pluginPort}\n        log: ${JSON.stringify(log)}\n`;
  await writeFile(join(profile, 'cordis.patch.yml'), userPatch);
  const npmFixture = join(home, 'npm.mjs');
  await writeFile(npmFixture, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(join(home, 'npm.log'))}, process.argv.slice(2).join(' ')+'\\n'); console.log('10.9.9');`);
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: '', HOST: '127.0.0.1', PORT: String(port), THINBOOK_DATA_DIR: home, npm_execpath: npmFixture };
  const host = launch(join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), ['--profile', 'web', '--no-open', '--port', '0'], env);
  let launcher;
  try {
    await waitFor(() => host.output().includes('dsh web:'), host.output);
    assert.ok((await runningDsh({ home })).length > 0);
    if (hmr) launcher = launch(join(root, 'scripts/environment.mjs'), [], env);
    else {
      const wrapper = join(home, 'launch.mjs');
      await writeFile(wrapper, `import { main } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/launch.mjs')).href)}; main({open:false,attachTimeout:600}).catch(error=>{console.error(error.message);process.exitCode=1});`);
      launcher = launch(wrapper, [], env);
    }
    const code = await launcher.exited;
    assert.equal(code, hmr ? 0 : 1, `${launcher.output()}\n${host.output()}`);
    assert.equal(host.child.exitCode, null); assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
    assert.doesNotMatch(host.output() + launcher.output(), /EADDRINUSE|entry did not activate/);
    assert.ok((await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).startsWith(userPatch));
    if (hmr) {
      assert.match(launcher.output(), /复用 DSH/); const endpoint = JSON.parse(await readFile(join(home, 'thinbook/host.json'), 'utf8')); assert.equal((await readHealth(endpoint.webPort)).runtime, 'dsh'); assert.notEqual(endpoint.port, endpoint.webPort); assert.equal(endpoint.basePath, ''); assert.equal((await fetch(endpoint.url)).status, 200);
      assert.equal(JSON.parse(await readFile(join(home, 'thinbook/host.json'), 'utf8')).pid, host.child.pid);
      const again = launch(join(root, 'scripts/environment.mjs'), [], env);
      assert.equal(await again.exited, 0, again.output()); assert.match(again.output(), /已经在运行/);
      const configure = launch(join(root, 'scripts/environment.mjs'), ['--dsh', 'web', '--no-open'], env);
      assert.equal(await configure.exited, 0, configure.output()); assert.match(configure.output(), /复用现有 DSH Web/);
      assert.equal(host.child.exitCode, null); assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
      assert.ok(!(await readFile(join(home, 'npm.log'), 'utf8')).includes('view'));
    } else assert.match(launcher.output(), /未启动第二个/);
  } finally {
    if (launcher && launcher.child.exitCode === null && launcher.child.signalCode === null) { launcher.child.kill('SIGTERM'); await launcher.exited; }
    host.child.kill('SIGTERM'); const force = setTimeout(() => host.child.kill('SIGKILL'), 5000); await host.exited; clearTimeout(force);
  }
});
