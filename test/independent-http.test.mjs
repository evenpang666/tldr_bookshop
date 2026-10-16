import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listenIndependent, closeIndependent } from '../lib/independent-http.mjs';

test('occupied preferred port falls back on the real LAN listener and closes cleanly', async () => {
  const occupied = http.createServer(), app = http.createServer((req,res) => res.end('app'));
  const preferred = await listenIndependent(occupied, 0);
  try {
    const selected = await listenIndependent(app, preferred, { log() {} });
    assert.notEqual(selected, preferred);
    assert.equal(app.address().address, '0.0.0.0');
    assert.equal(await (await fetch(`http://127.0.0.1:${selected}`)).text(), 'app');
  } finally { await closeIndependent(app); await closeIndependent(occupied); }
  assert.equal(app.listening, false);
});
