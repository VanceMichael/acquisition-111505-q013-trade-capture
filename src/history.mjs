// 按修订重建仓库状态。节点对象不可变,每个修订保留整棵树的快照(结构共享),
// 因此复制来源永远解析到"那个修订当时"的对象:源分支之后的修改不会回写到副本。
// 新增(无 copyfrom)与 replace 都会分配新的谱系 id,同一路径删掉重建不会接回
// 原来的对象谱系;复制则共享来源谱系并记录 copiedFrom 指针。

import { createHash } from 'node:crypto';
import { applySvndiff } from './svndiff.mjs';
import { validatePath } from './dump.mjs';

export class HistoryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HistoryError';
  }
}

const md5hex = bytes => createHash('md5').update(bytes).digest('hex');
const sha256hex = bytes => createHash('sha256').update(bytes).digest('hex');
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

// 属性值是二进制安全的:可解码为 UTF-8 时按字符串保留(空串即存在但为空),
// 否则以 base64 标记保留,删除只表现为属性不存在。
export function encodeValue(buffer) {
  try {
    return utf8Strict.decode(buffer);
  } catch {
    return { base64: buffer.toString('base64') };
  }
}

const propsToObject = props => Object.fromEntries([...props].map(([name, value]) => [name, encodeValue(value)]));

export function revisionPropsToObject(operations) {
  const result = {};
  for (const operation of operations) {
    if (operation.op === 'set') result[operation.name] = encodeValue(operation.value);
    else delete result[operation.name];
  }
  return result;
}

function lookupIn(root, segments) {
  let node = root;
  for (const segment of segments) {
    if (!node || node.kind !== 'dir') return null;
    node = node.children.get(segment);
  }
  return node ?? null;
}

function setIn(node, segments, value) {
  if (segments.length === 0) return value;
  if (node.kind !== 'dir') throw new HistoryError('路径穿越了文件节点');
  const [head, ...rest] = segments;
  const children = new Map(node.children);
  if (rest.length === 0) {
    children.set(head, value);
  } else {
    const child = children.get(head);
    if (!child) throw new HistoryError(`父目录 ${head} 不存在`);
    children.set(head, setIn(child, rest, value));
  }
  return { ...node, children };
}

function removeIn(node, segments) {
  const [head, ...rest] = segments;
  const children = new Map(node.children);
  if (rest.length === 0) {
    children.delete(head);
  } else {
    const child = children.get(head);
    if (!child) throw new HistoryError(`父目录 ${head} 不存在`);
    children.set(head, removeIn(child, rest));
  }
  return { ...node, children };
}

function serializeNode(node) {
  return {
    id: node.id,
    kind: node.kind,
    props: [...node.props].map(([name, value]) => [name, value.toString('base64')]),
    text: node.text === null ? null : node.text.toString('base64'),
    copiedFrom: node.copiedFrom,
    children: node.children === null ? null : Object.fromEntries([...node.children].map(([name, child]) => [name, serializeNode(child)])),
  };
}

function deserializeNode(data) {
  return {
    id: data.id,
    kind: data.kind,
    props: new Map(data.props.map(([name, value]) => [name, Buffer.from(value, 'base64')])),
    text: data.text === null ? null : Buffer.from(data.text, 'base64'),
    copiedFrom: data.copiedFrom,
    children: data.children === null ? null : new Map(Object.entries(data.children).map(([name, child]) => [name, deserializeNode(child)])),
  };
}

export class HistoryBuilder {
  constructor() {
    this.states = new Map(); // 修订号 → 该修订提交后的根节点(不可变)
    this.nodeCounter = 0;
    this.root = this.#fresh('dir');
    this.pending = null;
    this.lastRevision = -1;
  }

