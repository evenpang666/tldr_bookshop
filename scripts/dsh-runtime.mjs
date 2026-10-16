import { access, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const validVersion = version => typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
const execute = promisify(execFile);
const entryAt = directory => ({ command: process.execPath, args: [join(directory, 'node_modules/@deepseek-ai/dsh/lib/bin.js')] });

async function nodeCommand(candidate, shimEntries = []) {
  try {
    await access(candidate);
    const target = await realpath(candidate);
    if (/\.cmd$/i.test(target)) {
      for (const relative of shimEntries) {
        const entry = join(dirname(target), relative);
        try { await access(entry); return { command: process.execPath, args: [entry] }; } catch {}
      }
      return null;
    }
    return /\.[cm]?js$/i.test(target) ? { command: process.execPath, args: [target] } : { command: target, args: [] };
  } catch { return null; }
}

export async function findDsh(env = process.env) {
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh'];
  const candidates = env.DSH_BIN ? [resolve(env.DSH_BIN)] : [
    ...(env.PATH || env.Path || '').split(delimiter).filter(Boolean).flatMap(dir => names.map(name => join(dir, name))),
    join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
  ];
  for (const candidate of candidates) {
    const runtime = await nodeCommand(candidate, ['node_modules/@deepseek-ai/dsh/lib/bin.js', 'node_modules/@deepseek-ai/dsh/bin.js']);
    if (runtime) return runtime;
  }
  return null;
}

export async function findPnpm(env = process.env) {
  const names = process.platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe', 'pnpm'] : ['pnpm'];
  for (const directory of (env.PATH || env.Path || '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const runtime = await nodeCommand(join(directory, name), ['node_modules/pnpm/bin/pnpm.cjs', 'node_modules/pnpm/bin/pnpm.mjs']);
      if (runtime) return runtime;
    }
  }
  return null;
}

export async function findNpm(env = process.env) {
  const names = process.platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'];
  const candidates = [
    ...(env.npm_execpath ? [env.npm_execpath] : []),
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    ...(env.PATH || env.Path || '').split(delimiter).filter(Boolean).flatMap(dir => names.map(name => join(dir, name))),
  ];
  for (const candidate of candidates) {
    const npm = await nodeCommand(candidate, ['node_modules/npm/bin/npm-cli.js']);
    if (npm) return npm;
  }
  throw new Error('未找到 npm，无法自动安装 DSH。请重新安装包含 npm 的 Node.js 24 LTS 后重试。');
}

export async function readDshVersion(runtime, { run = execute, env = process.env } = {}) {
  if (!runtime) return null;
  try {
    const result = await run(runtime.command, [...runtime.args, '--version'], { env, timeout: 10000, windowsHide: true });
    const version = result.stdout.trim();
    return validVersion(version) ? version : null;
  } catch { return null; }
}

export async function latestDshVersion({ env = process.env, locateNpm = findNpm, run = execute } = {}) {
  const npm = await locateNpm(env);
  const result = await run(npm.command, [...npm.args, 'view', '@deepseek-ai/dsh@latest', 'version', '--json', '--prefer-online'], { env, timeout: 30000, windowsHide: true });
  const version = JSON.parse(result.stdout);
  if (!validVersion(version)) throw new Error('npm 未返回有效的 DSH 最新版本');
  return version;
}

export function runInstaller(command, args, options) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit', windowsHide: true });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const cleanup = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code === 0) done();
      else reject(new Error(signal ? `运行被 ${signal} 中止` : `命令退出码 ${code}`));
    });
  });
}

// Install separately from the plugin dependencies and the user's global DSH.
// Publish only a verified installation; interrupted downloads remain temporary.
export async function installDsh(directory, { version = 'latest', env = process.env, locateNpm = findNpm, run = runInstaller, versionOf = readDshVersion } = {}) {
  const npm = await locateNpm(env);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(directory), '.install-'));
  let backup;
  try {
    await writeFile(join(staging, 'package.json'), JSON.stringify({ private: true }), { mode: 0o600 });
    await run(npm.command, [...npm.args, 'install', '--prefix', staging, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', `@deepseek-ai/dsh@${version}`], { env, cwd: staging });
    const installed = await versionOf(entryAt(staging), { env });
    if (!installed || version !== 'latest' && installed !== version) throw new Error('安装后的 DSH 版本校验失败');
    try { await rename(staging, directory); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      // A simultaneous launch may have finished the same installation first.
      if (await versionOf(entryAt(directory), { env }) === installed) return;
      backup = `${directory}.old-${randomUUID()}`;
      await rename(directory, backup);
      try { await rename(staging, directory); }
      catch (failure) { await rename(backup, directory); backup = undefined; throw failure; }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (backup) await rm(backup, { recursive: true, force: true });
  }
}

export async function ensureDsh({ env = process.env, directory = join(env.DSH_HOME || join(homedir(), '.dsh'), 'runtimes', 'thinbook', 'current'), locate = findDsh, versionOf = readDshVersion, log = console.log } = {}) {
  const existing = await locate(env);
  const detected = await versionOf(existing, { env });
  if (detected) { log(`复用已安装 DSH ${detected}，不检查或下载其他版本。`); return existing; }
  const managed = entryAt(directory);
  const managedVersion = await versionOf(managed, { env });
  if (managedVersion) { log(`复用已安装 DSH ${managedVersion}，不检查或下载其他版本。`); return managed; }
  throw new Error('未找到可运行的已安装 DSH。请先安装一次并加入 PATH，或用 DSH_BIN 指定已有入口；启动器不会自动安装或升级 DSH。');
}

// Also expose the managed CLI for one-time model setup and plugin management.
// Ordinary ThinBook startup continues to use launch.mjs with --no-open.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) throw new Error('请使用 Node.js 24.5+。');
    const runtime = await ensureDsh();
    await runInstaller(runtime.command, [...runtime.args, ...process.argv.slice(2)], { cwd: root, env: process.env });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
