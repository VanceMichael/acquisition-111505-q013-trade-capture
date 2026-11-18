import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DumpParser, DumpError, parseProperties, validatePath } from '../src/dump.mjs';
import { applySvndiff, SvndiffError } from '../src/svndiff.mjs';
import { HistoryBuilder } from '../src/history.mjs';

const historyDump = await readFile(new URL('../fixtures/history.dump', import.meta.url));
const truncatedDump = await readFile(new URL('../fixtures/truncated.dump', import.meta.url));
const badChecksumDump = await readFile(new URL('../fixtures/bad-checksum.dump', import.meta.url));

function ingest(bytes, { finalize = true } = {}) {
  const parser = new DumpParser();
  const builder = new HistoryBuilder();
  const entries = [];
  for (const record of parser.push(bytes)) {
    if (record.type === 'revision') {
      if (builder.pending) entries.push(builder.commit());
      builder.beginRevision(record.number, record.props);
    } else if (record.type === 'node') {
      builder.applyNode(record);
    }
  }
  if (finalize) {
    parser.finish();
    if (builder.pending) entries.push(builder.commit());
  }
  return { parser, builder, entries: entries.filter(Boolean) };
}

test('svndiff0 窗口重建差分正文并允许目标自引用', () => {
  const parser = new DumpParser();
  const records = parser.push(historyDump);
  const change = records.find(record => record.type === 'node' && record.textDelta);
  assert.equal(change.baseMd5, '2d7a935334f594eaa8da791f8ec3b6af');
  assert.equal(applySvndiff(Buffer.from('permit=A\n'), change.text).toString(), 'permit=B\n');
  // 目标复制引用当前窗口已生成的部分: 'abc' + 自复制 6 字节
  const delta = Buffer.concat([Buffer.from('SVN\0'), Buffer.from([0, 0, 9, 3, 3, 0x83, 0x46, 0x00]), Buffer.from('abc')]);
  assert.equal(applySvndiff(Buffer.alloc(0), delta).toString(), 'abcabcabc');
});

test('svndiff 拒绝不支持的版本、截断窗口与越界视窗', () => {
  assert.throws(() => applySvndiff(Buffer.alloc(0), Buffer.from('SVN\x01\0\0\0\0\0')), SvndiffError);
  assert.throws(() => applySvndiff(Buffer.alloc(0), Buffer.from('SVN\x01\0\0\0\0\0')), /不支持的差分版本/);
  assert.throws(() => applySvndiff(Buffer.alloc(0), Buffer.from('SVN\0\0\0\x05')), SvndiffError); // 窗口头截断
  assert.throws(() => applySvndiff(Buffer.from('ab'), Buffer.from('SVN\0\0\x05\0\0\0')), /源视窗超出基底/);
  assert.throws(() => applySvndiff(Buffer.alloc(0), Buffer.from('BAD!\0\0\0\0\0')), /SVN 标记/);
});

test('属性块区分删除与空值,拒绝残缺块', () => {
  const ops = parseProperties(Buffer.from('K 4\nnote\nV 0\n\nD 2\nxx\nK 1\ny\nV 3\nabc\nPROPS-END\n'));
  assert.deepEqual(ops.map(op => op.op), ['set', 'delete', 'set']);
  assert.equal(ops[0].name, 'note');
  assert.equal(ops[0].value.toString(), ''); // 空串是存在但值为空
  assert.deepEqual(ops[1], { op: 'delete', name: 'xx' });
  assert.equal(ops[2].value.toString(), 'abc');
  assert.throws(() => parseProperties(Buffer.from('K 1\na\nV 1\nb\n')), /PROPS-END/);
  assert.throws(() => parseProperties(Buffer.from('PROPS-END\nxx')), /多余/);
  assert.throws(() => parseProperties(Buffer.from('K 5\nab\n')), /截断/);
});

