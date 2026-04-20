const https = require('https');
const http  = require('http');

const API_KEY    = process.env.ANTHROPIC_API_KEY;
const APP_SECRET = process.env.APP_SECRET || 'sav-secret-2024';
const PORT       = process.env.PORT || 3000;

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Secret');
}

const server = http.createServer(function(req, res) {
  corsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({status: 'ok', version: '1.0'}));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/analyze') {
    res.writeHead(404); res.end('Not found'); return;
  }

  // Vérifier le secret
  if (req.headers['x-app-secret'] !== APP_SECRET) {
    res.writeHead(401, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({error: 'Unauthorized'})); return;
  }

  // Lire le body
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); }
    catch(e) {
      res.writeHead(400, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'Invalid JSON'})); return;
    }

    // Appeler l'API Anthropic
    const data = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: payload.max_tokens || 2000,
      system: payload.system || undefined,
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

    const apiReq = https.request(options, apiRes => {
      let response = '';
      apiRes.on('data', chunk => { response += chunk; });
      apiRes.on('end', () => {
        res.writeHead(apiRes.statusCode, {'Content-Type': 'application/json'});
        res.end(response);
      });
    });

    apiReq.on('error', err => {
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: err.message}));
    });

    apiReq.write(data);
    apiReq.end();
  });
});

server.listen(PORT, () => {
  console.log('SAV Server running on port ' + PORT);
});
