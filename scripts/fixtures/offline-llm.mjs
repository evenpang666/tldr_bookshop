// Test-only stream, loaded exclusively by check-harness, never by the application.
export const name = 'thinbook-offline-check';
export const inject = ['llm'];
export function segmentResponse(prompt) {
  if (prompt.includes('[SOURCE_SEGMENT]')) {
    const text = prompt.match(/<untrusted_source_segment>([\s\S]*?)<\/untrusted_source_segment>/)[1];
    return { text: text.slice(0, 400) + text.slice(-400), framework: [] };
  }
  if (prompt.includes('[SEGMENT_REDUCE]')) return { text: '离线分层压缩材料。'.repeat(20), coveredIds: JSON.parse(prompt.match(/"coveredIds":(\[[^\n]*?\])/)[1]) };
  if (prompt.includes('[SEGMENT_SYNTHESIS]')) {
    const framework = JSON.parse(prompt.match(/标题）：(\[[^\n]*\])/)[1]);
    return { body: framework.map(title => `## ${title}\n\n${'会话创建与完整框架的分段整合验证。'.repeat(10)}`).join('\n\n') || '会话创建与分段整合。'.repeat(20), coveredIds: JSON.parse(prompt.match(/"coveredIds":(\[[^\n]*?\])/)[1]), coverage: '离线分段验证。', sources: [] };
  }
}
export function apply(ctx) {
  ctx.on('llm/stream', async function* (options) {
    if (options.messages.some(message => !message.role || !message.id)) throw new Error('Reader messages require a role and stable identity');
    const names = (options.tools || []).map(tool => tool.name).sort();
    const prompt = JSON.stringify(options.messages);
    const latest = options.messages.findLast(message => message.role === 'user').content.filter(block => block.type === 'text').map(block => block.text).join('');
    const segment = segmentResponse(latest);
    const expected = prompt.includes('<untrusted_book_text>') || segment ? [] : ['web_fetch', 'web_search'];
    if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`Unexpected reader tools: ${names.join(', ')}`);
    if (!prompt.includes('thin-book') || !prompt.includes('薄书阅读智能体')) throw new Error('Reader skill was not included in model context');
    const text = JSON.stringify(segment || {
      title: '离线运行时验证', author: '测试数据', basis: '节选缩写',
      body: '这段文字仅用于验证本地阅读智能体的会话创建、提示组装和结果返回，不代表真实书籍内容。'.repeat(5),
      notes: '离线书籍附注，仅用于验证与正文分开传递。',
      coverage: '离线模拟模型输出，不访问任何外部 API。', sources: [],
    });
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 350, cacheReadTokens: 200 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
}
