import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Run the browser entrypoint with inert UI elements, without a live server or model.
async function readerUI(fetchReading = () => new Promise(() => {})) {
  const elements = new Map();
  const element = () => ({
    hidden: false, textContent: '', innerHTML: '', children: [], handlers: {},
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
    URL: { createObjectURL(blob) { exported = blob; return 'blob:test'; }, revokeObjectURL() {} },
  };
  const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  runInNewContext(`${script}\nglobalThis.showReading = openReading; globalThis.readerState = state;`, context);
  return { get, show: context.showReading, state: context.readerState, exportText: async () => {
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

const oldReading = { title: '渡口', author: '测试', book: { id: 'ferry', title: '渡口', author: '测试' }, minutes: 5, basis: '资料提炼', body: '原来的正文。', cacheId: 'a'.repeat(64), progress: .8 };
const streamResponse = event => new Response(JSON.stringify(event) + '\n');

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

test('old source readings require importing the source before regeneration', async () => {
  let sent;
  const ui = await readerUI((_url, options) => { sent = JSON.parse(options.body); return streamResponse({ type: 'error', message: '测试结束。' }); });
  await ui.show({ ...oldReading, basis: '原文缩写' });
  await ui.get('#regenerate-reading').handlers.click();
  assert.equal(sent, undefined); assert.equal(ui.get('#book-dialog').open, true);
  await ui.get('#read-book').handlers.click(); assert.equal(sent, undefined);
  ui.get('#source-text').value = '重新导入的原文。';
  await ui.get('#read-book').handlers.click();
  assert.equal(sent.force, true); assert.equal(sent.replaceCacheId, oldReading.cacheId);
  assert.equal(sent.sourceText, '重新导入的原文。'); assert.equal(sent.sourceComplete, true);
});
