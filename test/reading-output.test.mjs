import test from 'node:test';
import assert from 'node:assert/strict';
import { readingOutput, partialBody } from '../lib/reading-output.mjs';
import { createReader } from '../harness/reader.mjs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createServer } from '../server.mjs';
import { createStorage } from '../lib/storage.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('pages appear before completion and final metadata applies to the complete body', async () => {
  const partials = [], prompts = []; let calls = 0;
  const raw = await readingOutput({ prompt: '按原书框架生成。', publish: true, onPartial: value => partials.push(value.body), turn: async prompt => {
    prompts.push(prompt);
    if (calls++ === 0) return { text: JSON.stringify({ bodyChunk: '第一章\n\n开端。', done: false, nextSection: '第二章' }) };
    assert.deepEqual(partials, ['第一章\n\n开端。']);
    return { text: JSON.stringify({ bodyChunk: '第二章\n\n结局。', done: true, notes: '末尾附注', sources: [], coveredIds: ['p1', 'p2'] }) };
  } });
  const result = JSON.parse(raw);
  assert.equal(result.body, '第一章\n\n开端。\n\n第二章\n\n结局。');
  assert.equal(result.notes, '末尾附注'); assert.deepEqual(result.coveredIds, ['p1', 'p2']);
  assert.match(prompts[1], /READING_NEXT_PAGE/); assert.match(prompts[1], /第二章/);
});

test('a truncated JSON string resumes across escape boundaries without losing text', async () => {
  const partials = []; let index = 0;
  const responses = [
    { text: '{"bodyChunk":"第一段\\n\\u4e2', limited: true },
    { text: 'd😀\\\"引文\\\"","done":false,"nextSection":"结尾"}' },
    { text: '{"bodyChunk":"最后一段。","done":true,"sources":[]}' },
  ];
  const result = JSON.parse(await readingOutput({ prompt: '', publish: true, onPartial: value => partials.push(value.body), turn: async prompt => {
    if (index === 1) assert.match(prompt, /OUTPUT_CONTINUATION/);
    return responses[index++];
  } }));
  assert.equal(partials[0], '第一段\n');
  assert.equal(result.body, '第一段\n中😀"引文"\n\n最后一段。');
  assert.equal(partials.at(-1), result.body);
  assert.equal(partialBody('{"body":"abc\\uD83D'), 'abc');
});

test('pagination retains earlier chapter attributions and sources when the last page only supplies new ones', async () => {
  const original = { sectionId: 'original-1', section: '前部', basis: 'original', urls: ['https://original.example/'] };
  const reference = { sectionId: 'reference-1', section: '后部', basis: 'reference', urls: ['https://reference.example/'] };
  const pages = [
    { bodyChunk: '前部。', done: false, coverageMap: [original], sources: [{ title: '原文', url: original.urls[0] }] },
    { bodyChunk: '后部。', done: false, coverageMap: [reference], sources: [{ title: '资料', url: reference.urls[0] }] },
    { bodyChunk: '', done: true, coverageMap: [{ ...reference, section: '后部修正名称' }], sources: [{ title: '资料修正标题', url: reference.urls[0] }] },
  ];
  let index = 0;
  const result = JSON.parse(await readingOutput({ prompt: '', publish: true, turn: async () => ({ text: JSON.stringify(pages[index++]) }) }));
  assert.equal(result.body, '前部。\n\n后部。');
  assert.deepEqual(result.coverageMap, [original, { ...reference, section: '后部修正名称' }]);
  assert.equal(result.sources.length, 2); assert.equal(result.sources[1].title, '资料修正标题');
});

test('legacy length-limited bodies can continue as pages and non-body stages do not publish', async () => {
  let calls = 0;
  const result = JSON.parse(await readingOutput({ prompt: '', publish: true, turn: async () => calls++ === 0 ? { text: '{"body":"已生成的正文。","sources":[]}', limited: true } : { text: '{"bodyChunk":"新增结尾。","done":true,"coverage":"全篇。"}' } }));
  assert.equal(result.body, '已生成的正文。\n\n新增结尾。'); assert.equal(calls, 2);
  const partials = []; let part = 0;
  const raw = await readingOutput({ prompt: '内部提炼', onPartial: value => partials.push(value), turn: async () => part++ === 0 ? { text: '{"text":"摘要', limited: true } : { text: '内容"}' } });
  assert.equal(JSON.parse(raw).text, '摘要内容'); assert.equal(partials.length, 0);
});

