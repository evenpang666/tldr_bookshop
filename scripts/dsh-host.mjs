import { mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);
export const dshHome = (env = process.env) => resolve(env.DSH_HOME || join(homedir(), '.dsh'));
export const endpointPath = home => join(home, 'thinbook', 'host.json');
const begin = '# >>> thinbook launcher >>>', end = '# <<< thinbook launcher <<<';

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export function isDshWebCommand(args) {
  const index = args.findIndex(arg => /(?:^|[/\\])(?:@deepseek-ai[/\\])?dsh[/\\](?:lib[/\\])?bin\.[cm]?js$/.test(arg) || /(?:^|[/\\])dsh(?:\.exe)?$/.test(arg));
  if (index < 0) return false;
  const options = args.slice(index + 1);
  if (options.some(arg => ['--version', '-V', '--help', '-h', '--dump-config', '--dump-default-config', '--dump-config-schema', 'plugin'].includes(arg))) return false;
  const profileIndex = options.indexOf('--profile');
  if (profileIndex >= 0) return options[profileIndex + 1] === 'web';
  const profile = options.find(arg => arg.startsWith('--profile='));
  if (profile) return profile === '--profile=web';
  return !options.length || options[0] === 'web' || options[0].startsWith('--');
}

// Inspect only CLI identities. Never print process environments or command lines.
export async function runningDsh({ home = dshHome(), platform = process.platform, proc = '/proc', run = execute } = {}) {
  if (platform === 'linux') {
    const entries = await readdir(proc);
    const found = await Promise.all(entries.filter(entry => /^\d+$/.test(entry) && Number(entry) !== process.pid).map(async entry => {
      try {
        const directory = join(proc, entry);
        if (process.getuid && (await stat(directory)).uid !== process.getuid()) return null;
        const args = (await readFile(join(directory, 'cmdline'), 'utf8')).split('\0').filter(Boolean);
        if (!isDshWebCommand(args)) return null;
        // DSH_HOME is needed to distinguish unrelated profiles in another home.
        // Other environment values (including credentials) are never used.
        const variables = (await readFile(join(directory, 'environ'), 'utf8')).split('\0');
        const declared = variables.find(value => value.startsWith('DSH_HOME='))?.slice(9);
        const target = declared ? resolve(await readlink(join(directory, 'cwd')).catch(() => process.cwd()), declared) : join(homedir(), '.dsh');
        return resolve(target) === resolve(home) ? Number(entry) : null;
      } catch { return null; }
    }));
    return found.filter(Boolean);
  }
  if (platform === 'win32') {
    const result = await run('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "^(node|dsh)(\\.exe)?$" } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'], { timeout: 10000, windowsHide: true });
    const data = JSON.parse(result.stdout.trim() || '[]');
    return (Array.isArray(data) ? data : [data]).filter(row => {
      const args = (row.CommandLine || '').match(/"[^"]*"|\S+/g)?.map(arg => arg.replace(/^"|"$/g, '')) || [];
      return row.ProcessId !== process.pid && isDshWebCommand(args);
    }).map(row => row.ProcessId);
  }
  const result = await run('ps', ['-axo', 'pid=,command='], { timeout: 10000 });
  return result.stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || Number(match[1]) === process.pid) return [];
    return isDshWebCommand(match[2].match(/"[^"]*"|\S+/g)?.map(arg => arg.replace(/^"|"$/g, '')) || []) ? [Number(match[1])] : [];
  });
}

export async function registeredThinbook(home, health) {
  try {
    const record = JSON.parse(await readFile(endpointPath(home), 'utf8'));
    if (record.profile !== 'web' || !alive(record.pid) || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) return null;
    const response = await health(record.port);
    return response?.app === 'thinbook' && response.runtime === 'dsh' ? record : null;
  } catch { return null; }
}

export async function startupLock(home, { timeout = 90000 } = {}) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, '.thinbook-start.lock'), owner = randomUUID(), deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, owner }), { mode: 0o600 });
      return async () => {
        try { if (JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')).owner === owner) await rm(path, { recursive: true, force: true }); } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const record = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
        if (!alive(record.pid)) { await rm(path, { recursive: true, force: true }); continue; }
      } catch (readError) {
        if (readError.code === 'ENOENT' && Date.now() - (await stat(path).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > 10000) { await rm(path, { recursive: true, force: true }); continue; }
      }
      await new Promise(done => setTimeout(done, 100));
    }
  }
  throw new Error('另一个薄书启动器仍在配置 DSH，请稍后重试。');
}

export function profilePatch(original, fragment) {
  let text = original;
  const first = text.indexOf(begin), last = text.indexOf(end);
  if ((first >= 0) !== (last >= 0) || last >= 0 && last < first) throw new Error('薄书配置标记不完整，请检查 DSH profile 的 cordis.patch.yml。');
  if (first >= 0) text = text.slice(0, first) + text.slice(last + end.length).replace(/^\r?\n/, '');
  if (text.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).join('\n').trim() === '[]') text = text.replace(/^\s*\[\]\s*$/m, '');
  if (text.trim().startsWith('[')) {
    let entries;
    try { entries = JSON.parse(text); } catch { throw new Error('DSH profile 使用了无法安全追加的流式 YAML，请改为标准 YAML 列表后重试。'); }
    text = entries.map(entry => `- ${JSON.stringify(entry)}`).join('\n');
  }
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${begin}\n${fragment.trimEnd()}\n${end}\n`;
}

export async function installProfilePatch(home, fragment) {
  const profile = join(home, 'profiles/web'), path = join(profile, 'cordis.patch.yml');
  await mkdir(profile, { recursive: true });
  let original;
  try { original = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; original = ''; }
  const next = profilePatch(original, fragment);
  if (next === original) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, next, { mode: 0o600 });
    let current;
    try { current = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; current = ''; }
    if (current !== original) throw new Error('DSH 配置同时被修改，请重新启动薄书以重试。');
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
