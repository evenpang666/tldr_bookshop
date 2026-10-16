import { readFile, realpath, writeFile, rename, rm } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { findPnpm } from './dsh-runtime.mjs';

const execute = promisify(execFile);
const begin = '# >>> thinbook launcher >>>', end = '# <<< thinbook launcher <<<';

export async function thinbookInstalled(home, root) {
  try {
    const profile = join(home, 'profiles/web');
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
    return Object.hasOwn(manifest.dependencies || {}, 'thinbook') && manifest.dsh?.profile?.bundles?.includes('thinbook') &&
      await realpath(join(profile, 'node_modules/thinbook')) === await realpath(root);
  } catch { return false; }
}

// Only migrate the block owned by this launcher. Other user YAML stays intact.
export function migrateLauncherPatch(text) {
  const first = text.indexOf(begin), last = text.indexOf(end);
  if (first < 0 && last < 0) return text;
  if (first < 0 || last < first) throw new Error('薄书配置标记不完整，请检查 DSH profile 的 cordis.patch.yml。');
  const block = text.slice(first + begin.length, last);
  if (!/^\s*- insert:\s*$/m.test(block)) return text;
  if (!/^    - id: thinbook\s*$/m.test(block) || (block.match(/^    - /gm) || []).length !== 1)
    throw new Error('薄书配置块包含额外条目，无法安全迁移。');
  const migrated = block.replace(/^\s*- insert:\s*\n/, '\n').split('\n').map(line => line.startsWith('    ') ? line.slice(4) : line)
    .filter(line => !/^  name:/.test(line)).join('\n');
  return text.slice(0, first + begin.length) + migrated + text.slice(last);
}

async function savePatch(path, expected, next) {
  if (expected === next) return;
  if (await readFile(path, 'utf8') !== expected) throw new Error('DSH 配置同时被修改，请重试薄书注册。');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, next, { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export async function registerThinbook({ home, root, runtime, env = process.env, run = execute, locatePnpm = findPnpm, log = console.log }) {
  const profile = join(home, 'profiles/web'), path = join(profile, 'cordis.patch.yml');
  let original;
  try { original = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const migrated = original === undefined ? undefined : migrateLauncherPatch(original);
  const installed = await thinbookInstalled(home, root);
  if (installed) { if (migrated !== undefined) await savePatch(path, original, migrated); return; }
  const childEnv = { ...env, DSH_HOME: home };
  let metadata = {};
  try {
    const text = await readFile(join(profile, 'node_modules/.modules.yaml'), 'utf8');
    try { metadata = JSON.parse(text); } catch {
      for (const key of ['packageManager', 'storeDir']) metadata[key] = text.match(new RegExp(`^${key}:\\s*["']?([^"'\\r\\n]+)["']?\\s*$`, 'm'))?.[1]?.trim();
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (metadata.storeDir) {
    const store = /^v\d+$/.test(basename(metadata.storeDir)) ? dirname(metadata.storeDir) : metadata.storeDir;
    delete childEnv.NPM_CONFIG_STORE_DIR;
    childEnv.npm_config_store_dir = store; childEnv.PNPM_CONFIG_STORE_DIR = store;
  }
  const pnpm = await locatePnpm(childEnv);
  if (!pnpm) throw new Error('请将已有 pnpm 加入 PATH 后重试；薄书注册不会重新安装 DSH 环境。');
  const version = (await run(pnpm.command, [...pnpm.args, '--version'], { env: childEnv, timeout: 10000 })).stdout.trim();
  const required = metadata.packageManager?.match(/^pnpm@(\d+)/)?.[1];
  if (required && version.split('.')[0] !== required) throw new Error(`共享 DSH profile 使用 pnpm ${required}，当前为 ${version}；请复用匹配的已安装 pnpm。`);
  try {
    if (migrated !== undefined) await savePatch(path, original, migrated);
    log('正在将薄书注册到 DSH Web 插件列表…');
    await run(runtime.command, [...runtime.args, 'plugin', '--profile', 'web', 'add', `link:${root}`], { cwd: root, env: childEnv, timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true });
    if (!await thinbookInstalled(home, root)) throw new Error('DSH 未完成薄书 bundle 注册。');
  } catch (error) {
    if (migrated !== undefined && migrated !== original && !await thinbookInstalled(home, root)) {
      try { await savePatch(path, migrated, original); } catch {}
    }
    throw new Error(`薄书插件注册失败：${error.message}`);
  }
}
