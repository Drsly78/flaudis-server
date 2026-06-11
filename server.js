const https  = require('https');
const http   = require('http');
const { Pool } = require('pg');

const API_KEY         = process.env.ANTHROPIC_API_KEY;
const APP_SECRET      = process.env.APP_SECRET || 'sav-flaudis-2024';
const PORT            = process.env.PORT || 3000;
const GITHUB_NOTICES  = 'https://raw.githubusercontent.com/Drsly78/flaudis-notices/main/notices/';
const FIREBASE_URL    = process.env.FIREBASE_URL || 'https://flaudis-prod-default-rtdb.europe-west1.firebasedatabase.app';
const FIREBASE_SECRET = process.env.FIREBASE_SECRET; // optionnel si règles ouvertes
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

// ── PostgreSQL ────────────────────────────────────────────
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
    // Ajout colonnes tracking et date_envoi si absentes
    await pool.query(`ALTER TABLE dossiers ADD COLUMN IF NOT EXISTS tracking VARCHAR(200)`);
    await pool.query(`ALTER TABLE dossiers ADD COLUMN IF NOT EXISTS date_envoi VARCHAR(20)`);
    // Table compteurs pour numéros d'accord
    await pool.query(`
      CREATE TABLE IF NOT EXISTS compteurs (
        cle VARCHAR(50) PRIMARY KEY,
        valeur INTEGER NOT NULL DEFAULT 0,
        mois_annee VARCHAR(10)
      )
    `);
    console.log('Table dossiers OK');
  } catch(e) { console.error('DB init error:', e.message); }
}

// ── Google Sheets Auth ────────────────────────────────────
let _sheetsToken = null;
let _sheetsTokenExpiry = 0;

async function getSheetsToken() {
  if (_sheetsToken && Date.now() < _sheetsTokenExpiry - 60000) return _sheetsToken;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT manquant');
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  })).toString('base64url');
  const { createSign } = require('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(header + '.' + claim);
  const sig = sign.sign(sa.private_key, 'base64url');
  const jwt = header + '.' + claim + '.' + sig;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const tokenData = await tokenRes.json();
  _sheetsToken = tokenData.access_token;
  _sheetsTokenExpiry = Date.now() + 3500000;
  return _sheetsToken;
}

// ── Firebase REST ─────────────────────────────────────────
async function firebaseGet(path) {
  const url = FIREBASE_URL + '/' + path + '.json' +
    (FIREBASE_SECRET ? '?auth=' + FIREBASE_SECRET : '');
  const r = await fetch(url);
  if (!r.ok) return null;
  return r.json();
}

