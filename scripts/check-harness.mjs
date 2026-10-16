import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { root } from '../harness/reader.mjs';

export async function checkHarness({ transport = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'thinbook-dsh-check-'));
  const patch = join(home, 'offline.patch.yml');
  const profile = join(home, 'profiles/web');
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'thinbook-check-profile', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'thinbook'] } } }));
  await symlink(root, join(profile, 'node_modules/thinbook'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: not-a-real-key-offline-check\n', { mode: 0o600 });
  await writeFile(patch, `- id: session-title-llm\n  disabled: true\n- id: llm-retry\n  disabled: true\n- id: thinbook\n  config:\n    port: 0\n    host: 127.0.0.1\n    dataRoot: ${JSON.stringify(home)}\n- insert:\n    - id: thinbook-offline-check\n      name: ${JSON.stringify(pathToFileURL(join(root, `scripts/fixtures/offline-${transport ? 'transport' : 'llm'}.mjs`)).href)}\n`);
  if (transport) await writeFile(patch, '- id: web\n  config:\n    searchProvider: thinbook-offline\n    fetchProvider: thinbook-offline\n', { flag: 'a' });
  const child = spawn(process.execPath, [join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--patch', patch, '--no-open', '--port', '0'], {
    cwd: root, env: { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: '', DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', timer;
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    const url = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`DSH startup timed out: ${output.slice(-5000)}`)), 20000);
      const collect = chunk => { output += chunk; const match = output.match(/\[DSH 插件\]\s+本机：(http:\/\/127\.0\.0\.1:\d+)/); if (match) resolve(match[1]); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      child.once('error', reject); child.once('exit', code => reject(new Error(`DSH exited ${code}: ${output.slice(-5000)}`)));
    });
    clearTimeout(timer);
    const health = await (await fetch(`${url}/api/health`)).json(); assert.equal(health.runtime, 'dsh');
    assert.equal((await fetch(`${url}/api/bootstrap`)).status, 200);
    assert.equal((await fetch(`${url}/app.js`)).status, 200);
    const record = JSON.parse(await readFile(join(home, 'thinbook/host.json'), 'utf8'));
    assert.equal(new URL(record.url).search, '');
    assert.equal((await fetch(`http://127.0.0.1:${record.webPort}/`)).status, 401);
    const hostFetch = fetch;
    const page = await (await hostFetch(url + '/')).text(); assert.match(page, /src="\/app.js"/); assert.match(page, /href="\/style.css"/);
    assert.equal((await hostFetch(url + '/app.js')).status, 200);
    const bootstrap = await (await hostFetch(`${url}/api/bootstrap`)).json();
    assert.equal(bootstrap.settings.managed, true); assert.equal(bootstrap.settings.hasKey, true); assert.equal(bootstrap.settings.admin, false);
    assert.ok(!JSON.stringify(bootstrap).includes('not-a-real-key'));
    const headers = { 'Content-Type': 'application/json', 'X-Thinbook-Token': bootstrap.token };
    for (const route of ['settings', 'test-key']) assert.equal((await hostFetch(`${url}/api/${route}`, { method: 'POST', headers, body: '{}' })).status, 409);
    for (const minutes of [5, 10]) {
      const response = await hostFetch(`${url}/api/generate`, { method: 'POST', headers, body: JSON.stringify({ book: bootstrap.books[0], minutes, sourceText: '离线测试原文' }) });
      const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(events.at(-1).type, 'result', JSON.stringify(events) + '\n' + output.slice(-6000).replace(/\?token=[^\s]+/g, '?token=[redacted]'));
      assert.match(events.at(-1).reading.body, /会话创建/);
      assert.equal(events.at(-1).reading.provider, 'deepseek-official');
      if (!transport) assert.equal(events.at(-1).reading.notes, '离线书籍附注，仅用于验证与正文分开传递。');
    }
    const cached = await hostFetch(`${url}/api/generate`, { method: 'POST', headers, body: JSON.stringify({ book: bootstrap.books[0], minutes: 5, sourceText: '离线测试原文' }) });
    assert.equal(JSON.parse((await cached.text()).trim()).reading.cached, true);
    const longSource = ['第一章 开端', '第二章 结局'].map(title => `${title}\n${'离线长原文。'.repeat(1800)}\n`).join('\n');
    const segmented = await hostFetch(`${url}/api/generate`, { method: 'POST', headers, body: JSON.stringify({ book: bootstrap.books[0], minutes: 5, sourceText: longSource, sourceComplete: true }) });
    const segmentedEvents = (await segmented.text()).trim().split('\n').map(JSON.parse);
    assert.equal(segmentedEvents.at(-1).type, 'result', JSON.stringify(segmentedEvents));
    assert.equal(segmentedEvents.at(-1).reading.basis, '原文缩写');
    assert.ok(segmentedEvents.at(-1).reading.segmentation.parts > 1);
    assert.match(segmentedEvents.at(-1).reading.body, /第一章 开端[\s\S]*第二章 结局/);
    assert.ok(segmentedEvents.at(-1).reading.cost.modelCalls > 1);
    if (transport) {
      const contextRetry = await hostFetch(`${url}/api/generate`, { method: 'POST', headers, body: JSON.stringify({ book: bootstrap.books[0], minutes: 5, sourceText: 'offline:CONTEXT\n第一章 开端\n' + '原文。'.repeat(1000) + '\n第二章 结局\n终点。', sourceComplete: true }) });
      const retriedEvents = (await contextRetry.text()).trim().split('\n').map(JSON.parse);
      assert.equal(retriedEvents.at(-1).type, 'result', JSON.stringify(retriedEvents));
      assert.ok(retriedEvents.at(-1).reading.segmentation.parts > 1);
      assert.ok(retriedEvents.some(event => event.type === 'status' && /自动拆分/.test(event.message)));
      const response = await hostFetch(`${url}/api/generate`, { method: 'POST', headers, body: JSON.stringify({ book: bootstrap.books[0], minutes: 5 }) });
      const events = (await response.text()).trim().split('\n').map(JSON.parse);
      assert.equal(events.at(-1).type, 'result', JSON.stringify(events));
      assert.equal(events.at(-1).reading.basis, '资料提炼');
      assert.equal(events.at(-1).reading.sourceMode, 'web-reference');
      assert.match(events.at(-1).reading.coverage, /未获得可读取原文/);
      assert.deepEqual(events.at(-1).reading.sources.map(source => source.url).sort(), ['https://a.example/book', 'https://b.example/book']);
      assert.ok(events.some(event => event.type === 'status' && /查找/.test(event.message)));
      assert.ok(events.some(event => event.type === 'status' && /核对来源/.test(event.message)));
      for (const [marker, basis] of [['ORIGINAL', '原文缩写'], ['EXCERPT', '原文与资料综合提炼']]) {
        const response = await hostFetch(`${url}/api/generate`, { method: 'POST', headers, body: JSON.stringify({ book: { ...bootstrap.books[0], title: `offline:${marker}` }, minutes: 5 }) });
        const events = (await response.text()).trim().split('\n').map(JSON.parse);
        assert.equal(events.at(-1).type, 'result', JSON.stringify(events));
        assert.equal(events.at(-1).reading.sourceMode, marker === 'EXCERPT' ? 'web-mixed' : 'web-original');
        assert.equal(events.at(-1).reading.basis, basis);
        const original = events.at(-1).reading.original;
        assert.equal(original.complete, marker !== 'EXCERPT');
        assert.equal(original.cached, marker !== 'EXCERPT');
        assert.equal(original.pages, undefined);
        assert.deepEqual(original.links.map(link => link.url), ['https://a.example/book']);
        const originalResponse = await hostFetch(`${url}/api/readings/${events.at(-1).reading.cacheId}/original`);
        assert.equal(originalResponse.status, marker === 'EXCERPT' ? 404 : 200);
        if (marker !== 'EXCERPT') {
          const data = await originalResponse.json();
          assert.equal(data.original.pages[0].text, '完整测试网页。');
          assert.ok(!data.original.pages[0].text.includes('External web content'));
        } else await originalResponse.json();
        assert.deepEqual(events.at(-1).reading.sources.map(source => source.url), marker === 'EXCERPT' ? ['https://a.example/book', 'https://b.example/book', 'https://c.example/book'] : ['https://a.example/book']);
        if (marker === 'EXCERPT') assert.deepEqual(events.at(-1).reading.coverageMap.map(section => section.basis), ['original', 'reference', 'reference']);
        assert.ok(!events.some(event => event.type === 'status' && /回退/.test(event.message)));
      }
      const continued = await hostFetch(`${url}/api/generate`, { method: 'POST', headers, body: JSON.stringify({ book: bootstrap.books[0], minutes: 5, sourceText: 'offline:MAX_TOKENS' }) });
      const continuedEvents = (await continued.text()).trim().split('\n').map(JSON.parse);
      assert.equal(continuedEvents.at(-1).type, 'result', JSON.stringify(continuedEvents));
      assert.ok(continuedEvents.filter(event => event.type === 'partial').length >= 2);
      assert.equal(continuedEvents.at(-1).reading.body, '达到单次输出上限后仍应连续生成完整正文，之前已显示的内容不能丢失。'.repeat(10));
      assert.ok(continuedEvents.at(-1).reading.cost.modelCalls >= 2);
      for (const [marker, expected] of [['AUTH', /认证失败/], ['QUOTA', /额度不足/], ['TRANSPORT', /请求处理或网络连接失败/]]) {
        const response = await hostFetch(`${url}/api/generate`, { method: 'POST', headers, body: JSON.stringify({ book: bootstrap.books[0], minutes: 5, sourceText: `offline:${marker}` }) });
        const events = (await response.text()).trim().split('\n').map(JSON.parse);
        assert.equal(events.at(-1).type, 'error');
        assert.match(events.at(-1).message, expected);
        assert.doesNotMatch(JSON.stringify(events), /private-provider-detail|sk-test-secret/);
      }
      for (const [marker, expected] of [['WEB_ERROR', /联网检索暂时不可用/], ['WEB_INIT', /联网工具初始化失败/], ['NO_EVIDENCE', /资料不足/]]) {
        const response = await hostFetch(`${url}/api/generate`, { method: 'POST', headers, body: JSON.stringify({ book: { ...bootstrap.books[0], title: `offline:${marker}` }, minutes: 5 }) });
        const events = (await response.text()).trim().split('\n').map(JSON.parse);
        assert.equal(events.at(-1).type, 'error');
        assert.match(events.at(-1).message, expected, JSON.stringify(events));
        assert.doesNotMatch(JSON.stringify(events), /private-provider-detail|sk-test-secret|without inject/);
      }
      const readings = await (await hostFetch(`${url}/api/readings`)).json();
      assert.equal(readings.readings.length, 8, 'Failed readings must never be cached; completed continuation must be saved');
    }
    return { sessions: transport ? 14 : 3, response: true, skill: true, tools: true, ...(transport ? { transport: true, webTools: true, failures: 6 } : {}) };
  } finally {
    clearTimeout(timer); child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited; clearTimeout(killTimer);
    await rm(home, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkHarness().then(() => console.log('PASS: DSH Web loaded the native plugin, reused managed credentials, completed ordinary and segmented offline readings and served the cache. No model API calls.')).catch(error => { console.error(error); process.exitCode = 1; });
}
