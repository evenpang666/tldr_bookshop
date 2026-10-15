// Test-only stream, loaded exclusively by check-harness, never by the application.
export const name = 'thinbook-offline-check';
export const inject = ['llm'];
export function apply(ctx) {
  ctx.on('llm/stream', async function* (options) {
    const names = (options.tools || []).map(tool => tool.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(['skill', 'web_fetch', 'web_search'])) throw new Error(`Unexpected reader tools: ${names.join(', ')}`);
    const prompt = JSON.stringify(options.messages);
    if (!prompt.includes('thin-book') || !prompt.includes('薄书阅读智能体')) throw new Error('Reader skill was not included in model context');
    const text = JSON.stringify({
      title: '离线运行时验证', author: '测试数据', basis: '节选缩写',
      body: '这段文字仅用于验证本地阅读智能体的会话创建、提示组装和结果返回，不代表真实书籍内容。'.repeat(5),
      coverage: '离线模拟模型输出，不访问任何外部 API。', sources: [],
    });
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 350, cacheReadTokens: 200 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
}
