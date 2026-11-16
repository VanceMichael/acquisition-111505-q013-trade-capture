// SVN 转储流（SVN-fs-dump-format-version: 2）增量解析。
// 只读解析字节流：不执行钩子、脚本或转储正文；逐条产出记录，
// 截断的头、内容和差分窗口都不会被当成完整记录交出去。
export class DumpSyntaxError extends Error {
  constructor(message, offset) {
    super(offset === undefined ? message : `${message}（字节 ${offset}）`);
    this.name = 'DumpSyntaxError';
  }
}

const LINE = 0x0a;

// 头部块：连续的 "Key: value\n" 行，以空行结束。返回 null 表示字节还不够。
function readHeaderBlock(buffer, offset) {
  const headers = new Map();
  let pos = 0;
  for (;;) {
    const end = buffer.indexOf(LINE, pos);
    if (end === -1) return null;
    if (end === pos) return { headers, consumed: pos + 1 };
    const line = buffer.toString('utf8', pos, end);
    const match = /^([A-Za-z][A-Za-z0-9-]*): (.*)$/.exec(line);
    if (!match) throw new DumpSyntaxError(`头部行格式无效: ${JSON.stringify(line)}`, offset + pos);
    if (headers.has(match[1])) throw new DumpSyntaxError(`头部重复: ${match[1]}`, offset + pos);
    headers.set(match[1], match[2]);
    pos = end + 1;
  }
}

function headerInt(headers, name, offset) {
  const raw = headers.get(name);
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new DumpSyntaxError(`头部 ${name} 不是非负整数: ${raw}`, offset);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new DumpSyntaxError(`头部 ${name} 超出安全整数: ${raw}`, offset);
  return value;
}

function headerFlag(headers, name, offset) {
  const raw = headers.get(name);
  if (raw === undefined) return false;
  if (raw !== 'true' && raw !== 'false') throw new DumpSyntaxError(`头部 ${name} 应为 true 或 false: ${raw}`, offset);
  return raw === 'true';
}

function headerHex(headers, name, length, offset) {
  const raw = headers.get(name);
  if (raw === undefined) return null;
  if (!new RegExp(`^[0-9a-f]{${length}}$`, 'i').test(raw)) throw new DumpSyntaxError(`头部 ${name} 不是有效摘要: ${raw}`, offset);
  return raw.toLowerCase();
}

function recordKind(headers, offset) {
  if (headers.has('SVN-fs-dump-format-version')) return 'format';
  if (headers.has('UUID')) return 'uuid';
  if (headers.has('Revision-number')) return 'revision';
  if (headers.has('Node-path')) return 'node';
  throw new DumpSyntaxError(`无法识别的记录头部: ${[...headers.keys()].join(', ')}`, offset);
}

// 属性块：K/V 设置、D 删除，长度定界，PROPS-END 结束。
// 空字符串是存在但值为空（V 0），D 是删除，两者语义不同，分别保留。
export function parsePropBlock(buffer, offset = 0) {
  const entries = [];
  let pos = 0;
  const fail = message => { throw new DumpSyntaxError(`属性块无效：${message}`, offset + pos); };
  for (;;) {
    if (pos >= buffer.length) fail('缺少 PROPS-END');
    const end = buffer.indexOf(LINE, pos);
    if (end === -1) fail('条目行截断');
    const tag = buffer.toString('utf8', pos, end);
    pos = end + 1;
    if (tag === 'PROPS-END') {
      if (pos !== buffer.length) fail('PROPS-END 之后有多余字节');
      return entries;
    }
    const setting = /^K ([0-9]+)$/.exec(tag);
    const deletion = /^D ([0-9]+)$/.exec(tag);
    if (!setting && !deletion) fail(`未知条目 ${JSON.stringify(tag)}`);
    const nameLength = Number((setting || deletion)[1]);
    if (nameLength > buffer.length - pos) fail('属性名截断');
    const name = buffer.toString('utf8', pos, pos + nameLength);
    pos += nameLength;
    if (buffer[pos] !== LINE) fail('属性名后缺少换行');
    pos += 1;
    if (deletion) {
      entries.push({ op: 'delete', name });
      continue;
    }
    const valueEnd = buffer.indexOf(LINE, pos);
    if (valueEnd === -1) fail('属性值长度行截断');
    const valueTag = buffer.toString('utf8', pos, valueEnd);
    const valueMatch = /^V ([0-9]+)$/.exec(valueTag);
    if (!valueMatch) fail(`K 条目后应为 V 行，实为 ${JSON.stringify(valueTag)}`);
    pos = valueEnd + 1;
    const valueLength = Number(valueMatch[1]);
    if (valueLength > buffer.length - pos) fail('属性值截断');
    const value = Buffer.from(buffer.subarray(pos, pos + valueLength));
    pos += valueLength;
    if (buffer[pos] !== LINE) fail('属性值后缺少换行');
    pos += 1;
    entries.push({ op: 'set', name, value });
  }
}