function getKey(ref) {
  return ref.replace(/[.#$\/\[\]]/g, '_');
}

// ── Helpers ───────────────────────────────────────────────
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

// ── INDEX DES NOTICES (GitHub) avec matching flou ──────────
// Les refs du fichier EAN ne correspondent pas toujours exactement aux noms
// de fichiers (ex: ref "BLAINVILLE 3X4 A/B" → fichier "BLAINVILLE 3X4 AB.pdf",
// un "/" étant impossible dans un nom de fichier).
let noticeIndex = { files: null, ts: 0 };

function fetchGithubJSON(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'flaudis-server', 'Accept': 'application/vnd.github+json' } }, res => {
      if (res.statusCode !== 200) { resolve(null); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch(e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

// Normalisation : majuscules, suppression de .pdf et de tout caractère non alphanumérique
const normRef = s => String(s || '').toUpperCase().replace(/\.PDF$/i, '').replace(/[^A-Z0-9]/g, '');

async function findNoticeFile(ref) {
  // Index rafraîchi toutes les 10 minutes
  if (!noticeIndex.files || Date.now() - noticeIndex.ts > 10 * 60 * 1000) {
    const list = await fetchGithubJSON('https://api.github.com/repos/Drsly78/flaudis-notices/contents/notices');
    if (Array.isArray(list)) {
      noticeIndex = { files: list.filter(f => /\.pdf$/i.test(f.name)).map(f => f.name), ts: Date.now() };
      console.log('Index notices rafraîchi:', noticeIndex.files.length, 'fichiers');
    }
  }
  const files = noticeIndex.files || [];
  const rn = normRef(ref);
  if (!rn || files.length === 0) return null;

  // 1. Égalité normalisée (BLAINVILLE 3X4 A/B ↔ BLAINVILLE 3X4 AB.pdf)
  let m = files.filter(f => normRef(f) === rn);
  if (m.length) return m[0];
  // 2. Préfixe normalisé dans les deux sens — le match le plus long gagne
  m = files.filter(f => { const fn = normRef(f); return fn.startsWith(rn) || rn.startsWith(fn); });
  if (m.length) return m.sort((a, b) => normRef(b).length - normRef(a).length)[0];
  // 3. Premier mot de la ref, seulement si UN SEUL fichier correspond
  const tok = normRef(String(ref).split(/\s+/)[0]);
  if (tok.length >= 4) {
    m = files.filter(f => normRef(f).startsWith(tok));
    if (m.length === 1) return m[0];
  }
  return null;
}

async function pdfToImages(pdfBuffer, maxPages = 25) {
  try {
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    const { createCanvas } = require('canvas');
    const data = new Uint8Array(pdfBuffer);
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const images = [];
    const pages = Math.min(pdf.numPages, maxPages);
    for (let i = 1; i <= pages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2.2 }); // résolution élevée — tables de pièces lisibles
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
      model: 'claude-sonnet-4-6',
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

// ── Serveur ───────────────────────────────────────────────
const server = http.createServer(async function(req, res) {
  corsHeaders(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '4.0', db: !!pool }));
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

      // ── SAUVEGARDER UN DOSSIER ────────────────────────────
      if (req.url === '/save-dossier') {
        if (!pool) { res.writeHead(200); res.end(JSON.stringify({ ok: true, msg: 'no db' })); return; }
        const d = payload;
        await pool.query(`
          INSERT INTO dossiers (numero_dossier, enseigne, departement_ville, ref_produit, piece, decision, date_reception, tracking, date_envoi)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (numero_dossier) DO UPDATE SET
            enseigne=$2, departement_ville=$3, ref_produit=$4, piece=$5,
            decision=$6, date_reception=$7, date_traitement=NOW(),
            tracking=COALESCE(EXCLUDED.tracking, dossiers.tracking),
            date_envoi=COALESCE(EXCLUDED.date_envoi, dossiers.date_envoi)
        `, [d.numero_dossier||null, d.enseigne||null, d.departement_ville||null,
            d.ref_produit||null, d.piece||null, d.decision||null, d.date_reception||null,
            d.tracking||null, d.date_envoi||null]);
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── VERIFIER UN DOSSIER ───────────────────────────────
      if (req.url === '/check-dossier') {
        if (!pool) { res.writeHead(200); res.end(JSON.stringify({ found: false })); return; }
        const { numero_dossier } = payload;
        if (!numero_dossier) { res.writeHead(200); res.end(JSON.stringify({ found: false })); return; }
        const result = await pool.query('SELECT * FROM dossiers WHERE numero_dossier=$1', [numero_dossier]);
        res.writeHead(200);
        res.end(JSON.stringify(result.rows.length > 0
          ? { found: true, dossier: result.rows[0] }
          : { found: false }));
        return;
      }

      // ── HISTORIQUE MAGASIN (2 tableaux) ──────────────────
      if (req.url === '/get-historique-magasin') {
        if (!pool) { res.writeHead(200); res.end(JSON.stringify({ par_ref: [], complet: [] })); return; }
        const { enseigne, departement_ville, ref_produit } = payload;

        // Extraire le nom de ville seul (sans département) et normaliser
        const ville = (departement_ville||'')
          .replace(/^\d+\s*/, '').trim()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/-/g, ' ').replace(/\s+/g, ' ').trim();

        const sixMoisAvant = new Date();
        sixMoisAvant.setMonth(sixMoisAvant.getMonth() - 6);
        const dateLimit = sixMoisAvant.toISOString().slice(0, 10);

        // Tableau 1 : même magasin + même ref, 6 mois
        const resRef = await pool.query(`
          SELECT * FROM dossiers
          WHERE UPPER(departement_ville) LIKE $1
          AND UPPER(enseigne) LIKE $2
          AND UPPER(ref_produit) = $3
          AND date_reception >= $4
          ORDER BY date_reception DESC
          LIMIT 20
        `, [
          '%' + ville.toUpperCase() + '%',
          '%' + (enseigne||'').toUpperCase() + '%',
          (ref_produit||'').toUpperCase(),
          dateLimit
        ]);

        // Tableau 2 : même magasin tous produits, 6 mois
        const resComplet = await pool.query(`
          SELECT * FROM dossiers
          WHERE UPPER(departement_ville) LIKE $1
          AND UPPER(enseigne) LIKE $2
          AND date_reception >= $3
          ORDER BY date_reception DESC
          LIMIT 150
        `, [
          '%' + ville.toUpperCase() + '%',
          '%' + (enseigne||'').toUpperCase() + '%',
          dateLimit
        ]);

        // Pour chaque dossier avec CNB, tenter de récupérer tracking + date_envoi depuis Sheet
        const enrichir = async (rows) => {
          if (!GOOGLE_SHEET_ID) return rows;
          try {
            const token = await getSheetsToken();
            // Lire SYSTEME U (col H=CNB, B=date_envoi, G=tracking)
            // et REMBOURSEMENT SU (col I=CNB, A=date_recep)
            const [sheetSav, sheetRemb] = await Promise.all([
              fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent('SYSTEME U!A:H')}`, { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json()),
              fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent('REMBOURSEMENT SU!A:J')}`, { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json())
            ]);
            const cnbIndex = {};
            (sheetSav.values || []).forEach(r => {
              const cnb = (r[7]||'').trim();
              if (cnb) cnbIndex[cnb] = { date_envoi: r[1]||'', tracking: r[6]||'' };
            });
            (sheetRemb.values || []).forEach(r => {
              const cnb = (r[8]||'').trim();
              if (cnb && !cnbIndex[cnb]) cnbIndex[cnb] = { date_envoi: r[1]||'', tracking: '' };
            });
            return rows.map(r => {
              const extra = r.numero_dossier ? cnbIndex[r.numero_dossier] : null;
              if (extra) {
                // SYNC RETOUR : si le Sheet a un tracking/date_envoi absent ou différent
                // en base, on met à jour PostgreSQL (en arrière-plan, sans bloquer)
                const newTracking = extra.tracking || r.tracking || '';
                const newEnvoi = extra.date_envoi || r.date_envoi || '';
                if (pool && r.numero_dossier &&
                    ((extra.tracking && extra.tracking !== (r.tracking || '')) ||
                     (extra.date_envoi && extra.date_envoi !== (r.date_envoi || '')))) {
                  pool.query(
                    'UPDATE dossiers SET tracking = $1, date_envoi = $2 WHERE numero_dossier = $3',
                    [newTracking, newEnvoi, r.numero_dossier]
                  ).then(() => console.log('Sync tracking → DB:', r.numero_dossier, newTracking))
                   .catch(e => console.error('Sync tracking erreur:', e.message));
                }
                return {
                  ...r,
                  date_envoi: newEnvoi,
                  tracking: newTracking
                };
              }
              return r;
            });
          } catch(e) {
            console.error('Sheets enrichissement error:', e.message);
            return rows;
          }
        };

        const [par_ref, complet] = await Promise.all([
          enrichir(resRef.rows),
          enrichir(resComplet.rows)
        ]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ par_ref, complet }));
        return;
      }

      // ── INFOS PRODUIT ENTREPÔT (Firebase) ────────────────
      if (req.url === '/get-produit-info') {
        const { ref } = payload;
        if (!ref) { res.writeHead(200); res.end(JSON.stringify({ found: false })); return; }

        // Chercher d'abord la clé exacte, sinon chercher par préfixe
        let key = getKey(ref);
        let data = await firebaseGet('produits/' + key);

        if (!data) {
          // Chercher toutes les clés Firebase qui commencent par la ref
          const allProduits = await firebaseGet('produits');
          if (allProduits) {
            const refUpper = ref.toUpperCase().replace(/[.#$\/\[\]]/g, '_');
            const matchKey = Object.keys(allProduits).find(k =>
              k.toUpperCase().replace(/[.#$\/\[\]]/g, '_').startsWith(refUpper)
            );
            if (matchKey) {
              key = getKey(matchKey);
              data = allProduits[matchKey];
            }
          }
        }

        if (!data) {
          res.writeHead(200); res.end(JSON.stringify({ found: false })); return;
        }

        // Collecter tous les emplacements (loc, loc2, loc3...)
        const emplacements = [];
        let i = 0;
        while (true) {
          const slotKey = i === 0 ? 'loc' : 'loc' + (i + 1);
          // Vérifier aussi les nouvelles clés loc2, loc3...
          const locKey = i === 0 ? 'loc' : 'loc' + (i + 1);
          const loc = data[locKey];
          if (!loc && i > 0) break;
          if (loc && loc.allee) {
            let label = '';
            if (loc.allee === 'AREA') label = 'Zone AREA';
            else if (loc.cote === 'SOL') label = 'Allée ' + loc.allee + ' SOL';
            else {
              label = 'Allée ' + loc.allee;
              if (loc.cote) label += ' ' + loc.cote;
              if (loc.rack != null) label += ' R' + loc.rack;
              if (loc.hauteur != null) label += ' H' + loc.hauteur;
            }
            emplacements.push(label);
          }
          i++;
          if (i > 10) break; // sécurité
        }

        // Stock cartons
        const pieces = data.pieces || {};
        const pids = Object.keys(pieces);
        let cartons_complets = 0;
        let cartons_total = 0;
        if (pids.length > 0) {
          const fp = pieces[pids[0]];
          const allC = Object.keys(fp.cartons || {}).filter(c => /^c[0-9]+$/.test(c));
          cartons_total = fp.totalCartons || allC.length;
          cartons_complets = allC.filter(c => fp.cartons[c]?.sealed === true).length;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          found: true,
          emplacements,                          // ['Allée 1 G R2 H1', 'Allée 3 D R1 H0']
          emplacements_str: emplacements.join(' / ') || 'Non renseigné',
          visserie: data.visserie ?? null,        // true / false / null
          cartons_complets,                       // nb cartons sealed
          cartons_total,                          // nb total cartons
          qty: data.qty ?? null,                  // pour produits sans pièces
          note: data.note || ''
        }));
        return;
      }

      // ── EXPORT VERS GOOGLE SHEET ─────────────────────────
      if (req.url === '/export-to-sheet') {
        if (!GOOGLE_SHEET_ID) { res.writeHead(200); res.end(JSON.stringify({ ok: false, error: 'GOOGLE_SHEET_ID manquant' })); return; }
        const { mode, row } = payload;
        if (!row || !Array.isArray(row)) { res.writeHead(400); res.end(JSON.stringify({ error: 'row requis' })); return; }
        try {
          const token = await getSheetsToken();
          const sheetName = mode === 'remb' ? 'Import Refund' : 'Import SAV';

          // ── ANTI-DOUBLON ──────────────────────────────────
          // Clé d'identification : CNB en priorité, FLA à défaut
          // Import SAV : CNB col H (idx 7), FLA col I (idx 8)
          // Import Refund : CNB col I (idx 8), FLA col M (idx 12)
          const cnbIdx = mode === 'remb' ? 8 : 7;
          const flaIdx = mode === 'remb' ? 12 : 8;
          const key = (row[cnbIdx] || '').trim() || (row[flaIdx] || '').trim();
          if (key) {
            const checkRange = encodeURIComponent(sheetName + '!A:N');
            const existing = await fetch(
              `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${checkRange}`,
              { headers: { Authorization: 'Bearer ' + token } }
            ).then(r => r.json());
            const dup = (existing.values || []).some(r =>
              ((r[cnbIdx] || '').trim() === key) || ((r[flaIdx] || '').trim() === key)
            );
            if (dup) {
              console.log('Export ignoré — déjà présent dans', sheetName, ':', key);
              res.writeHead(200); res.end(JSON.stringify({ ok: true, duplicate: true, key }));
              return;
            }
          }

          const range = encodeURIComponent(sheetName + '!A:A');
          const appendRes = await fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
            {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ values: [row] })
            }
          );
          const appendData = await appendRes.json();
          if (appendData.error) throw new Error(appendData.error.message);
          res.writeHead(200); res.end(JSON.stringify({ ok: true }));
        } catch(e) {
          res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // ── SCAN NOTICE ───────────────────────────────────────
      if (req.url === '/scan-notice') {
        const { pdfUrl } = payload;
        if (!pdfUrl) { res.writeHead(400); res.end(JSON.stringify({ error: 'pdfUrl required' })); return; }
        const pdfData = await new Promise((resolve, reject) => {
          const client = pdfUrl.startsWith('https') ? https : http;
          client.get(pdfUrl, (r) => {
            const chunks = [];
            r.on('data', c => chunks.push(c));
            r.on('end', () => resolve(Buffer.concat(chunks)));
            r.on('error', reject);
          }).on('error', reject);
        });
        const b64 = pdfData.toString('base64');
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 2000,
            messages: [{ role: 'user', content: [{
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: b64 }
            }, {
              type: 'text',
              text: "Cette notice PDF contient une nomenclature de pièces. Extrait TOUTES les pièces. Retourne la référence exacte telle qu'elle apparaît (ex: A, B, 1, 2, A2, K) et la quantité. Aucune description. JSON uniquement : {\"pieces\": [{\"nom\": \"A\", \"qte\": 2}]}"
            }]}]
          })
        });
        const claudeData = await claudeRes.json();
        const text = claudeData.content?.map(b => b.text || '').join('') || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(parsed));
        return;
      }

      // ── HISTORIQUE MAGASIN (ancien endpoint — conservé compat) ──
      if (req.url === '/get-dossiers-magasin') {
        if (!pool) { res.writeHead(200); res.end(JSON.stringify({ dossiers: [] })); return; }
        const { enseigne, departement_ville } = payload;
        const villeKeyword = (departement_ville||'').replace(/^\d+\s*/, '').trim();
        const result = await pool.query(
          `SELECT * FROM dossiers WHERE departement_ville ILIKE $1 AND (enseigne ILIKE $2 OR $2 = '')
           ORDER BY date_traitement DESC LIMIT 30`,
          ['%' + villeKeyword + '%', enseigne ? '%' + enseigne + '%' : '']
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ dossiers: result.rows }));
        return;
      }

      // ── CHECK HISTORIQUE (ancien — conservé compat) ───────
      if (req.url === '/check-historique-magasin') {
        if (!pool) { res.writeHead(200); res.end(JSON.stringify({ alerte: null })); return; }
        const { enseigne, departement_ville, ref_produit, designation_piece } = payload;
        const villeKeyword = (departement_ville||'').replace(/^\d+\s*/, '').trim();
        const resultMagasin = await pool.query(
          `SELECT * FROM dossiers WHERE departement_ville ILIKE $1 AND (enseigne ILIKE $2 OR $2 = '')
           ORDER BY date_traitement DESC LIMIT 20`,
          ['%' + villeKeyword + '%', enseigne ? '%' + enseigne + '%' : '']
        );
        if (resultMagasin.rows.length === 0) {
          res.writeHead(200); res.end(JSON.stringify({ alerte: null })); return;
        }
        const historique = resultMagasin.rows.map(r =>
          '- ' + (r.date_reception||'?') + ' | Ref: ' + (r.ref_produit||'?') + ' | Piece: ' + (r.piece||'?') + ' | Decision: ' + (r.decision||'?')
        ).join('\n');
        const aiResult = await callAnthropic({
          messages: [{ role: 'user', content:
            'Nouveau dossier SAV :\nEnseigne: ' + enseigne + '\nVille: ' + departement_ville +
            '\nRef produit: ' + ref_produit + '\nPiece: ' + designation_piece + '\n\n' +
            'Historique des ' + resultMagasin.rows.length + ' derniers dossiers de CE magasin :\n' + historique + '\n\n' +
            'Analyse si ce magasin a deja fait une demande pour EXACTEMENT le meme probleme sur le MEME produit ET la MEME piece. ' +
            'IMPORTANT : une demande sur un produit similaire mais pour une piece differente N EST PAS un doublon. ' +
            'Reponds UNIQUEMENT si tu identifies un vrai doublon. Format : "Deja traite le JJ/MM - meme piece : [nom piece]". Si pas de doublon : reponds AUCUN'
          }],
          max_tokens: 100
        });
        const aiText = aiResult.content?.[0]?.text?.trim() || 'AUCUN';
        res.writeHead(200); res.end(JSON.stringify({ alerte: aiText === 'AUCUN' ? null : aiText }));
        return;
      }

      // ── NUMÉRO D'ACCORD ──────────────────────────────────────
      // Format : SU + année (2 chiffres) + mois (2 chiffres) — ex: SU2606
      // Identique pour tous les dossiers du mois, change automatiquement chaque mois
      if (req.url === '/get-next-accord') {
        const now = new Date();
        const yy = String(now.getFullYear()).slice(2);
        const mm = String(now.getMonth()+1).padStart(2,'0');
        res.writeHead(200); res.end(JSON.stringify({ accord: 'SU' + yy + mm }));
        return;
      }

      // ── ANALYSE AVEC NOTICE ───────────────────────────────
      let noticeInfo = null;
      if (req.url === '/analyze-with-notice' && payload.ref_produit) {
        const raw = payload.ref_produit.trim();
        let pdfBuffer = null, foundRef = null;

        // 1. Matching flou contre l'index réel des fichiers du repo
        const fileName = await findNoticeFile(raw);
        if (fileName) {
          const buf = await downloadBuffer(GITHUB_NOTICES + encodeURIComponent(fileName));
          if (buf) { pdfBuffer = buf; foundRef = fileName.replace(/\.pdf$/i, ''); }
        }

        // 2. Secours : anciens candidats par nom exact (si l'API GitHub est indisponible)
        if (!pdfBuffer) {
          const parts = raw.split(/\s+/);
          const candidates = [raw];
          if (parts.length > 1 && /^20\d{2}$/.test(parts[parts.length - 1]))
            candidates.push(parts.slice(0, -1).join(' '));
          if (parts.length > 1) candidates.push(parts[0]);
          for (const cand of candidates) {
            const buf = await downloadBuffer(GITHUB_NOTICES + encodeURIComponent(cand) + '.pdf');
            if (buf) { pdfBuffer = buf; foundRef = cand; break; }
          }
        }
        if (!pdfBuffer) {
          noticeInfo = { attached: false, reason: 'notice introuvable sur GitHub', tried: [raw, fileName].filter(Boolean) };
          console.log('Notice INTROUVABLE pour:', raw, '— meilleur candidat index:', fileName || 'aucun');
        } else {
          const images = await pdfToImages(pdfBuffer);
          if (images.length > 0) {
            const noticeContent = [{ type: 'text', text: 'Notice technique du produit ' + foundRef + ' (' + images.length + ' pages) :' }];
            images.forEach((img, i) => {
              noticeContent.push({ type: 'text', text: '[Page ' + (i+1) + ']' });
              noticeContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } });
            });
            const lastMsg = payload.messages[payload.messages.length - 1];
            const orig = Array.isArray(lastMsg.content) ? lastMsg.content : [{ type: 'text', text: lastMsg.content }];
            lastMsg.content = [...noticeContent, ...orig];
            noticeInfo = { attached: true, ref: foundRef, pages: images.length };
            console.log('Notice attachée:', foundRef, '—', images.length, 'pages');
          } else {
            noticeInfo = { attached: false, reason: 'conversion PDF echouee', ref: foundRef };
            console.log('Notice trouvée mais conversion ÉCHOUÉE:', foundRef);
          }
        }
      }

      // ── ANALYSE STANDARD ──────────────────────────────────
      const data = await callAnthropic(payload);
      if (noticeInfo) data._notice = noticeInfo;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));

    } catch(err) {
      console.error('Error:', err.message);
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
  });
});

initDB().then(() => {
  server.listen(PORT, () => console.log('SAV Server v4.0 on port ' + PORT));
});
