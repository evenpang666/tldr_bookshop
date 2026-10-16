// Isolated UI verification server. Never uses the user's project configuration or a model API.
import { createServer } from '../../server.mjs';
import { createStorage } from '../../lib/storage.mjs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const base = resolve('output/playwright');
await mkdir(base, { recursive: true });
const directory = await mkdtemp(join(base, 'qa-'));
const server = createServer({
  storage: createStorage(directory),
  addresses: [{ name: '以太网', address: '192.168.10.106' }],
  settings: { getConfig: async () => ({ hasKey: true, model: 'deepseek-flash', provider: 'deepseek-official' }) },
  generate: async ({ book, minutes, onStatus }) => {
    onStatus('正在验证阅读页…');
    return { book, title: book.title, author: book.author, minutes, basis: '界面验证 · 模拟内容', body: '## 阅读之间\n\n这段文字只用于验证阅读界面、项目缓存和费用标注，不是所选书籍的真实提炼。\n\n' + '书页之间，故事与思想缓缓展开。这里检查自然段的行距、字号与阅读进度，不会调用外部模型。\n\n'.repeat(12), coverage: '仅用于界面验证，不是书籍正文。', sources: [], cost: { currency: 'USD', minUsd: .0012, maxUsd: .0024, searchCalls: 0, note: '界面验证用模拟费用，不是实际扣费。' }, createdAt: new Date().toISOString() };
  },
});
server.listen(3321, '0.0.0.0', () => console.log('Isolated UI verification: http://127.0.0.1:3321'));
process.once('SIGINT', () => server.close(async () => { if (directory.startsWith(base + sep)) await rm(directory, { recursive: true, force: true }); process.exit(0); }));
