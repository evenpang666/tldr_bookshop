import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createReader } from '../harness/reader.mjs';

const sources = ['original', 'research', 'guide'].map(name => ({ title: name, url: `https://${name}.example/book` }));
const book = { title: '预算边界', author: '测试' };
const body = '已有证据支持的连续正文。'.repeat(20);
const coverageMap = [
  { section: '前部', basis: 'original', urls: [sources[0].url] },
  { section: '后部', basis: 'reference', urls: [sources[1].url, sources[2].url] },
];

// Drive the scoped assembly and dispatch hooks, including parallel tool batches.
function driver(turns) {
  const prompts = [], decisions = [], statuses = [], handles = [];
  const ctx = { agents: { async create(options) {
    const listeners = new Map(), events = []; let section, pending, callNumber = 0;
    await options.setup({
      tools: { restrict() {}, presentAs() {} },
      systemPrompt: { suppressRuntimeContext() {}, section(value) { section = value; } },
      on(name, callback) { listeners.set(name, callback); },
    });
    const emit = event => { events.push(event); listeners.get('session/event')?.(null, event); };
    const api = {
      async assembly() {
        const value = { tools: ['web_search', 'web_fetch'].map(name => ({ name })) };
        const assembled = await listeners.get('system-prompt/assemble')(value, {}, async () => value);
        return { ...assembled, text: typeof section.text === 'function' ? section.text() : section.text };
      },
      async call(name = 'web_search', failed = false) {
        const callId = `call-${callNumber++}`;
        emit({ type: 'tool/call', data: { name, callId } });
        const decision = await listeners.get('tools/pre-execute')({ name, callId }, async () => ({ kind: 'allow' }));
        decisions.push(decision);
        const isError = failed || decision.kind !== 'allow';
        emit({ type: 'tool/result', data: { message: { toolCallId: callId, isError, content: [{ type: 'text', text: isError ? '未取得正文。' : '实际已读取的材料。' }] }, ...(decision.info ? { error: decision.info } : {}),
          ...(!isError ? { meta: name === 'web_fetch' ? { url: sources[0].url, statusCode: 200, truncated: true } : { sources } } : {}) } });
        return decision;
      },
      batch(count) { return Promise.all(Array.from({ length: count }, () => api.call())); },
    };
    const handle = { disposed: false, canceled: false, async dispose() { this.disposed = true; }, agent: {
      followup(message) {
        const index = prompts.length; prompts.push(message.content[0].text);
        pending = (async () => {
          assert.ok(turns[index], 'Unexpected extra turn');
          const output = await turns[index](api);
          emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify(output) }] } } });
          emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
        })();
      },
      async whenIdle() { await pending; }, cancel() { handle.canceled = true; }, session: { snapshotEvents: () => [...events] },
    } };
    handles.push(handle); return handle;
  } } };
  return { prompts, decisions, statuses, handles, generate: input => createReader(ctx, { createUserMessage, applyWebTools() {} })({ book, minutes: 5, onStatus: value => statuses.push(value), ...input }) };
}

test('discovery exhaustion reserves a fresh reference budget and preserves successful evidence', async () => {
  const agent = driver([
    async api => {
      await api.batch(14);
      const assembly = await api.assembly();
      assert.deepEqual(assembly.tools, []); assert.match(assembly.text, /联网预算已用完/);
      return { originals: [], reason: '无可读取原文。' };
    },
    async api => {
      assert.equal((await api.assembly()).tools.length, 2);
      await api.batch(17);
      assert.deepEqual((await api.assembly()).tools, []);
      return { body, sources };
    },
  ]);
  const reading = await agent.generate();
  assert.equal(reading.body, body); assert.equal(reading.sourceMode, 'web-reference');
  assert.equal(agent.decisions.filter(decision => decision.kind === 'allow').length, 28);
  assert.equal(agent.decisions.filter(decision => decision.kind === 'deny').length, 3);
  assert.ok(agent.handles.every(handle => handle.disposed && !handle.canceled));
  assert.equal(agent.statuses.filter(status => /本阶段尝试/.test(status)).length, 1);
});

test('pagination shares its budget and both metadata repairs share the reserved four calls', async () => {
  const agent = driver([
    async api => {
      await api.call(); await api.call('web_fetch'); await api.batch(10);
      return { originals: [{ url: sources[0].url, complete: false }], coveredSections: ['前部'], missingSections: ['后部'] };
    },
    async api => { await api.batch(16); return { bodyChunk: body, done: false }; },
    async api => {
      assert.deepEqual((await api.assembly()).tools, []);
      assert.equal((await api.call()).kind, 'deny');
      return { bodyChunk: '', done: true, sources, coverageMap: [] };
    },
    async api => {
      assert.equal((await api.assembly()).tools.length, 2);
      await api.batch(5);
      return { sources, coverageMap: [] };
    },
    async api => {
      assert.deepEqual((await api.assembly()).tools, []);
      assert.equal((await api.call()).kind, 'deny');
      return { sources, coverageMap, coverage: '据已取得的原文和资料核验。', body: '不能替换已生成正文。' };
    },
  ]);
  const reading = await agent.generate();
  assert.equal(reading.body, body); assert.equal(reading.sourceMode, 'web-mixed');
  assert.deepEqual(reading.coverageMap, coverageMap);
  assert.equal(agent.decisions.filter(decision => decision.kind === 'allow').length, 32);
  assert.ok(agent.decisions.length > 32);
  assert.ok(agent.handles.every(handle => handle.disposed && !handle.canceled));
});

test('budget exhaustion still rejects fabricated or insufficient sources', async () => {
  const agent = driver([
    async api => { await api.batch(12); return { originals: [] }; },
    async api => {
      await api.batch(16);
      return { body, sources: [{ title: '虚构资料', url: 'https://invented.example/book' }] };
    },
  ]);
  await assert.rejects(agent.generate(), /实际检索来源/);
  assert.ok(agent.handles.every(handle => handle.disposed));
});

test('failed fetches consume discovery budget without discarding earlier successes', async () => {
  const agent = driver([
    async api => {
      await api.call(); await api.call('web_fetch');
      for (let index = 0; index < 10; index++) await api.call('web_fetch', true);
      assert.deepEqual((await api.assembly()).tools, []);
      return { originals: [{ url: sources[0].url, complete: true }], coveredSections: ['前部'], missingSections: ['后部'] };
    },
    async api => { await api.call(); return { body, sources, coverageMap }; },
  ]);
  const reading = await agent.generate();
  assert.equal(reading.sourceMode, 'web-mixed'); assert.equal(reading.original.complete, false);
  assert.equal(agent.decisions.length, 13);
});