test('context recovery resumes prior pages and retains its cursor', async () => {
  let calls = 0, state;
  await assert.rejects(readingOutput({ prompt: '', publish: true, turn: async () => {
    if (calls++ === 0) return { text: '{"bodyChunk":"保留前部。","done":false,"nextSection":"后部"}' };
    throw new Error('context');
  } }), error => { state = error.outputState; return error.message === 'context'; });
  const result = JSON.parse(await readingOutput({ prompt: '压缩后的资料', publish: true, resume: state, turn: async prompt => {
    assert.match(prompt, /后部/); return { text: '{"bodyChunk":"继续后部。","done":true,"sources":[]}' };
  } }));
  assert.equal(result.body, '保留前部。\n\n继续后部。');
});

test('empty or repeating output stops, and cancellation prevents later pages', async () => {
  let calls = 0;
  await assert.rejects(readingOutput({ prompt: '', publish: true, turn: async () => { calls++; return { text: '', limited: true }; } }), /可继续的内容/);
  assert.equal(calls, 2);
  await assert.rejects(readingOutput({ prompt: '', publish: true, turn: async () => ({ text: '{"bodyChunk":"相同一页。","done":false}' }) }), /新的正文段落/);
  const controller = new AbortController(); let pages = 0;
  await assert.rejects(readingOutput({ prompt: '', publish: true, signal: controller.signal, onPartial: () => controller.abort(), turn: async () => { pages++; return { text: '{"bodyChunk":"第一页。","done":false}' }; } }), { name: 'AbortError' });
  assert.equal(pages, 1);
});

test('the DSH reader continues a max-tokens turn and reports each body preview', async () => {
  let turn = 0, disposed = false;
  const packet = JSON.stringify({ body: '保留原文笔墨的正文。'.repeat(20), coverage: '全部原文。', sources: [] });
  const cutoff = 120, events = [], partials = [];
  const handle = { async dispose() { disposed = true; }, agent: { followup(message) {
    if (turn) assert.match(message.content[0].text, /OUTPUT_CONTINUATION/);
    events.push({ type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 50 }, message: { content: [{ type: 'text', text: turn ? packet.slice(cutoff) : packet.slice(0, cutoff) }] } } }, { type: 'turn/end', data: { reason: { kind: turn++ ? 'completed' : 'max-tokens' } } });
  }, async whenIdle() {}, session: { snapshotEvents: () => [...events] } } };
  const generate = createReader({ agents: { async create() { return handle; } } }, { createUserMessage, applyWebTools() {} });
  const result = await generate({ book: { title: '书', author: '作者' }, sourceText: '用户原文。', minutes: 5, model: 'deepseek-flash', onPartial: value => partials.push(value.body) });
  assert.equal(result.body, JSON.parse(packet).body); assert.equal(turn, 2); assert.ok(partials.length >= 2);
  assert.ok(result.body.startsWith(partials[0])); assert.equal(result.cost.modelCalls, 2); assert.equal(disposed, true);
});

test('HTTP exposes partial content before saving, and only caches the final reading', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'thinbook-output-')); const storage = createStorage(directory);
  let release;
  const done = new Promise(resolve => { release = resolve; });
  const server = createServer({ storage, settings: { getConfig: async () => ({ hasKey: true, model: 'deepseek-flash' }) }, generate: async ({ book, minutes, onPartial }) => {
    onPartial({ body: '第一段。' }); await done; onPartial({ body: '第一段。\n\n第二段。' });
    return { book, title: book.title, author: book.author, minutes, body: '第一段。\n\n第二段。' };
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`, bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  const response = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Thinbook-Token': bootstrap.token }, body: JSON.stringify({ book: { title: '书', author: '作者' }, minutes: 5 }) });
  const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '';
  while (!text.includes('partial')) text += decoder.decode((await reader.read()).value, { stream: true });
  assert.match(text, /第一段/); assert.equal((await storage.listReadings()).length, 0);
  release();
  while (true) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value, { stream: true }); }
  const result = JSON.parse(text.trim().split('\n').at(-1));
  assert.equal(result.type, 'result'); assert.equal((await storage.listReadings()).length, 1);
  assert.equal((await storage.getReading(result.reading.cacheId)).body, '第一段。\n\n第二段。');
});
