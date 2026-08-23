/**
 * Static server for the browser-driven detector harness.
 *
 * Why a server at all: the harness has to read a video's pixels through a
 * canvas, and a `file://` page cannot — the canvas is tainted the moment a
 * cross-origin (which `file://` counts as) video is drawn to it, and
 * `getImageData` then throws SecurityError. Serving both the page and the
 * footage from one origin is the whole point.
 *
 * Range requests are implemented because `<video>` seeking needs them; without
 * a 206 the element will not scrub, which is exactly what the harness does.
 *
 * Usage:  node worker/tools/serve.mjs [videoDir] [port]
 * Videos are mounted at /video/, harness files at /.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_DIR = process.argv[2] || 'C:/Users/kianz/OneDrive/Desktop/GlendaleVids';
const PORT = Number(process.argv[3] || 5199);
const OUT_DIR = path.join(HERE, 'out');

const TYPES = {
  '.html': 'text/html',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  // tesseract.js fetches its language data as a gzip and sniffs the extension;
  // serving it as octet-stream is fine, but it must NOT be given
  // Content-Encoding: gzip or the worker double-decompresses it.
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
};

fs.mkdirSync(OUT_DIR, { recursive: true });

function sendFile(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    const type = TYPES[path.extname(filePath)] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : st.size - 1;
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': st.size,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

http
  .createServer((req, res) => {
    // The harness posts PNGs and JSON results back so they can be inspected
    // from outside the browser.
    if (req.method === 'POST' && req.url === '/save') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const { name, dataUrl, json } = JSON.parse(body);
          const safe = String(name).replace(/[^A-Za-z0-9._-]/g, '_');
          if (json !== undefined) {
            fs.writeFileSync(path.join(OUT_DIR, `${safe}.json`), JSON.stringify(json, null, 2));
          } else {
            const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
            fs.writeFileSync(path.join(OUT_DIR, `${safe}.png`), Buffer.from(b64, 'base64'));
          }
          res.writeHead(200);
          res.end('ok');
        } catch (e) {
          res.writeHead(500);
          res.end(String(e));
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/videos') {
      const files = fs.readdirSync(VIDEO_DIR).filter((f) => f.endsWith('.mp4'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(files));
    }

    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url.startsWith('/video/')) {
      return sendFile(req, res, path.join(VIDEO_DIR, url.slice('/video/'.length)));
    }
    // Mounted rather than copied: these are the same worker/WASM/traineddata
    // files the app ships, and the harness must exercise the app's build of
    // them, not a stale duplicate.
    if (url.startsWith('/tesseract/')) {
      return sendFile(req, res, path.join(HERE, '../../public/tesseract', url.slice('/tesseract/'.length)));
    }
    sendFile(req, res, path.join(HERE, url === '/' ? 'probe.html' : url));
  })
  .listen(PORT, () => {
    console.log(`harness  http://localhost:${PORT}/`);
    console.log(`videos   ${VIDEO_DIR}`);
    console.log(`output   ${OUT_DIR}`);
  });
