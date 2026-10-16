import http from 'node:http';
import { listenIndependent, closeIndependent } from '../lib/independent-http.mjs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { endpointPath } from '../scripts/dsh-host.mjs';
import { createApp, openBrowser } from '../server.mjs';
import { createReader } from '../harness/reader.mjs';
import { createStorage } from '../lib/storage.mjs';
import { lanUrls } from '../lib/network.mjs';

export const name = 'thinbook';
export const inject = ['agents', 'tools', 'systemPrompt', 'web', 'credentials', 'agentDefaultModel', 'profileContext', 'webServer', 'connection'];

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
  const basePath = '/thinbook', instance = randomUUID();
  const independent = {};
  let actualPort;
  const dataRoot = resolve(config.dataRoot ?? join(ctx.profileContext.home, 'thinbook'));
  const app = createApp({ settings: createSettings(ctx), storage: createStorage(dataRoot), generate: createReader(ctx, { applyWebTools, createUserMessage }), independent, basePath, connection: ctx.connection, webServer: ctx.webServer, instanceId: instance });
  const server = http.createServer(app.handler);
  ctx.effect(() => async () => { await app.close(); await closeIndependent(server); });
  actualPort = independent.port = await listenIndependent(server, config.port ?? process.env.THINBOOK_PORT ?? 3102);
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: basePath, handler: app.handler }));
  const launchUrl = new URL(`http://127.0.0.1:${actualPort}/`);
  launchUrl.pathname = '/';
  const recordPath = endpointPath(ctx.profileContext.home);
  const temporary = `${recordPath}.${randomUUID()}.tmp`;
  try {
    await mkdir(join(ctx.profileContext.home, 'thinbook'), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ instance, pid: process.pid, port: actualPort, webPort: ctx.webServer.port, basePath: '', instanceId: instance, url: launchUrl.href, profile: ctx.profileContext.name }), { mode: 0o600 });
    await rename(temporary, recordPath);
  } finally { await rm(temporary, { force: true }); }
  ctx.effect(() => async () => {
    try { if (JSON.parse(await readFile(recordPath, 'utf8')).instance === instance) await rm(recordPath, { force: true }); } catch {}
  });
  const url = `http://127.0.0.1:${actualPort}/`;
  const addresses = lanUrls(actualPort).map(address => address + '/');
  console.log([
    '[DSH 插件] 薄书 (thinbook) · 已加载',
    `[DSH 插件]   本机：${url}`,
    ...addresses.map(address => `[DSH 插件]   局域网：${address}`),
    '[DSH 插件]   生成：复用 DSH 默认模型与凭据',
  ].join('\n'));
  if (config.openBrowser === true) openBrowser(launchUrl.href);
}
