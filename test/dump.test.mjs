import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Ingestor } from '../src/ingest.mjs';
import { applySvndiff } from '../src/svndiff.mjs';
import { parsePropBlock } from '../src/dump.mjs';

const fixture = name => readFile(new URL(`../fixtures/${name}`, import.meta.url));
const md5 = bytes => createHash('md5').update(bytes).digest('hex');

// ---- 转储构造工具（仅测试用）----

function propBlock(entries) {
  const parts = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    if (entry.op === 'delete') {
      parts.push(Buffer.from(`D ${name.length}\n`), name, Buffer.from('\n'));
    } else {
      const value = Buffer.from(entry.value);
      parts.push(Buffer.from(`K ${name.length}\n`), name, Buffer.from('\n'), Buffer.from(`V ${value.length}\n`), value, Buffer.from('\n'));
    }
  }
  parts.push(Buffer.from('PROPS-END\n'));
  return Buffer.concat(parts);
}

function nodeRecord({ path, kind, action, copyfromRev, copyfromPath, props, propDelta = false, text, textDelta = false, withMd5 = false, contentMd5 = null, deltaBaseMd5 = null }) {
  const headers = [`Node-path: ${path}`];
  if (kind) headers.push(`Node-kind: ${kind}`);
  headers.push(`Node-action: ${action}`);
  if (copyfromPath !== undefined) headers.push(`Node-copyfrom-rev: ${copyfromRev}`, `Node-copyfrom-path: ${copyfromPath}`);
  if (textDelta) headers.push('Text-delta: true');
  if (deltaBaseMd5) headers.push(`Text-delta-base-md5: ${deltaBaseMd5}`);
  const declaredMd5 = contentMd5 ?? (withMd5 && text ? md5(text) : null);
  if (declaredMd5) headers.push(`Text-content-md5: ${declaredMd5}`);
  if (propDelta) headers.push('Prop-delta: true');
  const propBytes = props ? propBlock(props) : null;
  if (propBytes) headers.push(`Prop-content-length: ${propBytes.length}`);
  if (text) headers.push(`Text-content-length: ${text.length}`);
  const content = Buffer.concat([...(propBytes ? [propBytes] : []), ...(text ? [text] : [])]);
  if (propBytes || text) headers.push(`Content-length: ${content.length}`);
  return Buffer.concat([Buffer.from(`${headers.join('\n')}\n\n`), content, Buffer.from('\n')]);
}

function revisionRecord(number, nodes, log = '交付') {
  const props = propBlock([{ op: 'set', name: 'svn:log', value: Buffer.from(log) }]);
  return Buffer.concat([
    Buffer.from(`Revision-number: ${number}\nProp-content-length: ${props.length}\nContent-length: ${props.length}\n\n`),
    props,
    Buffer.from('\n'),
    ...nodes,
  ]);
}

function dump(...revisions) {
  return Buffer.concat([Buffer.from('SVN-fs-dump-format-version: 2\n\nUUID: 00000000-1111-2222-3333-444455556666\n\n'), ...revisions]);
}

function varint(value) {
  const groups = [value & 0x7f];
  value = Math.floor(value / 128);
  while (value > 0) { groups.unshift((value & 0x7f) | 0x80); value = Math.floor(value / 128); }
  return Buffer.from(groups);
}

function svndiffWindow({ sourceOffset = 0, sourceLength = 0, targetLength, instructions, newData = Buffer.alloc(0) }) {
  return Buffer.concat([
    varint(sourceOffset), varint(sourceLength), varint(targetLength),
    varint(instructions.length), varint(newData.length), instructions, newData,
  ]);
}

const sourceCopy = (length, offset) => Buffer.concat([Buffer.from([length]), varint(offset)]);
const targetCopy = (length, offset) => Buffer.concat([Buffer.from([0x40 | length]), varint(offset)]);
const newDataCopy = length => Buffer.from([0x80 | length]);

// ---- 真实交付夹具 ----

