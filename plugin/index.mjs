import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { endpointPath } from '../scripts/dsh-host.mjs';
import { createServer, openBrowser } from '../server.mjs';
import { createReader } from '../harness/reader.mjs';
import { createStorage } from '../lib/storage.mjs';
import { lanUrls } from '../lib/network.mjs';

export const name = 'thinbook';
export const inject = ['agents', 'tools', 'systemPrompt', 'web', 'credentials', 'agentDefaultModel', 'profileContext'];

export function createSettings(ctx) {
  return {
    async getConfig() {
      const selection = ctx.agentDefaultModel.currentSelection();
      const credential = await ctx.credentials.describe('DEEPSEEK_API_KEY');
      return { ...selection, managed: true, hasKey: selection.provider === 'deepseek-official' && credential.configured };
    },
  };
}

export async function apply(ctx, config = {}) {
  // Resolve from the running host, including global npm installations. A
  // checkout's node_modules must not supply a second copy of DSH services.
  const hostRequire = createRequire(ctx.profileContext.installAnchor);
  const webTools = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-tool-web')).href);
  const { createUserMessage } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-llm')).href);
  const applyWebTools = (agentCtx, options) => agentCtx.plugin(webTools, options);
  const port = Number(config.port ?? process.env.PORT ?? 3210);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('薄书端口必须为 0–65535。');
  const host = config.host ?? process.env.HOST ?? '0.0.0.0';
  const dataRoot = resolve(config.dataRoot ?? join(ctx.profileContext.home, 'thinbook'));
  const server = createServer({ settings: createSettings(ctx), storage: createStorage(dataRoot), generate: createReader(ctx, { applyWebTools, createUserMessage }) });
  ctx.effect(() => () => new Promise((done, reject) => {
    server.close(error => error ? reject(error) : done());
    server.closeAllConnections();
  }));
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, host, done); });
  server.on('error', error => console.error(`薄书服务错误：${error.code || 'UNKNOWN'}`));
  const actualPort = server.address().port;
  const recordPath = endpointPath(ctx.profileContext.home);
  const temporary = `${recordPath}.${randomUUID()}.tmp`;
  const instance = randomUUID();
  try {
    await mkdir(join(ctx.profileContext.home, 'thinbook'), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ instance, pid: process.pid, port: actualPort, webPort: ctx.get('webServer')?.port, profile: ctx.profileContext.name }), { mode: 0o600 });
    await rename(temporary, recordPath);
  } finally { await rm(temporary, { force: true }); }
  ctx.effect(() => async () => {
    try { if (JSON.parse(await readFile(recordPath, 'utf8')).instance === instance) await rm(recordPath, { force: true }); } catch {}
  });
  const url = `http://127.0.0.1:${actualPort}`;
  console.log(`\n  薄书 THINBOOK · DSH 插件\n  本机 ${url}\n${lanUrls(actualPort).map(address => `  局域网 ${address}`).join('\n')}\n  使用当前 DSH 服务的 API Key 与默认模型。\n`);
  if (config.openBrowser === true) openBrowser(url);
}
