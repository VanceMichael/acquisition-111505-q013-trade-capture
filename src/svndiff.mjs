// svndiff0 差分窗口解码。只解析字节并重建正文,不执行转储中的任何内容。
// 格式: "SVN" + 零字节版本标记,随后一个或多个窗口。
// 窗口头为五个大端 7 位续位整数: source offset / source length / target length /
// instruction length / new-data length;之后是指令字节与新数据字节。
// 指令高 2 位选择 source/target/new 复制,低 6 位为长度,零长度则后跟续位整数;
// source 与 target 复制再跟一个续位整数偏移。target 复制可引用当前窗口已生成的部分。

export class SvndiffError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SvndiffError';
  }
}

function readVarint(bytes, position) {
  let value = 0;
  const start = position;
  for (;;) {
    if (position >= bytes.length) throw new SvndiffError('差分整数在窗口内被截断');
    const byte = bytes[position++];
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, position];
    if (position - start >= 10) throw new SvndiffError('差分整数超出长度上限');
  }
}

export function applySvndiff(base, delta) {
  if (delta.length < 4 || delta[0] !== 0x53 || delta[1] !== 0x56 || delta[2] !== 0x4e) {
    throw new SvndiffError('差分缺少 SVN 标记');
  }
  if (delta[3] !== 0x00) throw new SvndiffError(`不支持的差分版本 ${delta[3]},该节点正文已隔离`);
  let position = 4;
  const output = [];
  while (position < delta.length) {
    let sourceOffset, sourceLength, targetLength, instructionLength, newDataLength;
    [sourceOffset, position] = readVarint(delta, position);
    [sourceLength, position] = readVarint(delta, position);
    [targetLength, position] = readVarint(delta, position);
    [instructionLength, position] = readVarint(delta, position);
    [newDataLength, position] = readVarint(delta, position);
    if (sourceOffset + sourceLength > base.length) throw new SvndiffError('差分源视窗超出基底正文');
    if (position + instructionLength + newDataLength > delta.length) throw new SvndiffError('差分窗口在指令或新数据前被截断');
    const instructions = delta.subarray(position, position + instructionLength);
    const newData = delta.subarray(position + instructionLength, position + instructionLength + newDataLength);
    position += instructionLength + newDataLength;
    const source = base.subarray(sourceOffset, sourceOffset + sourceLength);
    const target = Buffer.alloc(targetLength);
    let produced = 0;
    let ip = 0;
    let np = 0;
    while (ip < instructions.length) {
      const opcode = instructions[ip++];
      const kind = opcode >> 6;
      let length = opcode & 0x3f;
      if (length === 0) [length, ip] = readVarint(instructions, ip);
      if (produced + length > targetLength) throw new SvndiffError('指令输出超出窗口目标长度');
      if (kind === 0) {
        let offset;
        [offset, ip] = readVarint(instructions, ip);
        if (offset + length > source.length) throw new SvndiffError('源复制指令超出源视窗');
        source.copy(target, produced, offset, offset + length);
      } else if (kind === 1) {
        let offset;
        [offset, ip] = readVarint(instructions, ip);
        if (length > 0 && offset >= produced) throw new SvndiffError('目标复制引用了尚未生成的位置');
        for (let index = 0; index < length; index += 1) target[produced + index] = target[offset + index]; // 逐字节复制,允许重叠自引用
      } else if (kind === 2) {
        if (np + length > newData.length) throw new SvndiffError('新数据指令超出窗口新数据');
        newData.copy(target, produced, np, np + length);
        np += length;
      } else {
        throw new SvndiffError('差分指令类型 3 无效');
      }
      produced += length;
    }
    if (produced !== targetLength) throw new SvndiffError('窗口目标长度与指令输出不符');
    if (np !== newData.length) throw new SvndiffError('窗口新数据未被指令全部消费');
    output.push(target);
  }
  return Buffer.concat(output);
}