test('完整转储按修订交接文件、属性、目录与复制谱系', async () => {
  const ing = new Ingestor();
  ing.feed(await fixture('history.dump'));
  ing.seal();
  const repo = ing.repository;
  assert.equal(ing.uuid, '7c59fa47-22c3-4ed7-ae11-001122334455');
  assert.deepEqual(repo.committed, [1, 2, 3]);
  assert.equal(repo.revisionProps(1).get('svn:log').toString(), '本地授权文本交付');

  const notice1 = repo.nodeAt(1, 'trunk/notice.txt');
  assert.equal(notice1.text.toString(), 'permit=A\n');
  assert.equal(notice1.props.get('note').toString(), '已核对');
  assert.equal(notice1.props.get('empty').toString(), '');

  // 差分窗口按正确基底重建并通过结果校验
  const notice2 = repo.nodeAt(2, 'trunk/notice.txt');
  assert.equal(notice2.text.toString(), 'permit=B\n');
  assert.equal(notice2.props.has('note'), false);
  assert.equal(notice2.props.get('empty').toString(), '');

  // 复制锚定过去修订：副本是修订 1 的同一历史对象
  const copy2 = repo.nodeAt(2, 'branches/exhibit/notice.txt');
  assert.equal(copy2.text.toString(), 'permit=A\n');
  assert.equal(copy2.id, notice1.id);
  assert.equal(copy2.props.get('note').toString(), '已核对');

  // 替换产生新谱系，且不回写已复制的副本
  const notice3 = repo.nodeAt(3, 'trunk/notice.txt');
  assert.equal(notice3.text.toString(), 'new-registration\n');
  assert.notEqual(notice3.id, notice1.id);
  assert.equal(notice3.props.get('owner').toString(), 'registrar');
  assert.equal(notice3.props.has('empty'), false);
  assert.equal(repo.nodeAt(3, 'branches/exhibit/notice.txt').text.toString(), 'permit=A\n');

  // 目录关系与历史修订不被后续修改影响
  assert.deepEqual([...repo.nodeAt(3, 'trunk').children.keys()], ['notice.txt']);
  assert.deepEqual([...repo.nodeAt(2, 'branches/exhibit').children.keys()], ['notice.txt']);
  assert.equal(repo.nodeAt(1, 'trunk/notice.txt').text.toString(), 'permit=A\n');
});

test('分段停在修订中间时只交接先前完整修订', async () => {
  const ing = new Ingestor();
  ing.feed(await fixture('truncated.dump'));
  assert.deepEqual(ing.repository.committed, [1, 2]);
  assert.equal(ing.pendingRevision, 3);
  assert.equal(ing.atBoundary, false);
  assert.equal(ing.repository.nodeAt(3, 'trunk/notice.txt'), null);
  assert.equal(ing.repository.nodeAt(2, 'branches/exhibit/notice.txt').text.toString(), 'permit=A\n');
  assert.throws(() => ing.seal(), /修订记录中间结束/);
});

test('正文校验和不符的修订被拒绝且不交接', async () => {
  const bytes = await fixture('bad-checksum.dump');
  const ing = new Ingestor();
  assert.throws(() => ing.feed(bytes), /正文 md5 校验不符/);
  assert.deepEqual(ing.repository.committed, []);
});

// ---- svndiff0 差分 ----

test('差分窗口支持源复制、新数据与目标重叠展开', () => {
  const base = Buffer.from('abc');
  const delta = Buffer.concat([
    Buffer.from('SVN\0'),
    svndiffWindow({
      sourceLength: 3,
      targetLength: 8,
      instructions: Buffer.concat([sourceCopy(3, 0), newDataCopy(1), targetCopy(4, 3)]),
      newData: Buffer.from('x'),
    }),
  ]);
  assert.equal(applySvndiff(base, delta).toString(), 'abcx' + 'xxxx');
});

test('不支持的差分版本明确隔离', () => {
  assert.throws(() => applySvndiff(Buffer.alloc(0), Buffer.from('SVN\x01')), /不支持的差分版本 svndiff1/);
  assert.throws(() => applySvndiff(Buffer.alloc(0), Buffer.from('not-diff')), /不是 svndiff 数据/);
});

test('损坏的差分窗口被拒绝', () => {
  const base = Buffer.from('abc');
  const overrun = Buffer.concat([Buffer.from('SVN\0'), svndiffWindow({ sourceLength: 10, targetLength: 0, instructions: Buffer.alloc(0) })]);
  assert.throws(() => applySvndiff(base, overrun), /源区间超出基底/);
  const truncated = Buffer.concat([Buffer.from('SVN\0'), varint(0), varint(3), varint(1), varint(5), varint(0), Buffer.from([0x81])]);
  assert.throws(() => applySvndiff(base, truncated), /截断/);
  const illegal = Buffer.concat([Buffer.from('SVN\0'), svndiffWindow({ targetLength: 1, instructions: Buffer.from([0xc1]) })]);
  assert.throws(() => applySvndiff(base, illegal), /指令类型非法/);
  const unused = Buffer.concat([Buffer.from('SVN\0'), svndiffWindow({ targetLength: 0, instructions: Buffer.alloc(0), newData: Buffer.from('z') })]);
  assert.throws(() => applySvndiff(base, unused), /未完全使用新数据区/);
});