test('完整转储解析出格式头、UUID、三个修订与节点记录', () => {
  const parser = new DumpParser();
  const records = parser.push(historyDump);
  assert.deepEqual(records.map(record => record.type), ['format', 'uuid', 'revision', 'node', 'node', 'revision', 'node', 'node', 'node', 'revision', 'node']);
  assert.equal(records[1].uuid, '7c59fa47-22c3-4ed7-ae11-001122334455');
  assert.deepEqual(records.filter(record => record.type === 'revision').map(record => record.number), [1, 2, 3]);
  assert.equal(records[9].offset, 1079); // 修订 3 记录起点即截断情景下的已交接边界
  const copy = records.find(record => record.type === 'node' && record.copyfromPath);
  assert.deepEqual([copy.copyfromRev, copy.copyfromPath], [1, 'trunk']);
  const change = records.find(record => record.type === 'node' && record.action === 'change');
  assert.deepEqual(change.props.map(op => op.op), ['delete', 'set']);
  parser.finish(); // 封口导出在完整字节终点干净结束
});

test('截断转储只产出完整记录,尾部不伪装成空节点', () => {
  const parser = new DumpParser();
  const records = parser.push(truncatedDump);
  assert.equal(records.length, 10);
  assert.equal(records[9].type, 'revision');
  assert.equal(records[9].number, 3);
  assert.ok(parser.buffer.length > 0); // 修订 3 的节点记录残缺,保持等待
  assert.throws(() => parser.finish(), /无法解析/);
});

test('续解析从已交接边界开始,不要求格式头', () => {
  const parser = new DumpParser({ resumed: true, offset: 1079, lastRevision: 2 });
  const records = parser.push(truncatedDump.subarray(1079));
  assert.equal(records.length, 1);
  assert.equal(records[0].type, 'revision');
  assert.equal(records[0].offset, 1079);
  assert.throws(() => new DumpParser().push(Buffer.from('Revision-number: 1\nProp-content-length: 0\nContent-length: 0\n\n')), DumpError);
});

test('历史重建保持复制谱系:源分支后改不影响副本,重建不接回旧谱系', () => {
  const { builder, entries } = ingest(historyDump);
  assert.equal(entries.length, 3);
  const noticeRev1 = builder.nodeAt(1, 'trunk/notice.txt');
  assert.equal(noticeRev1.text.toString(), 'permit=A\n');
  assert.deepEqual([...noticeRev1.props.keys()].sort(), ['empty', 'note']);
  // 修订 2:目录复制定格 trunk@1;trunk 正文差分为 permit=B,属性删除 note、保留空值 empty
  const copied = builder.nodeAt(2, 'branches/exhibit/notice.txt');
  assert.equal(copied.text.toString(), 'permit=A\n');
  assert.equal(copied.id, noticeRev1.id); // 复制共享来源谱系
  const noticeRev2 = builder.nodeAt(2, 'trunk/notice.txt');
  assert.equal(noticeRev2.text.toString(), 'permit=B\n');
  assert.equal(noticeRev2.props.has('note'), false); // D 删除
  assert.equal(noticeRev2.props.get('empty').toString(), ''); // V 0 空值保留
  // 修订 3:replace 删掉重建,新对象谱系与旧对象无关;副本不受源分支修改影响
  const noticeRev3 = builder.nodeAt(3, 'trunk/notice.txt');
  assert.equal(noticeRev3.text.toString(), 'new-registration\n');
  assert.notEqual(noticeRev3.id, noticeRev1.id);
  assert.equal(noticeRev3.props.has('empty'), false); // 完整属性替换
  assert.equal(noticeRev3.props.get('owner').toString(), 'registrar');
  const copiedRev3 = builder.nodeAt(3, 'branches/exhibit/notice.txt');
  assert.equal(copiedRev3.text.toString(), 'permit=A\n');
  assert.equal(copiedRev3.id, noticeRev1.id);
  assert.equal(builder.nodeAt(1, 'trunk/notice.txt').text.toString(), 'permit=A\n'); // 历史修订保持定格
});

