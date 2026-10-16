import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, validateInput } from '../server.mjs';
import { parseReading, verifyEvidence } from '../harness/reader.mjs';
import { books, categories } from '../data/catalog.mjs';
import http from 'node:http';
import { createStorage } from '../lib/storage.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const request = { book: books[0], apiKey: 'sk-client-must-be-ignored', minutes: 10 };
test('catalog has unique titles, authors and valid categories', () => {
  assert.ok(books.length >= 400); assert.equal(new Set(books.map(b => b.id)).size, books.length); assert.equal(new Set(books.map(b => b.title)).size, books.length);
  assert.ok(books.every(b => b.author && categories.includes(b.category) && b.description?.length >= 15));
});
test('generation rejects incomplete input and excessive text', () => {
  assert.equal(validateInput(request).minutes, 10);
  for (const value of [{ ...request, minutes: 300 }, { ...request, model: '../bad' }, { ...request, sourceText: 'x'.repeat(600001) }, { ...request, book: { title: 'test' } }, null]) assert.throws(() => validateInput(value));
});
test('reading requires evidence and cannot claim original text without upload', () => {
  const answer = { body: '正文'.repeat(100), basis: '原文缩写', coverage: '基于公开资料', sources: [{ title: '恶意', url: 'javascript:alert(1)' }, { title: '来源', url: 'https://example.com/source' }] };
  const result = parseReading(JSON.stringify(answer), books[0]);
  assert.equal(result.basis, '资料提炼'); assert.equal(result.sources.length, 1);
  assert.equal(parseReading(JSON.stringify(answer), books[0], true, false).basis, '节选缩写');
  assert.throws(() => parseReading(JSON.stringify({ ...answer, sources: [] }), books[0]));
  assert.throws(() => parseReading('truncated JSON', books[0]));
  assert.throws(() => parseReading(JSON.stringify({ body: '', coverage: '缺少可靠来源' }), books[0]), /资料不足/);
});
test('reading keeps book commentary separate and accepts older outputs without notes', () => {
  const body = '我走到渡口，雨停了，岸边只剩下一盏灯。'.repeat(10);
  const notes = '这本书采用第一人称叙述。';
  const answer = { body, notes: `\n${notes}\n`, coverage: '仅覆盖所给节选。' };
  const result = parseReading(JSON.stringify(answer), books[0], true);
  assert.equal(result.body, body);
  assert.equal(result.notes, notes);
  assert.equal(result.coverage, answer.coverage);
  for (const legacyNotes of [undefined, null, ['背景'], { text: '背景' }]) {
    assert.equal(parseReading(JSON.stringify({ ...answer, notes: legacyNotes }), books[0], true).notes, '');
  }
  assert.throws(() => parseReading(JSON.stringify({ body: '', notes: notes.repeat(100) }), books[0], true), /资料不足/);
});
test('only sources present in successful Harness web results survive verification', () => {
  const reading = { sources: [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }, { title: 'invented', url: 'https://invented.example/' }] };
  const events = [
    { type: 'tool/call', data: { callId: '1', name: 'web_search' } },
    { type: 'tool/result', data: { message: { toolCallId: '1', isError: false }, meta: { sources: [{ title: 'Verified A', url: 'https://a.example/' }, { title: 'Verified B', url: 'https://b.example/' }] } } },
  ];
  const result = verifyEvidence(reading, events, false);
  assert.equal(result.sources.length, 2); assert.equal(result.sources[0].title, 'Verified A');
  assert.throws(() => verifyEvidence(reading, [], false), /实际检索来源/);
  assert.throws(() => verifyEvidence(reading, [events[0], { ...events[1], data: { ...events[1].data, message: { toolCallId: '1', isError: true } } }], false));
  assert.equal(verifyEvidence(reading, [], true).sources.length, 0);
});
test('HTTP serves only public files, blocks foreign origins and streams results', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'thinbook-test-'));
  t.after(async () => { assert.ok(directory.startsWith(join(tmpdir(), 'thinbook-test-'))); await rm(directory, { recursive: true, force: true }); });
  const storage = createStorage(directory);
  let hasKey = true;
  const settings = { getConfig: async () => ({ hasKey, model: 'deepseek-flash', provider: 'deepseek-official' }) };
  let generations = 0;
  const server = createServer({ storage, settings, generate: async ({ book, onStatus, apiKey }) => { assert.equal(apiKey, undefined); generations++; onStatus('正在核对'); return { book, author: book.author, title: book.title, body: '模拟正文', basis: '资料提炼', createdAt: new Date().toISOString(), minutes: 10 }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json(); assert.equal(bootstrap.books.length, books.length);
  assert.equal(bootstrap.settings.hasKey, true); assert.equal(bootstrap.settings.admin, false); assert.ok(!JSON.stringify(bootstrap).includes('sk-storage-test-only'));
  const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /薄书/);
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/.local/config.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/bootstrap`, { headers: { Origin: 'https://foreign.example' } })).status, 403);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/bootstrap`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject);
  });
  assert.equal(invalidHostStatus, 403);
  assert.equal((await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })).status, 403);
  const response = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Thinbook-Token': bootstrap.token }, body: JSON.stringify(request) });
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).type, 'result'); assert.equal(events.at(-1).reading.title, books[0].title);
  hasKey = false;
  const cached = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Thinbook-Token': bootstrap.token }, body: JSON.stringify(request) });
  const cachedReading = JSON.parse((await cached.text()).trim()).reading;
  assert.equal(cachedReading.cached, true); assert.equal(cachedReading.chargedThisRequest, false); assert.equal(generations, 1);
  const missingKey = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Thinbook-Token': bootstrap.token }, body: JSON.stringify({ ...request, force: true }) });
  assert.equal(missingKey.status, 400); assert.equal(generations, 1);
  const restored = createStorage(directory); assert.equal((await restored.listReadings()).length, 1); assert.equal((await restored.getReading(cachedReading.cacheId)).body, '模拟正文');
  assert.equal((await (await fetch(`${base}/api/readings/${cachedReading.cacheId}`)).json()).reading.cached, true);
});
