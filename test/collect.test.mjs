import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createProvider } from '../provider/server.mjs';
import { createIntake } from '../src/server.mjs';
import { Archive } from '../src/archive.mjs';
import { DumpCollector } from '../src/collect.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(context, { mode = 'complete' } = {}) {
  const provider = createProvider();
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  context.after(async () => {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const source = `http://127.0.0.1:${provider.address().port}`;
  const control = value => fetch(`${source}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  if (mode !== 'complete') await control({ mode });
  const archive = await new Archive(directory).initialize();
  const collector = new DumpCollector({ archive });
  return { source, control, archive, collector, directory };
}

test('截断导出只交接完整修订,同一边界续领不重复交接', async context => {
  const { source, collector, archive } = await fixture(context, { mode: 'truncated' });
  const first = await collector.collect({ source });
  assert.equal(first.status, 'pending-revision');
  assert.deepEqual(first.boundary.committedRevisions, [1, 2]);
  assert.equal(first.boundary.pendingRevision, 3);
  assert.equal(first.boundary.committedOffset, 1079);
  assert.equal(first.boundary.received, 1368);
  assert.equal(first.boundary.sealed, false);
  assert.equal(first.handedOver.length, 2);
  const receipts = (await archive.list()).filter(record => record.source === 'dump-revision');
  assert.deepEqual(receipts.map(record => Number(record.identity.revision)).sort(), [1, 2]); // 修订 3 未完整,不可见
  const again = await collector.collect({ source }); // 用 Range+If-Match 说明已有边界续领
  assert.equal(again.status, 'pending-revision');
  assert.equal(again.handedOver.length, 0);
  assert.equal(again.boundary.committedOffset, 1079);
  assert.equal((await archive.list()).filter(record => record.source === 'dump-revision').length, 2);
});

test('导出实例更换后拒绝拼接,重新领取才推进', async context => {
  const { source, control, collector, archive } = await fixture(context, { mode: 'truncated' });
  await collector.collect({ source });
  await control({ mode: 'complete' });
  const changed = await collector.collect({ source });
  assert.equal(changed.status, 'export-changed'); // 不把两次不同导出的尾部拼在一起
  assert.deepEqual(changed.boundary.committedRevisions, [1, 2]);
  assert.equal((await archive.list()).filter(record => record.source === 'dump-revision').length, 2);
  const restarted = await collector.collect({ source, reset: true });
  assert.equal(restarted.status, 'sealed');
  assert.deepEqual(restarted.boundary.committedRevisions, [1, 2, 3]);
  assert.deepEqual(restarted.handedOver.map(item => item.duplicate), [true, true, false]); // 已交接内容复用版本
  const third = (await archive.list()).find(record => record.source === 'dump-revision' && record.identity.revision === '3');
  const change = third.versions[0].data.changes[0];
  assert.equal(change.action, 'replace');
  assert.equal((await archive.bytes(change.text.sha256)).toString(), 'new-registration\n');
});

test('正文校验不符的修订被隔离,已交接修订保持有效', async context => {
  const { source, collector, archive } = await fixture(context, { mode: 'bad-checksum' });
  const failed = await collector.collect({ source });
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /正文结果校验不符/);
  assert.deepEqual(failed.boundary.committedRevisions, []);
  assert.equal((await archive.list()).filter(record => record.source === 'dump-revision').length, 0);
  const latched = await collector.collect({ source });
  assert.equal(latched.status, 'error'); // 失败随游标锁定,不反复重试同一批字节
  assert.match(latched.error, /校验不符/);
});

test('交接后按修订查询文件、属性与目录关系', async context => {
  const { source, collector } = await fixture(context);
  const result = await collector.collect({ source });
  assert.equal(result.status, 'sealed');
  const builder = await collector.builderWithRevision(3);
  const tree = builder.treeAt(3);
  const notice = tree.find(item => item.path === 'trunk/notice.txt');
  const copied = tree.find(item => item.path === 'branches/exhibit/notice.txt');
  assert.equal(notice.text.sha256, sha256(Buffer.from('new-registration\n')));
  assert.equal(copied.text.sha256, sha256(Buffer.from('permit=A\n')));
  assert.notEqual(notice.lineage, copied.lineage); // 重建的 trunk 对象与旧谱系无关
  const exhibit = tree.find(item => item.path === 'branches/exhibit');
  assert.deepEqual(exhibit.copiedFrom, { path: 'trunk', revision: 1 });
  assert.equal(builder.treeAt(2).find(item => item.path === 'trunk/notice.txt').text.sha256, sha256(Buffer.from('permit=B\n')));
});

test('HTTP 入口完成领取、查询与人工收件共存', async context => {
  const provider = createProvider();
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const directory = await mkdtemp(join(tmpdir(), 'intake-http-'));
  const intake = await createIntake(directory);
  intake.listen(0, '127.0.0.1');
  await once(intake, 'listening');
  context.after(async () => {
    intake.closeAllConnections();
    provider.closeAllConnections();
    await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const collect = await fetch(`${base}/api/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) });
  assert.equal(collect.status, 200);
  assert.equal((await collect.json()).status, 'sealed');
  const revisions = await (await fetch(`${base}/api/dump/revisions`)).json();
  assert.deepEqual(revisions.map(item => item.revision), [1, 2, 3]);
  const second = await (await fetch(`${base}/api/dump/revisions/2`)).json();
  const notice = second.versions[0].data.changes.find(change => change.path === 'trunk/notice.txt');
  assert.deepEqual(notice.propChanges, [{ op: 'delete', name: 'note' }, { op: 'set', name: 'empty', value: '' }]);
  assert.deepEqual(notice.props, { empty: '' }); // 删除与空值区别保留
  const state = await (await fetch(`${base}/api/dump/state?revision=3`)).json();
  const copied = state.nodes.find(item => item.path === 'branches/exhibit/notice.txt');
  const blob = await fetch(`${base}/api/blobs/${copied.text.sha256}`);
  assert.equal(await blob.text(), 'permit=A\n'); // 副本不受源分支后改影响
  const missing = await fetch(`${base}/api/dump/revisions/9`);
  assert.equal(missing.status, 404);
  const cursors = await (await fetch(`${base}/api/collect`)).json();
  assert.equal(cursors.cursors[0].sealed, true);
  assert.equal(cursors.cursors[0].committedOffset, cursors.cursors[0].received);
  const manual = await fetch(`${base}/api/manual`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repositoryUuid: 'u', revision: '1', nodePath: 'p' }) });
  assert.equal(manual.status, 201);
  const unreachable = await fetch(`${base}/api/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'http://127.0.0.1:1' }) });
  assert.equal(unreachable.status, 502);
});
