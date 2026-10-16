import assert from 'node:assert/strict';

// Exercise the real provider serializer, transport and SSE decoder without
// sending credentials or making any external network requests.
export const name = 'thinbook-offline-transport';
export const inject = ['web'];
export function apply(ctx) {
  const sources = [
    { title: '离线来源 A', url: 'https://a.example/book', snippet: '测试专用资料 A' },
    { title: '离线来源 B', url: 'https://b.example/book', snippet: '测试专用资料 B' },
  ];
  ctx.web.registerSearchProvider({
    id: 'thinbook-offline', available: () => true,
    async search(request) {
      assert.equal(request.maxResults, 8);
      if (request.query.includes('offline:WEB_ERROR')) throw new Error('private-provider-detail sk-test-secret');
      if (request.query.includes('offline:WEB_INIT')) throw new Error('cannot get property "web" without inject');
      return { sources: request.query.includes('offline:NO_EVIDENCE') ? [] : sources, truncated: false };
    },
  });
  ctx.web.registerFetchProvider({
    id: 'thinbook-offline', available: () => true,
    async fetch(request) {
      assert.ok(sources.some(source => source.url === request.url));
      return { url: request.url, statusCode: 200, body: { kind: 'text', content: '完整测试网页。' }, truncated: false };
    },
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /^https:\/\/api\.deepseek\.com\/anthropic\/v1\/messages$/);
    const request = JSON.parse(options.body);
    assert.deepEqual(request.tools.map(tool => tool.name).sort(), ['web_fetch', 'web_search']);
    assert.equal(options.headers['x-api-key'], 'not-a-real-key-offline-check');
    assert.match(request.system, /thin-book/);
    assert.ok(request.messages.every(message => ['user', 'assistant', 'system'].includes(message.role)));
    assert.equal(request.messages.at(-1).role, 'user');
    const prompt = JSON.stringify(request.messages);
    const status = prompt.includes('offline:AUTH') ? 401 : prompt.includes('offline:QUOTA') ? 402 : undefined;
    if (status) return Response.json({ error: { message: 'private-provider-detail sk-test-secret', type: 'api_error' } }, { status });
    if (prompt.includes('offline:TRANSPORT')) throw new TypeError('private-provider-detail sk-test-secret');
    const withoutSource = !prompt.includes('<untrusted_book_text>');
    const results = request.messages.flatMap(message => message.content.filter(block => block.type === 'tool_result'));
    let blocks, stopReason = 'end_turn';
    if (withoutSource && !results.length) {
      const marker = ['WEB_ERROR', 'WEB_INIT', 'NO_EVIDENCE'].find(marker => prompt.includes(`offline:${marker}`));
      blocks = [{ type: 'tool_use', id: 'offline-search', name: 'web_search', input: { queries: [marker ? `offline:${marker}` : '离线书目资料'] } }];
      stopReason = 'tool_use';
    } else if (withoutSource && results.length === 1 && !/offline:(?:WEB_ERROR|WEB_INIT|NO_EVIDENCE)/.test(prompt)) {
      assert.ok(!results[0].is_error, JSON.stringify(results));
      assert.match(JSON.stringify(results), /a\.example\/book/);
      blocks = sources.map((source, index) => ({ type: 'tool_use', id: `offline-fetch-${index}`, name: 'web_fetch', input: { url: source.url } }));
      stopReason = 'tool_use';
    } else {
      if (withoutSource && results.length > 1) {
        assert.equal(results.length, 3);
        assert.ok(results.every(result => !result.is_error), JSON.stringify(results));
        assert.match(JSON.stringify(results), /完整测试网页/);
      }
      const insufficient = /offline:(?:WEB_ERROR|WEB_INIT|NO_EVIDENCE)/.test(prompt);
      const text = JSON.stringify({ body: insufficient ? '' : '模拟正文只用于验证真实模型适配器的请求序列化、会话创建与流式响应解析。'.repeat(8), coverage: insufficient ? 'private-provider-detail sk-test-secret' : '离线测试资料。', sources: withoutSource ? sources : [] });
      blocks = [{ type: 'text', text }];
    }
    const events = [
      { type: 'message_start', message: { id: 'offline', role: 'assistant', model: request.model, content: [], usage: { input_tokens: 1200, output_tokens: 0 } } },
      ...blocks.flatMap((block, index) => [
        { type: 'content_block_start', index, content_block: block },
        { type: 'content_block_stop', index },
      ]),
      { type: 'message_delta', delta: { stop_reason: prompt.includes('offline:MAX_TOKENS') ? 'max_tokens' : stopReason }, usage: { output_tokens: 350 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  ctx.effect(() => () => { globalThis.fetch = original; });
}
