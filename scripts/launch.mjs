import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { openBrowser } from '../lib/browser.mjs';
import { registerThinbook, thinbookInstalled } from './register-plugin.mjs';
import { ensureDsh } from './dsh-runtime.mjs';
import { dshHome, registeredThinbook, runningDsh, startupLock, installProfilePatch } from './dsh-host.mjs';

const execute = promisify(execFile);

const root = fileURLToPath(new URL('../', import.meta.url));

export function readHealth(port) {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/thinbook/api/health', timeout: 500 }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; if (data.length > 4096) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(null));
  });
}

export function launchPatch({ dataRoot = root } = {}) {
  // The installed bundle owns the row; this patch configures it without inserting it again.
  return `- id: thinbook\n  config:\n    dataRoot: ${JSON.stringify(dataRoot)}\n`;
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
  const preferred = Number(process.env.DSH_WEB_PORT || (process.env.DSH_WEB_URL ? new URL(process.env.DSH_WEB_URL).port || 80 : 3080));
  if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65535) throw new Error('DSH_WEB_PORT 必须为 1–65535。');
  const home = dshHome(), dataRoot = process.env.THINBOOK_DATA_DIR || root;
  // Check even when an already-running ThinBook could be reused immediately.
  const runtime = await ensure();
  const statePath = join(dataRoot, '.local', 'launcher.json');
  const reuse = async () => {
    const record = await registeredThinbook(home, readHealth);
    if (!record) return false;
    const url = `http://127.0.0.1:${record.port}${record.basePath}/`;
    console.log(`薄书已经在运行：${url} · 复用现有 DSH 服务`);
    if (open) openBrowser(record.url || url);
    return true;
  };
  if (await thinbookInstalled(home, root)) {
    await registerThinbook({ home, root, runtime });
    if (await reuse()) return;
  }
  let release = await startupLock(home);
  let child, exited, stop;
  try {
    if (await thinbookInstalled(home, root) && await reuse()) return;
    const processes = await detect({ home });
    const profile = join(home, 'profiles/web');
    if (!processes.length) {
      await execute(runtime.command, [...runtime.args, '--profile', 'web', '--dump-default-config'], { env: process.env, timeout: 15000, windowsHide: true });
    }
    await registerThinbook({ home, root, runtime });
    if (await reuse()) return;
    await installProfilePatch(home, launchPatch({ dataRoot }));
    if (processes.length) {
      console.log('检测到已运行的 DSH Web，正在热加载薄书；不会启动第二个 DSH 服务…');
    } else {
      const appeared = await detect({ home });
      if (appeared.length) console.log('DSH Web 已启动，正在接入现有服务…');
      else {
        const port = await selectPort(preferred, '127.0.0.1');
        child = spawn(runtime.command, [...runtime.args, '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
        exited = new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })); });
        exited.catch(() => {});
        stop = () => child.kill('SIGTERM');
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
      }
    }
    const deadline = Date.now() + (child ? 60000 : attachTimeout);
    let record, finished = false;
    exited?.then(() => { finished = true; }, () => { finished = true; });
    while (!finished && Date.now() < deadline) {
      record = await registeredThinbook(home, readHealth);
      if (record) break;
      await new Promise(done => setTimeout(done, 200));
    }
    if (!record) {
      if (child) { stop(); await exited; throw new Error('DSH 插件未能启动，请检查上方日志、端口和依赖。'); }
      throw new Error('已检测到 DSH Web，但薄书未完成热加载。请检查该服务是否启用 HMR，必要时重启原 DSH 服务；未启动第二个 DSH Web。');
    }
    const url = `http://127.0.0.1:${record.port}${record.basePath}/`;
    await remember(statePath, { port: record.port, preferred, dshPid: record.pid, owned: Boolean(child) });
    console.log(`薄书已就绪：${url}${child ? ' · 关闭此窗口可停止本次启动的 DSH' : ' · 已复用 DSH，关闭此窗口不会停止原服务'}`);
    if (open) openBrowser(record.url || url);
    await release(); release = async () => {};
    if (exited) { const result = await exited; if (result.code) process.exitCode = result.code; }
  } finally {
    if (stop) { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    await release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
