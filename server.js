const https  = require('https');
const http   = require('http');
const { Pool } = require('pg');

const API_KEY    = process.env.ANTHROPIC_API_KEY;
const APP_SECRET = process.env.APP_SECRET || 'sav-flaudis-2024';
const PORT       = process.env.PORT || 3000;
const GITHUB_NOTICES = 'https://raw.githubusercontent.com/Drsly78/sav-notices/main/notices/';

// PostgreSQL
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;

async function initDB() {
  if (!pool) { console.log('Pas de DATABASE_URL — mode sans DB'); return; }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dossiers (
        id SERIAL PRIMARY KEY,
        numero_dossier VARCHAR(100) UNIQUE,
        enseigne VARCHAR(100),
        departement_ville VARCHAR(100),
        ref_produit VARCHAR(100),
        piece VARCHAR(100),
        decision VARCHAR(50),
        date_reception VARCHAR(20),
        date_traitement TIMESTAMP DEFAULT NOW(),
        notes TEXT
      )
    `);
    console.log('Table dossiers OK');
  } catch(e) { console.error('DB init error:', e.message); }
}

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
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

async function pdfToImages(pdfBuffer) {
  try {
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    const { createCanvas } = require('canvas');
    const data = new Uint8Array(pdfBuffer);
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const images = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = createCanvas(viewport.width, viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      images.push(canvas.toBuffer('image/jpeg', { quality: 0.85 }).toString('base64'));
    }
    return images;
  } catch(e) { console.error('pdfToImages error:', e.message); return []; }
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
    res.end(JSON.stringify({ status: 'ok', version: '3.0', db: !!pool }));
    return;
  }

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
      // SAUVEGARDER UN DOSSIER
      if (req.url === '/save-dossier') {
        if (!pool) { res.writeHead(200); res.end(JSON.stringify({ ok: true, msg: 'no db' })); return; }
        const d = payload;
        await pool.query(`
          INSERT INTO dossiers (numero_dossier, enseigne, departement_ville, ref_produit, piece, decision, date_reception)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (numero_dossier) DO UPDATE SET
            enseigne=$2, departement_ville=$3, ref_produit=$4, piece=$5,
            decision=$6, date_reception=$7, date_traitement=NOW()
        `, [d.numero_dossier||null, d.enseigne||null, d.departement_ville||null,
            d.ref_produit||null, d.piece||null, d.decision||null, d.date_reception||null]);
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
        return;
      }

      // VERIFIER UN DOSSIER
      if (req.url === '/check-dossier') {
        if (!pool) { res.writeHead(200); res.end(JSON.stringify({ found: false })); return; }
        const { numero_dossier } = payload;
        if (!numero_dossier) { res.writeHead(200); res.end(JSON.stringify({ found: false })); return; }
        const result = await pool.query('SELECT * FROM dossiers WHERE numero_dossier=$1', [numero_dossier]);
        if (result.rows.length > 0) {
          res.writeHead(200); res.end(JSON.stringify({ found: true, dossier: result.rows[0] }));
        } else {
          res.writeHead(200); res.end(JSON.stringify({ found: false }));
        }
        return;
      }

      // ANALYSE AVEC NOTICE
      if (req.url === '/analyze-with-notice' && payload.ref_produit) {
        const ref = payload.ref_produit.trim();
        console.log('Cherche notice:', GITHUB_NOTICES + ref + '.pdf');
        const pdfBuffer = await downloadBuffer(GITHUB_NOTICES + ref + '.pdf');
        if (pdfBuffer) {
          const images = await pdfToImages(pdfBuffer);
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
              ? lastMsg.content : [{ type: 'text', text: lastMsg.content }];
            lastMsg.content = [...noticeContent, ...orig];
          }
        }
      }

      // ANALYSE STANDARD
      const data = await callAnthropic(payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));

    } catch(err) {
      console.error('Error:', err.message);
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
  });
});

initDB().then(() => {
  server.listen(PORT, () => console.log('SAV Server v3.0 on port ' + PORT));
});
