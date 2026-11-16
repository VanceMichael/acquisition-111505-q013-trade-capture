import { createHash } from 'node:crypto';
import { applySvndiff } from './svndiff.mjs';
import { DumpSyntaxError } from './dump.mjs';

export class RepositoryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RepositoryError';
  }
}

const checksum = (bytes, algorithm) => createHash(algorithm).update(bytes).digest('hex');

const makeDir = (id, props = new Map(), children = new Map()) => ({ id, kind: 'dir', props, children });
const makeFile = (id, props = new Map(), text = Buffer.alloc(0)) => ({ id, kind: 'file', props, text });

// 路径从仓库根计；拒绝绝对路径、上级越界和空区段。空串表示根。
export function splitPath(path) {
  if (typeof path !== 'string') throw new RepositoryError('路径必须是字符串');
  if (path === '') return [];
  if (path.startsWith('/') || path.endsWith('/')) throw new RepositoryError(`路径越界或格式无效: ${path}`);
  const segments = path.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') throw new RepositoryError(`路径含非法区段: ${path}`);
  }
  return segments;
}

// 只读历史仓库：每个已交接修订一棵不可变目录树，写时复制共享未变子树。
// 节点 id 是谱系身份：新增/替换/复制都发新 id；删除后重建不会接回原谱系。
export class Repository {
  constructor() {
    this.roots = new Map();       // 修订号 -> 根目录节点
    this.revprops = new Map();    // 修订号 -> Map(名 -> 值字节)
    this.history = new Map();     // 修订号 -> 节点变更记录
    this.committed = [];          // 已交接修订号（严格递增，允许间隔）
    this.pending = null;          // 尚未交接的修订
    this.nextId = 1;
    this.rootNode = makeDir(0);
  }

  get pendingRevision() {
    return this.pending ? this.pending.number : null;
  }

  beginRevision(number, propEntries) {
    if (this.pending) throw new RepositoryError(`修订 ${this.pending.number} 尚未交接，不能开始修订 ${number}`);
    const last = this.committed[this.committed.length - 1];
    if (last !== undefined && number <= last) throw new RepositoryError(`修订号必须严格递增：${number} 不大于 ${last}`);
    const props = new Map();
    for (const entry of propEntries) {
      if (entry.op !== 'set') throw new RepositoryError('修订属性不应包含删除条目');
      props.set(entry.name, entry.value);
    }
    const base = last === undefined ? this.rootNode : this.roots.get(last);
    this.pending = { number, root: base, props, changes: [] };
  }

  commitPending() {
    if (!this.pending) return null;
    const { number, root, props, changes } = this.pending;
    this.roots.set(number, root);
    this.revprops.set(number, props);
    this.history.set(number, changes);
    this.committed.push(number);
    this.pending = null;
    return number;
  }

  lookup(root, segments) {
    let node = root;
    for (const segment of segments) {
      if (!node || node.kind !== 'dir') return null;
      node = node.children.get(segment);
    }
    return node ?? null;
  }

  // 沿路径写时复制，value 为 null 表示删除。
  splice(node, segments, value) {
    if (segments.length === 0) return value;
    if (!node || node.kind !== 'dir') throw new RepositoryError('父路径不是目录');
    const [head, ...rest] = segments;
    const children = new Map(node.children);
    if (rest.length === 0) {
      if (value === null) children.delete(head);
      else children.set(head, value);
    } else {
      const child = children.get(head);
      if (!child || child.kind !== 'dir') throw new RepositoryError(`父目录不存在: ${head}`);
      children.set(head, this.splice(child, rest, value));
    }
    return { ...node, children };
  }