  #fresh(kind) {
    this.nodeCounter += 1;
    return {
      id: `n${this.nodeCounter}`,
      kind,
      props: new Map(),
      text: kind === 'file' ? Buffer.alloc(0) : null,
      children: kind === 'dir' ? new Map() : null,
      copiedFrom: null,
    };
  }

  beginRevision(number, revProps) {
    if (this.pending) throw new HistoryError('上一修订尚未提交');
    if (number <= this.lastRevision) throw new HistoryError(`修订号 ${number} 未递增`);
    this.pending = { number, revProps, changes: [] };
  }

  applyNode(record) {
    if (!this.pending) throw new HistoryError('节点记录不在任何修订内');
    const existing = lookupIn(this.root, record.segments);
    if (record.action === 'delete') {
      if (!existing) throw new HistoryError(`删除不存在的路径 ${record.path}`);
      if (record.kind !== undefined && record.kind !== existing.kind) throw new HistoryError(`节点 ${record.path} 类型与既有对象不符`);
      this.root = removeIn(this.root, record.segments);
      this.pending.changes.push({ action: 'delete', path: record.path, kind: existing.kind, lineage: existing.id });
      return;
    }
    if (record.action === 'change') {
      if (!existing) throw new HistoryError(`修改不存在的路径 ${record.path}`);
      if (record.kind !== undefined && record.kind !== existing.kind) throw new HistoryError(`节点 ${record.path} 类型与既有对象不符`);
      const node = this.#revised(existing, record);
      this.root = setIn(this.root, record.segments, node);
      this.pending.changes.push(this.#describe('change', record, node));
      return;
    }
    // add / replace
    if (record.action === 'add' && existing) throw new HistoryError(`新增路径已存在 ${record.path}`);
    if (record.action === 'replace' && !existing) throw new HistoryError(`替换不存在的路径 ${record.path}`);
    const parent = lookupIn(this.root, record.segments.slice(0, -1));
    if (!parent || parent.kind !== 'dir') throw new HistoryError(`父目录不存在 ${record.path}`);
    let base;
    if (record.copyfromPath !== undefined) {
      const sourceRoot = this.states.get(record.copyfromRev);
      if (!sourceRoot) throw new HistoryError(`复制来源修订 ${record.copyfromRev} 不在已接收历史中`);
      const source = lookupIn(sourceRoot, validatePath(record.copyfromPath));
      if (!source) throw new HistoryError(`复制来源 ${record.copyfromPath}@${record.copyfromRev} 不存在`);
      if (record.kind !== undefined && record.kind !== source.kind) throw new HistoryError(`节点 ${record.path} 类型与复制来源不符`);
      // 复制共享来源谱系与子树;来源之后的修改基于不可变快照,不会回写到副本
      base = { ...source, copiedFrom: { path: record.copyfromPath, revision: record.copyfromRev } };
    } else {
      if (record.kind === undefined) throw new HistoryError(`节点 ${record.path} 缺少 Node-kind`);
      base = this.#fresh(record.kind); // 全新对象谱系,不接回同一路径上被删除的旧对象
    }
    const node = this.#revised(base, record);
    this.root = setIn(this.root, record.segments, node);
    this.pending.changes.push(this.#describe(record.action, record, node));
  }

  #revised(base, record) {
    let props = base.props;
    if (record.props !== null) {
      if (record.propDelta) {
        props = new Map(base.props);
        for (const operation of record.props) {
          if (operation.op === 'set') props.set(operation.name, operation.value);
          else props.delete(operation.name);
        }
      } else {
        // 非 Prop-delta 是完整属性替换:未列出的属性全部移除
        props = new Map();
        for (const operation of record.props) {
          if (operation.op === 'set') props.set(operation.name, operation.value);
        }
      }
    }
    let text = base.text;
    if (record.text !== null) {
      if (base.kind !== 'file') throw new HistoryError(`目录 ${record.path} 不允许携带正文`);
      if (record.textDelta) {
        const baseText = base.text ?? Buffer.alloc(0);
        if (record.baseMd5 !== undefined && md5hex(baseText) !== record.baseMd5) {
          throw new HistoryError(`节点 ${record.path} 差分基底校验不符,声明 ${record.baseMd5}`);
        }
        text = applySvndiff(baseText, record.text);
      } else {
        text = record.text;
      }
      if (record.contentMd5 !== undefined && md5hex(text) !== record.contentMd5) {
        throw new HistoryError(`节点 ${record.path} 正文结果校验不符,声明 ${record.contentMd5}`);
      }
    }
    return { ...base, props, text };
  }

  #describe(action, record, node) {
    const change = { action, path: record.path, kind: node.kind, lineage: node.id };
    if (node.copiedFrom) change.copiedFrom = node.copiedFrom;
    change.props = propsToObject(node.props);
    if (record.props !== null) {
      change.propChanges = record.props.map(operation => (operation.op === 'set'
        ? { op: 'set', name: operation.name, value: encodeValue(operation.value) }
        : { op: 'delete', name: operation.name }));
      if (!record.propDelta) change.propsReplaced = true;
    }
    if (record.text !== null && node.kind === 'file') {
      change.text = { length: node.text.length, sha256: sha256hex(node.text), md5: md5hex(node.text) };
      if (record.textDelta) change.text.delta = true;
      change.textBytes = node.text; // 交接时落为 blob,随后从记录中移除
    }
    return change;
  }

  commit() {
    if (!this.pending) return null;
    const entry = {
      revision: this.pending.number,
      revProps: revisionPropsToObject(this.pending.revProps),
      changes: this.pending.changes,
    };
    this.states.set(this.pending.number, this.root);
    this.lastRevision = this.pending.number;
    this.pending = null;
    return entry;
  }

  nodeAt(revision, path) {
    const root = this.states.get(revision);
    if (!root) return null;
    return lookupIn(root, validatePath(path));
  }

  treeAt(revision) {
    const root = this.states.get(revision);
    if (!root) return null;
    const listing = [];
    const walk = (node, path) => {
      const item = { path, kind: node.kind, lineage: node.id, props: propsToObject(node.props) };
      if (node.copiedFrom) item.copiedFrom = node.copiedFrom;
      if (node.kind === 'file') item.text = { length: node.text.length, sha256: sha256hex(node.text), md5: md5hex(node.text) };
      listing.push(item);
      if (node.kind === 'dir') {
        for (const [name, child] of [...node.children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          walk(child, path ? `${path}/${name}` : name);
        }
      }
    };
    walk(root, '');
    return listing;
  }

  toJSON() {
    return {
      nodeCounter: this.nodeCounter,
      lastRevision: this.lastRevision,
      root: serializeNode(this.root),
      states: [...this.states.entries()].map(([revision, root]) => [revision, serializeNode(root)]),
    };
  }

  static fromJSON(data) {
    const builder = new HistoryBuilder();
    builder.nodeCounter = data.nodeCounter;
    builder.lastRevision = data.lastRevision;
    builder.root = deserializeNode(data.root);
    builder.states = new Map(data.states.map(([revision, node]) => [revision, deserializeNode(node)]));
    return builder;
  }
}
