import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Archive } from './archive.mjs';
import { receiveManual } from './intake.mjs';
import { DumpCollector } from './collect.mjs';

export async function createIntake(directory, options = {}) {
  const archive = await new Archive(directory).initialize();
  const collector = new DumpCollector({ archive });
  const defaultSource = options.source || process.env.SOURCE_URL || 'http://127.0.0.1:4200';
  return createServer(async (incoming, outgoing) => {
    const reply = (status, body) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); outgoing.end(JSON.stringify(body)); };
    try {
      const url = new URL(incoming.url, 'http://localhost');
      const path = url.pathname;
      if (incoming.method === 'GET' && path === '/health') return reply(200, { status: 'ok', acquisition: 'manual+dump' });
      if (incoming.method === 'GET' && path === '/api/records') return reply(200, await archive.list());
      if (incoming.method === 'GET' && path === '/api/collect') return reply(200, await collector.status());
      if (incoming.method === 'POST' && path === '/api/collect') {
        const chunks = []; let length = 0;
        for await (const chunk of incoming) { length += chunk.length; if (length > 65536) return reply(413, { error: '领取请求过大' }); chunks.push(chunk); }
        let body = {};
        if (chunks.length) {
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { return reply(400, { error: 'JSON 无效' }); }
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(422, { error: '领取请求应是对象' });
        const source = typeof body.source === 'string' && body.source ? body.source : defaultSource;
        try { new URL(source); } catch { return reply(422, { error: '来源地址无效' }); }
        try {
          return reply(200, await collector.collect({ source, reset: body.reset === true }));
        } catch (error) {
          return reply(502, { error: `来源领取失败: ${error.message}` });
        }
      }
      if (incoming.method === 'GET' && path === '/api/dump/revisions') {
        const receipts = (await archive.list()).filter(record => record.source === 'dump-revision');
        return reply(200, receipts.map(record => ({
          repositoryUuid: record.identity.repositoryUuid,
          revision: Number(record.identity.revision),
          versions: record.versions.length,
          receivedAt: record.versions[record.versions.length - 1].receivedAt,
        })));
      }
      const revisionMatch = incoming.method === 'GET' && /^\/api\/dump\/revisions\/(\d+)$/.exec(path);
      if (revisionMatch) {
        const wanted = Number(revisionMatch[1]);
        const repository = url.searchParams.get('repository');
        const found = (await archive.list()).find(record => record.source === 'dump-revision'
          && Number(record.identity.revision) === wanted
          && (!repository || record.identity.repositoryUuid === repository));
        if (!found) return reply(404, { error: '修订不存在或尚未交接' });
        return reply(200, found);
      }
      if (incoming.method === 'GET' && path === '/api/dump/state') {
        const revision = Number(url.searchParams.get('revision'));
        if (!Number.isInteger(revision) || revision < 0) return reply(422, { error: 'revision 参数无效' });
        const builder = await collector.builderWithRevision(revision);
        const tree = builder ? builder.treeAt(revision) : null;
        if (!tree) return reply(404, { error: '修订不存在或尚未交接' });
        return reply(200, { revision, nodes: tree });
      }
      const blobMatch = incoming.method === 'GET' && /^\/api\/blobs\/([0-9a-f]{64})$/.exec(path);
      if (blobMatch) {
        try {
          const bytes = await archive.bytes(blobMatch[1]);
          outgoing.writeHead(200, { 'content-type': 'application/octet-stream' });
          return outgoing.end(bytes);
        } catch {
          return reply(404, { error: '摘要不存在' });
        }
      }
      if (incoming.method === 'POST' && path === '/api/manual') {
        const chunks = []; let length = 0;
        for await (const chunk of incoming) { length += chunk.length; if (length > 1048576) return reply(413, { error: '单份人工收件过大' }); chunks.push(chunk); }
        let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { error: 'JSON 无效' }); }
        try { return reply(201, await receiveManual(archive, payload)); } catch (error) { return reply(422, { error: error.message }); }
      }
      return reply(404, { error: '路径不存在' });
    } catch (error) { return reply(500, { error: error.message }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await createIntake(process.env.ARCHIVE_DIR || '.local/archive');
  service.listen(Number(process.env.PORT || 3200), '0.0.0.0', () => console.log('收件服务已就绪'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close(() => process.exit(0)));
}
