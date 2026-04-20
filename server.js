const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const API_KEY    = process.env.ANTHROPIC_API_KEY;
const APP_SECRET = process.env.APP_SECRET || 'sav-flaudis-2024';
const PORT       = process.env.PORT || 3000;
const GITHUB_NOTICES = 'https://raw.githubusercontent.com/Drsly78/sav-notices/main/notices/';

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Secret');
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode === 404) { resolve(null); return; }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// Convertir PDF en images base64 via pdfjs-dist (pur JS, pas de dépendance système)
async function pdfToImages(pdfBuffer) {
  try {
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    const { createCanvas } = require('canvas');

    const data = new Uint8Array(pdfBuffer);
    const loadingTask = pdfjsLib.getDocument({ data });
    const pdf = await loadingTask.promise;
    const images = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      const b64 = canvas.toBuffer('image/jpeg', { quality: 0.85 }).toString('base64');
      images.push(b64);
    }
    return images;
  } catch(e) {
    console.error('pdfToImages error:', e.message);
    return [];
  }
}

function callAnthropic(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: payload.max_tokens || 2000,
      ...(payload.system ? { system: payload.system } : {}),
      messages: payload.messages
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, res => {
      let response = '';
      res.on('data', c => { response += c; });
      res.on('end', () => { try { resolve(JSON.parse(response)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const server = http.createServer(async function(req, res) {
  corsHeaders(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '2.1' }));
    return;
  }
  if (req.method !== 'POST') { res.writeHead(404); res.end('Not found'); return; }
  if (req.headers['x-app-secret'] !== APP_SECRET) {
    res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body); }
    catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

    try {
      if (req.url === '/analyze-with-notice' && payload.ref_produit) {
        const ref = payload.ref_produit.trim();
        const noticeUrl = GITHUB_NOTICES + ref + '.pdf';
        console.log('Cherche notice:', noticeUrl);
        const pdfBuffer = await downloadBuffer(noticeUrl);

        if (pdfBuffer) {
          console.log('Notice trouvée (' + pdfBuffer.length + ' bytes), conversion...');
          const images = await pdfToImages(pdfBuffer);
          console.log('Pages converties:', images.length);

          if (images.length > 0) {
            const noticeContent = [
              { type: 'text', text: 'Notice technique du produit ' + ref + ' (' + images.length + ' pages) :' }
            ];
            images.forEach((img, i) => {
              noticeContent.push({ type: 'text', text: '[Page ' + (i+1) + ']' });
              noticeContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } });
            });
            const lastMsg = payload.messages[payload.messages.length - 1];
            const orig = Array.isArray(lastMsg.content)
              ? lastMsg.content
              : [{ type: 'text', text: lastMsg.content }];
            lastMsg.content = [...noticeContent, ...orig];
          }
        } else {
          console.log('Pas de notice pour:', ref);
        }
      }

      const data = await callAnthropic(payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(err) {
      console.error('Error:', err.message);
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log('SAV Server v2.1 on port ' + PORT);
});
