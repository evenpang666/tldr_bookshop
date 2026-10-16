import assert from 'node:assert/strict';
import { segmentResponse } from './offline-llm.mjs';

// Exercise the real provider serializer, transport and SSE decoder without
// sending credentials or making any external network requests.
export const name = 'thinbook-offline-transport';
export const inject = ['web'];
export function apply(ctx) {
  const sources = [
    { title: '离线来源 A', url: 'https://a.example/book', snippet: '测试专用资料 A' },
    { title: '离线来源 B', url: 'https://b.example/book', snippet: '测试专用资料 B' },
  ];
  const extra = { title: '离线来源 C', url: 'https://c.example/book', snippet: '缺失章节的研究资料' };
  ctx.web.registerSearchProvider({
    id: 'thinbook-offline', available: () => true,
    async search(request) {
      assert.equal(request.maxResults, 8);
      if (request.query.includes('offline:WEB_ERROR')) throw new Error('private-provider-detail sk-test-secret');
      if (request.query.includes('offline:WEB_INIT')) throw new Error('cannot get property "web" without inject');
      return { sources: request.query.includes('offline:NO_EVIDENCE') ? [] : request.query.includes('offline:mixed') ? [sources[1], extra] : sources, truncated: false };
    },
  });
  ctx.web.registerFetchProvider({
    id: 'thinbook-offline', available: () => true,
    async fetch(request) {
      assert.ok([...sources, extra].some(source => source.url === request.url));
      return { url: request.url, statusCode: 200, body: { kind: 'text', content: '完整测试网页。' }, truncated: false };
    },
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /^https:\/\/api\.deepseek\.com\/anthropic\/v1\/messages$/);
    const request = JSON.parse(options.body);
    assert.equal(options.headers['x-api-key'], 'not-a-real-key-offline-check');
    assert.match(request.system, /thin-book/);
    assert.ok(request.messages.every(message => ['user', 'assistant', 'system'].includes(message.role)));
    assert.equal(request.messages.at(-1).role, 'user');
    const prompt = JSON.stringify(request.messages);
    const latest = request.messages.findLast(message => message.role === 'user').content.filter(block => block.type === 'text').map(block => block.text).join('');
    const segment = segmentResponse(latest);
    const withoutSource = !prompt.includes('<untrusted_book_text>') && !segment;
    assert.deepEqual((request.tools || []).map(tool => tool.name).sort(), withoutSource ? ['web_fetch', 'web_search'] : []);
    const status = prompt.includes('offline:AUTH') ? 401 : prompt.includes('offline:QUOTA') ? 402 : prompt.includes('offline:CONTEXT') && prompt.includes('<untrusted_book_text>') ? 413 : undefined;
    if (status) return Response.json({ error: { message: 'private-provider-detail sk-test-secret', type: 'api_error' } }, { status });
    if (prompt.includes('offline:TRANSPORT')) throw new TypeError('private-provider-detail sk-test-secret');
    const phaseStart = request.messages.findLastIndex(message => message.role === 'user' && message.content.some(block => block.type === 'text' && /\[(?:ORIGINAL_DISCOVERY|SOURCE_SEGMENT|SEGMENT_REDUCE|SEGMENT_SYNTHESIS)\]|目标阅读时长/.test(block.text)));
    const discovery = JSON.stringify(request.messages[phaseStart]).includes('[ORIGINAL_DISCOVERY]');
    const mixed = JSON.stringify(request.messages[phaseStart]).includes('[MIXED_COMPLETION]');
    const originalFound = /offline:(?:ORIGINAL|EXCERPT)/.test(prompt);
    const results = request.messages.slice(phaseStart).flatMap(message => message.content.filter(block => block.type === 'tool_result'));
    let blocks, stopReason = 'end_turn';
    if (segment) {
      blocks = [{ type: 'text', text: JSON.stringify(segment) }];
    } else if (withoutSource && !results.length && (discovery || !originalFound || mixed)) {
      const marker = ['WEB_ERROR', 'WEB_INIT', 'NO_EVIDENCE'].find(marker => prompt.includes(`offline:${marker}`));
      blocks = [{ type: 'tool_use', id: 'offline-search', name: 'web_search', input: { queries: [marker ? `offline:${marker}` : mixed ? 'offline:mixed' : '离线书目资料'] } }];
      stopReason = 'tool_use';
    } else if (withoutSource && results.length === 1 && !/offline:(?:WEB_ERROR|WEB_INIT|NO_EVIDENCE)/.test(prompt)) {
      assert.ok(!results[0].is_error, JSON.stringify(results));
      assert.match(JSON.stringify(results), mixed ? /b\.example\/book/ : /a\.example\/book/);
      blocks = (mixed ? [sources[1], extra] : sources).map((source, index) => ({ type: 'tool_use', id: `offline-fetch-${index}`, name: 'web_fetch', input: { url: source.url } }));
      stopReason = 'tool_use';
    } else {
      if (withoutSource && results.length > 1) {
        assert.equal(results.length, 3);
        assert.ok(results.every(result => !result.is_error), JSON.stringify(results));
        assert.match(JSON.stringify(results), /完整测试网页/);
      }
      const insufficient = /offline:(?:WEB_ERROR|WEB_INIT|NO_EVIDENCE)/.test(prompt);
      const text = JSON.stringify(discovery ? { originals: originalFound ? [{ url: sources[0].url, complete: !prompt.includes('offline:EXCERPT') }] : [], coveredSections: ['第一部分'], missingSections: prompt.includes('offline:EXCERPT') ? ['第二部分', '第三部分'] : [], reason: '候选网页仅为非原文资料或正文节选。' } : { body: insufficient ? '' : '模拟正文只用于验证真实模型适配器的请求序列化、会话创建与流式响应解析。'.repeat(8), coverage: insufficient ? 'private-provider-detail sk-test-secret' : '离线测试资料。', ...(mixed ? { coverageMap: [{ section: '第一部分', basis: 'original', urls: [sources[0].url] }, { section: '第二部分', basis: 'reference', urls: [sources[1].url] }, { section: '第三部分', basis: 'reference', urls: [extra.url] }] } : {}), sources: withoutSource ? (mixed ? [...sources, extra] : originalFound ? [sources[0]] : sources) : [] });
      blocks = [{ type: 'text', text }];
    }
    const continued = latest.includes('[OUTPUT_CONTINUATION]');
    if (prompt.includes('offline:MAX_TOKENS')) {
      const packet = JSON.stringify({ body: '达到单次输出上限后仍应连续生成完整正文，之前已显示的内容不能丢失。'.repeat(10), coverage: '离线输出接续验证。', sources: [] });
      blocks = [{ type: 'text', text: continued ? packet.slice(180) : packet.slice(0, 180) }];
    }
    const events = [
      { type: 'message_start', message: { id: 'offline', role: 'assistant', model: request.model, content: [], usage: { input_tokens: 1200, output_tokens: 0 } } },
      ...blocks.flatMap((block, index) => [
        { type: 'content_block_start', index, content_block: block },
        { type: 'content_block_stop', index },
      ]),
      { type: 'message_delta', delta: { stop_reason: prompt.includes('offline:MAX_TOKENS') && !continued ? 'max_tokens' : stopReason }, usage: { output_tokens: 350 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  ctx.effect(() => () => { globalThis.fetch = original; });
}
