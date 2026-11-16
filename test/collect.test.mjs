import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
import { DumpStore } from '../src/store.mjs';

async function setup(context, mode) {
  const provider = createProvider();
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const sourceBase = `http://127.0.0.1:${provider.address().port}`;
  const control = value => fetch(`${sourceBase}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  if (mode) await control({ mode });
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  const intake = await createIntake(directory, { sourceUrl: sourceBase });
  intake.listen(0, '127.0.0.1');
  await once(intake, 'listening');
  context.after(async () => {
    intake.closeAllConnections();
    provider.closeAllConnections();
    await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${intake.address().port}`, sourceBase, control, directory };
}

const collect = base => fetch(`${base}/api/collect`, { method: 'POST' });

test('完整导出交接后可按修订查询文件、属性与目录关系', async context => {
  const { base } = await setup(context);
  const reply = await collect(base);
  assert.equal(reply.status, 200);
  const report = await reply.json();
  assert.equal(report.restarted, false);
  assert.equal(report.fetchedBytes, 1380);
  assert.deepEqual(report.committedNow, [1, 2, 3]);
  assert.equal(report.boundary.complete, true);
  assert.equal(report.boundary.sealed, true);
  assert.equal(report.boundary.repositoryUuid, '7c59fa47-22c3-4ed7-ae11-001122334455');

  const revisions = await (await fetch(`${base}/api/dump/revisions`)).json();
  assert.deepEqual(revisions.map(r => r.revision), [1, 2, 3]);
  assert.equal(revisions[0].props['svn:log'], '本地授权文本交付');
  const copyChange = revisions[1].changes.find(c => c.path === 'branches/exhibit');
  assert.deepEqual({ rev: copyChange.copyfromRev, path: copyChange.copyfromPath }, { rev: 1, path: 'trunk' });

  const node = async (rev, path) => {
    const response = await fetch(`${base}/api/dump/revisions/${rev}/node?path=${encodeURIComponent(path)}`);
    return { status: response.status, body: await response.json() };
  };
  const source1 = await node(1, 'trunk/notice.txt');
  assert.equal(source1.body.text, 'permit=A\n');
  assert.deepEqual(source1.body.props, { note: '已核对', empty: '' });
  const copy2 = await node(2, 'branches/exhibit/notice.txt');
  assert.equal(copy2.body.text, 'permit=A\n');
  assert.equal(copy2.body.id, source1.body.id);
  const trunk2 = await node(2, 'trunk/notice.txt');
  assert.equal(trunk2.body.text, 'permit=B\n');
  assert.deepEqual(trunk2.body.props, { empty: '' });
  const trunk3 = await node(3, 'trunk/notice.txt');
  assert.equal(trunk3.body.text, 'new-registration\n');
  assert.notEqual(trunk3.body.id, source1.body.id);
  assert.deepEqual(trunk3.body.props, { owner: 'registrar' });
  const copy3 = await node(3, 'branches/exhibit/notice.txt');
  assert.equal(copy3.body.text, 'permit=A\n');
  const dir = await node(2, 'branches/exhibit');
  assert.deepEqual(dir.body.children, [{ name: 'notice.txt', kind: 'file', id: source1.body.id }]);
  assert.equal((await node(9, 'trunk')).status, 404);
  assert.equal((await node(3, 'missing')).status, 404);
  assert.equal((await node(3, '..')).status, 400);
});

test('分段停在修订中间：完整修订先交接，待决修订不可用，补领说明边界', async context => {
  const { base, control, directory } = await setup(context, 'truncated');
  const first = await (await collect(base)).json();
  assert.deepEqual(first.boundary.committedRevisions, [1, 2]);
  assert.equal(first.boundary.pendingRevision, 3);
  assert.equal(first.boundary.sealed, false);
  assert.equal(first.boundary.complete, false);
  assert.equal(first.boundary.consumedBytes, 1368);

  const pending = await fetch(`${base}/api/dump/revisions/3/node?path=trunk/notice.txt`);
  assert.equal(pending.status, 404);
  const handed = await fetch(`${base}/api/dump/revisions/2/node?path=branches/exhibit/notice.txt`);
  assert.equal((await handed.json()).text, 'permit=A\n');

  // 导出未变化时补领没有新字节，边界如实说明
  const again = await (await collect(base)).json();
  assert.equal(again.fetchedBytes, 0);
  assert.deepEqual(again.boundary.committedRevisions, [1, 2]);
  assert.equal(again.boundary.pendingRevision, 3);

  // 导出实例更换后整体重领，绝不拼接两次导出的尾部
  await control({ mode: 'complete' });
  const resumed = await (await collect(base)).json();
  assert.equal(resumed.restarted, true);
  assert.deepEqual(resumed.committedNow, [1, 2, 3]);
  assert.equal(resumed.boundary.complete, true);
  const prefix = await readFile(join(directory, 'dump', 'prefix.dump'));
  const original = await readFile(new URL('../fixtures/history.dump', import.meta.url));
  assert.deepEqual(prefix, original);
});