  freshId() {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  // 复制锚定 (copyfromPath, copyfromRev) 当时对象：子树不可变共享，
  // 源分支之后的修改不会回写；副本根发新谱系 id，变更记录留存源对象 id 备查。
  copyFrom(record, fail) {
    const root = this.roots.get(record.copyfromRev);
    if (!root) fail(`复制源修订 ${record.copyfromRev} 不在已交接修订中`);
    const source = this.lookup(root, splitPath(record.copyfromPath));
    if (!source) fail(`复制源 ${record.copyfromPath} 在修订 ${record.copyfromRev} 不存在`);
    const node = source.kind === 'dir'
      ? { id: this.freshId(), kind: 'dir', props: source.props, children: source.children }
      : { id: this.freshId(), kind: 'file', props: source.props, text: source.text };
    return { node, sourceId: source.id };
  }

  applyProps(node, record, fail) {
    if (record.props === null) return node;
    let props;
    if (record.propDelta) {
      props = new Map(node.props);
      for (const entry of record.props) {
        if (entry.op === 'set') props.set(entry.name, entry.value);
        else props.delete(entry.name);
      }
    } else {
      props = new Map();
      for (const entry of record.props) {
        if (entry.op !== 'set') fail('完整属性块不应包含删除条目');
        props.set(entry.name, entry.value);
      }
    }
    return { ...node, props };
  }

  applyText(node, record, fail) {
    if (record.text === null) return node;
    if (node.kind !== 'file') fail('目录不应携带正文');
    let text;
    if (record.textDelta) {
      const base = node.text;
      if (record.deltaBaseMd5 && checksum(base, 'md5') !== record.deltaBaseMd5) fail(`差分基底 md5 不符（声明 ${record.deltaBaseMd5}）`);
      if (record.deltaBaseSha1 && checksum(base, 'sha1') !== record.deltaBaseSha1) fail('差分基底 sha1 不符');
      try {
        text = applySvndiff(base, record.text);
      } catch (error) {
        fail(`差分应用失败：${error.message}`);
      }
    } else {
      text = record.text;
    }
    if (record.contentMd5 && checksum(text, 'md5') !== record.contentMd5) fail(`正文 md5 校验不符（声明 ${record.contentMd5}）`);
    if (record.contentSha1 && checksum(text, 'sha1') !== record.contentSha1) fail('正文 sha1 校验不符');
    return { ...node, text };
  }

  applyNode(record) {
    const pending = this.pending;
    if (!pending) throw new RepositoryError(`节点 ${record.path} 出现在任何修订记录之外`);
    const fail = message => {
      const error = new RepositoryError(`修订 ${pending.number} 路径 ${record.path || '/'}：${message}`);
      error.contextual = true;
      throw error;
    };
    try {
      const segments = splitPath(record.path);
      const existing = this.lookup(pending.root, segments);
      if (record.action === 'add' || record.action === 'replace') {
        if (record.action === 'add' && existing) fail('新增目标已存在');
        if (record.action === 'replace' && !existing) fail('替换目标不存在');
        if (record.action === 'replace' && segments.length === 0) fail('不能替换根目录');
        let node;
        let copyfromId;
        if (record.copyfromPath !== null) {
          const copied = this.copyFrom(record, fail);
          node = copied.node;
          copyfromId = copied.sourceId;
        } else {
          node = record.kind === 'dir' ? makeDir(this.freshId()) : makeFile(this.freshId());
        }
        if (record.kind && node.kind !== record.kind) fail(`类型不符：记录为 ${record.kind}，复制源为 ${node.kind}`);
        node = this.applyProps(node, record, fail);
        node = this.applyText(node, record, fail);
        pending.root = this.splice(pending.root, segments, node);
        pending.changes.push({
          action: record.action, path: record.path, kind: node.kind, id: node.id,
          ...(record.copyfromPath !== null ? { copyfromRev: record.copyfromRev, copyfromPath: record.copyfromPath, copyfromId } : {}),
        });
      } else if (record.action === 'change') {
        if (!existing) fail('修改目标不存在');
        if (record.copyfromPath !== null) fail('change 不应携带复制来源');
        if (record.kind && existing.kind !== record.kind) fail(`类型不符：记录为 ${record.kind}，现有为 ${existing.kind}`);
        let node = this.applyProps(existing, record, fail);
        node = this.applyText(node, record, fail);
        if (node !== existing) pending.root = this.splice(pending.root, segments, node);
        pending.changes.push({ action: 'change', path: record.path, kind: node.kind, id: node.id });
      } else if (record.action === 'delete') {
        if (!existing) fail('删除目标不存在');
        if (segments.length === 0) fail('不能删除根目录');
        if (record.props !== null || record.text !== null) fail('delete 不应携带属性或正文');
        pending.root = this.splice(pending.root, segments, null);
        pending.changes.push({ action: 'delete', path: record.path, kind: existing.kind, id: existing.id });
      } else {
        fail(`未支持的节点动作 ${record.action}`);
      }
    } catch (error) {
      if (error.contextual) throw error;
      if (error instanceof RepositoryError || error instanceof DumpSyntaxError) {
        throw new RepositoryError(`修订 ${pending.number} 路径 ${record.path || '/'}：${error.message}`);
      }
      throw error;
    }
  }

  // 只读查询：修订未交接或路径当时不存在都返回 null。
  nodeAt(revision, path) {
    const root = this.roots.get(revision);
    if (!root) return null;
    return this.lookup(root, splitPath(path));
  }

  revisionProps(revision) {
    return this.revprops.get(revision) ?? null;
  }

  changes(revision) {
    return this.history.get(revision) ?? null;
  }
}