// Content-length 与 Prop/Text-content-length 的一致性核对。
function readLengths(headers, offset) {
  const content = headerInt(headers, 'Content-length', offset);
  const props = headerInt(headers, 'Prop-content-length', offset);
  const text = headerInt(headers, 'Text-content-length', offset);
  if (props === undefined && text === undefined) {
    if (content !== undefined && content !== 0) throw new DumpSyntaxError('声明了 Content-length 但缺少属性/正文长度', offset);
    return { content: content === undefined ? null : 0, props: null, text: null };
  }
  if (content === undefined) throw new DumpSyntaxError('缺少 Content-length', offset);
  if (content !== (props ?? 0) + (text ?? 0)) throw new DumpSyntaxError('Content-length 与属性/正文长度之和不符', offset);
  return { content, props: props ?? null, text: text ?? null };
}

export class DumpParser {
  constructor(onRecord) {
    this.onRecord = onRecord;
    this.buffer = Buffer.alloc(0);
    this.offset = 0;          // 已消费的总字节数（流内绝对位置）
    this.state = 'headers';   // headers | content | separator
    this.headers = null;
    this.lengths = null;
    this.content = null;
    this.recordOffset = 0;
    this.recordCount = 0;
  }

  // 是否正好停在记录边界上（封口导出据此确认末尾修订完整）。
  get atBoundary() {
    return this.state === 'headers' && this.buffer.length === 0;
  }

  feed(chunk) {
    if (chunk.length) this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    this.drain();
  }

  advance(count) {
    this.buffer = this.buffer.subarray(count);
    this.offset += count;
  }

  drain() {
    for (;;) {
      if (this.state === 'headers') {
        const block = readHeaderBlock(this.buffer, this.offset);
        if (!block) return;
        this.recordOffset = this.offset;
        this.advance(block.consumed);
        this.headers = block.headers;
        this.content = null;
        const kind = recordKind(this.headers, this.recordOffset);
        if (kind === 'format' || kind === 'uuid') {
          if (this.headers.has('Content-length')) throw new DumpSyntaxError('格式与 UUID 记录不应携带正文', this.recordOffset);
          this.emit(kind);
        } else {
          this.lengths = readLengths(this.headers, this.recordOffset);
          if (this.lengths.content === null) this.state = 'separator';
          else if (this.lengths.content === 0) { this.content = Buffer.alloc(0); this.state = 'separator'; }
          else this.state = 'content';
        }
      } else if (this.state === 'content') {
        if (this.buffer.length < this.lengths.content) return;
        this.content = Buffer.from(this.buffer.subarray(0, this.lengths.content));
        this.advance(this.lengths.content);
        this.state = 'separator';
      } else {
        if (this.buffer.length < 1) return;
        if (this.buffer[0] !== LINE) throw new DumpSyntaxError('记录正文后应为分隔空行', this.offset);
        this.advance(1);
        this.emit(recordKind(this.headers, this.recordOffset));
        this.state = 'headers';
        this.headers = null;
        this.lengths = null;
        this.content = null;
      }
    }
  }

