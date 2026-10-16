import test from 'node:test';
import assert from 'node:assert/strict';
import { createReader, parseReading, selectOriginals, verifyMixedCoverage, coverageRequirements } from '../harness/reader.mjs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

const book = { title: '渡口', author: '测试' };
const sources = [{ title: '正文', url: 'https://a.example/book' }, { title: '研究', url: 'https://b.example/book' }, { title: '导读', url: 'https://c.example/book' }];
const search = id => [
  { type: 'tool/call', data: { callId: id, name: 'web_search' } },
  { type: 'tool/result', data: { message: { toolCallId: id, isError: false }, meta: { sources } } },
];
const fetchPage = (truncated = false, failed = false) => [
  { type: 'tool/call', data: { callId: 'fetch', name: 'web_fetch' } },
  { type: 'tool/result', data: { message: { toolCallId: 'fetch', isError: failed, content: [{ type: 'text', text: '实际抓取的原文，不是模型摘要。' }] }, meta: { url: sources[0].url, statusCode: failed ? 403 : 200, truncated } } },
];
const answer = { body: '我走到渡口，雨停了。'.repeat(20), coverage: '实际已读内容。', sources };

function driver(turns) {
  const prompts = [], events = []; let webRegistrations = 0;
  const ctx = { agents: { async create(options) {
    await options.setup({ tools: { restrict() {}, presentAs() {} }, systemPrompt: { suppressRuntimeContext() {}, section() {} }, on() {} });
    return { async dispose() {}, agent: {
      followup(message) {
        prompts.push(message.content[0].text);
        const turn = turns[prompts.length - 1]; assert.ok(turn, 'Unexpected extra model turn');
        events.push(...(turn.events || []), { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify(turn.output) }] } } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
      }, async whenIdle() {}, session: { snapshotEvents: () => [...events] },
    } };
  } } };
  return { prompts, generate: createReader(ctx, { createUserMessage, applyWebTools() { webRegistrations++; } }), webRegistrations: () => webRegistrations };
}

test('local original generates in one turn without registering web tools', async () => {
  const agent = driver([{ output: answer }]);
  const reading = await agent.generate({ book, minutes: 5, sourceText: '本地原文。', sourceComplete: true });
  assert.equal(agent.prompts.length, 1); assert.equal(agent.webRegistrations(), 0);
  assert.equal(reading.basis, '原文缩写'); assert.equal(reading.sourceMode, 'local-original');
  assert.equal(reading.original, undefined);
});

test('complete fetched original generates without reference supplementation', async () => {
  const agent = driver([
    { events: [...search('original-search'), ...fetchPage()], output: { originals: [{ url: sources[0].url, complete: true }] } },
    { output: { ...answer, sources: [sources[0]], original: { complete: true, pages: [{ text: '模型伪造的原文' }] } } },
  ]);
  const reading = await agent.generate({ book, minutes: 5 });
  assert.equal(agent.prompts.length, 2); assert.match(agent.prompts[0], /\[ORIGINAL_DISCOVERY\]/);
  assert.doesNotMatch(agent.prompts[1], /\[REFERENCE_FALLBACK\]/);
  assert.equal(reading.sourceMode, 'web-original'); assert.equal(reading.basis, '原文缩写');
  assert.equal(reading.sources.length, 1);
  assert.equal(reading.original.complete, true);
  assert.equal(reading.original.pages[0].text, '实际抓取的原文，不是模型摘要。');
});

const missingSections = ['农业革命', '人类的融合统一', '科学革命'];
const coverageMap = [{ section: '认知革命', basis: 'original', urls: [sources[0].url] }, ...missingSections.map((section, index) => ({ section, basis: 'reference', urls: [sources[1 + index % 2].url] }))];
const partialDiscovery = truncated => ({ events: [...search('original-search'), ...fetchPage(truncated)], output: { originals: [{ url: sources[0].url, complete: truncated }], coveredSections: ['认知革命'], missingSections, reason: '第五章以后受订阅与登录限制。' } });

