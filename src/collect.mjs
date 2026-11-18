// 只读转储接入:从来源目录领取导出字节,按确认边界提交修订并交接归档。
// 续领时用 Range 说明已有材料的字节边界、用 If-Match 锁定导出实例;
// 导出实例更换(412 或目录 etag 变化)时不拼接两次导出的尾部,只能重新领取。

import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request, decodeJson } from './transport.mjs';
import { DumpParser } from './dump.mjs';
import { HistoryBuilder } from './history.mjs';
import { digest } from './archive.mjs';

const boundaryOf = cursor => ({
  repositoryUuid: cursor.uuid,
  exportId: cursor.exportId,
  etag: cursor.etag,
  generation: cursor.generation,
  received: cursor.received, // 已取得的字节(含尚未确认的修订尾部)
  committedOffset: cursor.committedOffset, // 已交接的字节边界,只覆盖完整修订
  committedRevisions: [...cursor.committedRevisions],
  pendingRevision: cursor.pendingRevision, // 已见到记录但尚未确认完整的修订
  sealed: cursor.sealed,
  failed: cursor.failed,
});

const exportOf = entry => ({
  id: entry.id,
  generation: entry.generation,
  size: entry.size,
  sha256: entry.sha256,
  etag: entry.etag,
  sealed: entry.sealed,
});

export class DumpCollector {
  constructor({ archive, directory }) {
    this.archive = archive;
    this.directory = directory ?? join(archive.directory, 'dump');
  }

