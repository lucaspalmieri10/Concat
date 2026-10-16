// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { ConcatClient } from '../client.mjs';

async function fixture(t, handle) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf('\n')) !== -1;) {
        const call = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        handle(call, socket);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new ConcatClient({ host: '127.0.0.1', port: server.address().port, token: 'test-token' });
  t.after(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return client;
}
const reply = (socket, call, result) => socket.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }) + '\n');

test('authenticates first and handles fragmented responses with interleaved export events', async t => {
  const calls = [];
  const client = await fixture(t, (call, socket) => {
    calls.push(call);
    if (call.method === 'auth') return reply(socket, call, {});
    const event = { jsonrpc: '2.0', method: 'export.done', params: { job: 'j1' } };
    const line = JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { job: 'j1' } }) + '\n';
    socket.write(JSON.stringify(event) + '\n' + line.slice(0, 15));
    setImmediate(() => socket.write(line.slice(15)));
  });
  await Promise.all([client.connect(), client.connect()]);
  const started = await client.request('export.run', { output: 'new.mp4' });
  assert.equal((await client.waitForExport(started.job)).method, 'export.done');
  assert.deepEqual(calls.map(call => call.method), ['auth', 'export.run']);
  assert.equal(calls[0].params.token, 'test-token');
});

test('rejects a bad token without allowing edits', async t => {
  const calls = [];
  const client = await fixture(t, (call, socket) => {
    calls.push(call.method);
    socket.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'Unauthorized', data: { code: 'unauthorized' } } }) + '\n');
  });
  await assert.rejects(client.connect(), { code: 'unauthorized' });
  assert.equal(client.ready, false);
  assert.deepEqual(calls, ['auth']);
});

test('connection loss rejects an uncertain edit without replaying it', async t => {
  let edits = 0;
  const client = await fixture(t, (call, socket) => {
    if (call.method === 'auth') return reply(socket, call, {});
    edits++;
    socket.destroy();
  });
  await client.connect();
  await assert.rejects(client.request('edit.apply'), /Nenhuma edição foi repetida/);
  assert.equal(edits, 1);
});

test('pending export is reported honestly without claiming completion', async t => {
  const client = await fixture(t, (call, socket) => reply(socket, call, {}));
  await client.connect();
  assert.equal((await client.waitForExport('j2', 20)).method, 'export.pending');
});
