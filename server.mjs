import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { books, categories } from './data/catalog.mjs';
import { root } from './harness/reader.mjs';
import { randomBytes } from 'node:crypto';
import { createStorage } from './lib/storage.mjs';
import { localAddresses, lanUrls, isLoopback, isPrivatePeer } from './lib/network.mjs';
import { searchBooks } from './lib/search.mjs';
import { createHash } from 'node:crypto';
import { ReadingError } from './lib/reading-error.mjs';

const token = randomBytes(32).toString('hex');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const onlineCache = new Map();
let active = 0;
export function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('请求格式不正确。');
  const { book, model = 'deepseek-flash', minutes = 10, sourceText = '' } = input;
  if (!book || typeof book.title !== 'string' || !book.title.trim() || book.title.length > 200 || typeof book.author !== 'string' || !book.author.trim() || book.author.length > 200) throw new Error('请提供有效书名和作者（各不超过 200 字）。');
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(model)) throw new Error('模型名称格式不正确。');
  if (![5, 10, 20].includes(minutes)) throw new Error('请选择 5、10 或 20 分钟。');
  if (typeof sourceText !== 'string' || sourceText.length > 600000) throw new Error('原文最多支持 60 万字，请分段提炼。');
  return { book: { id: String(book.id || '').slice(0, 200), title: book.title.trim(), author: book.author.trim(), description: String(book.description || '').slice(0, 500), category: String(book.category || '自选书籍').slice(0, 40), color: Number(book.color) || 0 }, model, minutes, sourceText, sourceComplete: Boolean(input.sourceComplete) };
}
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
// Keep imported source text on disk for regeneration, out of browser history/API responses.
function publicReading(reading) {
  const { generationInput, ...result } = reading;
  return { ...result, canRegenerate: Boolean(generationInput && reading.cacheId) || reading.basis === '资料提炼' };
}
async function body(req) {
  let length = 0; const parts = [];
  for await (const part of req) { length += part.length; if (length > 3_000_000) throw new Error('内容过大，请缩短原文。'); parts.push(part); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new Error('请求 JSON 格式不正确。'); }
}
export function createApp({ generate = async () => { throw new Error('请通过 DSH 插件启动薄书。'); }, storage = createStorage(), settings = { getConfig: async () => ({ hasKey: false, model: 'deepseek-flash', provider: 'deepseek-official' }) }, search = searchBooks, addresses = localAddresses(), basePath: mountPath = "", connection: hostConnection = null, webServer: hostServer = null, instanceId, independent } = {}) {
  const pendingReadings = new Set();
  const controllers = new Map();
  const handler = async (req, res) => {
    const standalone = Boolean(independent?.port) && independent.port === req.socket.localPort;
    const connection = standalone ? null : hostConnection, webServer = standalone ? null : hostServer;
    const basePath = standalone && !req.url.startsWith(mountPath + '/') ? '' : mountPath;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      // Only the machine's real interfaces are accepted as Host; configuration is loopback-only.
      const host = req.headers.host || '';
      if ((!connection || standalone) && !isPrivatePeer(req.socket.remoteAddress)) return json(res, 403, { error: '仅允许本机与私有局域网访问。' });
      const hostname = host.replace(/:\d+$/, '');
      if ((!connection || standalone) && !['127.0.0.1', 'localhost', ...addresses.map(a => a.address)].includes(hostname)) return json(res, 403, { error: '访问地址不被允许。' });
      const admin = isLoopback(req.socket.remoteAddress) && ['127.0.0.1', 'localhost'].includes(hostname);
      if ((!connection || standalone) && req.headers.origin && ![`http://${host}`].includes(req.headers.origin)) return json(res, 403, { error: '来源不被允许。' });
      const url = new URL(req.url, `http://${host}`);
      if (basePath) {
        if (url.pathname !== basePath && !url.pathname.startsWith(basePath + '/')) return json(res, 404, { error: '页面不存在。' });
        url.pathname = url.pathname.slice(basePath.length) || '/';
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, app: 'thinbook', runtime: 'dsh', instanceId });
      if (connection) {
        if (['/', '/index.html'].includes(url.pathname)) {
          const indexRequest = { method: req.method, headers: req.headers, url: '/' + url.search };
          const indexResponse = { writeHead(status, headers = {}) { return res.writeHead(status, { ...headers, ...(status === 303 ? { location: basePath + '/' } : {}) }); }, end: data => res.end(data) };
          if (!connection.authorizeIndex(indexRequest, indexResponse)) return;
          if (new URL(req.url, 'http://localhost').pathname === basePath) { res.writeHead(308, { location: basePath + '/' }); return res.end(); }
        } else {
          const rejection = connection.requestRejection(req);
          if (rejection) return json(res, rejection, { error: rejection === 401 ? '请先登录 DSH Web，再打开薄书。' : 'DSH 拒绝了此请求来源。' });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        const config = await settings.getConfig();
        const port = req.socket.localPort;
        return json(res, 200, { books, categories, token, version: '2.0.0', settings: { hasKey: Boolean(config.hasKey), model: config.model, provider: config.provider, managed: true, admin: false }, lanUrls: lanUrls(independent?.port || webServer?.port || port, addresses).map(url => url + (independent?.port ? '/' : basePath ? basePath + '/' : '')), readings: await storage.listReadings() });
      }
      if (req.method === 'GET' && url.pathname === '/api/readings') return json(res, 200, { readings: await storage.listReadings() });
      if (req.method === 'GET' && url.pathname.startsWith('/api/readings/')) { const reading = await storage.getReading(url.pathname.split('/').pop()); return json(res, reading ? 200 : 404, reading ? { reading: publicReading({ ...reading, cached: true, chargedThisRequest: false }) } : { error: '本地缓存不存在。' }); }
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
        if (url.pathname === '/api/settings' || url.pathname === '/api/test-key') {
          return json(res, admin ? 409 : 403, { error: '密钥与模型由 DSH 管理，请在 DSH 中修改后刷新薄书。' });
        }
        if (url.pathname === '/api/generate') {
          const config = await settings.getConfig();
          const request = await body(req);
          let replacement;
          if (request.replaceCacheId !== undefined) {
            if (request.force !== true || typeof request.replaceCacheId !== 'string' || !/^[a-f0-9]{64}$/.test(request.replaceCacheId)) return json(res, 400, { error: '重新读薄的缓存编号无效。' });
            replacement = await storage.getReading(request.replaceCacheId);
            if (!replacement) return json(res, 404, { error: '原阅读已不存在，请刷新最近阅读。' });
            if (!replacement.generationInput && replacement.basis !== '资料提炼' && !request.sourceText?.trim()) return json(res, 400, { code: 'SOURCE_REQUIRED', error: '这篇旧阅读未保存原文，请重新导入原文后读薄。' });
          }
          const originalInput = replacement ? { book: replacement.book, minutes: replacement.minutes, ...(replacement.generationInput || {}), ...(request.sourceText ? { sourceText: request.sourceText, sourceComplete: request.sourceComplete } : {}) } : request;
          const input = { ...validateInput({ ...originalInput, model: config.model }), provider: config.provider || 'deepseek-official', reasoningEffort: config.reasoningEffort };
          const skill = await readFile(join(root, '.dsh/skills/thin-book/SKILL.md'), 'utf8');
          const cacheId = storage.cacheKey({ ...input, skillHash: createHash('sha256').update(skill).digest('hex') });
          if (!request.force) { const cached = await storage.getReading(cacheId); if (cached) { res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ type: 'result', reading: publicReading({ ...cached, cached: true, chargedThisRequest: false }) }) + '\n'); } }
          if (!config.hasKey) return json(res, 400, { error: '请先在 DSH 中配置 DeepSeek API Key，并选择 DeepSeek 官方默认模型，再刷新薄书。' });
          const lockIds = [...new Set([cacheId, ...(replacement ? [request.replaceCacheId] : [])])];
          if (lockIds.some(id => pendingReadings.has(id))) return json(res, 409, { error: '这本书的相同版本正在提炼，请完成后从最近阅读打开，避免重复计费。' });
          if (active >= 2) return json(res, 429, { error: '当前有两本书正在提炼，请等待完成后再试。' });
          active++; lockIds.forEach(id => pendingReadings.add(id));
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
          const controller = new AbortController();
          let settled; const done = new Promise(resolve => { settled = resolve; });
          controllers.set(controller, done);
          const send = (type, data) => { if (!res.destroyed) res.write(JSON.stringify({ type, ...data }) + '\n'); };
          const abort = () => controller.abort(); res.once('close', abort);
          const heartbeat = setInterval(() => send('heartbeat', {}), 12000);
          try {
            send('status', { message: '正在启动阅读智能体…' });
            const reading = await generate({ ...input, signal: controller.signal, onStatus: message => send('status', { message }) });
            controller.signal.throwIfAborted();
            let saved = { ...reading, generationInput: { sourceText: input.sourceText, sourceComplete: input.sourceComplete }, cached: false, chargedThisRequest: true };
            try { saved = await storage.saveReading(cacheId, saved); } catch {
              if (replacement) { send('error', { message: '重新读薄未能保存，原内容已保留。请检查磁盘空间后重试。' }); return; }
              saved.cacheWarning = '正文已生成，但本地磁盘缓存写入失败。请立即导出保存。';
            }
            if (replacement && request.replaceCacheId !== cacheId) {
              try { await storage.removeReading(request.replaceCacheId); } catch { saved.cacheWarning = '新内容已保存，但旧版本未能清理，请检查本地缓存目录权限。'; }
            }
            send('result', { reading: publicReading(saved) });
          } catch (error) {
            let message = String(error.message || '提炼失败。');
            // Never expose arbitrary runtime diagnostics or credential-bearing errors.
            if (error instanceof ReadingError) message = error.message;
            else if (/401|authentication|api.?key|credential/i.test(message)) message = 'DeepSeek 认证失败，请检查 API Key 与账户权限。';
            else if (/402|balance|insufficient/i.test(message)) message = 'DeepSeek 账户余额不足，请充值后重试。';
            else if (/429|rate.?limit/i.test(message)) message = 'DeepSeek 请求过于频繁，请稍后重试。';
            else if (/transport|initialize|module|runtime|profile|stderr/i.test(message)) message = 'DSH 插件运行失败，请检查 DSH 版本与模型配置后重启薄书。';
            else if (!/^(模型未返回|资料不足|这次提炼|未能核实|DSH 未完成|DSH 没有返回|提炼超过|检索次数)/.test(message)) message = '提炼失败，请检查 DSH 配置或补充原文后重试。';
            message = message.slice(0, 700);
            send('error', { message });
          } finally { controllers.delete(controller); settled(); active--; lockIds.forEach(id => pendingReadings.delete(id)); clearInterval(heartbeat); res.off('close', abort); res.end(); }
          return;
        }
        return json(res, 404, { error: '接口不存在。' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '方法不被允许。' });
      const allowed = new Set(['/', '/index.html', '/style.css', '/app.js', '/favicon.svg', '/logo.svg']);
      if (!allowed.has(url.pathname)) return json(res, 404, { error: '页面不存在。' });
      const path = join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      let file = await readFile(path);
      if (basePath && extname(path) === '.html') file = Buffer.from(file.toString().replaceAll('href="/', 'href="' + basePath + '/').replaceAll('src="/', 'src="' + basePath + '/'));
      res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : file);
    } catch (error) { if (!res.headersSent) json(res, 400, { error: error.name === 'TimeoutError' ? '网络请求超时，请稍后重试。' : error.message === 'fetch failed' ? '网络连接失败，请检查网络与系统代理设置。' : String(error.message || '请求失败。').slice(0, 400) }); else res.end(); }
  };
  return { handler, async close() { const pending = [...controllers]; for (const [controller] of pending) controller.abort(); await Promise.allSettled(pending.map(([,done]) => done)); } };
}
export function createServer(options) { return http.createServer(createApp(options).handler); }

export { openBrowser } from './lib/browser.mjs';