for (const truncated of [false, true]) test(`partial original supplements unavailable sections from references (truncated: ${truncated})`, async () => {
  const agent = driver([partialDiscovery(truncated), { events: search('reference-search'), output: { ...answer, basis: '原文缩写', coverageMap } }]);
  const reading = await agent.generate({ book, minutes: 5 });
  assert.match(agent.prompts[1], /\[MIXED_COMPLETION\]/);
  for (const section of missingSections) assert.ok(agent.prompts[1].includes(section));
  assert.equal(reading.sourceMode, 'web-mixed'); assert.equal(reading.basis, '原文与资料综合提炼');
  assert.deepEqual(reading.coverageMap, coverageMap); assert.equal(reading.sources.length, 3);
  assert.match(reading.coverage, /缺失原文部分以非原文资料补充/);
  assert.equal(reading.original.complete, false); assert.equal(reading.original.pages, undefined);
  assert.deepEqual(reading.original.links.map(link => link.url), [sources[0].url]);
});

test('mixed validation rejects omitted chapters, nonexistent mappings and no new search', () => {
  const cases = [
    { output: { ...answer, coverageMap: coverageMap.slice(0, -1) }, events: search('refs'), error: /缺失章节/ },
    { output: { ...answer, coverageMap: [...coverageMap, { section: '冒充原文', basis: 'original', urls: [sources[1].url] }] }, events: search('refs'), error: /对应关系/ },
    { output: { ...answer, coverageMap }, events: [], error: /实际检索来源/ },
  ];
  for (const failure of cases) {
    const material = { originals: [sources[0].url], coveredSections: ['认知革命'], missingSections, mixed: true };
    assert.throws(() => verifyMixedCoverage(parseReading(JSON.stringify(failure.output), book, false, false, material), failure.events, material), failure.error);
  }
});

test('mixed section names tolerate typography and numbering while preserving scope', () => {
  const material = { originals: [sources[0].url], coveredSections: ['认知革命'], missingSections, mixed: true };
  const reading = { ...answer, coverageMap: coverageMap.map(row => ({ ...row, section: row.basis === 'original' ? '第一部分：“认知革命”' : `《${row.section}》` })) };
  const result = verifyMixedCoverage(reading, search('refs'), material);
  assert.deepEqual(result.coverageMap, coverageMap);
  assert.throws(() => verifyMixedCoverage({ ...reading, coverageMap: reading.coverageMap.map(row => row.basis === 'original' ? { ...row, section: '认知革命与农业革命' } : row) }, search('refs'), material), /已读章节/);
  const numbered = { ...material, coveredSections: ['第一章'], missingSections: ['第二章'] };
  assert.throws(() => verifyMixedCoverage({ ...answer, coverageMap: [{ section: '第三章', basis: 'original', urls: [sources[0].url] }, { section: '第二章', basis: 'reference', urls: [sources[1].url] }] }, search('refs'), numbered), /已读章节/);
});

test('fixed section IDs preserve discovery ranges across different final headings', () => {
  const material = { originals: [sources[0].url], coveredSections: ['第一部分认知革命第一至第四章'], missingSections, mixed: true };
  const rows = coverageRequirements(material).map((row, index) => ({ ...row, section: index === 0 ? '认知革命' : row.section, urls: [sources[index === 0 ? 0 : 1].url] }));
  const result = verifyMixedCoverage({ ...answer, coverageMap: rows }, search('refs'), material);
  assert.equal(result.coverageMap[0].section, material.coveredSections[0]);
  assert.throws(() => verifyMixedCoverage({ ...answer, coverageMap: rows.map(row => row.basis === 'original' ? { ...row, sectionId: 'reference-1' } : row) }, search('refs'), material), /标识与来源类型/);
});

