export const initialState = () => ({ name: '只读成交回报', revision: 1 });

const soh = '\x01';
function message(sequence, fields) {
  const body = `35=${fields.type || 'AE'}${soh}34=${sequence}${soh}49=PARTNER${soh}56=MUSEUM${soh}52=20261101-00:00:00${soh}${fields.extra || ''}`;
  const raw = `8=FIX.4.4${soh}9=${Buffer.byteLength(body)}${soh}${body}`;
  const checksum = [...Buffer.from(raw)].reduce((sum, value) => sum + value, 0) % 256;
  return `${raw}10=${String(checksum).padStart(3, '0')}${soh}`;
}
export async function handle({ url, body, state, json }) {
  const original = message(1, { extra: `571=r1${soh}17=e1${soh}487=0${soh}32=5${soh}` });
  const correction = message(4, { extra: `571=r2${soh}17=e2${soh}487=2${soh}572=r1${soh}32=4${soh}` });
  if (url.pathname === '/session/poll') {
    const messages = state.gap ? [original, correction] : [original, message(2, { type: '4', extra: `123=Y${soh}36=4${soh}` }), correction];
    if (state.corrupt) messages[0] = messages[0].slice(0, -5) + '999' + soh;
    json(200, { sessionDay: state.day || '2026-11-01', resetSeqNum: !!state.reset, messages }); return true;
  }
  if (url.pathname === '/session/resend') { json(200, { from: body?.from, to: body?.to, messages: [message(1, { extra: `43=Y${soh}122=20261101-00:00:00${soh}571=r1${soh}17=e1${soh}487=0${soh}32=5${soh}` })] }); return true; }
  return false;
}