  emit(kind) {
    const index = this.recordCount;
    this.recordCount += 1;
    if (index === 0 && kind !== 'format') throw new DumpSyntaxError('转储流应以格式版本记录开始', this.recordOffset);
    if (index === 1 && kind !== 'uuid') throw new DumpSyntaxError('格式版本记录后应为 UUID 记录', this.recordOffset);
    if (index >= 2 && (kind === 'format' || kind === 'uuid')) throw new DumpSyntaxError('格式与 UUID 记录只能出现在流开头', this.recordOffset);
    this.onRecord(this.buildRecord(kind));
    if (this.state === 'headers') {
      this.headers = null;
      this.lengths = null;
      this.content = null;
    }
  }

  buildRecord(kind) {
    const { headers, recordOffset: offset, content } = this;
    if (kind === 'format') {
      const raw = headers.get('SVN-fs-dump-format-version');
      if (raw !== '2') throw new DumpSyntaxError(`不支持的转储格式版本 ${raw}，仅接收 2`, offset);
      return { type: 'format', version: 2 };
    }
    if (kind === 'uuid') {
      const uuid = headers.get('UUID');
      if (!uuid) throw new DumpSyntaxError('UUID 记录为空', offset);
      return { type: 'uuid', uuid };
    }
    if (kind === 'revision') {
      const number = headerInt(headers, 'Revision-number', offset);
      if (this.lengths.props === null || this.lengths.text !== null || content === null) {
        throw new DumpSyntaxError('修订记录应只携带属性块', offset);
      }
      return { type: 'revision', number, props: parsePropBlock(content, offset) };
    }
    const path = headers.get('Node-path');
    const action = headers.get('Node-action');
    if (!['add', 'change', 'delete', 'replace'].includes(action)) throw new DumpSyntaxError(`未知的节点动作 ${action}`, offset);
    const nodeKind = headers.get('Node-kind');
    if (nodeKind !== undefined && nodeKind !== 'file' && nodeKind !== 'dir') throw new DumpSyntaxError(`未知的节点类型 ${nodeKind}`, offset);
    const copyfromRev = headerInt(headers, 'Node-copyfrom-rev', offset);
    const copyfromPath = headers.get('Node-copyfrom-path') ?? null;
    if ((copyfromRev === undefined) !== (copyfromPath === null)) throw new DumpSyntaxError('复制来源修订与路径必须同时出现', offset);
    const textDelta = headerFlag(headers, 'Text-delta', offset);
    const propDelta = headerFlag(headers, 'Prop-delta', offset);
    const deltaBaseMd5 = headerHex(headers, 'Text-delta-base-md5', 32, offset);
    const deltaBaseSha1 = headerHex(headers, 'Text-delta-base-sha1', 40, offset);
    const contentMd5 = headerHex(headers, 'Text-content-md5', 32, offset);
    const contentSha1 = headerHex(headers, 'Text-content-sha1', 40, offset);
    let props = null;
    let text = null;
    if (this.lengths.props !== null) props = parsePropBlock(content.subarray(0, this.lengths.props), offset);
    if (this.lengths.text !== null) text = Buffer.from(content.subarray(this.lengths.props ?? 0));
    if (textDelta && text === null) throw new DumpSyntaxError('声明了 Text-delta 但没有正文', offset);
    if (propDelta && props === null) throw new DumpSyntaxError('声明了 Prop-delta 但没有属性块', offset);
    if ((deltaBaseMd5 || deltaBaseSha1) && !textDelta) throw new DumpSyntaxError('差分基底校验和只应出现在差分正文上', offset);
    return {
      type: 'node', path, action, kind: nodeKind ?? null,
      copyfromRev: copyfromRev ?? null, copyfromPath,
      textDelta, propDelta, props, text,
      deltaBaseMd5, deltaBaseSha1, contentMd5, contentSha1,
    };
  }
}
