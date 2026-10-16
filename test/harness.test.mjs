import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHarness } from '../scripts/check-harness.mjs';

test('DSH Web loads the native plugin and reuses managed credentials for isolated reading agents', { timeout: 30000 }, async () => {
  assert.deepEqual(await checkHarness(), { sessions: 2, response: true, skill: true, tools: true });
});

test('real DSH provider runs web tools, verifies sources and reports structured failures without leaking secrets', { timeout: 30000 }, async () => {
  assert.deepEqual(await checkHarness({ transport: true }), { sessions: 10, response: true, skill: true, tools: true, transport: true, webTools: true, failures: 7 });
});
