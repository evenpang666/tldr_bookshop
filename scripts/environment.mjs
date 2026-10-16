import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findNpm, ensureDsh, runInstaller } from './dsh-runtime.mjs';
import { dshHome, endpointPath, registeredThinbook, runningDsh } from './dsh-host.mjs';
import { openBrowser } from '../lib/browser.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);

export function supportedNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major > 24 || major === 24 && minor >= 5;
}

export function sessionEnvironment(env = process.env, node = process.execPath) {
  const bypass = [...new Set([env.NO_PROXY, env.no_proxy, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',').split(',').map(value => value.trim()).filter(Boolean))].join(',');
  const paths = [...new Set([dirname(node), ...(env.PATH || env.Path || '').split(delimiter).filter(Boolean)])];
  return { ...env, PATH: paths.join(delimiter), NO_PROXY: bypass, no_proxy: bypass, NODE_USE_ENV_PROXY: '1' };
}

export async function dependenciesReady(directory = root) {
  try {
    const { dependencies = {} } = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const require = createRequire(join(directory, 'package.json'));
    for (const [name, version] of Object.entries(dependencies)) {
      const installed = JSON.parse(await readFile(join(directory, 'node_modules', name, 'package.json'), 'utf8'));
      if (installed.version !== version) return false;
      await access(require.resolve(name), constants.R_OK);
    }
    return true;
  } catch { return false; }
}

export async function ensureDependencies({ directory = root, env = process.env, locateNpm = findNpm, run = runInstaller, log = console.log } = {}) {
  if (await dependenciesReady(directory)) { log('项目依赖 · 检查通过'); return; }
  log('项目依赖缺失或损坏，正在自动安装或修复…');
  const npm = await locateNpm(env);
  let locked = true;
  try { await access(join(directory, 'package-lock.json')); } catch { locked = false; }
  const args = [locked ? 'ci' : 'install', '--omit=dev', '--no-audit', '--no-fund'];
  if (!locked) args.push('--no-package-lock');
  try {
    await run(npm.command, [...npm.args, ...args], { cwd: directory, env });
    if (!await dependenciesReady(directory)) throw new Error('安装后依赖校验未通过');
  } catch (error) { throw new Error(`依赖自动配置失败：${error.message}。请检查网络与项目目录写入权限后重试。`); }
  log('项目依赖 · 自动配置完成');
}

export async function prepareEnvironment({ directory = root, dataRoot = process.env.THINBOOK_DATA_DIR || directory, env = process.env, log = console.log, ...options } = {}) {
  const prepared = sessionEnvironment(env);
  for (const path of [join(directory, '.runtime'), join(dataRoot, '.local', 'readings')]) {
    try {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const probe = await mkdtemp(join(path, '.write-check-'));
      await rm(probe, { recursive: true, force: true });
    } catch { throw new Error(`环境目录不可写：${path}。请将项目放到可写目录，或设置 THINBOOK_DATA_DIR。`); }
  }
  await ensureDependencies({ directory, env: prepared, log, ...options });
  return prepared;
}

async function npmReady(env) {
  try {
    const npm = await findNpm(env);
    const result = await execute(npm.command, [...npm.args, '--version'], { env, timeout: 10000, windowsHide: true });
    return /^\d+\.\d+\.\d+/.test(result.stdout.trim());
  } catch { return false; }
}

async function main() {
  const args = process.argv.slice(2);
  const env = sessionEnvironment();
  if (!supportedNode() || !await npmReady(env)) {
    if (process.env.THINBOOK_BOOTSTRAPPED) throw new Error('自动配置后的 Node.js 或 npm 仍不可用，请检查上方下载或系统错误。');
    console.log('Node.js 或 npm 不满足要求，正在自动配置运行环境…');
    const windows = process.platform === 'win32';
    const forwarded = args.length ? args : ['--no-open'];
    await runInstaller(windows ? 'powershell.exe' : 'sh', windows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/bootstrap-node.ps1')] : [join(root, 'start.sh'), ...forwarded], { cwd: root, env: { ...env, THINBOOK_BOOTSTRAP_ARGS: JSON.stringify(forwarded) } });
    return;
  }
  Object.assign(process.env, await prepareEnvironment({ env }));
  console.log(`运行环境 · Node.js ${process.versions.node} / npm 就绪`);
  if (args[0] === '--dsh') {
    const forwarded = args.slice(1);
    const web = forwarded[0] === 'web' || forwarded[0] === '--profile' && forwarded[1] === 'web' || forwarded[0] === '--profile=web';
    if (web) {
      const { main: launch, readHealth } = await import('./launch.mjs');
      const home = dshHome();
      if (await registeredThinbook(home, readHealth) || (await runningDsh({ home })).length) {
        await launch({ open: false });
        const record = JSON.parse(await readFile(endpointPath(home), 'utf8'));
        if (Number.isInteger(record.webPort) && record.webPort > 0) {
          const url = `http://127.0.0.1:${record.webPort}`;
          console.log(`复用现有 DSH Web：${url}；若浏览器尚未认证，请使用原 DSH 终端打印的登录链接。`);
          if (!forwarded.includes('--no-open')) openBrowser(url);
        } else console.log('DSH Web 已在运行，请使用原服务地址配置模型。');
        return;
      }
    }
    const runtime = await ensureDsh();
    await runInstaller(runtime.command, [...runtime.args, ...args.slice(1)], { cwd: root, env: process.env });
  } else {
    const { main: launch } = await import('./launch.mjs');
    await launch({ open: args.includes('--open') && !args.includes('--no-open') });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
