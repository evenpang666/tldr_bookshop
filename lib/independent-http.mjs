// Bind the real listener directly: no probe/close race when choosing a port.
export async function listenIndependent(server, preferred, { host = '0.0.0.0', log = console.log } = {}) {
  const port = Number(preferred);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('页面端口必须为 0–65535 的整数。');
  const listen = value => new Promise((resolve, reject) => {
    const failed = error => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolve(server.address().port); };
    server.once('error', failed); server.once('listening', ready);
    server.listen(value, host);
  });
  try { return await listen(port); }
  catch (error) {
    if (!['EADDRINUSE', 'EACCES'].includes(error.code) || port === 0) throw error;
    const selected = await listen(0);
    log(`页面端口 ${port} 不可用，已自动选择 ${selected}。`);
    return selected;
  }
}
export async function closeIndependent(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

