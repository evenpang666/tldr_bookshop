// Test-only stand-in for a plugin such as dsh-whereto with its own TCP port.
import net from 'node:net';
import { appendFile } from 'node:fs/promises';
export const name = 'thinbook-listening-fixture';
export async function apply(ctx, config) {
  const server = net.createServer();
  ctx.effect(() => () => new Promise(done => { server.close(done); for (const socket of sockets) socket.destroy(); }));
  const sockets = new Set(); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', done); });
  await appendFile(config.log, `${process.pid}\n`);
}
