import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Run the browser entrypoint with inert UI elements, without a live server or model.
async function readerUI(fetchReading = () => new Promise(() => {})) {
  const elements = new Map();
  const element = () => ({
    hidden: false, value: '', textContent: '', innerHTML: '', children: [], handlers: {},
    style: { setProperty() {} },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    click() {}, close() { this.open = false; }, showModal() { this.open = true; },
  });
  const get = selector => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  let exported;
  const context = {
    location: { pathname: '/' },
    document: { querySelector: get, querySelectorAll: () => [], addEventListener() {}, body: { style: {} }, createElement: element },
    localStorage: { getItem() { return null; }, setItem() {} },
    // Leave bootstrap pending; these tests supply readings directly.
    fetch: (url, options) => url === '/api/bootstrap' ? new Promise(() => {}) : fetchReading(url, options),
    requestAnimationFrame() {}, setTimeout() {}, clearTimeout() {}, Blob, AbortController, TextDecoder,
    URL: class extends URL { static createObjectURL(blob) { exported = blob; return 'blob:test'; } static revokeObjectURL() {} },
  };
  const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  runInNewContext(`${script}\nglobalThis.showReading = openReading; globalThis.readerState = state; globalThis.openBookDetail = openBook; globalThis.importBookFile = importSourceFile;`, context);
  return { get, show: context.showReading, state: context.readerState, openBook: context.openBookDetail, importFile: context.importBookFile, exportText: async () => {
    get('#export-reading').handlers.click();
    return exported.text();
  } };
}

test('reader displays notes outside the body and clears them for older readings', async () => {
  const ui = await readerUI();
  const reading = { title: '渡口', author: '测试', basis: '节选缩写', body: '我走到渡口。', notes: '这本书的背景。\n<script>test</script>', coverage: '节选。' };
  await ui.show(reading);
  assert.equal(ui.get('#reader-body').innerHTML, '<p>我走到渡口。</p>');
  assert.equal(ui.get('#reader-notes').hidden, false);
  assert.equal(ui.get('#reader-notes-text').textContent, reading.notes);
  assert.equal(ui.get('#reader-notes-text').innerHTML, '');
  const exported = await ui.exportText();
  assert.ok(exported.indexOf('## 书籍附注') > exported.indexOf(reading.body));
  assert.ok(exported.includes('<small>这本书的背景。<br>&lt;script&gt;test&lt;/script&gt;</small>'));
  const { notes, ...legacy } = reading;
  await ui.show(legacy);
  assert.equal(ui.get('#reader-notes').hidden, true);
  assert.equal(ui.get('#reader-notes-text').textContent, '');
  assert.ok(!(await ui.exportText()).includes('书籍附注'));
});

test('mixed reading shows chapter provenance at the end and preserves it in exports', async () => {
  const ui = await readerUI();
  const reading = { title: '测试书', author: '测试', basis: '原文与资料综合提炼', sourceMode: 'web-mixed', body: '完整框架下的连续正文。', coverage: '前部据原文，后部据资料补全。', coverageMap: [
    { section: '认知革命', basis: 'original', urls: ['https://a.example/book'] },
    { section: '农业革命 <test>', basis: 'reference', urls: ['https://b.example/book'] },
  ] };
  await ui.show(reading);
  assert.match(ui.get('#reader-basis').textContent, /原文＋资料补全/);
  assert.equal(ui.get('#reader-coverage-map').hidden, false);
  assert.match(ui.get('#reader-coverage-map').innerHTML, /认知革命：原文压缩/);
  assert.match(ui.get('#reader-coverage-map').innerHTML, /农业革命 &lt;test&gt;：资料补全/);
  assert.equal(ui.get('#reader-body').innerHTML, '<p>完整框架下的连续正文。</p>');
  const exported = await ui.exportText();
  assert.ok(exported.indexOf('认知革命：原文压缩') > exported.indexOf(reading.body));
  assert.match(exported, /农业革命 &lt;test&gt;：资料补全（https:\/\/b.example\/book）/);
  await ui.show({ ...reading, coverageMap: undefined });
  assert.equal(ui.get('#reader-coverage-map').hidden, true);
});

