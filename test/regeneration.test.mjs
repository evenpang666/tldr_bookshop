import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createStorage } from '../lib/storage.mjs';

const oldId = 'a'.repeat(64);
const original = { book: { id: 'ferry', title: '渡口', author: '测试' }, title: '渡口', author: '测试', minutes: 5, basis: '节选缩写', body: '原内容。', generationInput: { sourceText: '保留的原文。', sourceComplete: false } };

async function setup(t, generate) {
  const directory = await mkdtemp(join(tmpdir(), 'thinbook-regeneration-'));
  const storage = createStorage(directory);
  await storage.saveReading(oldId, original);
  const settings = { getConfig: async () => ({ hasKey: true, model: 'deepseek-flash', provider: 'deepseek-official' }) };
  const app = createApp({ storage, settings, generate });
  const server = http.createServer(app.handler);
  t.after(async () => { await app.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  const request = (input = {}, options = {}) => fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Thinbook-Token': bootstrap.token }, body: JSON.stringify({ force: true, replaceCacheId: oldId, ...input }), ...options });
  const events = async response => (await response.text()).trim().split('\n').map(JSON.parse);
  return { storage, app, request, events, get: async id => (await fetch(`${base}/api/readings/${id}`)).json() };
}

test('regeneration reuses stored source, replaces the old identity and serves the new cache', async t => {
  let calls = 0, input;
  const api = await setup(t, async options => {
    calls++; input = options;
    return { ...original, generationInput: undefined, body: '新的正文。', notes: '附注。' };
  });
  const result = (await api.events(await api.request({ book: { title: '错误书目', author: '错误作者' }, minutes: 20 }))).at(-1);
  assert.equal(result.type, 'result'); assert.equal(result.reading.body, '新的正文。');
  assert.equal(input.sourceText, original.generationInput.sourceText); assert.equal(input.sourceComplete, false);
  assert.equal(input.book.title, original.title); assert.equal(input.minutes, 5);
  assert.equal(result.reading.cached, false); assert.equal(result.reading.chargedThisRequest, true);
  assert.equal(result.reading.canRegenerate, true); assert.equal(result.reading.generationInput, undefined);
  assert.equal(await api.storage.getReading(oldId), null);
  assert.equal((await api.storage.listReadings()).length, 1);
  const saved = await api.storage.getReading(result.reading.cacheId);
  assert.deepEqual(saved.generationInput, original.generationInput);
  assert.equal((await api.get(result.reading.cacheId)).reading.generationInput, undefined);
  const cached = (await api.events(await api.request({ replaceCacheId: undefined, force: false, book: original.book, minutes: 5, ...original.generationInput }))).at(-1);
  assert.equal(cached.reading.cached, true); assert.equal(cached.reading.body, '新的正文。');
  assert.equal(cached.reading.generationInput, undefined); assert.equal(calls, 1);
  await api.request({ replaceCacheId: result.reading.cacheId }).then(api.events);
  assert.equal(calls, 2); assert.equal((await api.storage.listReadings()).length, 1);
});

test('failed generation or failed replacement write leaves old content intact', async t => {
  let failGeneration = true;
  const api = await setup(t, async () => { if (failGeneration) throw new Error('模型未返回完整正文。'); return { ...original, body: '新的正文。' }; });
  assert.equal((await api.events(await api.request())).at(-1).type, 'error');
  assert.equal((await api.storage.getReading(oldId)).body, original.body);
  failGeneration = false;
  api.storage.saveReading = async () => { throw new Error('disk full'); };
  const failed = (await api.events(await api.request())).at(-1);
  assert.equal(failed.type, 'error'); assert.match(failed.message, /原内容已保留/);
  assert.equal((await api.storage.getReading(oldId)).body, original.body);
  assert.equal((await api.storage.listReadings()).length, 1);
});

test('old source caches require reimport and invalid replacement IDs do not generate', async t => {
  let calls = 0, input;
  const api = await setup(t, async options => { calls++; input = options; return original; });
  await api.storage.saveReading(oldId, { ...original, generationInput: undefined });
  const missing = await api.request();
  assert.equal(missing.status, 400); assert.equal((await missing.json()).code, 'SOURCE_REQUIRED');
  for (const invalid of ['../bad', 'b'.repeat(64)]) {
    const response = await api.request({ replaceCacheId: invalid });
    assert.ok([400, 404].includes(response.status)); await response.json();
  }
  assert.equal(calls, 0);
  const result = (await api.events(await api.request({ sourceText: '重新导入的原文。', sourceComplete: true }))).at(-1);
  assert.equal(result.type, 'result'); assert.equal(input.sourceText, '重新导入的原文。'); assert.equal(input.sourceComplete, true);
});

test('replacement target is locked against duplicate generation', async t => {
  let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const api = await setup(t, async () => { calls++; await pending; return original; });
  const first = await api.request();
  const duplicate = await api.request({ sourceText: '不同的原文。' });
  assert.equal(duplicate.status, 409); await duplicate.json(); assert.equal(calls, 1);
  release(); assert.equal((await api.events(first)).at(-1).type, 'result');
});

test('canceling generation preserves the old cache even if the generator returns', async t => {
  const api = await setup(t, async ({ signal }) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { ...original, body: '取消后的结果。' };
  });
  const response = await api.request();
  await response.body.cancel(); await api.app.close();
  assert.equal((await api.storage.getReading(oldId)).body, original.body);
  assert.equal((await api.storage.listReadings()).length, 1);
});