test('差分基底与结果校验和都在接收端核对', () => {
  const delta = Buffer.concat([
    Buffer.from('SVN\0'),
    svndiffWindow({ targetLength: 1, instructions: newDataCopy(1), newData: Buffer.from('B') }),
  ]);
  const good = dump(
    revisionRecord(1, [nodeRecord({ path: 'f', kind: 'file', action: 'add', text: Buffer.from('AAA'), withMd5: true })]),
    revisionRecord(2, [nodeRecord({ path: 'f', kind: 'file', action: 'change', text: delta, textDelta: true, deltaBaseMd5: md5(Buffer.from('AAA')), contentMd5: md5(Buffer.from('B')) })]),
  );
  const ing = new Ingestor();
  ing.feed(good);
  ing.seal();
  assert.equal(ing.repository.nodeAt(2, 'f').text.toString(), 'B');

  const wrongBase = dump(
    revisionRecord(1, [nodeRecord({ path: 'f', kind: 'file', action: 'add', text: Buffer.from('AAA') })]),
    revisionRecord(2, [nodeRecord({ path: 'f', kind: 'file', action: 'change', text: delta, textDelta: true, deltaBaseMd5: md5(Buffer.from('ZZZ')) })]),
  );
  assert.throws(() => new Ingestor().feed(wrongBase), /差分基底 md5 不符/);
});

// ---- 属性语义 ----

test('属性删除与空值区别保留', () => {
  const entries = parsePropBlock(propBlock([
    { op: 'set', name: 'empty', value: Buffer.alloc(0) },
    { op: 'delete', name: 'gone' },
    { op: 'set', name: 'kept', value: Buffer.from('值') },
  ]));
  assert.deepEqual(entries.map(e => e.op), ['set', 'delete', 'set']);
  assert.equal(entries[0].value.length, 0);
  assert.equal(entries[1].value, undefined);
  assert.throws(() => parsePropBlock(Buffer.from('K 5\nab')), /属性块无效/);
  assert.throws(() => parsePropBlock(propBlock([{ op: 'set', name: 'a', value: Buffer.from('b') }]).subarray(0, 5)), /属性块无效/);
});

test('属性差分删除键而空值键保留', () => {
  const bytes = dump(
    revisionRecord(1, [nodeRecord({ path: 'f', kind: 'file', action: 'add', text: Buffer.from('v1'), props: [{ op: 'set', name: 'note', value: Buffer.from('x') }, { op: 'set', name: 'empty', value: Buffer.alloc(0) }] })]),
    revisionRecord(2, [nodeRecord({ path: 'f', kind: 'file', action: 'change', props: [{ op: 'delete', name: 'note' }, { op: 'set', name: 'empty', value: Buffer.alloc(0) }], propDelta: true })]),
  );
  const ing = new Ingestor();
  ing.feed(bytes);
  ing.seal();
  const props = ing.repository.nodeAt(2, 'f').props;
  assert.equal(props.has('note'), false);
  assert.equal(props.get('empty').toString(), '');
});

// ---- 复制谱系 ----

test('同一路径删除重建后不会接回原谱系，复制按修订解析当时对象', () => {
  const bytes = dump(
    revisionRecord(1, [nodeRecord({ path: 'a', kind: 'file', action: 'add', text: Buffer.from('old-lineage') })]),
    revisionRecord(2, [
      nodeRecord({ path: 'a', kind: 'file', action: 'delete' }),
      nodeRecord({ path: 'a', kind: 'file', action: 'add', text: Buffer.from('new-lineage') }),
    ]),
    revisionRecord(3, [
      nodeRecord({ path: 'b', kind: 'file', action: 'add', copyfromRev: 1, copyfromPath: 'a' }),
      nodeRecord({ path: 'c', kind: 'file', action: 'add', copyfromRev: 2, copyfromPath: 'a' }),
    ]),
  );
  const ing = new Ingestor();
  ing.feed(bytes);
  ing.seal();
  const repo = ing.repository;
  const oldNode = repo.nodeAt(1, 'a');
  const newNode = repo.nodeAt(2, 'a');
  assert.notEqual(oldNode.id, newNode.id);
  // 副本内容锚定各自修订的当时对象，副本根是独立谱系
  const copyOld = repo.nodeAt(3, 'b');
  const copyNew = repo.nodeAt(3, 'c');
  assert.equal(copyOld.text.toString(), 'old-lineage');
  assert.equal(copyNew.text.toString(), 'new-lineage');
  assert.notEqual(copyOld.id, oldNode.id);
  assert.notEqual(copyOld.id, newNode.id);
  assert.notEqual(copyNew.id, newNode.id);
  // 变更记录留存复制来源对象 id，谱系可审计
  const changes = repo.changes(3);
  assert.equal(changes.find(c => c.path === 'b').copyfromId, oldNode.id);
  assert.equal(changes.find(c => c.path === 'b').copyfromRev, 1);
  assert.equal(changes.find(c => c.path === 'c').copyfromId, newNode.id);
  // 未动的路径保持重建后的谱系
  assert.equal(repo.nodeAt(3, 'a').id, newNode.id);
});

