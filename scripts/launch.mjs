import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { openBrowser } from '../lib/browser.mjs';
import { ensureDsh } from './dsh-runtime.mjs';
import { dshHome, registeredThinbook, runningDsh, startupLock, installProfilePatch } from './dsh-host.mjs';

const execute = promisify(execFile);

const root = fileURLToPath(new URL('../', import.meta.url));

export function readHealth(port) {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/health', timeout: 500 }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; if (data.length > 4096) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(null));
  });
}

export function launchPatch({ port, host, dataRoot = root, bundled = false }) {
  // DSH treats a patch's name as an identity guard. A bundled row must keep
  // its original module name, otherwise DSH skips the entire configuration.
  const moduleName = bundled ? '' : `  name: ${JSON.stringify(pathToFileURL(join(root, 'plugin/index.mjs')).href)}\n`;
  const entry = `- id: thinbook\n${moduleName}  disabled: false\n  config:\n    port: ${port}\n    host: ${JSON.stringify(host)}\n    dataRoot: ${JSON.stringify(dataRoot)}\n`;
  return bundled ? entry : '- insert:\n' + entry.split('\n').filter(Boolean).map(line => `    ${line}`).join('\n') + '\n';
}

export async function selectPort(preferred, host, log = console.log) {
  const probe = port => new Promise((done, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, host, () => { const selected = server.address().port; server.close(error => error ? reject(error) : done(selected)); });
  });
  try { return await probe(preferred); }
  catch (error) {
    if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    const selected = await probe(0);
    log(`端口 ${preferred} 不可用，已自动选择 ${selected}。`);
    return selected;
  }
}

async function remember(statePath, data) {
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, statePath);
  } catch { console.log('无法保存启动地址，下次启动将重新检测端口。'); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}

export async function main({ open = process.argv.includes('--open'), detect = runningDsh, ensure = ensureDsh, attachTimeout = 15000 } = {}) {
  if (!process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) throw new Error('请使用 Node.js 24.5+。');
  const preferred = Number(process.env.PORT || 3210), host = process.env.HOST || '0.0.0.0';
  if (!Number.isInteger(preferred) || preferred < 1024 || preferred > 65535) throw new Error('PORT 必须为 1024–65535。');
  const home = dshHome(), dataRoot = process.env.THINBOOK_DATA_DIR || root;
  const statePath = join(dataRoot, '.local', 'launcher.json');
  const reuse = async () => {
    const registered = await registeredThinbook(home, readHealth);
    let previous;
    try { previous = JSON.parse(await readFile(statePath, 'utf8')).port; } catch {}
    for (const candidate of [registered?.port, previous, preferred]) {
      if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65535) continue;
      const health = await readHealth(candidate);
      if (health?.app === 'thinbook' && health.runtime === 'dsh') {
        const url = `http://127.0.0.1:${candidate}`;
        console.log(`薄书已经在运行：${url} · 复用现有 DSH 服务`);
        if (open) openBrowser(url);
        return true;
      }
    }
    return false;
  };
  if (await reuse()) return;
  let release = await startupLock(home);
  let child, exited, stop;
  try {
    if (await reuse()) return;
    const processes = await detect({ home });
    const port = await selectPort(preferred, host), url = `http://127.0.0.1:${port}`;
    const profile = join(home, 'profiles/web');
    let runtime;
    if (!processes.length) {
      runtime = await ensure();
      // Let DSH initialize its own profile. This command starts no Web server.
      await execute(runtime.command, [...runtime.args, '--profile', 'web', '--dump-default-config'], { env: process.env, timeout: 15000, windowsHide: true });
    }
    let bundled = false;
    try { bundled = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).dsh?.profile?.bundles?.includes('thinbook') || false; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await installProfilePatch(home, launchPatch({ port, host, bundled, dataRoot }));
    if (processes.length) {
      console.log('检测到已运行的 DSH Web，正在热加载薄书；不会启动第二个 DSH 服务…');
    } else {
      // Recheck immediately before spawning, including DSH started externally
      // while this launcher was checking updates or writing configuration.
      const appeared = await detect({ home });
      if (appeared.length) console.log('DSH Web 已启动，正在接入现有服务…');
      else {
        child = spawn(runtime.command, [...runtime.args, '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: host }, stdio: 'inherit', windowsHide: true });
        exited = new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })); });
        exited.catch(() => {});
        stop = () => child.kill('SIGTERM');
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
      }
    }
    const deadline = Date.now() + (child ? 60000 : attachTimeout);
    let ready = false, finished = false;
    exited?.then(() => { finished = true; }, () => { finished = true; });
    while (!finished && Date.now() < deadline) {
      const health = await readHealth(port);
      if (health?.app === 'thinbook' && health.runtime === 'dsh') { ready = true; break; }
      await new Promise(done => setTimeout(done, 200));
    }
    if (!ready) {
      if (child) { stop(); await exited; throw new Error('DSH 插件未能启动，请检查上方日志、端口和依赖。'); }
      throw new Error('已检测到 DSH Web，但薄书未完成热加载。请检查该服务是否启用 HMR，必要时重启原 DSH 服务；未启动第二个 DSH Web。');
    }
    await remember(statePath, { port, preferred, host, dshPid: child?.pid || processes[0], owned: Boolean(child) });
    console.log(`薄书已就绪：${url}${child ? ' · 关闭此窗口可停止本次启动的 DSH' : ' · 已复用 DSH，关闭此窗口不会停止原服务'}`);
    if (open) openBrowser(url);
    await release(); release = async () => {};
    if (exited) { const result = await exited; if (result.code) process.exitCode = result.code; }
  } finally {
    if (stop) { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    await release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
