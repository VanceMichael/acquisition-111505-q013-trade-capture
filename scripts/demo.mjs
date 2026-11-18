import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const intake = await createIntake(directory);
const provider = createProvider();
try {
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const control = value => fetch(`${source}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const collect = body => fetch(`${base}/api/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(response => response.json());
  const get = path => fetch(`${base}${path}`).then(response => response.json());
  const show = (label, value) => console.log(JSON.stringify({ [label]: value }));
  await control({ mode: 'truncated' });
  show('截断来源首次领取', await collect({ source }));
  show('已交接修订(修订3未完整不可见)', await get('/api/dump/revisions'));
  show('同一边界续领', await collect({ source }));
  await control({ mode: 'complete' });
  show('导出更换后拒绝拼接', await collect({ source }));
  show('重新领取当前导出', await collect({ source, reset: true }));
  show('修订2(属性删除与空值、差分)', await get('/api/dump/revisions/2'));
  show('修订3状态(复制谱系隔离)', await get('/api/dump/state?revision=3'));
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const manual = await fetch(`${base}/api/manual`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  show('人工收件', await manual.json());
} finally {
  intake.closeAllConnections(); provider.closeAllConnections();
  await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
  await rm(directory, { recursive: true, force: true });
}