test('complete originals open lazily as escaped text while partial originals expose links only', async () => {
  let calls = 0;
  const ui = await readerUI(url => {
    calls++; assert.equal(url, `/api/readings/${'a'.repeat(64)}/original`);
    return Response.json({ original: { pages: [{ title: '原文', url: 'https://source.example/book', text: '真实原文。\n<script>不执行</script>' }] } });
  });
  const reading = { title: '测试书', author: '作者', body: '正文。', cacheId: 'a'.repeat(64), original: { complete: true, cached: true, characters: 1000, links: [{ title: '原文来源', url: 'https://source.example/book' }] } };
  await ui.show(reading);
  assert.equal(calls, 0); assert.equal(ui.get('#reader-original').hidden, false); assert.equal(ui.get('#view-original').hidden, false);
  await ui.get('#view-original').handlers.click();
  assert.equal(calls, 1); assert.equal(ui.get('#original-dialog').open, true);
  assert.match(ui.get('#original-content').innerHTML, /真实原文。/);
  assert.match(ui.get('#original-content').innerHTML, /&lt;script&gt;不执行&lt;\/script&gt;/);
  assert.ok(!ui.get('#original-content').innerHTML.includes('<script>'));
  assert.match(await ui.exportText(), /## 原文链接/);
  await ui.show({ ...reading, original: { ...reading.original, complete: false, cached: false } });
  assert.equal(ui.get('#view-original').hidden, true); assert.equal(ui.get('#original-dialog').open, false);
  assert.match(ui.get('#original-links').innerHTML, /https:\/\/source.example\/book/);
  assert.match(ui.get('#original-status').textContent, /部分原文/);
  await ui.show({ ...reading, original: undefined });
  assert.equal(ui.get('#reader-original').hidden, true); assert.equal(ui.get('#original-links').innerHTML, '');
});

test('a late original response cannot replace the viewer for a different reading', async () => {
  let release;
  const response = new Promise(resolve => { release = resolve; });
  const ui = await readerUI(() => response);
  await ui.show({ title: '旧书', author: '作者', body: '旧正文。', cacheId: 'a'.repeat(64), original: { cached: true, complete: true, links: [] } });
  const pending = ui.get('#view-original').handlers.click();
  await ui.show({ title: '新书', author: '作者', body: '新正文。' });
  release(Response.json({ original: { pages: [{ text: '过期原文', url: 'https://source.example/book' }] } })); await pending;
  assert.equal(ui.get('#original-dialog').open, false); assert.equal(ui.get('#original-content').innerHTML, '');
});

const oldReading = { title: '渡口', author: '测试', book: { id: 'ferry', title: '渡口', author: '测试' }, minutes: 5, basis: '资料提炼', body: '原来的正文。', cacheId: 'a'.repeat(64), progress: .8 };
const streamResponse = event => new Response(JSON.stringify(event) + '\n');

test('new pages appear while generation runs and history is saved only at completion', async () => {
  let output;
  const stream = new ReadableStream({ start(controller) { output = controller; } });
  const ui = await readerUI(() => new Response(stream));
  ui.openBook(oldReading.book); ui.state.hasKey = true;
  const pending = ui.get('#read-book').handlers.click();
  const send = event => output.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
  send({ type: 'partial', body: '第一段。' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.get('#reader-body').innerHTML, '<p>第一段。</p>');
  assert.equal(ui.get('#reader-article').hidden, false); assert.equal(ui.state.running, true);
  assert.equal(ui.get('#reader-stream').hidden, false); assert.equal(ui.get('#export-reading').disabled, true);
  assert.equal(ui.state.history.length, 0);
  ui.get('#reader').scrollTop = 200;
  send({ type: 'partial', body: '第一段。\n\n第二段。' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.get('#reader-body').innerHTML, '<p>第一段。</p><p>第二段。</p>');
  assert.equal(ui.get('#reader').scrollTop, 200); assert.equal(ui.state.history.length, 0);
  send({ type: 'result', reading: { ...oldReading, body: '第一段。\n\n第二段。', cacheId: 'b'.repeat(64) } }); output.close(); await pending;
  assert.equal(ui.get('#reader-stream').hidden, true); assert.equal(ui.state.running, false);
  assert.equal(ui.get('#export-reading').disabled, false); assert.equal(ui.state.history.length, 1);
  assert.equal(ui.state.history[0].body, '第一段。\n\n第二段。');
});

test('a failed new reading keeps the visible unfinished pages without saving them', async () => {
  const events = [{ type: 'partial', body: '已经显示的部分。' }, { type: 'error', message: '连接中断。' }];
  const ui = await readerUI(() => new Response(events.map(event => JSON.stringify(event) + '\n').join('')));
  ui.openBook(oldReading.book); ui.state.hasKey = true;
  await ui.get('#read-book').handlers.click();
  assert.equal(ui.get('#reader-body').innerHTML, '<p>已经显示的部分。</p>');
  assert.equal(ui.get('#reader-article').hidden, false); assert.equal(ui.get('#stream-retry').hidden, false);
  assert.match(ui.get('#stream-status').textContent, /尚未完成/); assert.equal(ui.state.history.length, 0);
  assert.equal(ui.get('#export-reading').disabled, true);
});

test('stopping a partial output prevents a late final result from replacing history', async () => {
  let output, signal;
  const stream = new ReadableStream({ start(controller) { output = controller; } });
  const ui = await readerUI((_url, options) => { signal = options.signal; return new Response(stream); });
  await ui.show(oldReading); ui.state.history = [oldReading];
  const pending = ui.get('#regenerate-reading').handlers.click();
  output.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'partial', body: '新生成的部分。' }) + '\n')); await new Promise(resolve => setImmediate(resolve));
  ui.get('#cancel-output').handlers.click(); assert.equal(signal.aborted, true);
  output.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'result', reading: { ...oldReading, body: '不应保存。' } }) + '\n')); output.close(); await pending;
  assert.equal(ui.state.history[0], oldReading); assert.equal(ui.get('#reader').hidden, true);
});

