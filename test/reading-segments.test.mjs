import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSource, sourceFramework, prepareSegments, synthesizeSegments, verifySegmentedReading } from '../lib/reading-segments.mjs';
import { createReader } from '../harness/reader.mjs';
import { ReadingError } from '../lib/reading-error.mjs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

const contextError = () => new ReadingError({ kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', status: 413 } });
const chunkText = prompt => prompt.match(/<untrusted_source_segment>([\s\S]*?)<\/untrusted_source_segment>/)?.[1];
const ids = prompt => JSON.parse(prompt.match(/"coveredIds":(\[[^\n]*?\])/)[1]);
function respond(prompt) {
  if (prompt.includes('[SOURCE_SEGMENT]')) return { text: chunkText(prompt).slice(0, 300) + chunkText(prompt).slice(-300) };
  if (prompt.includes('[SEGMENT_REDUCE]')) return { text: '经过逐段压缩并保留后半部分的叙述。'.repeat(20), coveredIds: ids(prompt) };
  if (prompt.includes('[SEGMENT_SYNTHESIS]')) {
    const framework = JSON.parse(prompt.match(/标题）：(\[[^\n]*\])/)[1]);
    return { body: framework.map(title => `## ${title}\n\n${'事件和论证沿原有顺序向前推进。'.repeat(10)}`).join('\n\n') || '连续正文。'.repeat(30), coverage: '全部所给内容。', coveredIds: ids(prompt), sources: [] };
  }
  return { body: '普通正文。'.repeat(30), sources: [] };
}
function driver(answer = respond) {
  const prompts = [], handles = []; let web = 0;
  const ctx = { agents: { async create(options) {
    const handle = { disposed: false, events: [], web: false, agent: {
      followup(message) {
        const prompt = message.content[0].text; prompts.push(prompt);
        const result = answer(prompt, prompts.length, handle);
        if (result?.events) { handle.events.push(...result.events); return; }
        if (result instanceof ReadingError) { handle.events.push({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED' } } } }); return; }
        handle.events.push({ type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 50 }, message: { content: [{ type: 'text', text: JSON.stringify(result) }] } } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
      }, async whenIdle() {}, cancel() { handle.canceled = true; }, session: { snapshotEvents: () => [...handle.events] },
    }, async dispose() { handle.disposed = true; } };
    const agentCtx = { tools: { restrict() {}, presentAs() {} }, systemPrompt: { suppressRuntimeContext() {}, section() {} }, on() {}, handle };
    await options.setup(agentCtx); handles.push(handle); return handle;
  } } };
  return { prompts, handles, generate: createReader(ctx, { createUserMessage, applyWebTools(agentCtx) { web++; agentCtx.handle.web = true; } }), web: () => web };
}
const input = { book: { title: '长书', author: '测试' }, minutes: 5, sourceComplete: true, model: 'deepseek-flash' };
const longText = ['第一章 开端', '第二章 转折', '第三章 结局'].map((heading, index) => `${heading}\n${`段${index}中的事件。`.repeat(1300)}\n`).join('\n');

test('splitting preserves every character, paragraph order and surrogate pairs', () => {
  const text = '第一章 起点\n\n' + '叙述😀。\n'.repeat(5000) + '第二章 终点\n最终结局。';
  const parts = splitSource(text, 2001);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.ok(parts.every((part, index) => part.text.length <= 2001 && part.start === (parts[index - 1]?.end || 0)));
  assert.ok(parts.every(part => !/^[\uDC00-\uDFFF]/.test(part.text) && !/[\uD800-\uDBFF]$/.test(part.text)));
  assert.deepEqual(sourceFramework(text), ['第一章 起点', '第二章 终点']);
});

test('long originals use isolated sessions and retain all chapters and usage', async () => {
  const agent = driver(); const reading = await agent.generate({ ...input, sourceText: longText });
  const chunks = agent.prompts.filter(prompt => prompt.includes('[SOURCE_SEGMENT]'));
  assert.equal(chunks.map(chunkText).join(''), longText);
  assert.ok(agent.handles.every(handle => handle.disposed && handle.events.filter(event => event.type === 'turn/end').length === 1));
  assert.equal(agent.web(), 0); assert.equal(reading.basis, '原文缩写');
  assert.deepEqual(reading.segmentation.framework, ['第一章 开端', '第二章 转折', '第三章 结局']);
  assert.equal(reading.cost.modelCalls, agent.handles.length);
  assert.ok(agent.prompts.at(-1).length < longText.length);
});

test('context failure automatically subdivides and never drops a failed range', async () => {
  const successful = [];
  const agent = driver(prompt => {
    if (prompt.includes('<untrusted_book_text>')) return contextError();
    const text = chunkText(prompt);
    if (text && text.length > 2200) return contextError();
    if (text) successful.push(text);
    return respond(prompt);
  });
  const text = '第一章 测试\n' + '内容。'.repeat(3000) + '\n第二章 结局\n结束。';
  const reading = await agent.generate({ ...input, sourceText: text });
  assert.equal(successful.join(''), text); assert.ok(reading.segmentation.parts > 2);
  assert.ok(agent.handles.every(handle => handle.disposed));
});

test('hierarchical reduction and a smaller synthesis context preserve all segment IDs', async () => {
  let finalCalls = 0, reductions = 0;
  const call = async prompt => {
    if (prompt.includes('[SOURCE_SEGMENT]')) return JSON.stringify({ text: '完整分段内容。'.repeat(200) });
    if (prompt.includes('[SEGMENT_REDUCE]')) reductions++;
    if (prompt.includes('[SEGMENT_SYNTHESIS]') && finalCalls++ === 0) throw contextError();
    return JSON.stringify(respond(prompt));
  };
  const prepared = await prepareSegments({ text: '正文。'.repeat(80000), call });
  prepared.notes = [{ ids: prepared.ids, text: '待进一步压缩的摘要。'.repeat(700) }];
  const raw = await synthesizeSegments(prepared, { call, context: '', minutes: 5 });
  verifySegmentedReading(raw, prepared);
  assert.ok(reductions > 0); assert.equal(finalCalls, 2);
});

test('unnumbered source headings can be retained while invented headings are rejected', async () => {
  const text = '认知革命\n人类开始构建共同想象。\n农业革命\n人们定居下来。';
  const prepared = await prepareSegments({ text, call: async () => JSON.stringify({ text: '原文内容。', framework: ['认知革命', '农业革命'] }) });
  assert.deepEqual(prepared.framework, ['认知革命', '农业革命']);
  await assert.rejects(prepareSegments({ text, call: async () => JSON.stringify({ text: '原文内容。', framework: ['杜撰章节'] }) }), /章节标题/);
});

test('missing or reordered chapters and missing segment coverage are rejected', async () => {
  const prepared = { ids: ['p0-100', 'p100-200'], framework: ['第一章 开端', '第二章 结局'] };
  for (const result of [
    { body: '第一章 开端\n内容', coveredIds: prepared.ids },
    { body: '第二章 结局\n内容\n第一章 开端', coveredIds: prepared.ids },
    { body: '第一章 开端\n第二章 结局', coveredIds: ['p0-100'] },
  ]) assert.throws(() => verifySegmentedReading(JSON.stringify(result), prepared), /框架|覆盖/);
});

test('cancellation stops subsequent segments and releases every handle', async () => {
  const controller = new AbortController();
  const agent = driver((prompt, number) => { if (number === 2) controller.abort(); return respond(prompt); });
  await assert.rejects(agent.generate({ ...input, sourceText: longText, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(agent.prompts.length, 2); assert.ok(agent.handles.every(handle => handle.disposed));
});

test('network context recovery summarizes retrieved materials without inventing sources', async () => {
  const url = 'https://source.example/book'; let failed = false;
  const agent = driver(prompt => {
    if (prompt.includes('[SOURCE_SEGMENT]') || prompt.includes('[SEGMENT_REDUCE]')) return respond(prompt);
    if (prompt.includes('[ORIGINAL_DISCOVERY]') && !failed) {
      failed = true;
      return { events: [
        { type: 'tool/call', data: { callId: 'search', name: 'web_search' } },
        { type: 'tool/result', data: { message: { toolCallId: 'search', content: [{ type: 'text', text: '找到原文。' }] }, meta: { sources: [{ title: '原文', url }] } } },
        { type: 'tool/call', data: { callId: 'fetch', name: 'web_fetch' } },
        { type: 'tool/result', data: { message: { toolCallId: 'fetch', content: [{ type: 'text', text: '第一章 开端\n' + '已读正文。'.repeat(6000) + '\n第二章 结局\n结束。' }] }, meta: { url, statusCode: 200, truncated: false } } },
        { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED' } } } },
      ] };
    }
    if (prompt.includes('[ORIGINAL_DISCOVERY]')) { assert.match(prompt, /COMPACTED_MATERIALS/); return { originals: [{ url, complete: true }] }; }
    return { body: '全部原文的连续压缩内容。'.repeat(20), sources: [{ title: '原文', url }] };
  });
  const reading = await agent.generate(input);
  assert.equal(reading.sourceMode, 'web-original'); assert.equal(reading.sources[0].url, url);
  assert.ok(agent.prompts.some(prompt => prompt.includes('[SOURCE_SEGMENT]')));
  assert.ok(agent.handles.every(handle => handle.disposed));
});
