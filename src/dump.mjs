// 只读 SVN 转储(格式 2)增量解析器。
// 头部为 ASCII 键值行、以空行结束;Content-length 是后续内容的精确字节数,
// 不用逐行切分猜测正文。记录未收齐时保持等待,截断的头、内容和差分窗口
// 不会被伪装成空节点。单个修订没有专门结束标记:下一条修订记录或封口导出
// 的完整字节终点才构成可确认边界,是否提交修订由调用方决定。

export class DumpError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DumpError';
  }
}

const HEADER_LIMIT = 1024 * 1024;
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

export function validatePath(path) {
  if (typeof path !== 'string' || path.length === 0) throw new DumpError('节点路径为空');
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new DumpError(`拒绝绝对路径 ${JSON.stringify(path)}`);
  }
  const segments = path.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new DumpError(`路径越界或含空段 ${JSON.stringify(path)}`);
  }
  return segments;
}

// 属性块:K/D 长度定界条目,K 后必须跟 V;空串是存在但值为空,D 是删除。
export function parseProperties(block) {
  const operations = [];
  let position = 0;
  const readLine = () => {
    const end = block.indexOf(0x0a, position);
    if (end === -1) throw new DumpError('属性块在换行前被截断');
    const text = utf8Strict.decode(block.subarray(position, end));
    position = end + 1;
    return text;
  };
  const readBytes = length => {
    if (position + length + 1 > block.length) throw new DumpError('属性条目内容被截断');
    const value = block.subarray(position, position + length);
    if (block[position + length] !== 0x0a) throw new DumpError('属性条目缺少结束换行');
    position += length + 1;
    return value;
  };
  for (;;) {
    if (position >= block.length) throw new DumpError('属性块缺少 PROPS-END');
    const token = readLine();
    if (token === 'PROPS-END') break;
    const match = /^([KD]) (\d+)$/.exec(token);
    if (!match) throw new DumpError(`属性条目无法识别 ${JSON.stringify(token)}`);
    const name = utf8Strict.decode(readBytes(Number(match[2])));
    if (match[1] === 'D') {
      operations.push({ op: 'delete', name });
      continue;
    }
    const valueToken = readLine();
    const valueMatch = /^V (\d+)$/.exec(valueToken);
    if (!valueMatch) throw new DumpError('属性 K 条目后缺少 V 值');
    operations.push({ op: 'set', name, value: readBytes(Number(valueMatch[1])) });
  }
  if (position !== block.length) throw new DumpError('PROPS-END 后存在多余属性字节');
  return operations;
}

function parseHeaders(block) {
  let text;
  try {
    text = utf8Strict.decode(block);
  } catch {
    throw new DumpError('头部不是合法 UTF-8');
  }
  const headers = new Map();
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9-]*): (.*)$/.exec(line);
    if (!match) throw new DumpError(`头部行无效 ${JSON.stringify(line)}`);
    if (headers.has(match[1])) throw new DumpError(`头部重复 ${match[1]}`);
    headers.set(match[1], match[2]);
  }
  return headers;
}

function nonNegativeInteger(headers, key) {
  const value = headers.get(key);
  if (!/^\d+$/.test(value)) throw new DumpError(`${key} 不是非负整数`);
  return Number(value);
}

function flag(headers, key) {
  const value = headers.get(key);
  if (value === undefined) return false;
  if (value !== 'true' && value !== 'false') throw new DumpError(`${key} 取值无效`);
  return value === 'true';
}

function md5Header(headers, key) {
  const value = headers.get(key);
  if (value !== undefined && !/^[0-9a-f]{32}$/.test(value)) throw new DumpError(`${key} 不是 md5 十六进制`);
  return value;
}

export class DumpParser {
  // resumed=true 表示从某个修订记录边界续解析,不再要求格式头与 UUID 记录;
  // offset 是缓冲区起点在整个导出中的绝对字节偏移。
  constructor({ resumed = false, offset = 0, lastRevision = -1 } = {}) {
    this.buffer = Buffer.alloc(0);
    this.base = offset;
    this.seenFormat = resumed;
    this.seenUuid = resumed;
    this.lastRevision = lastRevision;
  }

  get offset() {
    return this.base;
  }

  push(chunk) {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const records = [];
    for (;;) {
      const record = this.#parseOne();
      if (!record) break;
      records.push(record);
    }
    return records;
  }

  // 仅在封口导出且声明字节已全部到达时调用:剩余字节必须只是记录分隔空行。
  finish() {
    this.#skipSeparators();
    if (this.buffer.length !== 0) {
      throw new DumpError(`封口导出在偏移 ${this.base} 处留有 ${this.buffer.length} 个无法解析的字节`);
    }
  }

