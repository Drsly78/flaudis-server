const https  = require('https');
const http   = require('http');
const { execSync } = require('child_process');
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

// Télécharger un fichier depuis une URL
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 404) { resolve(null); return; }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// Convertir PDF en images base64 via pdftoppm
async function pdfToImages(pdfBuffer) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-'));
  const pdfPath = path.join(tmpDir, 'notice.pdf');
  fs.writeFileSync(pdfPath, pdfBuffer);

  try {
    execSync(`pdftoppm -jpeg -r 120 "${pdfPath}" "${path.join(tmpDir, 'page')}"`, { timeout: 30000 });
    const files = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('page') && f.endsWith('.jpg'))
      .sort();
    const images = files.map(f => {
      const data = fs.readFileSync(path.join(tmpDir, f));
      return data.toString('base64');
    });
    return images;
  } catch(e) {
    console.error('pdftoppm error:', e.message);
    return [];
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch(e) {}
  }
}

// Appeler l'API Anthropic
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
      res.on('data', chunk => { response += chunk; });
      res.on('end', () => resolve(JSON.parse(response)));
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
    res.end(JSON.stringify({ status: 'ok', version: '2.0' }));
    return;
  }

  if (req.method !== 'POST') { res.writeHead(404); res.end('Not found'); return; }

  if (req.headers['x-app-secret'] !== APP_SECRET) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' })); return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body); }
    catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

    try {
      // Si une référence produit est fournie, chercher la notice
      if (req.url === '/analyze-with-notice' && payload.ref_produit) {
        const ref = payload.ref_produit.trim();
        const noticeUrl = GITHUB_NOTICES + ref + '.pdf';
        console.log('Cherche notice:', noticeUrl);

        const pdfBuffer = await downloadFile(noticeUrl);
        if (pdfBuffer) {
          console.log('Notice trouvée, conversion en images...');
          const images = await pdfToImages(pdfBuffer);
          console.log('Pages converties:', images.length);

          if (images.length > 0) {
            // Ajouter les images de la notice au message
            const noticeContent = [
              { type: 'text', text: `Notice technique du produit ${ref} (${images.length} pages) :` }
            ];
            images.forEach((img, i) => {
              noticeContent.push({ type: 'text', text: `[Page ${i+1}]` });
              noticeContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } });
            });

            // Ajouter la notice au début du contenu
            const originalContent = payload.messages[payload.messages.length - 1].content;
            const enrichedContent = Array.isArray(originalContent)
              ? [...noticeContent, ...originalContent]
              : [...noticeContent, { type: 'text', text: originalContent }];

            payload.messages[payload.messages.length - 1].content = enrichedContent;
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
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log('SAV Server v2.0 running on port ' + PORT);
  // Vérifier pdftoppm
  try { execSync('pdftoppm -v 2>&1'); console.log('pdftoppm disponible'); }
  catch(e) { console.warn('pdftoppm non disponible — install poppler-utils'); }
});
