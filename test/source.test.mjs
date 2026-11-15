import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
async function withSource(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control, post };
}

test('会话跳号和业务更正是不同报文', async context => {
  const { base } = await withSource(context); const reply = await (await fetch(base + '/session/poll')).json();
  assert.equal(reply.messages.length, 3); assert.match(reply.messages[1], /123=Y/); assert.match(reply.messages[2], /572=r1/);
  const bytes = Buffer.from(reply.messages[0]); const boundary = bytes.lastIndexOf(Buffer.from('10='));
  const actual = [...bytes.subarray(0, boundary)].reduce((total, value) => total + value, 0) % 256;
  assert.equal(Number(bytes.subarray(boundary + 3, boundary + 6).toString()), actual);
});
test('补发保留原发送时间而换日不改业务历史', async context => {
  const { base, post, control } = await withSource(context); const resend = await (await post('/session/resend', { from: 1, to: 1 })).json(); assert.match(resend.messages[0], /43=Y/); assert.match(resend.messages[0], /122=/);
  await control({ day: '2026-11-02', reset: true }); const reply = await (await fetch(base + '/session/poll')).json(); assert.equal(reply.sessionDay, '2026-11-02'); assert.equal(reply.resetSeqNum, true);
});
