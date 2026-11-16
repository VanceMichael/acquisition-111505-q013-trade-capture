import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = createProvider();
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
const source = `http://127.0.0.1:${provider.address().port}`;
const intake = await createIntake(directory, { sourceUrl: source });
try {
  intake.listen(0, '127.0.0.1');
  await once(intake, 'listening');
  const base = `http://127.0.0.1:${intake.address().port}`;
  const control = value => fetch(`${source}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const collect = async () => (await fetch(`${base}/api/collect`, { method: 'POST' })).json();
  const node = async (rev, path) => (await fetch(`${base}/api/dump/revisions/${rev}/node?path=${encodeURIComponent(path)}`)).json();

  // 场景一：来源分段停在修订中间，完整修订先交接，待决修订不可用
  await control({ mode: 'truncated' });
  const partial = await collect();
  console.log(JSON.stringify({ 场景: '截断分段', 已交接修订: partial.boundary.committedRevisions, 待决修订: partial.boundary.pendingRevision, 已消费字节: partial.boundary.consumedBytes, 封口: partial.boundary.sealed }));
  console.log(JSON.stringify({ 待决修订查询: (await fetch(`${base}/api/dump/revisions/3/node?path=trunk/notice.txt`)).status }));

  // 场景二：导出实例更换后整体重领（不拼接两次导出的尾部），封口后末尾修订交接
  await control({ mode: 'complete' });
  const done = await collect();
  console.log(JSON.stringify({ 场景: '补领封口', 重新领取: done.restarted, 已交接修订: done.boundary.committedRevisions, 完整: done.boundary.complete }));

  // 场景三：按修订查询复制谱系——副本锚定历史修订，源分支后改不影响
  const copied = await node(3, 'branches/exhibit/notice.txt');
  const trunk = await node(3, 'trunk/notice.txt');
  console.log(JSON.stringify({ 修订3副本: copied.text, 副本谱系: copied.id, 修订3源支: trunk.text, 源支谱系: trunk.id }));
  const before = await node(2, 'trunk/notice.txt');
  console.log(JSON.stringify({ 修订2属性: before.props, 说明: 'note 已删除与 empty 空值区别保留' }));

  // 人工收件仍然可用
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const accepted = await fetch(`${base}/api/manual`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  console.log(JSON.stringify({ 人工收件: (await accepted.json()).version }));
} finally {
  intake.closeAllConnections();
  provider.closeAllConnections();
  await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
  await rm(directory, { recursive: true, force: true });
}
