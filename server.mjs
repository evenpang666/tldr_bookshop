import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { books, categories } from './data/catalog.mjs';
import { generateReading, root } from './harness/reader.mjs';
import { randomBytes } from 'node:crypto';
import { createStorage } from './lib/storage.mjs';
import { localAddresses, isLoopback, isPrivatePeer, networkJSON } from './lib/network.mjs';
import { searchBooks } from './lib/search.mjs';
import { createHash } from 'node:crypto';

const token = randomBytes(32).toString('hex');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const onlineCache = new Map();
let active = 0;
export function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('请求格式不正确。');
  const { book, apiKey, model = 'deepseek-flash', minutes = 10, sourceText = '' } = input;
  if (!book || typeof book.title !== 'string' || !book.title.trim() || book.title.length > 200 || typeof book.author !== 'string' || !book.author.trim() || book.author.length > 200) throw new Error('请提供有效书名和作者（各不超过 200 字）。');
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 512 || /[\r\n]/.test(apiKey)) throw new Error('请先填写有效的 DeepSeek API Key。');
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(model)) throw new Error('模型名称格式不正确。');
  if (![5, 10, 20].includes(minutes)) throw new Error('请选择 5、10 或 20 分钟。');
  if (typeof sourceText !== 'string' || sourceText.length > 600000) throw new Error('原文最多支持 60 万字，请分段提炼。');
  return { book: { id: String(book.id || '').slice(0, 200), title: book.title.trim(), author: book.author.trim(), description: String(book.description || '').slice(0, 500), category: String(book.category || '自选书籍').slice(0, 40), color: Number(book.color) || 0 }, apiKey: apiKey.trim(), model, minutes, sourceText, sourceComplete: Boolean(input.sourceComplete) };
}
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
async function body(req) {
  let length = 0; const parts = [];
  for await (const part of req) { length += part.length; if (length > 3_000_000) throw new Error('内容过大，请缩短原文。'); parts.push(part); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new Error('请求 JSON 格式不正确。'); }
}
export function createServer({ generate = generateReading, storage = createStorage(), search = searchBooks, addresses = localAddresses() } = {}) {
  const pendingReadings = new Set();
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      // Only the machine's real interfaces are accepted as Host; configuration is loopback-only.
      const host = req.headers.host || '';
      if (!isPrivatePeer(req.socket.remoteAddress)) return json(res, 403, { error: '仅允许本机与私有局域网访问。' });
      const hostname = host.replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', ...addresses.map(a => a.address)].includes(hostname)) return json(res, 403, { error: '访问地址不被允许。' });
      const admin = isLoopback(req.socket.remoteAddress) && ['127.0.0.1', 'localhost'].includes(hostname);
      if (req.headers.origin && ![`http://${host}`].includes(req.headers.origin)) return json(res, 403, { error: '来源不被允许。' });
      const url = new URL(req.url, `http://${host}`);
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        const config = await storage.getConfig();
        const port = req.socket.localPort;
        return json(res, 200, { books, categories, token, version: '1.1.0', settings: { hasKey: Boolean(config.apiKey), model: config.model, admin }, lanUrls: addresses.filter(a => !/vmware|virtual|vbox|docker|wsl|vethernet/i.test(a.name)).map(a => `http://${a.address}:${port}`), readings: await storage.listReadings() });
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, app: 'thinbook' });
      if (req.method === 'GET' && url.pathname === '/api/readings') return json(res, 200, { readings: await storage.listReadings() });
      if (req.method === 'GET' && url.pathname.startsWith('/api/readings/')) { const reading = await storage.getReading(url.pathname.split('/').pop()); return json(res, reading ? 200 : 404, reading ? { reading: { ...reading, cached: true, chargedThisRequest: false } } : { error: '本地缓存不存在。' }); }
      if (req.method === 'GET' && url.pathname === '/api/search') {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
        if (!q) return json(res, 400, { error: '请输入书名或作者。' });
        const cached = onlineCache.get(q);
        if (cached && Date.now() - cached.time < 600_000) return json(res, 200, cached.data);
        const result = await search(q);
        if (onlineCache.size > 100) onlineCache.delete(onlineCache.keys().next().value);
        if (!result.degraded) onlineCache.set(q, { time: Date.now(), data: result }); return json(res, 200, result);
      }
      if (req.method === 'POST') {
        if (req.headers['x-thinbook-token'] !== token) return json(res, 403, { error: '会话已更新，请刷新页面后重试。' });
        if (!(req.headers['content-type'] || '').includes('application/json')) return json(res, 415, { error: '需要 JSON 请求。' });
        if (url.pathname === '/api/settings') {
          if (!admin) return json(res, 403, { error: '请在主机的 http://127.0.0.1 页面修改密钥与模型。' });
          const input = await body(req);
          if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 512 || /[^\x21-\x7e]/.test(input.apiKey.trim()) && input.apiKey.trim())) return json(res, 400, { error: 'API Key 格式不正确。' });
          if (typeof input.model !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(input.model)) return json(res, 400, { error: '模型名称格式不正确。' });
          return json(res, 200, { settings: { ...await storage.saveConfig(input), admin } });
        }
        if (url.pathname === '/api/test-key') {
          if (!admin) return json(res, 403, { error: '请在主机本地页面测试连接。' });
          const input = await body(req);
          const key = input.apiKey?.trim() || (await storage.getConfig()).apiKey;
          if (!key || typeof key !== 'string' || key.length > 512 || /[^\x21-\x7e]/.test(key)) return json(res, 400, { error: '请填写有效的 API Key。' });
          try { const models = await networkJSON('https://api.deepseek.com/models', { headers: { Authorization: `Bearer ${key}` } }); return json(res, 200, { ok: true, models: (models.data || []).map(m => m.id) }); }
          catch(error) { return json(res, error.status === 401 ? 401 : 502, { error: error.status === 401 ? 'Key 无效或已失效。' : '连接 DeepSeek 失败，请检查网络或代理是否可用。' }); }
        }
        if (url.pathname === '/api/generate') {
          const config = await storage.getConfig();
          const request = await body(req);
          const input = validateInput({ ...request, apiKey: config.apiKey || 'cache-only', model: config.model });
          const skill = await readFile(join(root, '.dsh/skills/thin-book/SKILL.md'), 'utf8');
          const cacheId = storage.cacheKey({ ...input, skillHash: createHash('sha256').update(skill).digest('hex') });
          if (!request.force) { const cached = await storage.getReading(cacheId); if (cached) { res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ type: 'result', reading: { ...cached, cached: true, chargedThisRequest: false } }) + '\n'); } }
          if (!config.apiKey) return json(res, 400, { error: '请先在主机本地页面保存 DeepSeek API Key。' });
          if (pendingReadings.has(cacheId)) return json(res, 409, { error: '这本书的相同版本正在提炼，请完成后从最近阅读打开，避免重复计费。' });
          if (active >= 2) return json(res, 429, { error: '当前有两本书正在提炼，请等待完成后再试。' });
          active++; pendingReadings.add(cacheId);
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
          const controller = new AbortController();
          const send = (type, data) => { if (!res.destroyed) res.write(JSON.stringify({ type, ...data }) + '\n'); };
          const abort = () => controller.abort(); res.once('close', abort);
          const heartbeat = setInterval(() => send('heartbeat', {}), 12000);
          try {
            send('status', { message: '正在启动阅读智能体…' });
            const reading = await generate({ ...input, signal: controller.signal, onStatus: message => send('status', { message }) });
            let saved = { ...reading, cached: false, chargedThisRequest: true };
            try { saved = await storage.saveReading(cacheId, saved); } catch { saved.cacheWarning = '正文已生成，但本地磁盘缓存写入失败。请立即导出保存。'; }
            send('result', { reading: saved });
          } catch (error) {
            let message = String(error.message || '提炼失败。');
            // Never return SDK stderr or credentials to the UI.
            if (/401|authentication|api.?key|credential/i.test(message)) message = 'DeepSeek 认证失败，请检查 API Key 与账户权限。';
            else if (/402|balance|insufficient/i.test(message)) message = 'DeepSeek 账户余额不足，请充值后重试。';
            else if (/429|rate.?limit/i.test(message)) message = 'DeepSeek 请求过于频繁，请稍后重试。';
            else if (/transport|initialize|module|runtime|profile|stderr/i.test(message)) message = 'Harness 运行时启动失败。请在项目目录执行 npm ci，确认 Node.js 24+ 后重试。';
            message = message.split(input.apiKey).join('[已隐藏]').slice(0, 700);
            send('error', { message });
          } finally { active--; pendingReadings.delete(cacheId); clearInterval(heartbeat); res.off('close', abort); res.end(); }
          return;
        }
        return json(res, 404, { error: '接口不存在。' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '方法不被允许。' });
      const allowed = new Set(['/', '/index.html', '/style.css', '/app.js', '/favicon.svg', '/logo.svg']);
      if (!allowed.has(url.pathname)) return json(res, 404, { error: '页面不存在。' });
      const path = join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      const file = await readFile(path);
      res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : file);
    } catch (error) { if (!res.headersSent) json(res, 400, { error: error.name === 'TimeoutError' ? '网络请求超时，请稍后重试。' : error.message === 'fetch failed' ? '网络连接失败，请检查网络与系统代理设置。' : String(error.message || '请求失败。').slice(0, 400) }); else res.end(); }
  });
}

async function main() {
  const port = Number(process.env.PORT || 3210);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须为 1024–65535。');
  const server = createServer();
  server.on('error', async error => {
    if (error.code === 'EADDRINUSE') {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
        if ((await response.json()).app === 'thinbook') { if (process.argv.includes('--open')) openBrowser(`http://127.0.0.1:${port}`); console.log('薄书已经在运行。'); process.exitCode = 0; return; }
      } catch {}
    }
    console.error(`启动失败：${error.message}`); process.exitCode = 1;
  });
  server.listen(port, process.env.HOST || '0.0.0.0', () => { console.log(`\n  薄书 THINBOOK\n  本机 http://127.0.0.1:${port}\n${localAddresses().filter(a => !/vmware|virtual|vbox|docker|wsl|vethernet/i.test(a.name)).map(a => `  局域网 http://${a.address}:${port}`).join('\n')}\n  ${books.length} 本精选 · DeepSeek Harness\n\n  关闭此窗口即可停止服务。\n`); if (process.argv.includes('--open')) openBrowser(`http://127.0.0.1:${port}`); });
}
function openBrowser(url) {
  const command = process.platform === 'win32' ? 'rundll32' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }); child.on('error', () => console.log(`请在浏览器打开 ${url}`)); child.unref();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
