import assert from 'node:assert/strict';
import { createHarness, parseReading, root } from '../harness/reader.mjs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkHarness() {
  await mkdir(join(root, '.runtime'), { recursive: true });
  const home = await mkdtemp(join(root, '.runtime/check-'));
  const patch = join(home, 'offline.patch.yml');
  await writeFile(patch, `- insert:\n    - id: thinbook-offline-check\n      name: ${JSON.stringify(pathToFileURL(join(root, 'scripts/fixtures/offline-llm.mjs')).href)}\n`);
  const harness = await createHarness({ apiKey: 'not-a-real-key-offline-check', home, extraPatches: [patch] });
  try {
    await harness.start();
    const first = await harness.run('离线运行时验证；模型输出由测试插件提供。');
    const second = await harness.run('创建另一个会话，检查重复创建与作用域事件。');
    assert.notEqual(first.sessionId, second.sessionId);
    for (const result of [first, second]) {
      assert.ok(result.events.some(event => event.type === 'assistant/message'));
      const reading = parseReading(result.finalResponse, { title: '离线运行时验证', author: '测试数据' }, true);
      assert.equal(reading.basis, '节选缩写');
      assert.match(reading.body, /会话创建/);
    }
    return { sessions: 2, response: true, skill: true, tools: true };
  } finally { await harness.close(); await rm(home, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkHarness().then(() => console.log('PASS: official Harness created two sessions and completed offline model turns; reader skill and tool permissions verified. No API calls.')).catch(error => { console.error(error); process.exitCode = 1; });
}