  #cursorPath(source, exportId) {
    return join(this.directory, `${digest(Buffer.from(JSON.stringify([source, exportId])))}.json`);
  }

  async #load(source, exportId) {
    try {
      const cursor = JSON.parse(await readFile(this.#cursorPath(source, exportId), 'utf8'));
      return cursor && cursor.version === 1 ? cursor : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async #save(cursor) {
    await mkdir(this.directory, { recursive: true });
    await this.archive.atomic(this.#cursorPath(cursor.source, cursor.exportId), Buffer.from(JSON.stringify(cursor)));
  }

  async #cursors() {
    let names;
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const cursors = [];
    for (const name of names.filter(entry => entry.endsWith('.json')).sort()) {
      const cursor = JSON.parse(await readFile(join(this.directory, name), 'utf8'));
      if (cursor && cursor.version === 1) cursors.push(cursor);
    }
    return cursors;
  }

  async status() {
    const cursors = await this.#cursors();
    return { cursors: cursors.map(cursor => ({ source: cursor.source, ...boundaryOf(cursor) })) };
  }

  async builderWithRevision(revision) {
    for (const cursor of await this.#cursors()) {
      if (!cursor.history) continue;
      const builder = HistoryBuilder.fromJSON(cursor.history);
      if (builder.states.has(revision)) return builder;
    }
    return null;
  }

  async collect({ source, reset = false } = {}) {
    if (!source || typeof source !== 'string') throw new Error('缺少来源地址');
    const base = source.endsWith('/') ? source : `${source}/`;
    const catalog = decodeJson(await request(new URL('/exports', base)));
    const entry = catalog.exports?.[0];
    if (!entry || !entry.href) throw new Error('来源目录没有可用的导出实例');
    const uuid = catalog.repositoryUuid;
    if (!uuid) throw new Error('来源目录缺少 repositoryUuid');
    let cursor = await this.#load(source, entry.id);
    if (cursor && cursor.uuid !== uuid) cursor = null; // 仓库身份改变,旧游标不适用
    if (cursor?.failed && !reset) {
      return { status: 'error', error: cursor.failed, boundary: boundaryOf(cursor), export: exportOf(entry) };
    }
    if (cursor && (cursor.etag !== entry.etag || cursor.generation !== entry.generation)) {
      const untouched = cursor.received === 0 && cursor.committedRevisions.length === 0;
      if (reset || untouched) {
        cursor = null;
      } else {
        return {
          status: 'export-changed',
          boundary: boundaryOf(cursor),
          export: exportOf(entry),
          message: '导出实例已更换,不能用字节偏移跨导出续接;确认后以 reset 从当前导出重新领取',
        };
      }
    }
    if (reset) cursor = null;
    if (!cursor) {
      cursor = {
        version: 1,
        source,
        exportId: entry.id,
        uuid,
        etag: entry.etag,
        generation: entry.generation,
        received: 0,
        committedOffset: 0,
        committedRevisions: [],
        pendingRevision: null,
        sealed: false,
        history: null,
        failed: null,
      };
    }
    if (entry.size < cursor.committedOffset) {
      return { status: 'error', error: `来源导出 ${entry.size} 字节小于已交接边界 ${cursor.committedOffset}`, boundary: boundaryOf(cursor), export: exportOf(entry) };
    }
    let handedOver = [];
    let fetched = 0;
    if (!cursor.sealed && cursor.committedOffset < entry.size) {
      const headers = { 'if-match': entry.etag };
      if (cursor.committedOffset > 0) headers.range = `bytes=${cursor.committedOffset}-${entry.size - 1}`;
      const reply = await request(new URL(entry.href, base), { headers });
      if (reply.status === 412) {
        return {
          status: 'export-changed',
          boundary: boundaryOf(cursor),
          export: exportOf(entry),
          message: '条件领取被来源拒绝(412):导出实例已更换,未拼接任何字节',
        };
      }
      if (cursor.committedOffset > 0 && reply.status !== 206) throw new Error(`续领未按区间返回(状态 ${reply.status})`);
      if (cursor.committedOffset === 0 && reply.status !== 200) throw new Error(`来源返回状态 ${reply.status}`);
      const expected = entry.size - cursor.committedOffset;
      if (reply.bytes.length !== expected) throw new Error(`交付字节 ${reply.bytes.length} 与目录声明的 ${expected} 不符`);
      fetched = reply.bytes.length;
      cursor.received = entry.size;
      try {
        handedOver = await this.#ingest(cursor, entry, uuid, reply.bytes);
      } catch (error) {
        // 校验或解析失败:已交接的修订保持有效,失败原因随游标锁定,待人工处置
        cursor.failed = error.message;
        await this.#save(cursor);
        return { status: 'error', error: error.message, boundary: boundaryOf(cursor), export: exportOf(entry) };
      }
    }
    await this.#save(cursor);
    const status = cursor.sealed ? 'sealed' : cursor.pendingRevision !== null ? 'pending-revision' : 'awaiting-more';
    return { status, boundary: boundaryOf(cursor), export: exportOf(entry), handedOver, fetched };
  }

  async #ingest(cursor, entry, uuid, bytes) {
    const builder = cursor.history ? HistoryBuilder.fromJSON(cursor.history) : new HistoryBuilder();
    const base = cursor.committedOffset;
    const parser = new DumpParser({ resumed: base > 0, offset: base, lastRevision: builder.lastRevision });
    const handedOver = [];
    let pendingOffset = null;
    const commitPending = async endOffset => {
      const committed = builder.commit();
      if (!committed) return;
      const raw = bytes.subarray(pendingOffset - base, endOffset - base); // 该修订的原始交付字节
      for (const change of committed.changes) {
        if (change.textBytes) {
          change.text.sha256 = await this.archive.put(change.textBytes);
          delete change.textBytes;
        }
      }
      const identity = { repositoryUuid: uuid, revision: String(committed.revision) };
      const receipt = await this.archive.accept('dump-revision', identity, committed, raw);
      cursor.committedRevisions.push(committed.revision);
      cursor.committedOffset = endOffset;
      cursor.pendingRevision = null;
      cursor.history = builder.toJSON();
      await this.#save(cursor);
      handedOver.push({ revision: committed.revision, receipt: receipt.receipt, version: receipt.version, duplicate: receipt.duplicate });
    };
    for (const record of parser.push(bytes)) {
      if (record.type === 'format') continue;
      if (record.type === 'uuid') {
        if (record.uuid !== uuid) throw new Error(`转储 UUID ${record.uuid} 与目录 ${uuid} 不符`);
        continue;
      }
      if (record.type === 'revision') {
        // 下一条修订记录到达,上一修订才构成可确认边界
        if (builder.pending) await commitPending(record.offset);
        builder.beginRevision(record.number, record.props);
        cursor.pendingRevision = record.number;
        pendingOffset = record.offset;
        continue;
      }
      builder.applyNode(record); // 基底/结果校验失败在此抛出,该修订不会提交
    }
    if (entry.sealed && base + bytes.length === entry.size) {
      parser.finish(); // 封口导出的完整字节终点构成最后修订的边界
      if (builder.pending) await commitPending(entry.size);
      cursor.sealed = true;
    }
    cursor.history = builder.toJSON();
    await this.#save(cursor);
    return handedOver;
  }
}