test('复制源必须在已交接修订中真实存在', () => {
  const missingRev = dump(
    revisionRecord(1, [nodeRecord({ path: 'a', kind: 'file', action: 'add', text: Buffer.from('x') })]),
    revisionRecord(2, [nodeRecord({ path: 'b', kind: 'file', action: 'add', copyfromRev: 9, copyfromPath: 'a' })]),
  );
  assert.throws(() => new Ingestor().feed(missingRev), /复制源修订 9 不在已交接修订中/);
  const deleted = dump(
    revisionRecord(1, [nodeRecord({ path: 'a', kind: 'file', action: 'add', text: Buffer.from('x') })]),
    revisionRecord(2, [nodeRecord({ path: 'a', kind: 'file', action: 'delete' })]),
    revisionRecord(3, [nodeRecord({ path: 'b', kind: 'file', action: 'add', copyfromRev: 2, copyfromPath: 'a' })]),
  );
  assert.throws(() => new Ingestor().feed(deleted), /复制源 a 在修订 2 不存在/);
});

// ---- 路径与操作校验 ----

test('越界路径与非法节点操作被拒绝', () => {
  const withPath = path => dump(revisionRecord(1, [nodeRecord({ path, kind: 'file', action: 'add', text: Buffer.from('x') })]));
  assert.throws(() => new Ingestor().feed(withPath('../escape')), /非法区段/);
  assert.throws(() => new Ingestor().feed(withPath('/absolute')), /越界/);
  assert.throws(() => new Ingestor().feed(withPath('a//b')), /非法区段/);
  assert.throws(() => new Ingestor().feed(withPath('a/./b')), /非法区段/);

  const addExisting = dump(
    revisionRecord(1, [nodeRecord({ path: 'a', kind: 'file', action: 'add', text: Buffer.from('x') })]),
    revisionRecord(2, [nodeRecord({ path: 'a', kind: 'file', action: 'add', text: Buffer.from('y') })]),
  );
  assert.throws(() => new Ingestor().feed(addExisting), /新增目标已存在/);
  const changeMissing = dump(revisionRecord(1, [nodeRecord({ path: 'ghost', kind: 'file', action: 'change', text: Buffer.from('x') })]));
  assert.throws(() => new Ingestor().feed(changeMissing), /修改目标不存在/);
  const deleteMissing = dump(revisionRecord(1, [nodeRecord({ path: 'ghost', kind: 'file', action: 'delete' })]));
  assert.throws(() => new Ingestor().feed(deleteMissing), /删除目标不存在/);
  const missingParent = dump(revisionRecord(1, [nodeRecord({ path: 'no/such/dir/f', kind: 'file', action: 'add', text: Buffer.from('x') })]));
  assert.throws(() => new Ingestor().feed(missingParent), /父目录不存在/);
});

test('修订号必须严格递增但允许间隔，不自行补造修订', () => {
  const gaps = dump(
    revisionRecord(1, [nodeRecord({ path: 'a', kind: 'file', action: 'add', text: Buffer.from('x') })]),
    revisionRecord(3, [nodeRecord({ path: 'b', kind: 'file', action: 'add', text: Buffer.from('y') })]),
    revisionRecord(7, [nodeRecord({ path: 'c', kind: 'file', action: 'add', text: Buffer.from('z') })]),
  );
  const ing = new Ingestor();
  ing.feed(gaps);
  ing.seal();
  assert.deepEqual(ing.repository.committed, [1, 3, 7]);
  assert.equal(ing.repository.nodeAt(2, 'a'), null);
  assert.equal(ing.repository.nodeAt(7, 'c').text.toString(), 'z');

  const regression = dump(
    revisionRecord(2, [nodeRecord({ path: 'a', kind: 'file', action: 'add', text: Buffer.from('x') })]),
    revisionRecord(2, [nodeRecord({ path: 'b', kind: 'file', action: 'add', text: Buffer.from('y') })]),
  );
  assert.throws(() => new Ingestor().feed(regression), /严格递增/);
});

test('格式版本与流结构不符合约时被拒绝', () => {
  assert.throws(() => new Ingestor().feed(Buffer.from('SVN-fs-dump-format-version: 3\n\n')), /不支持的转储格式版本 3/);
  assert.throws(() => new Ingestor().feed(Buffer.from('UUID: x\n\n')), /应以格式版本记录开始/);
  const noUuid = Buffer.from('SVN-fs-dump-format-version: 2\n\nRevision-number: 1\nProp-content-length: 10\nContent-length: 10\n\nPROPS-END\n\n');
  assert.throws(() => new Ingestor().feed(noUuid), /应为 UUID 记录/);
});
