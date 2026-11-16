// svndiff0 差分窗口解码。只解析字节，不执行任何脚本；
// 不支持的差分版本明确报错隔离，绝不尝试应用。
export class SvndiffError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SvndiffError';
  }
}

// 单文件重建结果上限，防止损坏的窗口声明骗取巨量内存。
const MAX_RESULT_BYTES = 256 * 1024 * 1024;

// 大端 7 位续位整数：高位为 1 表示后续还有字节。
function readVarint(buffer, state) {
  let value = 0;
  let byte;
  do {
    if (state.pos >= buffer.length) throw new SvndiffError('差分数据在续位整数处截断');
    byte = buffer[state.pos];
    state.pos += 1;
    if (value > 0x1fffffffffffff) throw new SvndiffError('差分整数超出安全范围');
    value = value * 128 + (byte & 0x7f);
  } while (byte & 0x80);
  return value;
}

// 以 base 为基底应用 delta（svndiff0），返回重建后的完整字节。
export function applySvndiff(base, delta, { maxBytes = MAX_RESULT_BYTES } = {}) {
  if (!Buffer.isBuffer(base) || !Buffer.isBuffer(delta)) throw new SvndiffError('差分输入必须是字节');
  if (delta.length < 4 || delta[0] !== 0x53 || delta[1] !== 0x56 || delta[2] !== 0x4e) {
    throw new SvndiffError('正文不是 svndiff 数据');
  }
  const version = delta[3];
  if (version !== 0) throw new SvndiffError(`不支持的差分版本 svndiff${version}，已隔离不予应用`);
  const state = { pos: 4 };
  const windows = [];
  let total = 0;
  while (state.pos < delta.length) {
    const sourceOffset = readVarint(delta, state);
    const sourceLength = readVarint(delta, state);
    const targetLength = readVarint(delta, state);
    const instructionLength = readVarint(delta, state);
    const newLength = readVarint(delta, state);
    if (sourceOffset + sourceLength > base.length) throw new SvndiffError('差分窗口引用的源区间超出基底');
    if (targetLength > maxBytes || total + targetLength > maxBytes) throw new SvndiffError('差分结果超出接收大小上限');
    if (instructionLength > delta.length - state.pos) throw new SvndiffError('差分指令区在声明长度处截断');
    const instructions = delta.subarray(state.pos, state.pos + instructionLength);
    state.pos += instructionLength;
    if (newLength > delta.length - state.pos) throw new SvndiffError('差分新数据区在声明长度处截断');
    const newData = delta.subarray(state.pos, state.pos + newLength);
    state.pos += newLength;
    const target = Buffer.alloc(targetLength);
    let produced = 0;
    let consumed = 0;
    const istate = { pos: 0 };
    while (istate.pos < instructions.length) {
      const op = instructions[istate.pos];
      istate.pos += 1;
      const kind = op >> 6;
      let length = op & 0x3f;
      if (length === 0) length = readVarint(instructions, istate);
      if (kind === 3) throw new SvndiffError('差分指令类型非法');
      if (produced + length > targetLength) throw new SvndiffError('差分指令输出超出窗口目标长度');
      if (kind === 0) {
        const offset = readVarint(instructions, istate);
        if (offset + length > sourceLength) throw new SvndiffError('源复制指令超出窗口源区间');
        base.copy(target, produced, sourceOffset + offset, sourceOffset + offset + length);
      } else if (kind === 1) {
        const offset = readVarint(instructions, istate);
        // 偏移必须落在本窗口已生成部分之内；复制逐字节进行，
        // 因而长度可以越过当前位置，引用刚写出的字节做重叠展开。
        if (offset > produced || (length > 0 && offset === produced)) {
          throw new SvndiffError('目标复制指令超出本窗口已生成内容');
        }
        for (let index = 0; index < length; index += 1) target[produced + index] = target[offset + index];
      } else {
        if (consumed + length > newData.length) throw new SvndiffError('新数据指令超出窗口新数据区');
        newData.copy(target, produced, consumed, consumed + length);
        consumed += length;
      }
      produced += length;
    }
    if (produced !== targetLength) throw new SvndiffError('差分窗口输出长度与声明不符');
    if (consumed !== newData.length) throw new SvndiffError('差分窗口未完全使用新数据区');
    windows.push(target);
    total += targetLength;
  }
  return Buffer.concat(windows, total);
}
