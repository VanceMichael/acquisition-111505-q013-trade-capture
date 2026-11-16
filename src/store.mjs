import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ingestor } from './ingest.mjs';
import { request } from './transport.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const md5 = bytes => createHash('md5').update(bytes).digest('hex');

async function atomicWrite(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

const freshState = () => ({
  repositoryUuid: null,
  export: null,
  consumedBytes: 0,
  prefixSha256: sha256(Buffer.alloc(0)),
  committedRevisions: [],
  pendingRevision: null,
  sealed: false,
  complete: false,
  lastError: null,
});

const propsView = props => Object.fromEntries([...props].map(([name, value]) => [name, value.toString('utf8')]));

// 只读转储接入的落档与领取编排。
// 已消费字节原样落档（prefix.dump），内存模型由重放重建，保证解析器是唯一事实来源；
// 续领用 If-Match 钉住导出实例，实例更换即整体重领，绝不把两次导出的尾部拼在一起。
export class DumpStore {
  constructor(directory, { requestImpl } = {}) {
    this.directory = directory;
    this.prefixPath = join(directory, 'prefix.dump');
    this.statePath = join(directory, 'state.json');
    this.request = requestImpl ?? request;
    this.tail = Promise.resolve();
    this.ingestor = new Ingestor();
    this.prefix = Buffer.alloc(0);
    this.state = freshState();
  }

  async open() {
    await mkdir(this.directory, { recursive: true });
    let state = null;
    try {
      state = JSON.parse(await readFile(this.statePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (state) {
      const prefix = await readFile(this.prefixPath);
      if (prefix.length !== state.consumedBytes) throw new Error('转储前缀长度与状态不符，存档可能受损');
      if (sha256(prefix) !== state.prefixSha256) throw new Error('转储前缀摘要与状态不符，存档可能受损');
      this.prefix = prefix;
      this.state = state;
      this.ingestor = this.replay();
      const committed = this.ingestor.repository.committed;
      if (JSON.stringify(committed) !== JSON.stringify(state.committedRevisions)) {
        throw new Error('重放转储前缀与已交接修订不符，存档可能受损');
      }
      if (this.ingestor.pendingRevision !== state.pendingRevision) throw new Error('重放待决修订与状态不符，存档可能受损');
    }
    return this;
  }

  replay() {
    const ingestor = new Ingestor();
    if (this.prefix.length) ingestor.feed(this.prefix);
    if (this.state.complete) ingestor.seal();
    if (this.state.repositoryUuid && ingestor.uuid && ingestor.uuid !== this.state.repositoryUuid) {
      throw new Error('转储流身份与状态不符，存档可能受损');
    }
    return ingestor;
  }

  async persist() {
    this.state.committedRevisions = [...this.ingestor.repository.committed];
    this.state.pendingRevision = this.ingestor.pendingRevision;
    this.state.consumedBytes = this.prefix.length;
    this.state.prefixSha256 = sha256(this.prefix);
    await atomicWrite(this.prefixPath, this.prefix);
    await atomicWrite(this.statePath, Buffer.from(JSON.stringify(this.state, null, 2)));
  }

  status() {
    return {
      repositoryUuid: this.state.repositoryUuid,
      export: this.state.export,
      consumedBytes: this.state.consumedBytes,
      committedRevisions: [...this.ingestor.repository.committed],
      pendingRevision: this.ingestor.pendingRevision,
      sealed: this.state.sealed,
      complete: this.state.complete,
      lastError: this.state.lastError,
    };
  }

  revisionList() {
    const { repository } = this.ingestor;
    return repository.committed.map(revision => ({
      revision,
      props: propsView(repository.revisionProps(revision)),
      changes: repository.changes(revision),
    }));
  }

  nodeView(revision, path) {
    const node = this.ingestor.repository.nodeAt(revision, path);
    if (!node) return null;
    const view = { revision, path, kind: node.kind, id: node.id, props: propsView(node.props) };
    if (node.kind === 'dir') {
      view.children = [...node.children].map(([name, child]) => ({ name, kind: child.kind, id: child.id }));
    } else {
      view.size = node.text.length;
      view.md5 = md5(node.text);
      view.text = node.text.toString('utf8');
    }
    return view;
  }

  async catalog(sourceBase) {
    const reply = await this.request(`${sourceBase}/exports`);
    if (reply.status !== 200) throw new Error(`来源目录返回 ${reply.status}`);
    let parsed;
    try {
      parsed = JSON.parse(reply.bytes.toString('utf8'));
    } catch {
      throw new Error('来源目录不是有效 JSON');
    }
    if (!parsed || typeof parsed.repositoryUuid !== 'string' || !Array.isArray(parsed.exports) || !parsed.exports.length) {
      throw new Error('来源目录缺少 repositoryUuid 或可用导出');
    }
    return parsed;
  }

  async reset(delivery) {
    this.ingestor = new Ingestor();
    this.prefix = Buffer.alloc(0);
    this.state = { ...freshState(), repositoryUuid: this.state.repositoryUuid, export: delivery };
    await this.persist();
  }

  async collect(sourceBase) {
    const run = this.tail.then(() => this.collectOnce(sourceBase.replace(/\/+$/, '')));
    this.tail = run.catch(() => {});
    return run;
  }

  async collectOnce(sourceBase) {
    const report = { restarted: false, fetchedBytes: 0, committedNow: [] };
    try {
      let catalog = await this.catalog(sourceBase);
      let delivery = catalog.exports[0];
      if (this.state.repositoryUuid && this.state.repositoryUuid !== catalog.repositoryUuid) {
        throw new Error(`来源身份 ${catalog.repositoryUuid} 与已接收 ${this.state.repositoryUuid} 不符，不能混淆`);
      }
      if (!this.state.repositoryUuid) this.state.repositoryUuid = catalog.repositoryUuid;
      if (this.state.export && this.state.export.etag !== delivery.etag) {
        report.restarted = true;
        report.previousExport = this.state.export;
        await this.reset(delivery);
      }
      this.state.export = delivery;
      if (this.state.consumedBytes > delivery.size) throw new Error('已消费字节超过导出声明大小，导出可能已更换');
      if (this.state.consumedBytes < delivery.size) {
        const fetched = await this.fetchMissing(sourceBase, delivery, report);
        this.ingest(fetched.bytes, fetched.delivery, report);
      } else if (delivery.sealed && !this.state.complete) {
        this.seal(delivery, report);
      }
      this.state.sealed = delivery.sealed;
      this.state.lastError = null;
      await this.persist();
      report.boundary = this.status();
      return report;
    } catch (error) {
      this.state.lastError = error.message;
      await this.persist().catch(() => {});
      error.boundary = this.status();
      throw error;
    }
  }

  async fetchMissing(sourceBase, delivery, report) {
    const headers = { 'if-match': delivery.etag };
    if (this.state.consumedBytes > 0) headers.range = `bytes=${this.state.consumedBytes}-${delivery.size - 1}`;
    let reply = await this.request(`${sourceBase}${delivery.href}`, { headers });
    if (reply.status === 412) {
      // 目录读取与正文领取之间导出实例被更换：整体重领，不拼接。
      const renewed = await this.catalog(sourceBase);
      const next = renewed.exports[0];
      if (renewed.repositoryUuid !== this.state.repositoryUuid) {
        throw new Error(`来源身份 ${renewed.repositoryUuid} 与已接收 ${this.state.repositoryUuid} 不符，不能混淆`);
      }
      report.restarted = true;
      report.previousExport = this.state.export;
      await this.reset(next);
      this.state.export = next;
      delivery = next;
      reply = await this.request(`${sourceBase}${next.href}`, { headers: { 'if-match': next.etag } });
    }
    if (reply.status === 412) throw new Error('导出实例持续更换，本次无法领取');
    if (reply.status !== 200 && reply.status !== 206) throw new Error(`来源返回 ${reply.status}，无法领取转储`);
    const bytes = reply.bytes;
    if (reply.status === 200) {
      if (this.state.consumedBytes !== 0) throw new Error('续领应返回部分内容而非全量');
      if (bytes.length !== delivery.size) throw new Error(`交付字节数 ${bytes.length} 与目录声明 ${delivery.size} 不符`);
    } else {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(reply.headers['content-range'] ?? '');
      if (!range || Number(range[1]) !== this.state.consumedBytes || Number(range[3]) !== delivery.size) {
        throw new Error(`部分内容区间与已交接边界不符: ${reply.headers['content-range'] ?? '缺失'}`);
      }
      if (bytes.length !== delivery.size - this.state.consumedBytes) throw new Error('续领字节数与目录声明不符');
    }
    return { bytes, delivery };
  }

  ingest(bytes, delivery, report) {
    const before = this.ingestor.repository.committed.length;
    const consumedPrior = this.state.consumedBytes;
    try {
      this.ingestor.feed(bytes);
      const consumed = consumedPrior + bytes.length;
      if (consumed > delivery.size) throw new Error('交付超出目录声明大小');
      if (delivery.sealed && consumed === delivery.size) this.ingestor.seal();
      if (this.ingestor.uuid && this.ingestor.uuid !== this.state.repositoryUuid) {
        throw new Error(`转储流 UUID ${this.ingestor.uuid} 与来源目录 ${this.state.repositoryUuid} 不符`);
      }
      this.prefix = Buffer.concat([this.prefix, bytes]);
      this.state.consumedBytes = this.prefix.length;
      if (delivery.sealed && consumed === delivery.size) {
        if (sha256(this.prefix) !== delivery.sha256) throw new Error('完整交付摘要与来源目录不符');
        this.state.complete = true;
      }
      report.fetchedBytes = bytes.length;
      report.committedNow = this.ingestor.repository.committed.slice(before);
    } catch (error) {
      // 回滚到最近一个已交接修订边界：坏修订的字节与待决残段都不入档。
      const keep = this.ingestor.lastCommitOffset;
      this.prefix = keep <= consumedPrior
        ? this.prefix.subarray(0, keep)
        : Buffer.concat([this.prefix, bytes.subarray(0, keep - consumedPrior)]);
      this.state.consumedBytes = this.prefix.length;
      this.state.complete = false;
      this.ingestor = this.replay();
      throw error;
    }
  }

  seal(delivery, report) {
    const before = this.ingestor.repository.committed.length;
    try {
      this.ingestor.seal();
      if (sha256(this.prefix) !== delivery.sha256) throw new Error('完整交付摘要与来源目录不符');
      this.state.complete = true;
      report.committedNow = this.ingestor.repository.committed.slice(before);
    } catch (error) {
      this.state.complete = false;
      throw error;
    }
  }
}
