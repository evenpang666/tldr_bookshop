import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHarness } from '../scripts/check-harness.mjs';

test('official Harness creates sessions and returns reader output without scope identity conflicts', { timeout: 30000 }, async () => {
  assert.deepEqual(await checkHarness(), { sessions: 2, response: true, skill: true, tools: true });
});