  #skipSeparators() {
    let skipped = 0;
    while (skipped < this.buffer.length && this.buffer[skipped] === 0x0a) skipped += 1;
    if (skipped > 0) {
      this.buffer = this.buffer.subarray(skipped);
      this.base += skipped;
    }
  }

  #parseOne() {
    this.#skipSeparators();
    if (this.buffer.length === 0) return null;
    const end = this.buffer.indexOf('\n\n');
    if (end === -1) {
      if (this.buffer.length > HEADER_LIMIT) throw new DumpError('头部块超过 1MiB 仍未结束');
      return null;
    }
    const headers = parseHeaders(this.buffer.subarray(0, end));
    const contentLength = headers.has('Content-length') ? nonNegativeInteger(headers, 'Content-length') : 0;
    const total = end + 2 + contentLength;
    if (this.buffer.length < total) return null; // 内容未到齐,等待更多字节
    const content = this.buffer.subarray(end + 2, total);
    const record = this.#record(headers, content);
    record.offset = this.base;
    record.endOffset = this.base + total;
    this.buffer = this.buffer.subarray(total);
    this.base += total;
    return record;
  }

  #record(headers, content) {
    if (headers.has('SVN-fs-dump-format-version')) {
      if (this.seenFormat) throw new DumpError('转储格式头重复出现');
      const version = headers.get('SVN-fs-dump-format-version');
      if (version !== '2') throw new DumpError(`不支持的转储格式版本 ${version}`);
      this.seenFormat = true;
      return { type: 'format', version: 2 };
    }
    if (!this.seenFormat) throw new DumpError('转储缺少 SVN-fs-dump-format-version 头');
    if (headers.has('UUID')) {
      if (this.seenUuid) throw new DumpError('UUID 记录重复出现');
      this.seenUuid = true;
      return { type: 'uuid', uuid: headers.get('UUID') };
    }
    if (!this.seenUuid) throw new DumpError('转储缺少 UUID 记录');
    if (headers.has('Revision-number')) {
      const number = nonNegativeInteger(headers, 'Revision-number');
      if (number <= this.lastRevision) throw new DumpError(`修订号 ${number} 未递增`);
      this.lastRevision = number;
      for (const key of ['Prop-content-length', 'Content-length']) {
        if (!headers.has(key)) throw new DumpError(`修订 ${number} 缺少 ${key}`);
      }
      const propLength = nonNegativeInteger(headers, 'Prop-content-length');
      if (propLength !== content.length || nonNegativeInteger(headers, 'Content-length') !== content.length) {
        throw new DumpError(`修订 ${number} 的内容长度声明不一致`);
      }
      return { type: 'revision', number, props: parseProperties(content) };
    }
    if (headers.has('Node-path')) return this.#node(headers, content);
    throw new DumpError('无法识别的记录头');
  }

  #node(headers, content) {
    const path = headers.get('Node-path');
    const segments = validatePath(path);
    const action = headers.get('Node-action');
    if (!['add', 'change', 'delete', 'replace'].includes(action)) throw new DumpError(`节点 ${path} 的动作无效`);
    const kind = headers.get('Node-kind');
    if (kind !== undefined && kind !== 'file' && kind !== 'dir') throw new DumpError(`节点 ${path} 的类型无效`);
    const propLength = headers.has('Prop-content-length') ? nonNegativeInteger(headers, 'Prop-content-length') : 0;
    const textLength = headers.has('Text-content-length') ? nonNegativeInteger(headers, 'Text-content-length') : 0;
    if (!headers.has('Content-length')) {
      if (propLength > 0 || textLength > 0 || headers.has('Text-content-length')) {
        throw new DumpError(`节点 ${path} 缺少 Content-length 却声明了内容`);
      }
    } else if (nonNegativeInteger(headers, 'Content-length') !== propLength + textLength) {
      throw new DumpError(`节点 ${path} 的 Content-length 与属性/正文长度不符`);
    }
    const props = propLength > 0 ? parseProperties(content.subarray(0, propLength)) : null;
    const hasText = headers.has('Text-content-length');
    const text = hasText ? content.subarray(propLength, propLength + textLength) : null;
    const copyfromRev = headers.has('Node-copyfrom-rev') ? nonNegativeInteger(headers, 'Node-copyfrom-rev') : undefined;
    const copyfromPath = headers.get('Node-copyfrom-path');
    if ((copyfromRev === undefined) !== (copyfromPath === undefined)) {
      throw new DumpError(`节点 ${path} 的 copyfrom 修订与路径必须成对出现`);
    }
    if (copyfromPath !== undefined) validatePath(copyfromPath);
    const textDelta = flag(headers, 'Text-delta');
    const propDelta = flag(headers, 'Prop-delta');
    const baseMd5 = md5Header(headers, 'Text-delta-base-md5');
    const contentMd5 = md5Header(headers, 'Text-content-md5');
    if (baseMd5 !== undefined && !textDelta) throw new DumpError(`节点 ${path} 非差分正文却声明了基底校验`);
    if (textDelta && !hasText) throw new DumpError(`节点 ${path} 声明差分却没有正文内容`);
    if (contentMd5 !== undefined && !hasText) throw new DumpError(`节点 ${path} 没有正文却声明了正文校验`);
    if (propDelta && props === null) throw new DumpError(`节点 ${path} 声明属性差分却没有属性内容`);
    if (action === 'delete' && (props !== null || hasText || copyfromPath !== undefined)) {
      throw new DumpError(`删除节点 ${path} 不允许携带属性、正文或复制来源`);
    }
    if (action === 'change' && copyfromPath !== undefined) throw new DumpError(`修改节点 ${path} 不允许携带复制来源`);
    if (kind === 'dir' && hasText) throw new DumpError(`目录 ${path} 不允许携带正文`);
    return { type: 'node', path, segments, kind, action, copyfromRev, copyfromPath, propDelta, props, text, textDelta, baseMd5, contentMd5 };
  }
}
