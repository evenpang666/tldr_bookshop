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
const virtualAdapter = /vmware|virtual|vbox|docker|wsl|vethernet|hyper-v|loopback|tun|tap|tailscale|zerotier|wireguard|^br-|^virbr|^veth/i;
function addressPriority({ name, address }) {
  const ethernet = /以太网|ethernet|^eth\d|^en(?:\d|[opsx])/i.test(name);
  const homeNetwork = address.startsWith('192.168.');
  return virtualAdapter.test(name) ? 10 : ethernet && homeNetwork ? 0 : homeNetwork ? 1 : ethernet ? 2 : 3;
}
export function localAddresses(interfaces = networkInterfaces()) {
  return Object.entries(interfaces).flatMap(([name, entries]) => (entries || []).filter(a => a.family === 'IPv4' && !a.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)).map(a => ({ name, address: a.address }))).sort((a, b) => addressPriority(a) - addressPriority(b));
}
export function lanUrls(port, addresses = localAddresses()) {
  const [preferred] = addresses.filter(item => !virtualAdapter.test(item.name)).sort((a, b) => addressPriority(a) - addressPriority(b));
  return preferred ? [`http://${preferred.address}:${port}`] : [];
}
export function isLoopback(address = '') { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address); }
export function isPrivatePeer(address = '') { return isLoopback(address) || /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.replace(/^::ffff:/, '')); }
