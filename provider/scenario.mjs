import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const initialState = () => ({ name: '协作脚本版本历史交付', generation: 1, mode: 'complete' });
const names = { complete: 'history.dump', truncated: 'truncated.dump', 'bad-checksum': 'bad-checksum.dump' };

export async function handle({ incoming, url, state, json, bytes }) {
  const filename = names[state.mode] || names.complete;
  const body = await readFile(new URL(`../fixtures/${filename}`, import.meta.url));
  const sha256 = createHash('sha256').update(body).digest('hex');
  const etag = `"${state.generation}-${sha256}"`;
  if (url.pathname === '/exports') {
    json(200, { repositoryUuid: '7c59fa47-22c3-4ed7-ae11-001122334455', exports: [{ id: 'handover', generation: state.generation, href: '/exports/handover', sha256, size: body.length, etag, sealed: state.mode !== 'truncated' }] });
    return true;
  }
  if (url.pathname !== '/exports/handover') return false;
  if (incoming.headers['if-match'] && incoming.headers['if-match'] !== etag) {
    json(412, { error: '导出实例已更换' });
    return true;
  }
  const headers = { etag, 'accept-ranges': 'bytes' };
  if (!incoming.headers.range) {
    bytes(200, body, 'application/vnd.svn.dump', headers);
    return true;
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(incoming.headers.range);
  const start = match ? Number(match[1]) : -1;
  const end = match ? Number(match[2]) : -1;
  if (start < 0 || end < start || end >= body.length) {
    bytes(416, Buffer.alloc(0), 'application/vnd.svn.dump', { ...headers, 'content-range': `bytes */${body.length}` });
    return true;
  }
  bytes(206, body.subarray(start, end + 1), 'application/vnd.svn.dump', { ...headers, 'content-range': `bytes ${start}-${end}/${body.length}` });
  return true;
}