test('regenerate button forces one request for the open reading and replaces history', async () => {
  let release, calls = 0, sent;
  const response = new Promise(resolve => { release = resolve; });
  const ui = await readerUI((url, options) => {
    assert.equal(url, '/api/generate'); calls++; sent = JSON.parse(options.body);
    return response;
  });
  await ui.show(oldReading); ui.state.history = [oldReading];
  ui.state.selected = { title: '另一本书', author: '其他作者' }; ui.state.minutes = 20;
  const pending = ui.get('#regenerate-reading').handlers.click();
  assert.equal(ui.get('#regenerate-reading').disabled, true);
  await ui.get('#regenerate-reading').handlers.click();
  assert.equal(calls, 1);
  assert.equal(sent.book.title, oldReading.title); assert.equal(sent.minutes, 5);
  assert.equal(sent.force, true); assert.equal(sent.replaceCacheId, oldReading.cacheId);
  const replacement = { ...oldReading, body: '重新压缩的正文。', cacheId: 'b'.repeat(64) };
  release(streamResponse({ type: 'result', reading: replacement })); await pending;
  assert.equal(ui.get('#reader-body').innerHTML, '<p>重新压缩的正文。</p>');
  assert.equal(ui.get('#regenerate-reading').disabled, false);
  assert.equal(ui.state.history.length, 1); assert.equal(ui.state.history[0].cacheId, replacement.cacheId);
  assert.equal(ui.state.history[0].progress, 0);
});

test('failed regeneration restores the reading and progress without replacing history', async () => {
  const ui = await readerUI(() => streamResponse({ type: 'error', message: '模型请求失败。' }));
  await ui.show(oldReading); ui.state.history = [oldReading];
  await ui.get('#regenerate-reading').handlers.click();
  assert.equal(ui.get('#reader-body').innerHTML, '<p>原来的正文。</p>');
  assert.equal(ui.state.reading, oldReading); assert.equal(ui.state.history[0], oldReading);
  assert.equal(ui.state.reading.progress, .8); assert.equal(ui.get('#reader-article').hidden, false);
  assert.match(ui.get('#toast').textContent, /原内容已保留/);
});

test('canceling regeneration ignores a late result and preserves history', async () => {
  let release, signal;
  const response = new Promise(resolve => { release = resolve; });
  const ui = await readerUI((_url, options) => { signal = options.signal; return response; });
  await ui.show(oldReading); ui.state.history = [oldReading];
  const pending = ui.get('#regenerate-reading').handlers.click();
  ui.get('#reader').handlers.scroll();
  assert.equal(oldReading.progress, .8);
  ui.get('#cancel-reading').handlers.click();
  assert.equal(signal.aborted, true);
  release(streamResponse({ type: 'result', reading: { ...oldReading, body: '不应显示。' } })); await pending;
  assert.equal(ui.state.history[0], oldReading); assert.equal(ui.get('#reader').hidden, true);
});

test('old source readings can regenerate through the automatic source lookup', async () => {
  let sent;
  const ui = await readerUI((_url, options) => { sent = JSON.parse(options.body); return streamResponse({ type: 'error', message: '测试结束。' }); });
  await ui.show({ ...oldReading, basis: '原文缩写' });
  await ui.get('#regenerate-reading').handlers.click();
  assert.equal(sent.force, true); assert.equal(sent.replaceCacheId, oldReading.cacheId);
  assert.equal(sent.sourceText, undefined);
});

test('local file import stays associated with its book when the open detail changes', async () => {
  let release, sent;
  const fileRead = new Promise(resolve => { release = resolve; });
  const ui = await readerUI((url, options) => {
    assert.equal(url, '/api/book-sources'); sent = JSON.parse(options.body);
    return Response.json({ source: { book: sent.book, name: sent.name, characters: sent.sourceText.length, sourceComplete: false } });
  });
  ui.openBook(oldReading.book);
  const pending = ui.importFile({ name: '渡口.txt', size: 100, text: () => fileRead }, oldReading.book);
  assert.equal(ui.get('#read-book').disabled, true);
  ui.openBook({ title: '另一本书', author: '另一个作者' });
  release('第一本书的原文。'); await pending;
  assert.equal(sent.book.title, oldReading.title); assert.equal(sent.sourceText, '第一本书的原文。');
  assert.equal(ui.get('#source-status').textContent, '如果您有原文，可以直接上传。如果没有，AI会自己检索');
  ui.openBook(oldReading.book);
  assert.match(ui.get('#source-status').textContent, /渡口.txt/);
  assert.equal(ui.get('#read-book').disabled, false);
});
