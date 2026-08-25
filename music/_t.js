const B = 'http://127.0.0.1:3200';
(async () => {
  await fetch(B + '/api/queue', { method: 'DELETE' });
  await fetch(B + '/api/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ songs: [{ id: 509781655, name: '想你就写信', artists: '周杰伦', album: 'x', duration: 239, cover: 'http://p4.music.126.net/yD9vbpuILH-tqNRIaP640g==/109951163038292176.jpg' }] }) });
  await fetch(B + '/api/player/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  const r = await fetch(B + '/api/stream');
  console.log('stream status', r.status, 'type', r.headers.get('content-type'));
  const reader = r.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < 32768) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); total += value.length;
  }
  reader.cancel();
  const buf = Buffer.concat(chunks);
  console.log('streamed bytes (first 32KB):', buf.length, 'firstByte', buf[0].toString(16));
  await fetch(B + '/api/queue', { method: 'DELETE' });
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