test('交接条目保留属性操作与正文校验信息', () => {
  const { entries } = ingest(historyDump);
  const notice = entries[1].changes.find(change => change.path === 'trunk/notice.txt');
  assert.deepEqual(notice.propChanges, [
    { op: 'delete', name: 'note' },
    { op: 'set', name: 'empty', value: '' },
  ]);
  assert.deepEqual(notice.props, { empty: '' });
  assert.equal(notice.text.delta, true);
  assert.equal(notice.text.md5, '8d0f1ccfdc9852eeb9cb5b68df59916e');
  const exhibit = entries[1].changes.find(change => change.path === 'branches/exhibit');
  assert.deepEqual(exhibit.copiedFrom, { path: 'trunk', revision: 1 });
  const replaced = entries[2].changes.find(change => change.path === 'trunk/notice.txt');
  assert.equal(replaced.propsReplaced, true);
  assert.notEqual(replaced.lineage, notice.lineage);
});

test('正文结果校验不符的修订被拒绝', () => {
  assert.throws(() => ingest(badChecksumDump), /正文结果校验不符/);
});

test('路径拒绝绝对与上级越界', () => {
  for (const path of ['../x', '/abs', 'a//b', 'a/./b', 'a/../b', 'C:/x']) {
    assert.throws(() => validatePath(path), DumpError);
  }
  assert.deepEqual(validatePath('trunk/notice.txt'), ['trunk', 'notice.txt']);
});

test('同一路径删掉重建分配新谱系,旧修订复制仍解析到旧对象', () => {
  const propsBlock = Buffer.from('K 7\nsvn:log\nV 1\nx\nPROPS-END\n');
  const revision = number => Buffer.from(`Revision-number: ${number}\nProp-content-length: ${propsBlock.length}\nContent-length: ${propsBlock.length}\n\n${propsBlock.toString()}\n`);
  const node = lines => Buffer.from(`${lines.join('\n')}\n\n`);
  const fileNode = (path, text) => Buffer.from(`Node-path: ${path}\nNode-kind: file\nNode-action: add\nText-content-length: ${text.length}\nContent-length: ${text.length}\n\n${text}\n`);
  const bytes = Buffer.concat([
    Buffer.from('SVN-fs-dump-format-version: 2\n\nUUID: test-uuid\n\n'),
    revision(1), fileNode('a', 'one\n'),
    revision(2), node(['Node-path: a', 'Node-action: delete']),
    revision(3), fileNode('a', 'two\n'),
    revision(4), node(['Node-path: b', 'Node-kind: file', 'Node-action: add', 'Node-copyfrom-rev: 1', 'Node-copyfrom-path: a']),
  ]);
  const { builder } = ingest(bytes);
  const original = builder.nodeAt(1, 'a');
  const recreated = builder.nodeAt(3, 'a');
  assert.equal(original.text.toString(), 'one\n');
  assert.equal(recreated.text.toString(), 'two\n');
  assert.notEqual(recreated.id, original.id); // 重建不接回原来的对象谱系
  const copied = builder.nodeAt(4, 'b');
  assert.equal(copied.text.toString(), 'one\n'); // 复制过去修订的路径,取得当时的对象
  assert.equal(copied.id, original.id);
  assert.equal(builder.nodeAt(4, 'a').id, recreated.id);
});

test('历史状态可序列化并在恢复后继续接受修订', () => {
  const { builder } = ingest(historyDump);
  const restored = HistoryBuilder.fromJSON(JSON.parse(JSON.stringify(builder.toJSON())));
  assert.equal(restored.nodeAt(2, 'branches/exhibit/notice.txt').text.toString(), 'permit=A\n');
  assert.equal(restored.lastRevision, 3);
  assert.equal(restored.treeAt(3).some(item => item.path === 'branches/exhibit/notice.txt'), true);
});
