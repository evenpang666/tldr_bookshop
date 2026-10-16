import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { root } from '../harness/reader.mjs';
import { launchPatch, readHealth } from '../scripts/launch.mjs';

async function waitFor(check, detail) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(`Timed out: ${detail()}`);
}

test('launcher updates an installed bundle without inserting it twice', () => {
  assert.match(launchPatch({ dataRoot: '/existing/data' }), /^- id: thinbook/);
  const existing = launchPatch({ port: 3210, host: '127.0.0.1', bundled: true });
  assert.match(existing, /^- id: thinbook/); assert.doesNotMatch(existing, /insert:|disabled:|file:/);
  assert.doesNotMatch(existing, /\n  name:/);
});

for (const occupied of [false, true]) test(`environment launcher opens only ThinBook, reuses it, and stops its DSH host (occupied port: ${occupied})`, { skip: process.platform !== 'linux', timeout: 25000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'thinbook-launch-test-'));
  const profile = join(directory, 'profiles/web'), bin = join(directory, 'bin'), log = join(directory, 'opened.log');
  await mkdir(join(profile, 'node_modules'), { recursive: true }); await mkdir(bin);
  const installedDsh = JSON.parse(await readFile(join(root, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version;
  const npmFixture = join(bin, 'npm-fixture.mjs');
  await writeFile(npmFixture, `console.log(process.argv.includes("--version") ? "10.9.9" : JSON.stringify(${JSON.stringify(installedDsh)}));`);
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dependencies: { thinbook: `link:${root}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'thinbook'] } } }));
  await symlink(root, join(profile, 'node_modules/thinbook'), 'dir');
  await writeFile(join(bin, 'xdg-open'), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$THINBOOK_OPEN_LOG"\n', { mode: 0o755 });
  const reservation = http.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  if (!occupied) await new Promise(resolve => reservation.close(resolve));
  else t.after(() => new Promise(resolve => reservation.close(resolve)));
  const dshReservation = http.createServer(); await new Promise(resolve => dshReservation.listen(0, '127.0.0.1', resolve));
  const dshPort = dshReservation.address().port; await new Promise(resolve => dshReservation.close(resolve));
  const env = { ...process.env, npm_execpath: npmFixture, PATH: `${bin}:${process.env.PATH}`, DSH_HOME: directory, DSH_BIN: join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: '', THINBOOK_DATA_DIR: directory, THINBOOK_OPEN_LOG: log, DSH_WEB_PORT: String(dshPort), THINBOOK_PORT: String(port), PORT: String(port), HOST: '127.0.0.1' };
  const launch = () => {
    const child = spawn(process.execPath, [join(root, 'scripts/environment.mjs'), '--open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    const exited = new Promise((resolve, reject) => { child.once('exit', code => resolve(code)); child.once('error', reject); });
    return { child, exited, output: () => output };
  };
  let first;
  try {
    first = launch();
    await waitFor(() => first.output().includes('薄书已就绪'), first.output);
    assert.doesNotMatch(first.output(), /name mismatch/);
    await waitFor(async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').length === 1; } catch { return false; } }, first.output);
    const state = JSON.parse(await readFile(join(directory, '.local/launcher.json'), 'utf8'));
    const actualPort = state.port;
    if (occupied) { assert.notEqual(actualPort, port); assert.equal(reservation.listening, true); }
    else assert.equal(actualPort, port);
    const second = launch(); assert.equal(await second.exited, 0, second.output()); assert.match(second.output(), /已经在运行/);
    await waitFor(async () => (await readFile(log, 'utf8')).trim().split('\n').length === 2, second.output);
    const opened = (await readFile(log, 'utf8')).trim().split('\n').map(value => new URL(value));
    assert.deepEqual(opened.map(url => url.origin + url.pathname), [`http://127.0.0.1:${actualPort}/`, `http://127.0.0.1:${actualPort}/`]);
    assert.ok(opened.every(url => url.search === ''));
    assert.equal((await fetch(`http://127.0.0.1:${actualPort}/`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${actualPort}/api/bootstrap`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${actualPort}/api/bootstrap`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await readHealth(actualPort)).runtime, 'dsh');
    first.child.kill('SIGTERM'); assert.equal(await first.exited, 0, first.output());
    assert.equal(await readHealth(actualPort), null);
  } finally {
    if (first && first.child.exitCode === null && first.child.signalCode === null) { first.child.kill('SIGTERM'); await first.exited; }
    await rm(directory, { recursive: true, force: true });
  }
});
