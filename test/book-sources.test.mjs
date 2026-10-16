import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.mjs';
import { createStorage } from '../lib/storage.mjs';

test('book source upload persists by title and author and takes priority during generation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'thinbook-sources-'));
  const storage = createStorage(directory), inputs = [];
  const server = createServer({ storage, settings: { getConfig: async () => ({ hasKey: true, model: 'deepseek-flash' }) }, generate: async input => {
    inputs.push(input);
    return { book: input.book, title: input.book.title, author: input.book.author, minutes: input.minutes, body: '提炼正文。', basis: input.sourceText ? '节选缩写' : '资料提炼' };
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  const post = (path, value, token = bootstrap.token) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Thinbook-Token': token }, body: JSON.stringify(value) });
  const book = { title: '渡口', author: '测试' }, sourceText = '仅属于渡口的本地原文。';
  assert.equal((await post('/api/book-sources', { book, sourceText }, 'invalid')).status, 403);
  const uploaded = await (await post('/api/book-sources', { book, sourceText, sourceComplete: true, name: '渡口.txt' })).json();
  assert.equal(uploaded.source.characters, sourceText.length); assert.equal(uploaded.source.sourceText, undefined);
  assert.equal((await createStorage(directory).getBookSource(book)).sourceText, sourceText);
  const metadata = await (await fetch(`${base}/api/bootstrap`)).json();
  assert.equal(metadata.bookSources[0].name, '渡口.txt'); assert.ok(!JSON.stringify(metadata).includes(sourceText));
  const generate = async input => {
    const response = await post('/api/generate', { book, minutes: 5, ...input });
    return JSON.parse((await response.text()).trim().split('\n').at(-1)).reading;
  };
  const first = await generate(); assert.equal(inputs.at(-1).sourceText, sourceText); assert.equal(inputs.at(-1).sourceComplete, true);
  const cached = await generate(); assert.equal(cached.cached, true); assert.equal(inputs.length, 1);
  await post('/api/book-sources', { book, sourceComplete: false });
  assert.equal((await storage.getBookSource(book)).sourceComplete, false);
  await generate({ sourceText: '显式粘贴的节选。' }); assert.equal(inputs.at(-1).sourceText, '显式粘贴的节选。');
  await generate({ book: { title: '渡口', author: '另一位作者' } }); assert.equal(inputs.at(-1).sourceText, '');
  await post('/api/book-sources', { book, sourceText: '新的本地原文。' });
  const replaced = await generate({ force: true, replaceCacheId: first.cacheId });
  assert.equal(inputs.at(-1).sourceText, '新的本地原文。'); assert.notEqual(replaced.cacheId, first.cacheId);
  for (const invalid of ['', ' '.repeat(10), 'x'.repeat(600001)]) assert.equal((await post('/api/book-sources', { book, sourceText: invalid })).status, 400);
  assert.equal((await storage.getBookSource(book)).sourceText, '新的本地原文。');
});
