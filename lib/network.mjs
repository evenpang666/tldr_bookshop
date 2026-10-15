import { fetch as undiciFetch, Agent, EnvHttpProxyAgent } from 'undici';
import { networkInterfaces } from 'node:os';

const direct = new Agent({ connect: { timeout: 7000 } });
const environment = new EnvHttpProxyAgent({ connect: { timeout: 7000 } });
export async function networkJSON(url, { signal, timeout = 12000, headers = {}, method = 'GET', body } = {}) {
  const options = { method, headers: { 'User-Agent': 'ThinBook/1.1 (+https://github.com/deepseek-ai/deepseek-harness)', ...headers }, body, redirect: 'error' };
  const hasProxy = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
  const routes = hasProxy ? [environment, direct] : [direct];
  let last;
  for (const dispatcher of routes) {
    signal?.throwIfAborted();
    try {
      const response = await undiciFetch(url, { ...options, dispatcher, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
      if (!response.ok) { await response.body?.cancel(); const error = new Error(`远程服务返回 HTTP ${response.status}`); error.status = response.status; throw error; }
      return await response.json();
    } catch (error) { if (signal?.aborted) throw signal.reason; if (error.status && ![407, 502, 503, 504].includes(error.status)) throw error; last = error; }
  }
  throw last;
}
export function localAddresses(interfaces = networkInterfaces()) {
  return Object.entries(interfaces).flatMap(([name, entries]) => (entries || []).filter(a => a.family === 'IPv4' && !a.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)).map(a => ({ name, address: a.address }))).sort((a, b) => {
    const score = item => (/vmware|virtual|vbox|docker|wsl|vethernet|tun|tap|tailscale/i.test(item.name) ? 50 : 0) + (/以太网|ethernet|en\d|eth\d/i.test(item.name) ? -10 : 0) + (item.address.startsWith('192.168.') ? -5 : 0);
    return score(a) - score(b);
  });
}
export function isLoopback(address = '') { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address); }
export function isPrivatePeer(address = '') { return isLoopback(address) || /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.replace(/^::ffff:/, '')); }
