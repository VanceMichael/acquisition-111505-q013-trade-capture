import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createProvider } from '../provider/server.mjs';

async function source(context) {
  const service = createProvider();
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  context.after(async () => {
    service.closeAllConnections();
    await new Promise(resolve => service.close(resolve));
  });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control };
}

test('真实导出携带历史目录复制、差分字节及独立属性语义', async context => {
  const { base } = await source(context);
  const catalog = await (await fetch(base + '/exports')).json();
  const delivery = catalog.exports[0];
  const raw = Buffer.from(await (await fetch(base + delivery.href)).arrayBuffer());
  assert.equal(raw.length, delivery.size);
  assert.equal(createHash('sha256').update(raw).digest('hex'), delivery.sha256);
  assert.equal(delivery.sealed, true);
  assert.match(raw.toString(), /Node-copyfrom-rev: 1\nNode-copyfrom-path: trunk/);
  assert.match(raw.toString(), /D 4\nnote\n/);
  assert.match(raw.toString(), /K 5\nempty\nV 0\n\n/);
  assert.ok(raw.includes(Buffer.from('SVN\0')));
  assert.match(raw.toString(), /Node-action: replace/);
});

test('截断导出保留前缀，导出实例改变后旧条件领取失效', async context => {
  const { base, control } = await source(context);
  const complete = Buffer.from(await (await fetch(base + '/exports/handover')).arrayBuffer());
  const { exports: [old] } = await (await fetch(base + '/exports')).json();
  await control({ mode: 'truncated' });
  const catalog = await (await fetch(base + '/exports')).json();
  assert.equal(catalog.exports[0].sealed, false);
  const partial = Buffer.from(await (await fetch(base + '/exports/handover')).arrayBuffer());
  assert.deepEqual(partial, complete.subarray(0, complete.length - 12));
  assert.equal((await fetch(base + old.href, { headers: { 'if-match': old.etag } })).status, 412);
});

test('坏校验情景只改变声明且传输摘要仍对应实际交付', async context => {
  const { base, control } = await source(context);
  await control({ mode: 'bad-checksum' });
  const { exports: [delivery] } = await (await fetch(base + '/exports')).json();
  const raw = Buffer.from(await (await fetch(base + delivery.href)).arrayBuffer());
  assert.equal(createHash('sha256').update(raw).digest('hex'), delivery.sha256);
  assert.match(raw.toString(), /Text-content-md5: 00000000000000000000000000000000/);
  const reply = await fetch(base + delivery.href, { headers: { range: 'bytes=0-25', 'if-match': delivery.etag } });
  assert.equal(reply.status, 206);
  assert.equal((await reply.arrayBuffer()).byteLength, 26);
});
