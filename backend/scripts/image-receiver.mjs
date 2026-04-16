// Tiny one-shot HTTP server that accepts a POST with an image body and saves it to disk.
// Usage: node image-receiver.mjs <output-path>
import http from 'http';
import fs   from 'fs';
import path from 'path';

const outPath = process.argv[2] ?? path.resolve('received-image.jpg');
const PORT    = 7788;

const server = http.createServer((req, res) => {
  // CORS so the browser page can POST from any origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/save') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      fs.writeFileSync(outPath, body);
      console.log(`Saved ${body.length} bytes → ${outPath}`);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('saved');
      server.close();
    });
    return;
  }

  // Serve a minimal HTML page that fetches the image and POSTs it back
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html>
<html><body>
<script>
(async () => {
  try {
    const resp = await fetch(window.location.search.slice(1), { credentials: 'include' });
    const blob = await resp.blob();
    const post = await fetch('http://localhost:${PORT}/save', { method: 'POST', body: blob });
    const txt  = await post.text();
    document.body.textContent = 'Done: ' + txt;
  } catch(e) {
    document.body.textContent = 'Error: ' + e.message;
  }
})();
</script>
<p>Fetching image…</p>
</body></html>`);
});

server.listen(PORT, () => console.log(`Receiver ready on http://localhost:${PORT}  → ${outPath}`));
