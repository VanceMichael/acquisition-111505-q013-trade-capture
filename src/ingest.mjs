import { DumpParser, DumpSyntaxError } from './dump.mjs';
import { Repository } from './repository.mjs';

// 把解析出的记录驱动进仓库：修订在遇到下一修订头或封口干净结束时交接；
// 分段停在修订中间时，该修订保持待决，不提前变成可用版本。
export class Ingestor {
  constructor({ onCommit } = {}) {
    this.repository = new Repository();
    this.uuid = null;
    this.formatVersion = null;
    this.onCommit = onCommit ?? (() => {});
    this.lastCommitOffset = 0;
    this.parser = new DumpParser(record => this.record(record));
  }

  record(record) {
    if (record.type === 'format') {
      this.formatVersion = record.version;
    } else if (record.type === 'uuid') {
      this.uuid = record.uuid;
    } else if (record.type === 'revision') {
      const committed = this.repository.commitPending();
      if (committed !== null) {
        this.lastCommitOffset = this.parser.offset;
        this.onCommit(committed);
      }
      this.repository.beginRevision(record.number, record.props);
    } else {
      this.repository.applyNode(record);
    }
  }

  feed(bytes) {
    this.parser.feed(bytes);
  }

  get pendingRevision() {
    return this.repository.pendingRevision;
  }

  get atBoundary() {
    return this.parser.atBoundary;
  }

  get consumed() {
    return this.parser.offset;
  }

  // 封口导出结束时调用：只有停在干净记录边界才交接末尾修订。
  seal() {
    if (!this.parser.atBoundary) throw new DumpSyntaxError('导出在修订记录中间结束，末尾修订不予交接');
    const committed = this.repository.commitPending();
    if (committed !== null) {
      this.lastCommitOffset = this.parser.offset;
      this.onCommit(committed);
    }
  }
}