test('mixed reading automatically repairs attribution after paged output without replacing the body', async () => {
  const first = '第一章的连续正文。'.repeat(15), last = '后续章节与结局。'.repeat(15), partials = [], statuses = [];
  const agent = driver([
    partialDiscovery(false),
    { events: search('refs'), output: { bodyChunk: first, done: false } },
    { output: { bodyChunk: last, done: true, sources, coverageMap: coverageMap.map(row => row.basis === 'original' ? { ...row, section: '第一至第四章（试读范围）' } : row) } },
    { output: { coverageMap, sources, coverage: '原文与资料均已对应。', body: '不要接受修复响应中的替换正文。' } },
  ]);
  const reading = await agent.generate({ book, minutes: 5, onPartial: value => partials.push(value.body), onStatus: value => statuses.push(value) });
  assert.equal(reading.body, `${first}\n\n${last}`);
  assert.deepEqual(partials, [first, reading.body]);
  assert.deepEqual(reading.coverageMap, coverageMap);
  assert.match(agent.prompts[3], /COVERAGE_REPAIR/); assert.match(agent.prompts[3], /original-1/);
  assert.ok(statuses.some(status => /自动补核对/.test(status)));
  assert.equal(agent.prompts.length, 4);
});

test('attribution repair can retrieve missing reference evidence and is bounded if still invalid', async () => {
  const agent = driver([partialDiscovery(false), { output: { ...answer, coverageMap } }, { events: search('repair-refs'), output: { sources, coverageMap } }]);
  const reading = await agent.generate({ book, minutes: 5 });
  assert.equal(reading.body, answer.body); assert.deepEqual(reading.coverageMap, coverageMap);
  assert.match(agent.prompts[2], /COVERAGE_REPAIR/);
  const invalid = { ...answer, coverageMap: coverageMap.slice(1) };
  const blocked = driver([partialDiscovery(false), { events: search('refs'), output: invalid }, { output: invalid }, { output: invalid }]);
  await assert.rejects(blocked.generate({ book, minutes: 5 }), /对应关系/);
  assert.equal(blocked.prompts.length, 4);
});

test('repair can correct a directory-only original registration using explicitly classified fetched chapter pages', async () => {
  const chapters = [1, 2].map(number => ({ title: `原文章节 ${number}`, url: `https://a.example/book/chapter-${number}` }));
  const chapterEvents = chapters.flatMap((source, index) => [
    { type: 'tool/call', data: { callId: `chapter-${index}`, name: 'web_fetch' } },
    { type: 'tool/result', data: { message: { toolCallId: `chapter-${index}`, isError: false }, meta: { url: source.url, statusCode: 200, truncated: false } } },
  ]);
  const rows = coverageMap.map(row => row.basis === 'original' ? { ...row, urls: chapters.map(source => source.url) } : row);
  const agent = driver([
    { ...partialDiscovery(false), events: [...partialDiscovery(false).events, ...chapterEvents] },
    { events: search('refs'), output: { ...answer, sources: [...sources, ...chapters], coverageMap: rows } },
    { output: { originals: chapters.map(source => ({ url: source.url })), coverageMap: rows } },
  ]);
  const reading = await agent.generate({ book, minutes: 10 });
  assert.equal(reading.body, answer.body); assert.deepEqual(reading.coverageMap, rows);
  assert.deepEqual(reading.original.links.map(source => source.url), chapters.map(source => source.url));
  assert.match(agent.prompts[2], /unknown-original-url/);
  assert.ok(agent.prompts[2].includes(chapters[0].url));
});

test('repair cannot promote searched-only, failed or newly fetched reference pages to original text', async () => {
  for (const mode of ['search-only', 'failed', 'reference-phase']) {
    const source = { title: '候选章节', url: 'https://a.example/book/unread' };
    const fetchEvents = [
      { type: 'tool/call', data: { callId: 'unread', name: 'web_fetch' } },
      { type: 'tool/result', data: { message: { toolCallId: 'unread', isError: mode === 'failed' }, meta: { url: source.url, statusCode: mode === 'failed' ? 403 : 200 } } },
    ];
    const discovery = partialDiscovery(false);
    discovery.events.push({ type: 'tool/call', data: { callId: 'candidate-search', name: 'web_search' } }, { type: 'tool/result', data: { message: { toolCallId: 'candidate-search' }, meta: { sources: [source] } } });
    if (mode === 'failed') discovery.events.push(...fetchEvents);
    const rows = coverageMap.map(row => row.basis === 'original' ? { ...row, urls: [source.url] } : row);
    const patch = { originals: [{ url: source.url }], coverageMap: rows, sources: [...sources, source] };
    const agent = driver([discovery, { events: [...search('refs'), ...(mode === 'reference-phase' ? fetchEvents : [])], output: { ...answer, ...patch } }, { output: patch }, { output: patch }]);
    await assert.rejects(agent.generate({ book, minutes: 10 }), /对应关系/);
  }
});

