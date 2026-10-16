import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettings } from '../plugin/index.mjs';
import { createReader } from '../harness/reader.mjs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

// The configuration adapter needs presence facts only, never secret values.
test('DSH settings refresh selection and key presence without reading credentials', async () => {
  let model = 'deepseek-flash', configured = true;
  const settings = createSettings({ agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model }) }, credentials: { describe: async ref => { assert.equal(ref, 'DEEPSEEK_API_KEY'); return { configured }; } } });
  assert.equal((await settings.getConfig()).hasKey, true);
  model = 'deepseek-v4-pro'; configured = false;
  const refreshed = await settings.getConfig();
  assert.equal(refreshed.model, model); assert.equal(refreshed.hasKey, false); assert.equal(refreshed.apiKey, undefined);
});

test('canceling one reading disposes its agent while another reading completes', async () => {
  const handles = [];
  const ctx = { agents: { async create(options) {
    let finish;
    const idle = new Promise(resolve => { finish = resolve; });
    const handle = { disposed: false, agent: {
      followup(message) { assert.equal(message.role, 'user'); assert.ok(message.id); assert.ok(Object.isFrozen(message)); }, whenIdle: () => idle, cancel() { handle.canceled = true; finish(); },
      session: { snapshotEvents: () => [
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify({ body: '可靠的测试正文。'.repeat(30), sources: [] }) }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ] },
    }, finish, async dispose() { handle.disposed = true; } };
    const agentCtx = {
      tools: { restrict: filter => assert.deepEqual(filter, { allow: [] }), presentAs: mode => assert.equal(mode, 'native') },
      systemPrompt: { suppressRuntimeContext() {}, section: section => { assert.equal(section.complete, true); assert.match(section.text, /thin-book/); } },
      on() {},
    };
    await options.setup(agentCtx); handles.push(handle); return handle;
  } } };
  const generate = createReader(ctx, { applyWebTools() {}, createUserMessage });
  const controller = new AbortController();
  const input = { book: { title: '测试书', author: '作者' }, model: 'deepseek-flash', minutes: 5, sourceText: '原文' };
  const first = generate({ ...input, signal: controller.signal });
  const second = generate(input);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  while (handles.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort(); await rejected;
  const canceled = handles.find(handle => handle.canceled), remaining = handles.find(handle => !handle.canceled);
  assert.equal(canceled.disposed, true); assert.equal(remaining.disposed, false);
  remaining.finish(); assert.match((await second).body, /测试正文/); assert.equal(remaining.disposed, true);
});
