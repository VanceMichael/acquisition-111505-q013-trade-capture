import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Archive } from './archive.mjs';
import { receiveManual } from './intake.mjs';
import { DumpStore } from './store.mjs';

export async function createIntake(directory, options = {}) {
  const archive = await new Archive(directory).initialize();
  const dumps = await new DumpStore(join(directory, 'dump')).open();
  const sourceUrl = options.sourceUrl ?? process.env.SOURCE_URL ?? 'http://127.0.0.1:4200';
  return createServer(async (incoming, outgoing) => {
    const reply = (status, body) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); outgoing.end(JSON.stringify(body)); };
    try {
      const url = new URL(incoming.url, 'http://intake.local');
      if (incoming.method === 'GET' && url.pathname === '/health') return reply(200, { status: 'ok', acquisition: 'manual+dump' });
      if (incoming.method === 'GET' && url.pathname === '/api/records') return reply(200, await archive.list());
      if (incoming.method === 'POST' && url.pathname === '/api/collect') {
        try {
          return reply(200, await dumps.collect(sourceUrl));
        } catch (error) {
          return reply(502, { error: error.message, boundary: error.boundary ?? dumps.status() });
        }
      }
      if (incoming.method === 'GET' && url.pathname === '/api/dump/status') return reply(200, dumps.status());
      if (incoming.method === 'GET' && url.pathname === '/api/dump/revisions') return reply(200, dumps.revisionList());
      const nodeMatch = /^\/api\/dump\/revisions\/([0-9]+)\/node$/.exec(url.pathname);
      if (incoming.method === 'GET' && nodeMatch) {
        const revision = Number(nodeMatch[1]);
        const path = url.searchParams.get('path') ?? '';
        let view = null;
        try {
          view = dumps.nodeView(revision, path);
        } catch (error) {
          return reply(400, { error: error.message });
        }
        if (!view) return reply(404, { error: `修订 ${revision} 或路径 ${path || '/'} 不在已交接材料中` });
        return reply(200, view);
      }
      if (incoming.method === 'POST' && url.pathname === '/api/manual') {
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