test('incremental metadata repair preserves earlier valid chapters, source links and body', async () => {
  const incomplete = { ...answer, coverageMap: coverageMap.slice(0, -2) };
  const agent = driver([
    partialDiscovery(false), { events: search('refs'), output: incomplete },
    { output: { coverageMap: [coverageMap.at(-2)], sources: [sources[1]] } },
    { output: { coverageMap: [coverageMap.at(-1)], sources: [sources[2]], body: '不能覆盖正文。' } },
  ]);
  const reading = await agent.generate({ book, minutes: 10 });
  assert.equal(reading.body, answer.body); assert.deepEqual(reading.coverageMap, coverageMap);
  assert.deepEqual(reading.sources, sources); assert.equal(agent.prompts.length, 4);
});

test('mixed readings retain verified chapter sources beyond the old sixteen-link limit', async () => {
  const references = Array.from({ length: 18 }, (_, index) => ({ title: `资料 ${index}`, url: `https://references.example/chapter-${index}` }));
  const referenceSearch = search('many-refs'); referenceSearch[1].data.meta.sources = references;
  const rows = [coverageMap[0], ...missingSections.map((section, index) => ({ section, basis: 'reference', urls: references.slice(index * 6, index * 6 + 6).map(source => source.url) }))];
  const agent = driver([partialDiscovery(false), { events: referenceSearch, output: { ...answer, sources: [sources[0], ...references], coverageMap: rows } }]);
  const reading = await agent.generate({ book, minutes: 10 });
  assert.equal(reading.sources.length, 19); assert.deepEqual(reading.coverageMap, rows);
  assert.equal(agent.prompts.length, 2);
});

test('unreadable original candidates trigger a separate reference search and honest labeling', async () => {
  const agent = driver([
    { events: [...search('original-search'), ...fetchPage(false, true)], output: { originals: [{ url: sources[0].url, complete: true }], reason: '候选页面无法读取。' } },
    { events: search('reference-search'), output: { ...answer, basis: '原文缩写' } },
  ]);
  const reading = await agent.generate({ book, minutes: 5 });
  assert.match(agent.prompts[1], /\[REFERENCE_FALLBACK\]/);
  assert.equal(reading.sourceMode, 'web-reference'); assert.equal(reading.basis, '资料提炼');
  assert.match(reading.coverage, /未获得可读取原文/);
  assert.equal(reading.original, undefined);
});

test('fallback cannot reuse discovery results without a new reference search', async () => {
  const agent = driver([{ events: search('original-search'), output: { originals: [] } }, { output: answer }]);
  await assert.rejects(agent.generate({ book, minutes: 5 }), /实际检索来源/);
});

test('search snippets and invented URLs cannot be selected as original text', () => {
  const material = selectOriginals(JSON.stringify({ originals: [{ url: sources[0].url, complete: true }, { url: 'https://invented.example/book', complete: true }] }), search('search'));
  assert.deepEqual(material.originals, []); assert.equal(material.complete, false);
  assert.throws(() => selectOriginals('{"originals":[]}', []), /原文检索记录/);
  const reading = parseReading(JSON.stringify({ ...answer, basis: '原文缩写', sourceMode: 'web-original' }), book);
  assert.equal(reading.basis, '资料提炼'); assert.equal(reading.sourceMode, 'web-reference');
});
