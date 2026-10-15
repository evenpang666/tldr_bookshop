import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../lib/storage.mjs';
import { estimateCost } from '../lib/cost.mjs';
import { localAddresses, isPrivatePeer } from '../lib/network.mjs';
import { searchBooks } from '../lib/search.mjs';
import { createServer } from '../server.mjs';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('local config keeps key across model updates and distinguishes cache inputs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'thinbook-config-test-'));
  t.after(async () => { assert.ok(directory.startsWith(join(tmpdir(), 'thinbook-config-test-'))); await rm(directory, { recursive: true, force: true }); });
  const storage = createStorage(directory);
  assert.equal((await storage.getConfig()).apiKey, '');
  const publicResult = await storage.saveConfig({ apiKey: 'sk-test-private', model: 'deepseek-flash' }); assert.ok(!JSON.stringify(publicResult).includes('sk-test-private'));
  await storage.saveConfig({ model: 'deepseek-v4-pro' }); assert.equal((await createStorage(directory).getConfig()).apiKey, 'sk-test-private');
  const input = { book: { title: '测试', author: '作者' }, model: 'deepseek-flash', minutes: 5, sourceText: '原文', sourceComplete: false, skillHash: 'skill-a' };
  const key = storage.cacheKey(input);
  for (const patch of [{ minutes: 10 }, { sourceText: '其他原文' }, { sourceComplete: true }, { skillHash: 'skill-b' }, { model: 'deepseek-v4-pro' }]) assert.notEqual(storage.cacheKey({ ...input, ...patch }), key);
  assert.equal(await storage.getReading('../config'), null);
});

test('cost uses disjoint token counts, includes search allowance, and rejects unknown prices', () => {
  const usage = { type: 'assistant/message', data: { usage: { inputTokens: 1000000, cacheReadTokens: 1000000, outputTokens: 1000000, reasoningTokens: 100000 } } };
  const amount = estimateCost([usage], 'deepseek-flash');
  assert.ok(Math.abs(amount.maxUsd - 1.506) < 1e-9); assert.equal(amount.minUsd, amount.maxUsd / 2);
  const searched = estimateCost([usage, { type: 'web/deepseek-search-llm-request' }], 'deepseek-flash');
  assert.ok(searched.maxUsd > amount.maxUsd); assert.equal(searched.searchCalls, 1); assert.equal(searched.partial, true);
  assert.equal(estimateCost([usage], 'unpriced-model').maxUsd, null); assert.equal(estimateCost([], 'deepseek-flash').maxUsd, null);
});

test('LAN prefers a physical ethernet interface over virtual adapters', () => {
  const rows = localAddresses({ 'VMware VMnet8': [{ family: 'IPv4', address: '192.168.100.1' }], '以太网': [{ family: 'IPv4', address: '192.168.10.106' }], loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] });
  assert.equal(rows[0].address, '192.168.10.106'); assert.equal(rows.length, 2);
  assert.equal(isPrivatePeer('::ffff:192.168.10.11'), true); assert.equal(isPrivatePeer('8.8.8.8'), false);
});

test('online book search uses backup on primary failure and reports offline fallback honestly', async () => {
  const calls = [];
  const result = await searchBooks('测试', { request: async url => { calls.push(url); if (url.includes('openlibrary')) throw new Error('proxy failure'); return { items: [{ id: '1', volumeInfo: { title: '测试书', authors: ['作者'], description: '<p>真实书目介绍</p>' } }], totalItems: 1 }; } });
  assert.equal(calls.length, 2); assert.match(result.source, /Google Books/); assert.equal(result.books[0].description, '真实书目介绍');
  const offline = await searchBooks('三体', { request: async () => { throw new Error('network unavailable'); } });
  assert.equal(offline.degraded, true); assert.equal(offline.books.length, 3); assert.match(offline.notice, /本地/);
});

test('LAN can read but cannot modify or retrieve the project key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'thinbook-lan-test-'));
  t.after(async () => { assert.ok(directory.startsWith(join(tmpdir(), 'thinbook-lan-test-'))); await rm(directory, { recursive: true, force: true }); });
  const storage = createStorage(directory); await storage.saveConfig({ apiKey: 'sk-secret-test-only', model: 'deepseek-flash' });
  const server = createServer({ storage, addresses: [{ name: '以太网', address: '192.168.10.106' }] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: options.method || 'GET', headers: { Host: `192.168.10.106:${port}`, ...options.headers } }, res => { let body = ''; res.on('data', data => body += data); res.on('end', () => resolve({ status: res.statusCode, body })); }); req.on('error', reject); req.end(options.body);
  });
  const bootstrap = await request('/api/bootstrap'); assert.equal(bootstrap.status, 200); const data = JSON.parse(bootstrap.body); assert.equal(data.settings.admin, false); assert.ok(!bootstrap.body.includes('sk-secret-test-only'));
  const denied = await request('/api/settings', { method: 'POST', headers: { 'X-Thinbook-Token': data.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'sk-replaced', model: 'deepseek-flash' }) }); assert.equal(denied.status, 403);
  assert.equal((await storage.getConfig()).apiKey, 'sk-secret-test-only'); assert.equal((await request('/.local/config.json')).status, 404);
  for (const file of ['.gitignore', '.npmignore', '.gitattributes']) assert.match(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), /\.local/);
});