test('坏校验和的交付被拒绝且不进入已交接材料', async context => {
  const { base, control } = await setup(context, 'bad-checksum');
  const reply = await collect(base);
  assert.equal(reply.status, 502);
  const body = await reply.json();
  assert.match(body.error, /正文 md5 校验不符/);
  assert.deepEqual(body.boundary.committedRevisions, []);
  const status = await (await fetch(`${base}/api/dump/status`)).json();
  assert.deepEqual(status.committedRevisions, []);
  assert.match(status.lastError, /md5/);

  await control({ mode: 'complete' });
  const recovered = await (await collect(base)).json();
  assert.equal(recovered.restarted, true);
  assert.deepEqual(recovered.boundary.committedRevisions, [1, 2, 3]);
  assert.equal(recovered.boundary.lastError, null);
});

test('已交接材料落档持久，重开服务后由前缀重放恢复', async context => {
  const { base, directory } = await setup(context);
  await collect(base);
  const reopened = await new DumpStore(join(directory, 'dump')).open();
  assert.deepEqual(reopened.status().committedRevisions, [1, 2, 3]);
  assert.equal(reopened.status().complete, true);
  assert.equal(reopened.nodeView(2, 'branches/exhibit/notice.txt').text, 'permit=A\n');
  assert.equal(reopened.nodeView(3, 'trunk/notice.txt').text, 'new-registration\n');
});

test('领取途中导出实例更换则整体重领，不把两次导出的尾部拼在一起', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'collect-stub-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const truncated = await readFile(new URL('../fixtures/truncated.dump', import.meta.url));
  const complete = await readFile(new URL('../fixtures/history.dump', import.meta.url));
  const { createHash } = await import('node:crypto');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const catalogs = [
    { repositoryUuid: '7c59fa47-22c3-4ed7-ae11-001122334455', exports: [{ id: 'handover', generation: 1, href: '/exports/handover', sha256: sha(truncated), size: truncated.length, etag: '"1-a"', sealed: false }] },
    { repositoryUuid: '7c59fa47-22c3-4ed7-ae11-001122334455', exports: [{ id: 'handover', generation: 2, href: '/exports/handover', sha256: sha(complete), size: complete.length, etag: '"2-b"', sealed: true }] },
  ];
  const seen = [];
  const store = await new DumpStore(join(directory, 'dump'), {
    requestImpl: async (url, options = {}) => {
      seen.push({ url, headers: options.headers ?? {} });
      if (url.endsWith('/exports')) return { status: 200, headers: {}, bytes: Buffer.from(JSON.stringify(catalogs[seen.filter(s => s.url.endsWith('/exports')).length - 1] ?? catalogs[0])) };
      if (options.headers?.['if-match'] === '"1-a"') return { status: 412, headers: {}, bytes: Buffer.alloc(0) };
      return { status: 200, headers: {}, bytes: complete };
    },
  }).open();
  const report = await store.collect('http://source.local');
  assert.equal(report.restarted, true);
  assert.deepEqual(report.boundary.committedRevisions, [1, 2, 3]);
  assert.equal(report.boundary.complete, true);
  const prefix = await readFile(join(directory, 'dump', 'prefix.dump'));
  assert.deepEqual(prefix, complete);
});

test('来源身份不同的导出不能混入', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'collect-uuid-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const complete = await readFile(new URL('../fixtures/history.dump', import.meta.url));
  const { createHash } = await import('node:crypto');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  let uuid = '7c59fa47-22c3-4ed7-ae11-001122334455';
  const store = await new DumpStore(join(directory, 'dump'), {
    requestImpl: async url => {
      if (url.endsWith('/exports')) {
        return { status: 200, headers: {}, bytes: Buffer.from(JSON.stringify({ repositoryUuid: uuid, exports: [{ id: 'e', generation: 1, href: '/e', sha256: sha(complete), size: complete.length, etag: '"1-x"', sealed: true }] })) };
      }
      return { status: 200, headers: {}, bytes: complete };
    },
  }).open();
  await store.collect('http://source.local');
  uuid = 'ffffffff-0000-0000-0000-000000000000';
  await assert.rejects(() => store.collect('http://source.local'), /不能混淆/);
});
