import { mkdir, readFile, writeFile, rename, readdir, chmod, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const defaultConfig = { apiKey: '', model: 'deepseek-flash' };
const fingerprint = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');
async function readJSON(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('本地配置或缓存无法读取，请检查对应 JSON 文件。'); } }
async function writeJSON(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, path); await chmod(path, 0o600); }
  finally { await unlink(temporary).catch(() => {}); }
}
export function createStorage(root = projectRoot) {
  const configDir = join(root, '.local'), cacheDir = join(root, '.local', 'readings');
  const configPath = join(configDir, 'config.json');
  let writes = Promise.resolve();
  return {
    configPath,
    async getConfig() { return { ...defaultConfig, ...await readJSON(configPath, {}) }; },
    async saveConfig(patch) {
      const task = writes.catch(() => {}).then(async () => {
        const current = await this.getConfig();
        const next = { apiKey: patch.apiKey === undefined ? current.apiKey : patch.apiKey.trim(), model: patch.model ?? current.model };
        await mkdir(configDir, { recursive: true, mode: 0o700 }); await writeJSON(configPath, next);
        return { hasKey: Boolean(next.apiKey), model: next.model };
      });
      writes = task; return task;
    },
    cacheKey(input) { return fingerprint({ schema: 2, title: input.book.title, author: input.book.author, model: input.model, minutes: input.minutes, sourceHash: fingerprint(input.sourceText || ''), sourceComplete: input.sourceComplete, skill: input.skillHash }); },
    async getReading(id) { if (!/^[a-f0-9]{64}$/.test(id)) return null; return readJSON(join(cacheDir, `${id}.json`), null); },
    async saveReading(id, reading) { if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('缓存编号无效。'); await mkdir(cacheDir, { recursive: true, mode: 0o700 }); const saved = { ...reading, cacheId: id }; await writeJSON(join(cacheDir, `${id}.json`), saved); return saved; },
    async listReadings() {
      let files; try { files = await readdir(cacheDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const rows = await Promise.all(files.filter(f => /^[a-f0-9]{64}\.json$/.test(f)).map(async f => { try { const r = await readJSON(join(cacheDir, f), null); return r && { cacheId: r.cacheId, title: r.title, author: r.author, book: r.book, minutes: r.minutes, createdAt: r.createdAt, basis: r.basis, cost: r.cost }; } catch { return null; } }));
      return rows.filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },
  };
}
