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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS its_dossiers (
        id SERIAL PRIMARY KEY,
        date_reception TEXT,
        reference TEXT,
        pannes TEXT,
        magasin TEXT,
        decision TEXT,
        accord TEXT,
        tracking TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE its_dossiers ADD COLUMN IF NOT EXISTS tracking TEXT`).catch(() => {});
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS its_dossiers_uni ON its_dossiers (date_reception, reference, magasin)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notices_override (
        ref TEXT PRIMARY KEY,
        notice_file TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS produits_kb (
        ref TEXT PRIMARY KEY,
        notice_file TEXT,
        transcription TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Lever la limite VARCHAR(100) héritée de la création initiale :
    // les désignations de pièces / villes longues du Sheet la dépassent.
    for (const col of ['numero_dossier', 'enseigne', 'departement_ville', 'ref_produit', 'piece', 'decision', 'notes']) {
      await pool.query('ALTER TABLE dossiers ALTER COLUMN ' + col + ' TYPE TEXT').catch(() => {});
    }
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
const COLOR_WORDS = /\b(BLEU|GRIS|ROSE|ROUGE|VERT|KAKI|BLANC|NOIR|BEIGE|TAUPE|TERRACOTTA|MULTICOLORE?|WARM|WHITE|COLD|ANTHRACITE|CHENE|NATUREL|MARRON|JAUNE|ORANGE|VIOLET|TURQUOISE)\b/gi;
const yearOf = f => { const m = String(f).match(/(20\d\d)/); return m ? parseInt(m[1]) : 0; };

// Cœur du matching sur une chaîne normalisée — 4 niveaux
function coreNoticeMatch(files, rn) {
  if (!rn || rn.length < 3) return null;
  // 1. Égalité normalisée
  let m = files.filter(f => normRef(f) === rn);
  if (m.length) return { file: m.sort((a,b) => yearOf(b)-yearOf(a))[0], score: 99 };
  // 2. Préfixe normalisé bidirectionnel
  m = files.filter(f => { const fn = normRef(f); return fn.startsWith(rn) || rn.startsWith(fn); });
  if (m.length) return { file: m.sort((a,b) => (normRef(b).length - normRef(a).length) || (yearOf(b)-yearOf(a)))[0], score: 98 };
  // 3. Ref contenue dans le nom (fichiers multi-références)
  if (rn.length >= 6) {
    m = files.filter(f => normRef(f).includes(rn));
    if (m.length) return { file: m.sort((a,b) => (normRef(a).length - normRef(b).length) || (yearOf(b)-yearOf(a)))[0], score: 97 };
  }
  // 4. Plus long préfixe commun (gère suffixes divergents : A/B, _8, années…)
  let best = null, bs = 0;
  for (const f of files) {
    const fn = normRef(f).replace(/20\d\d$/, '');
    let i = 0;
    while (i < rn.length && i < fn.length && rn[i] === fn[i]) i++;
    if (i > bs || (i === bs && best && yearOf(f) > yearOf(best))) { best = f; bs = i; }
  }
  if (best) {
    const fn = normRef(best).replace(/20\d\d$/, '');
    if (bs >= 6 && bs >= 0.65 * Math.min(rn.length, fn.length)) return { file: best, score: bs };
  }
  return null;
}

// Candidats de recherche pour une ref : complète, segments "/", sans couleurs
function refCandidates(ref) {
  const raw = String(ref || '').trim();
  const candidates = [raw];
  if (raw.includes('/')) raw.split('/').forEach(s => { s = s.trim(); if (s) candidates.push(s); });
  const sansCouleur = raw.replace(COLOR_WORDS, '').replace(/[\s\-_,]+$/, '').trim();
  if (sansCouleur && sansCouleur !== raw) candidates.push(sansCouleur);
  return candidates;
}

// Meilleur match d'une ref parmi une liste de noms (notices ou clés Firebase)
function findBestMatch(names, ref) {
  let best = null;
  for (const c of refCandidates(ref)) {
    const r = coreNoticeMatch(names, normRef(c));
    if (r && (!best || r.score > best.score)) best = r;
    if (best && best.score === 99) break;
  }
  return best ? best.file : null;
}

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
  if (files.length === 0) return null;
  return findBestMatch(files, ref);
}

async function pdfToImages(pdfBuffer, maxPages = 14) {
  try {
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    const { createCanvas } = require('canvas');
    const data = new Uint8Array(pdfBuffer);
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const images = [];
    const pages = Math.min(pdf.numPages, maxPages);
    for (let i = 1; i <= pages; i++) {
      let canvas = null;
      try {
        const page = await pdf.getPage(i);
        // Résolution adaptative : ~1600px de large max. Net pour lire les
        // tables de pièces, sans saturer la RAM (scale 2.2 faisait crasher Railway).
        const base = page.getViewport({ scale: 1 });
        const scale = 1.5; // résolution d'origine qui fonctionnait
        const viewport = page.getViewport({ scale });
        canvas = createCanvas(viewport.width, viewport.height);
        await Promise.race([
          page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise,
          new Promise((_, rej) => setTimeout(() => rej(new Error('render timeout p' + i)), 30000))
        ]);
        images.push(canvas.toBuffer('image/jpeg', { quality: 0.8 }).toString('base64'));
        page.cleanup(); // libère la mémoire interne de la page
      } catch(pageErr) {
        console.warn('pdfToImages — page', i, 'ignorée:', pageErr.message);
      } finally {
        // Libère explicitement le canvas (gros consommateur RAM) avant la page suivante
        if (canvas) { canvas.width = 0; canvas.height = 0; canvas = null; }
      }
    }
    return images;
  } catch(e) { console.error('pdfToImages error:', e.message); return []; }
}

const MODEL_MAIN  = process.env.MODEL_MAIN  || 'claude-sonnet-4-6';
const MODEL_LIGHT = process.env.MODEL_LIGHT || 'claude-haiku-4-5-20251001';

function callAnthropic(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: payload.model || MODEL_MAIN,
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
      },
      timeout: 120000 // 2 min, sans rester bloqué indéfiniment
    };
    const req = https.request(options, res => {
      let response = '';
      res.on('data', c => { response += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error('API Claude HTTP ' + res.statusCode + ' : ' + response.slice(0, 200)));
        }
        try { resolve(JSON.parse(response)); }
        catch(e) { reject(new Error('Réponse API illisible : ' + response.slice(0, 120))); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout API Claude (2 min)')); });
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
  let bodySize = 0;
  const MAX_BODY = 12 * 1024 * 1024; // 12 Mo : au-delà on refuse plutôt que crasher
  let bodyTooBig = false;
  req.on('data', chunk => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY) {
      bodyTooBig = true;
      return; // on arrête d'accumuler en mémoire
    }
    body += chunk;
  });
  req.on('end', async () => {
    if (bodyTooBig) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Requête trop volumineuse (pièces jointes). Réduisez le nombre de photos/PDF.' }));
      return;
    }
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

        const HIST_MOIS = 4; // fenêtre d'historique magasin affichée dans l'app
        const sixMoisAvant = new Date();
        sixMoisAvant.setMonth(sixMoisAvant.getMonth() - HIST_MOIS);
        const dateLimit = sixMoisAvant.toISOString().slice(0, 10);

        // Tableau 1 : même magasin + même ref, sur la fenêtre HIST_MOIS
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

        // Tableau 2 : même magasin tous produits, sur la fenêtre HIST_MOIS
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
          // Matching flou contre les clés Firebase réelles — même algorithme
          // que les notices (les clés entrepôt viennent des noms de notices)
          const allProduits = await firebaseGet('produits');
          if (allProduits) {
            const keys = Object.keys(allProduits);
            const matchKey = findBestMatch(keys, ref);
            if (matchKey) {
              console.log('Entrepôt — match flou:', ref, '→', matchKey);
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

      // ── EXPORT U DIRECT : SYSTEME U / REMBOURSEMENT SU ────────
      // Écrit sur la première ligne libre des feuilles réelles.
      // SYSTEME U : append pur A:I (dates au format texte JJ/MM/AA maison).
      // REMBOURSEMENT SU : écriture ciblée cellule par cellule (L = formule,
      // jamais touchée), n° accord auto SUaamm### si non-DDP, vert A→L.
      if (req.url === '/export-u-direct') {
        if (!GOOGLE_SHEET_ID) { res.writeHead(200); res.end(JSON.stringify({ ok: false, error: 'GOOGLE_SHEET_ID manquant' })); return; }
        const { mode, row } = payload;
        if (!row || !Array.isArray(row)) { res.writeHead(400); res.end(JSON.stringify({ error: 'row requis' })); return; }
        const token = await getSheetsToken();
        const shortDate = v => {
          const m = String(v || '').trim().match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
          if (!m) return v;
          return m[1].padStart(2,'0') + '/' + m[2].padStart(2,'0') + '/' + (m[3].length === 4 ? m[3].slice(2) : m[3].padStart(2,'0'));
        };

        if (mode === 'sav') {
          // Anti-doublon CNB (H idx 7) / FLA (I idx 8) dans SYSTEME U
          const key = (row[7] || '').trim() || (row[8] || '').trim();
          if (key) {
            const existing = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent("'SYSTEME U'!H:I")}`,
              { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
            const dup = (existing.values || []).some(r2 =>
              ((r2[0] || '').trim() === key) || ((r2[1] || '').trim() === key));
            if (dup) { res.writeHead(200); res.end(JSON.stringify({ ok: true, duplicate: true, key })); return; }
          }
          const clean = row.slice(0, 9);
          clean[0] = shortDate(clean[0]); clean[1] = shortDate(clean[1]);
          const ap = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent("'SYSTEME U'!A:I")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: [clean] })
          }).then(r => r.json());
          if (ap.error) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: ap.error.message })); return; }
          console.log('Export direct SYSTEME U:', key);
          res.writeHead(200); res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (mode === 'remb') {
          // Anti-doublon CNB (I idx 8) / FLA (M idx 12) dans REMBOURSEMENT SU
          const key = (row[8] || '').trim() || (row[12] || '').trim();
          if (key) {
            const existing = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent("'REMBOURSEMENT SU'!I:M")}`,
              { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
            const dup = (existing.values || []).some(r2 =>
              ((r2[0] || '').trim() === key) || ((r2[4] || '').trim() === key));
            if (dup) { res.writeHead(200); res.end(JSON.stringify({ ok: true, duplicate: true, key })); return; }
          }

          // Première ligne libre (colonnes A, I, J les plus remplies)
          const bg = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values:batchGet?ranges=${encodeURIComponent("'REMBOURSEMENT SU'!A:A")}&ranges=${encodeURIComponent("'REMBOURSEMENT SU'!I:I")}&ranges=${encodeURIComponent("'REMBOURSEMENT SU'!J:J")}`,
            { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
          const vr = bg.valueRanges || [];
          const lens = vr.map(v => (v.values || []).length);
          const target = Math.max(...lens, 1) + 1;

          // N° accord auto : SU + aa + mm + ### (suivant du mois, colonne J)
          let accord = (row[9] || '').trim();
          const isDDP = !!payload.ddp;
          if (!accord && !isDDP) {
            const now = new Date();
            const aa = String(now.getFullYear()).slice(2);
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const prefix = 'SU' + aa + mm;
            const jvals = ((vr[2] || {}).values || []).map(x => (x[0] || '').toString().trim());
            let maxSeq = 0;
            const reNum = new RegExp('^' + prefix + '(\\d{3})$');
            jvals.forEach(v => { const m = v.match(reNum); if (m) maxSeq = Math.max(maxSeq, parseInt(m[1])); });
            accord = prefix + String(maxSeq + 1).padStart(3, '0');
          }

          // Écriture ciblée : A..K + M — la colonne L (formule) n'est JAMAIS touchée
          const colsTexte = { C: row[2], D: row[3], F: row[5], G: row[6], H: row[7], I: row[8], J: accord, K: row[10], M: row[12] };
          const colsTypes = { A: shortDate(row[0]), B: shortDate(row[1]), E: parseInt(row[4]) || 1 };
          const mkUpdates = obj => Object.entries(obj)
            .filter(([c, v]) => v !== '' && v !== null && v !== undefined)
            .map(([c, v]) => ({ range: "'REMBOURSEMENT SU'!" + c + target, values: [[v]] }));
          // Textes (EAN, refs, CNB…) en RAW pour préserver leur type texte
          await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values:batchUpdate`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ valueInputOption: 'RAW', data: mkUpdates(colsTexte) })
          });
          // Dates courtes + quantité en USER_ENTERED : vraies dates, vrai nombre
          await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values:batchUpdate`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: mkUpdates(colsTypes) })
          });

          // Vert #92d050 de A à L
          const gid = await getSheetGid(token, 'REMBOURSEMENT SU');
          if (gid !== null) {
            await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}:batchUpdate`, {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ requests: [{
                repeatCell: {
                  range: { sheetId: gid, startRowIndex: target - 1, endRowIndex: target, startColumnIndex: 0, endColumnIndex: 12 },
                  cell: { userEnteredFormat: { backgroundColor: { red: 146/255, green: 208/255, blue: 80/255 } } },
                  fields: 'userEnteredFormat.backgroundColor'
                }
              }] })
            });
          }
          console.log('Export direct REMBOURSEMENT SU: ligne', target, '| accord', accord || '(vide/DDP)');
          res.writeHead(200); res.end(JSON.stringify({ ok: true, ligne: target, accord: accord || null }));
          return;
        }

        res.writeHead(400); res.end(JSON.stringify({ error: 'mode inconnu' }));
        return;
      }

      // ── EXPORT VERS GOOGLE SHEET (Import — conservé compat) ───
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
      // ⛔ NOTICES TEMPORAIREMENT DÉSACTIVÉES (économie RAM Railway)
      // Pour réactiver : passer NOTICES_ENABLED à true (ou définir la
      // variable d'env NOTICES_ENABLED=true dans Railway).
      // ── RECHERCHE : bases SU / ITS (miroir des feuilles) ──────
      if (req.url === '/recherche') {
        if (!pool) { res.writeHead(200); res.end(JSON.stringify({ resultats: [] })); return; }
        const univers = payload.univers === 'its' ? 'its' : 'su';
        const q = (payload.q || '').trim();
        if (!q) { res.writeHead(400); res.end(JSON.stringify({ error: 'q requis' })); return; }
        const mots = q.split(/\s+/).filter(Boolean).slice(0, 6);

        // Un mot "date FR" (23/07 ou 23/07/26) doit matcher les deux conventions :
        // ISO 2026-07-23 (base SU) et JJ/MM/AA (base ITS)
        const variantes = (mot) => {
          const v = ['%' + mot + '%'];
          const m = mot.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
          if (m) {
            const jj = m[1].padStart(2, '0'), mm = m[2].padStart(2, '0');
            const aa = m[3] ? (m[3].length === 4 ? m[3].slice(2) : m[3]) : null;
            v.push('%' + (aa ? '20' + aa : '') + '-' + mm + '-' + jj + '%'); // ISO
            v.push('%' + jj + '/' + mm + (aa ? '/' + aa : '') + '%');        // JJ/MM/AA
          }
          return v;
        };

        const champs = univers === 'su'
          ? ['numero_dossier', 'enseigne', 'departement_ville', 'ref_produit', 'piece', 'decision', 'date_reception', 'notes', 'tracking']
          : ['date_reception', 'reference', 'pannes', 'magasin', 'decision', 'accord', 'tracking'];
        const params = [];
        const conds = mots.map(mot => {
          const ors = [];
          for (const v of variantes(mot)) {
            for (const c of champs) {
              params.push(v);
              ors.push(c + ' ILIKE $' + params.length);
            }
          }
          return '(' + ors.join(' OR ') + ')';
        });
        const table = univers === 'su' ? 'dossiers' : 'its_dossiers';
        const orderCol = univers === 'su' ? 'date_reception' : 'created_at';
        const sql = 'SELECT * FROM ' + table + ' WHERE ' + conds.join(' AND ') +
                    ' ORDER BY ' + orderCol + ' DESC NULLS LAST LIMIT 50';
        const r = await pool.query(sql, params);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ resultats: r.rows, total: r.rows.length }));
        return;
      }

      // ── SYNC HISTORIQUE : Sheet → PostgreSQL ──────────────────
      // Relit la fin des feuilles réelles et met à jour les bases
      // historique (UPSERT — aucune suppression possible).
      if (req.url === '/sync-historique') {
        if (!pool || !GOOGLE_SHEET_ID) { res.writeHead(500); res.end(JSON.stringify({ error: 'base ou sheet manquant' })); return; }
        const cible = payload.cible; // 'su' | 'its'
        const token = await getSheetsToken();
        const toIso = v => {
          const m = String(v || '').trim().match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
          if (!m) return null;
          const y = m[3].length === 2 ? '20' + m[3] : m[3];
          return y + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
        };
        const tail = async (sheet, keyCol, span, width) => {
          const lenQ = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent("'" + sheet + "'!" + keyCol + ":" + keyCol)}`,
            { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
          const last = (lenQ.values || []).length;
          const from = Math.max(1, last - span);
          const q = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent("'" + sheet + "'!A" + from + ":" + width + last)}`,
            { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
          return q.values || [];
        };

        try {
          if (cible === 'su') {
            let up = 0, skip = 0, trk = 0;
            // SYSTEME U (envois) — clé CNB/FLA
            const rows = await tail('SYSTEME U', 'H', 12000, 'I');
            for (const r of rows) {
              const cnb = (r[7] || '').toString().trim(), fla = (r[8] || '').toString().trim();
              const key = cnb || fla;
              const iso = toIso(r[0]);
              if (!key || !iso) { skip++; continue; }
              await pool.query(`
                INSERT INTO dossiers (numero_dossier, enseigne, departement_ville, ref_produit, piece, decision, date_reception, notes, tracking)
                VALUES ($1,$2,$3,$4,$5,'envoi_piece',$6,$7,$8)
                ON CONFLICT (numero_dossier) DO UPDATE SET
                  departement_ville = EXCLUDED.departement_ville,
                  ref_produit = EXCLUDED.ref_produit,
                  piece = EXCLUDED.piece,
                  date_reception = EXCLUDED.date_reception,
                  tracking = CASE WHEN EXCLUDED.tracking <> '' THEN EXCLUDED.tracking ELSE dossiers.tracking END
              `, [key, (r[4] || '').toString().trim(), (r[5] || '').toString().trim(),
                  (r[2] || '').toString().trim(), (r[3] || '').toString().trim(), iso,
                  fla ? 'FLA:' + fla : '', (r[6] || '').toString().trim()]);
              if ((r[6] || '').toString().trim()) trk++;
              up++;
            }
            // REMBOURSEMENT SU — clé CNB (I) / FLA (M)
            const rrows = await tail('REMBOURSEMENT SU', 'I', 1500, 'M');
            for (const r of rrows) {
              const cnb = (r[8] || '').toString().trim(), fla = (r[12] || '').toString().trim();
              const key = cnb || fla;
              const iso = toIso(r[0]);
              if (!key || !iso) { skip++; continue; }
              await pool.query(`
                INSERT INTO dossiers (numero_dossier, enseigne, departement_ville, ref_produit, piece, decision, date_reception, notes)
                VALUES ($1,$2,$3,$4,'','remboursement',$5,$6)
                ON CONFLICT (numero_dossier) DO UPDATE SET
                  departement_ville = EXCLUDED.departement_ville,
                  ref_produit = EXCLUDED.ref_produit,
                  decision = 'remboursement',
                  date_reception = EXCLUDED.date_reception
              `, [key, (r[5] || '').toString().trim(), (r[6] || '').toString().trim(),
                  (r[2] || '').toString().trim(), iso, fla ? 'FLA:' + fla : '']);
              up++;
            }
            console.log('Sync SU:', up, 'dossiers,', trk, 'trackings,', skip, 'lignes sans clé/date');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, maj: up, ignorees: skip, trackings: trk }));
            return;
          }

          if (cible === 'its') {
            let up = 0, skip = 0;
            const rows = await tail('INTERSPORT', 'A', 1500, 'J');
            for (const r of rows) {
              const date = (r[0] || '').toString().trim();
              const ref = (r[1] || '').toString().trim();
              const mag = (r[4] || '').toString().trim();
              if (!date || !ref || !mag || !/\d/.test(date)) { skip++; continue; }
              await pool.query(`
                INSERT INTO its_dossiers (date_reception, reference, pannes, magasin, decision, tracking)
                VALUES ($1,$2,$3,$4,$5,$6)
                ON CONFLICT (date_reception, reference, magasin) DO UPDATE SET
                  pannes = EXCLUDED.pannes,
                  decision = EXCLUDED.decision,
                  tracking = EXCLUDED.tracking
              `, [date, ref, (r[3] || '').toString().trim(), mag, (r[8] || '').toString().trim(), (r[9] || '').toString().trim()]);
              up++;
            }
            console.log('Sync ITS:', up, 'dossiers,', skip, 'lignes ignorées');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, maj: up, ignorees: skip }));
            return;
          }

          res.writeHead(400); res.end(JSON.stringify({ error: 'cible su ou its requise' }));
        } catch(e) {
          console.error('Sync historique:', e.message);
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      // ── INTERSPORT : historique par magasin (4 mois) ──────────
      if (req.url === '/its-historique') {
        if (!pool) { res.writeHead(200); res.end(JSON.stringify({ total: 0, dossiers: [] })); return; }
        const mag = (payload.magasin || '').trim();
        if (!mag) { res.writeHead(400); res.end(JSON.stringify({ error: 'magasin requis' })); return; }
        // Match permissif sur le nom (sans le n° de département)
        const magNom = mag.replace(/^\d{2,3}\s*/, '');
        const q = await pool.query(`
          SELECT date_reception, reference, pannes, decision, accord, tracking, created_at
          FROM its_dossiers
          WHERE magasin ILIKE $1 AND created_at > NOW() - INTERVAL '4 months'
          ORDER BY created_at DESC LIMIT 60
        `, ['%' + magNom + '%']);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ total: q.rows.length, dossiers: q.rows }));
        return;
      }

      // ── INTERSPORT 0/2 : référentiel produits lu DANS le Sheet ──
      // Feuilles CODE PRODUITS + PRIX AVOIR, jointes et mises en cache 30 min.
      // Toujours à jour : modifier le Sheet suffit, aucun fichier à régénérer.
      if (req.url === '/its-referentiel') {
        if (!GOOGLE_SHEET_ID) { res.writeHead(500); res.end(JSON.stringify({ error: 'GOOGLE_SHEET_ID manquant' })); return; }
        global._itsRefCache = global._itsRefCache || { ts: 0, items: [] };
        const FRESH = 30 * 60 * 1000;
        if (!payload.force && global._itsRefCache.items.length && Date.now() - global._itsRefCache.ts < FRESH) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ items: global._itsRefCache.items, cached: true }));
          return;
        }
        const token = await getSheetsToken();
        const bg = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values:batchGet?ranges=${encodeURIComponent("'CODE PRODUITS'!A:G")}&ranges=${encodeURIComponent("'PRIX AVOIR'!A:F")}`,
          { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
        if (!bg.valueRanges) { res.writeHead(500); res.end(JSON.stringify({ error: 'Lecture des feuilles CODE PRODUITS / PRIX AVOIR impossible', detail: bg.error?.message })); return; }
        const nrmJ = v => String(v || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9]/g, '');
        const prixByCode = {}, prixByName = {};
        (bg.valueRanges[1].values || []).slice(2).forEach(r => {
          const code = (r[0] || '').toString().trim(), lib = (r[1] || '').toString().trim();
          let v = r[4] !== undefined ? String(r[4]).trim() : '';
          if (!v) return;
          const num = parseFloat(v.replace(',', '.'));
          if (!isNaN(num)) v = String(Math.round(num * 100) / 100);
          if (code) prixByCode[nrmJ(code)] = v;
          if (lib) prixByName[nrmJ(lib)] = v;
        });
        const items = [];
        (bg.valueRanges[0].values || []).slice(2).forEach(r => {
          const ref = (r[0] || '').toString().trim();
          if (!ref) return;
          const art = (r[3] || '').toString().trim();
          items.push({
            ref,
            ean: (r[1] || '').toString().trim(),
            action: (r[4] || '').toString().trim(),
            famille: (r[6] || '').toString().trim(),
            prix: prixByCode[nrmJ(art)] || prixByName[nrmJ(ref)] || ''
          });
        });
        global._itsRefCache = { ts: Date.now(), items };
        console.log('Référentiel ITS rechargé depuis le Sheet:', items.length, 'produits');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items }));
        return;
      }

      // ── INTERSPORT 1/2 : extraction mail + bon de retour ──────
      if (req.url === '/its-extract') {
        const content = [];
        const files = Array.isArray(payload.files) ? payload.files
          : (payload.file_b64 ? [{ b64: payload.file_b64, media: payload.media_type || 'application/pdf' }] : []);
        for (const f of files.slice(0, 3)) {
          content.push(f.media === 'application/pdf'
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.b64 } }
            : { type: 'image', source: { type: 'base64', media_type: f.media || 'image/png', data: f.b64 } });
        }
        const _now = new Date();
        const _jours = ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];
        const _aujourdhui = _jours[_now.getDay()] + ' ' + String(_now.getDate()).padStart(2,'0') + '/' + String(_now.getMonth()+1).padStart(2,'0') + '/' + _now.getFullYear();
        content.push({ type: 'text', text: `NOUS SOMMES LE ${_aujourdhui}.

Voici un dossier SAV Intersport : le texte du mail reçu, et si joints, des documents (bon de retour PDF, photos du produit, ticket de caisse).

TEXTE DU MAIL :
${(payload.mail_text || '(non fourni)').slice(0, 6000)}

Extrais les informations suivantes. Règles :
- date_mail : la date d'ENVOI DU MAIL, convertie en JJ/MM/AA. Le webmail l'affiche souvent en RELATIF — c'est NORMAL et ce n'est PAS une incertitude, convertis-la avec la date du jour donnée ci-dessus. CAS LE PLUS COURANT sur ce webmail : "jeu. 23/07, 13:59" → la date est ÉCRITE (23/07), prends-la telle quelle et complète avec l'année en cours (si elle tombait dans le futur, c'est l'année précédente) → 23/07/26. Autres formats : "13:59" seul = aujourd'hui ; "hier" = la veille ; "jeu. 13:59" sans jour/mois = le jeudi le plus récent ; une date complète type "Envoyé : mardi 14 avril 2026" se prend telle quelle. La date du bon de retour ne sert JAMAIS de date_mail (elle peut au mieux confirmer ta conversion). Ne mets date_mail en incertitude que si le mail n'affiche vraiment AUCUNE indication de date ou d'heure.
- ville et cp : RÈGLE DE PRIORITÉ STRICTE. 1) Si un bon de retour est joint : le magasin est celui écrit dans le bloc en haut à gauche du bon — c'est LUI qui fait foi, ignore la signature du mail. 2) Sans bon de retour : lis attentivement le mail — l'expéditeur peut être la centrale Intersport France écrivant POUR un magasin ; le magasin concerné est alors celui NOMMÉ dans le texte du mail, pas l'expéditeur. N'utilise la signature que si l'expéditeur est manifestement le magasin lui-même. 3) Jamais l'adresse du siège (Intersport France, Longjumeau, 91).
- magasin_nom : le nom du magasin (ex JAUDE SPORT, INTERSPORT JAUDE).
- produits : la liste de TOUS les produits du bon de retour (il peut y en avoir plusieurs, une ligne de tableau chacun). Pour chaque produit : son NOM/désignation (ex E SWIM 10) et marque si visible — PAS la référence chiffrée qui est propre au magasin — sa quantité, et son motif propre s'il est indiqué sur sa ligne.
- motif_global : la panne/le motif général s'il est écrit hors tableau (mail, haut du bon).
Réponds UNIQUEMENT avec ce JSON, sans texte autour :
{"date_mail":"JJ/MM/AA","cp":"63000","ville":"CLERMONT FERRAND","magasin_nom":"...","motif_global":"...","produits":[{"produit_nom":"...","marque":"...","quantite":1,"motif":"..."}],"incertitudes":["champ : explication courte"]}` });

        const aiData = await callAnthropic({
          model: process.env.MODEL_EXTRACT || MODEL_MAIN,
          messages: [{ role: 'user', content }],
          max_tokens: 1200
        });
        const raw = (aiData.content || []).map(b => b.text || '').join('');
        let parsed = null;
        try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
        catch(e) { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch(e2) {} } }
        // Filtre dur : une incertitude n'est recevable QUE sur les champs utiles
        // (magasin/ville/cp, produit, quantité, motif/panne, date). Tout le reste
        // (marque, numéros de retour, références internes…) est écarté d'office.
        if (parsed && Array.isArray(parsed.incertitudes)) {
          const champsUtiles = /^(magasin|ville|cp|produit|quantit|motif|panne|date)/i;
          parsed.incertitudes = parsed.incertitudes
            .map(x => String(x || '').trim())
            .filter(x => champsUtiles.test(x));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(parsed || { error: 'Extraction illisible', raw: raw.slice(0, 300) }));
        return;
      }

      // ── INTERSPORT 2/2 : export INTERSPORT + bascule REMBOURSEMENT ITS ──
      if (req.url === '/its-export') {
        if (!GOOGLE_SHEET_ID) { res.writeHead(500); res.end(JSON.stringify({ error: 'GOOGLE_SHEET_ID manquant' })); return; }
        const d = payload;
        const produits = Array.isArray(d.produits) ? d.produits : [];
        if (!d.date || !d.magasin || !produits.length) { res.writeHead(400); res.end(JSON.stringify({ error: 'date, magasin et produits requis' })); return; }
        const token = await getSheetsToken();

        const now = new Date();
        const jj = String(now.getDate()).padStart(2, '0');
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const aa = String(now.getFullYear()).slice(2);
        const todayFR = jj + '/' + mm + '/' + aa;

        // Anti-doublon (date + référence + magasin)
        const existing = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent("'INTERSPORT'!A:E")}`,
          { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
        const nrmD = v => String(v || '').toUpperCase().trim();
        const exRows = existing.values || [];
        const isDup = (ref) => exRows.some(row =>
          nrmD(row[0]) === nrmD(d.date) && nrmD(row[1]) === nrmD(ref) &&
          nrmD(row[4]).includes(nrmD(d.magasin).slice(0, 12)));

        const values = [], applied = [], skipped = [], avoirProds = [];
        for (const p of produits) {
          const ref = (p.reference || '').trim();
          if (!ref) { skipped.push({ reference: '?', reason: 'référence vide' }); continue; }
          if (isDup(ref)) { skipped.push({ reference: ref, reason: 'déjà dans la feuille (même date/magasin)' }); continue; }
          const etat = (p.decision || '').trim();
          const isAvoir = etat.toUpperCase() === 'AVOIR';
          const commentaires = [p.quantite && parseInt(p.quantite) > 1 ? 'Qté ' + p.quantite : '',
                                d.commentaires || ''].filter(Boolean).join(' — ');
          // A DATE | B REF | C LOT | D PANNES | E MAGASIN | F COMM | G DATE RECEP | H DATE EXPE | I ETAT | J TRACKING
          values.push([d.date, ref, p.lot || '', p.pannes || '', d.magasin, commentaires, '', isAvoir ? todayFR : '', etat, '']);
          applied.push({ reference: ref, etat });
          if (isAvoir) avoirProds.push(p);
        }

        // Écriture INTERSPORT (append = ajout pur) + couleurs selon décision
        let firstRow = null;
        if (values.length) {
          const ap = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent("'INTERSPORT'!A:J")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ values })
          }).then(r => r.json());
          const ur = ap.updates && ap.updates.updatedRange;
          const mrow = ur && ur.match(/![A-Z]+(\d+)/);
          if (mrow) firstRow = parseInt(mrow[1]);

          if (firstRow) {
            const gid = await getSheetGid(token, 'INTERSPORT');
            if (gid !== null) {
              const requests = [];
              values.forEach((row, i) => {
                const etat = (row[8] || '').toUpperCase();
                let color = null;
                if (etat === 'AVOIR') color = { red: 146/255, green: 208/255, blue: 80/255 };          // #92d050
                else if (etat === 'DEMANDE RENVOI') color = { red: 1, green: 153/255, blue: 1 };        // #ff99ff
                if (color) requests.push({
                  repeatCell: {
                    range: { sheetId: gid, startRowIndex: firstRow - 1 + i, endRowIndex: firstRow + i, startColumnIndex: 0, endColumnIndex: 10 },
                    cell: { userEnteredFormat: { backgroundColor: color } },
                    fields: 'userEnteredFormat.backgroundColor'
                  }
                });
              });
              if (requests.length) {
                await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}:batchUpdate`, {
                  method: 'POST',
                  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ requests })
                });
              }
            }
          }
        }

        // ── Bascule des AVOIR vers REMBOURSEMENT ITS ─────────────
        // Feuille dynamique : on n'écrit QUE B, D, G, H (et J si non-DDP).
        // Les colonnes à formules (A, C, E, F, I, K) ne sont jamais touchées.
        const remboursements = [];
        if (avoirProds.length) {
          const bg = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values:batchGet?ranges=${encodeURIComponent("'REMBOURSEMENT ITS'!B:B")}&ranges=${encodeURIComponent("'REMBOURSEMENT ITS'!G:G")}&ranges=${encodeURIComponent("'REMBOURSEMENT ITS'!J:J")}`,
            { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
          const vr = bg.valueRanges || [];
          const lens = vr.map(v => (v.values || []).length);
          let row = Math.max(4, ...lens) + 1; // première ligne libre (données dès la ligne 5)

          // Dernier numéro d'accord du mois courant (colonne J)
          const jvals = ((vr[2] || {}).values || []).map(x => (x[0] || '').toString().trim());
          const prefix = 'ITS' + aa + mm;
          let maxSeq = 0;
          const reNum = new RegExp('^' + prefix + '(\\d{3})$');
          jvals.forEach(v => { const m = v.match(reNum); if (m) maxSeq = Math.max(maxSeq, parseInt(m[1])); });

          // Date complète (JJ/MM/AAAA) + quantité numérique, écrites en
          // USER_ENTERED : Sheets les enregistre en VRAIS date/nombre,
          // alignés comme le reste de la feuille (pas d'apostrophe texte).
          const dParts = (d.date || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
          const dateFull = dParts ? dParts[1].padStart(2,'0') + '/' + dParts[2].padStart(2,'0') + '/' + (dParts[3].length === 4 ? dParts[3].slice(2) : dParts[3].padStart(2,'0')) : d.date;
          const updates = [];
          for (const p of avoirProds) {
            const isDDP = String(p.prix || '').toUpperCase().includes('DDP');
            let accord = '';
            if (!isDDP) { maxSeq++; accord = prefix + String(maxSeq).padStart(3, '0'); }
            updates.push({ range: "'REMBOURSEMENT ITS'!B" + row, values: [[dateFull]] });
            updates.push({ range: "'REMBOURSEMENT ITS'!D" + row, values: [[parseInt(p.quantite) || 1]] });
            updates.push({ range: "'REMBOURSEMENT ITS'!G" + row, values: [[p.reference]] });
            updates.push({ range: "'REMBOURSEMENT ITS'!H" + row, values: [[d.magasin]] });
            if (accord) updates.push({ range: "'REMBOURSEMENT ITS'!J" + row, values: [[accord]] });
            remboursements.push({ reference: p.reference, ligne: row, accord: accord || '(DDP — sans numéro)' });
            row++;
          }
          await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values:batchUpdate`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates })
          });
        }

        // Historique ITS en base (arrière-plan, non bloquant)
        if (pool && applied.length) {
          const accordByRef = {};
          remboursements.forEach(r => { accordByRef[r.reference] = r.accord; });
          for (const a of applied) {
            const pr = produits.find(p => (p.reference || '').trim() === a.reference) || {};
            pool.query(
              'INSERT INTO its_dossiers (date_reception, reference, pannes, magasin, decision, accord) VALUES ($1,$2,$3,$4,$5,$6)',
              [d.date, a.reference, pr.pannes || '', d.magasin, a.etat || '', accordByRef[a.reference] || '']
            ).catch(e => console.warn('Historique ITS:', e.message));
          }
        }
        console.log('Export ITS:', applied.length, 'ligne(s) INTERSPORT,', remboursements.length, 'remboursement(s),', skipped.length, 'ignorée(s)');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ applied, skipped, remboursements }));
        return;
      }

      // ── TRACKINGS : helpers ───────────────────────────────────
      async function getSheetGid(token, sheetName) {
        const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}?fields=sheets.properties`,
          { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
        const sh = (meta.sheets || []).find(x => x.properties && x.properties.title === sheetName);
        return sh ? sh.properties.sheetId : null;
      }
      async function getExpedieColor() {
        // Vert EXPEDIE officiel du tableau : #92d050
        return { red: 146/255, green: 208/255, blue: 80/255 };
      }

      // ── TRACKINGS 1/3 : lignes candidates (marquées d'un x) ───
      if (req.url === '/trackings-candidates') {
        if (!GOOGLE_SHEET_ID) { res.writeHead(500); res.end(JSON.stringify({ error: 'GOOGLE_SHEET_ID manquant' })); return; }
        const token = await getSheetsToken();
        const data = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent("'SYSTEME U'!A:I")}`,
          { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
        const rows = data.values || [];
        const candidates = [];
        rows.forEach((r, i) => {
          const dateExpe = (r[1] || '').toString().trim().toLowerCase();
          if (dateExpe === 'x') {
            candidates.push({
              row: i + 1, // numéro de ligne Sheet (1-based)
              date_recep: r[0] || '', ref: r[2] || '', piece: r[3] || '',
              enseigne: r[4] || '', ville: r[5] || '', tracking: r[6] || '', cnb: r[7] || ''
            });
          }
        });
        // Candidats INTERSPORT : lignes marquées d'un x en colonne H
        // (même convention que Système U — lève l'ambiguïté des villes en doublon)
        let its_candidates = [];
        try {
          const itsData = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent("'INTERSPORT'!A:J")}`,
            { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
          const itsRows = itsData.values || [];
          itsRows.forEach((r, i) => {
            const marque = (r[7] || '').toString().trim().toLowerCase() === 'x';
            const mag = (r[4] || '').toString().trim();
            if (marque && mag) {
              its_candidates.push({ row: i + 1, date: r[0] || '', ref: r[1] || '',
                pannes: r[3] || '', magasin: mag, etat: r[8] || '', tracking: r[9] || '' });
            }
          });
        } catch(e) { console.warn('Candidats ITS:', e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ candidates, its_candidates }));
        return;
      }

      // ── TRACKINGS 2/3 : extraction du bordereau par Claude ────
      if (req.url === '/trackings-extract') {
        const media = payload.media_type || 'image/png';
        const isPdf = media === 'application/pdf';
        const block = isPdf
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: payload.file_b64 } }
          : { type: 'image', source: { type: 'base64', media_type: media, data: payload.file_b64 } };
        const prompt = `Voici un bordereau d'expédition transporteur (DPD : tableau avec colonnes Date/B.L./N° Colis/Client/C.P./Localité — ou DSV : liste de fret avec N° d'expédition et blocs DESTINATAIRE).
Extrais TOUTES les expéditions du document.
Règles :
- DPD : tracking = N° Colis (13 chiffres). DSV : tracking = N° d'expédition (8 chiffres commençant par 0).
- ville = nom de la localité SEULE (sans adresse, sans téléphone). cp = code postal 5 chiffres.
- enseigne = SUPER U, HYPER U, U EXPRESS, INTERSPORT… telle qu'écrite.
- date = la date d'expédition du bordereau au format JJ/MM/AAAA.
Réponds UNIQUEMENT avec ce JSON, sans aucun texte autour :
{"transporteur":"DPD|DSV|AUTRE","date":"JJ/MM/AAAA","lignes":[{"tracking":"...","cp":"...","ville":"...","enseigne":"..."}]}`;
        // Extraction bordereaux : les numéros ne sont PAS revérifiés par
        // l'opérateur → modèle principal obligatoire (fiabilité des chiffres).
        const aiData = await callAnthropic({
          model: process.env.MODEL_EXTRACT || MODEL_MAIN,
          messages: [{ role: 'user', content: [ block, { type: 'text', text: prompt } ] }],
          max_tokens: 3000
        });
        const raw = (aiData.content || []).map(b => b.text || '').join('');
        let parsed = null;
        try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
        catch(e) {
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) { try { parsed = JSON.parse(m[0]); } catch(e2) {} }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(parsed || { error: 'Extraction illisible', raw: raw.slice(0, 300) }));
        return;
      }

      // ── TRACKINGS 3/3 : écriture sécurisée dans le Sheet ──────
      if (req.url === '/trackings-apply') {
        if (!GOOGLE_SHEET_ID) { res.writeHead(500); res.end(JSON.stringify({ error: 'GOOGLE_SHEET_ID manquant' })); return; }
        const items = Array.isArray(payload.items) ? payload.items : [];
        let dateExpe = (payload.date_expe || '').trim();
        if (!items.length || !dateExpe) { res.writeHead(400); res.end(JSON.stringify({ error: 'items et date_expe requis' })); return; }
        // Format maison du tableau : JJ/MM/AA (ex 22/07/26)
        const dm = dateExpe.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
        if (dm) {
          const jj = dm[1].padStart(2, '0'), mm = dm[2].padStart(2, '0');
          const aa = dm[3].length === 4 ? dm[3].slice(2) : dm[3].padStart(2, '0');
          dateExpe = jj + '/' + mm + '/' + aa;
        }
        const token = await getSheetsToken();
        const applied = [], skipped = [];
        const valueUpdates = [];

        for (const it of items) {
          const row = parseInt(it.row);
          const trk = (it.tracking || '').toString().trim();
          if (!row || !trk) { skipped.push({ row: it.row, reason: 'données incomplètes' }); continue; }
          // GARDE-FOU : relire la ligne juste avant d'écrire
          const check = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent("'SYSTEME U'!A" + row + ":I" + row)}`,
            { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
          const cur = (check.values && check.values[0]) || [];
          const curX = (cur[1] || '').toString().trim().toLowerCase();
          const curTrk = (cur[6] || '').toString().trim();
          if (curX !== 'x') { skipped.push({ row, reason: "la ligne ne porte plus le marqueur x" }); continue; }
          if (curTrk && curTrk !== trk) { skipped.push({ row, reason: 'un tracking différent est déjà présent (' + curTrk + ')' }); continue; }
          valueUpdates.push({ range: "'SYSTEME U'!B" + row, values: [[dateExpe]] });
          valueUpdates.push({ range: "'SYSTEME U'!G" + row, values: [[trk]] });
          applied.push({ row, tracking: trk, cnb: (cur[7] || '').toString().trim() });
        }

        // Écriture par lots : UNIQUEMENT les cellules B et G des lignes validées
        if (valueUpdates.length) {
          await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values:batchUpdate`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ valueInputOption: 'RAW', data: valueUpdates })
          });
        }

        // Couleur EXPEDIE (copiée de la légende H2) sur les lignes écrites
        if (applied.length) {
          const gid = await getSheetGid(token, 'SYSTEME U');
          if (gid !== null) {
            const color = await getExpedieColor();
            const requests = applied.map(a => ({
              repeatCell: {
                range: { sheetId: gid, startRowIndex: a.row - 1, endRowIndex: a.row, startColumnIndex: 0, endColumnIndex: 9 },
                cell: { userEnteredFormat: { backgroundColor: color } },
                fields: 'userEnteredFormat.backgroundColor'
              }
            }));
            await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}:batchUpdate`, {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ requests })
            });
          }
        }

        // ── Trackings INTERSPORT : colonne J + vert A→J ──────────
        const itsItems = Array.isArray(payload.its_items) ? payload.its_items : [];
        const itsApplied = [], itsSkipped = [];
        if (itsItems.length) {
          const itsUpdates = [];
          for (const it of itsItems) {
            const row = parseInt(it.row);
            const trk = (it.tracking || '').toString().trim();
            if (!row || !trk) { itsSkipped.push({ row: it.row, reason: 'données incomplètes' }); continue; }
            // GARDE-FOU : relire la ligne avant d'écrire
            const check = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent("'INTERSPORT'!A" + row + ":J" + row)}`,
              { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
            const cur = (check.values && check.values[0]) || [];
            const curX = (cur[7] || '').toString().trim().toLowerCase();
            const curTrk = (cur[9] || '').toString().trim();
            if (curX !== 'x') { itsSkipped.push({ row, reason: "la ligne ne porte plus le marqueur x" }); continue; }
            if (curTrk && curTrk !== trk) { itsSkipped.push({ row, reason: 'un tracking différent est déjà présent (' + curTrk + ')' }); continue; }
            itsUpdates.push({ range: "'INTERSPORT'!H" + row, values: [[dateExpe]] });
            itsUpdates.push({ range: "'INTERSPORT'!J" + row, values: [[trk]] });
            itsApplied.push({ row, tracking: trk, date: (cur[0] || '').toString().trim(),
                              ref: (cur[1] || '').toString().trim(), magasin: (cur[4] || '').toString().trim() });
          }
          if (itsUpdates.length) {
            await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values:batchUpdate`, {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ valueInputOption: 'RAW', data: itsUpdates })
            });
            const itsGid = await getSheetGid(token, 'INTERSPORT');
            if (itsGid !== null) {
              const requests = itsApplied.map(a => ({
                repeatCell: {
                  range: { sheetId: itsGid, startRowIndex: a.row - 1, endRowIndex: a.row, startColumnIndex: 0, endColumnIndex: 10 },
                  cell: { userEnteredFormat: { backgroundColor: { red: 146/255, green: 208/255, blue: 80/255 } } },
                  fields: 'userEnteredFormat.backgroundColor'
                }
              }));
              await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}:batchUpdate`, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ requests })
              });
            }
            // Sync base its_dossiers (clé date+ref+magasin)
            if (pool) {
              for (const a of itsApplied) {
                pool.query('UPDATE its_dossiers SET tracking = $1 WHERE date_reception = $2 AND reference = $3 AND magasin = $4',
                  [a.tracking, a.date, a.ref, a.magasin]).catch(() => {});
              }
            }
          }
        }

        // Synchro PostgreSQL (tracking + date d'envoi sur le dossier CNB)
        let dbSync = 0;
        if (pool) {
          const parts = dateExpe.split('/');
          const iso = parts.length === 3 ? parts[2] + '-' + parts[1] + '-' + parts[0] : dateExpe;
          for (const a of applied) {
            if (!a.cnb) continue;
            try {
              const r = await pool.query('UPDATE dossiers SET tracking = $1, date_envoi = $2 WHERE numero_dossier = $3', [a.tracking, iso, a.cnb]);
              dbSync += r.rowCount || 0;
            } catch(e) { console.warn('Sync DB tracking:', e.message); }
          }
        }
        console.log('Trackings appliqués:', applied.length, '| ignorés:', skipped.length, '| sync DB:', dbSync);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ applied, skipped, db_sync: dbSync, its_applied: itsApplied, its_skipped: itsSkipped }));
        return;
      }

      // ── CERVEAU : état de la mémoire d'une référence ──────────
      if (req.url === '/kb-status') {
        if (!pool) { res.writeHead(200); res.end(JSON.stringify({ kb: null })); return; }
        const kref = (payload.ref || '').trim();
        const kq = await pool.query(
          'SELECT ref, notice_file, updated_at, LENGTH(transcription) AS taille, transcription FROM produits_kb WHERE ref = $1', [kref]);
        const row = kq.rows[0] || null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ kb: row ? {
          ref: row.ref, notice_file: row.notice_file, updated_at: row.updated_at,
          taille: row.taille, extrait: (row.transcription || '').slice(0, 600)
        } : null }));
        return;
      }
      // Liste complète des refs mémorisées
      if (req.url === '/kb-list') {
        if (!pool) { res.writeHead(200); res.end(JSON.stringify({ items: [] })); return; }
        const kl = await pool.query(
          'SELECT ref, notice_file, updated_at, LENGTH(transcription) AS taille FROM produits_kb ORDER BY updated_at DESC LIMIT 200');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: kl.rows }));
        return;
      }

      // ── CERVEAU : associations manuelles ref → notice ─────────
      if (req.url === '/notices-overrides') {
        if (!pool) { res.writeHead(200); res.end(JSON.stringify({ overrides: [] })); return; }
        const q = await pool.query('SELECT ref, notice_file, updated_at FROM notices_override ORDER BY ref');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ overrides: q.rows }));
        return;
      }
      if (req.url === '/notices-override-set') {
        if (!pool) { res.writeHead(500); res.end(JSON.stringify({ error: 'no db' })); return; }
        const oref = (payload.ref || '').trim();
        const ofile = (payload.notice_file || '').trim();
        if (!oref || !ofile) { res.writeHead(400); res.end(JSON.stringify({ error: 'ref et notice_file requis' })); return; }
        await pool.query(`
          INSERT INTO notices_override (ref, notice_file, updated_at) VALUES ($1, $2, NOW())
          ON CONFLICT (ref) DO UPDATE SET notice_file = $2, updated_at = NOW()`, [oref, ofile]);
        // L'association change la notice → purger la transcription mémorisée de cette ref
        await pool.query('DELETE FROM produits_kb WHERE ref = $1', [oref]).catch(() => {});
        console.log('Association manuelle:', oref, '→', ofile);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/notices-override-delete') {
        if (!pool) { res.writeHead(500); res.end(JSON.stringify({ error: 'no db' })); return; }
        const dref = (payload.ref || '').trim();
        await pool.query('DELETE FROM notices_override WHERE ref = $1', [dref]);
        await pool.query('DELETE FROM produits_kb WHERE ref = $1', [dref]).catch(() => {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // Liste des fichiers notices du repo (pour l'onglet Cerveau)
      if (req.url === '/notices-files') {
        const list = await fetchGithubJSON('https://api.github.com/repos/Drsly78/flaudis-notices/contents/notices');
        const files = Array.isArray(list) ? list.filter(f => /\.pdf$/i.test(f.name)).map(f => f.name) : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files }));
        return;
      }

      // ── BILAN PRODUIT (lecture seule) ────────────────────────
      // Statistiques SAV d'une référence : volumes, décisions, pièces, tendance
      if (req.url === '/bilan-produit') {
        if (!pool) { res.writeHead(200); res.end(JSON.stringify({ error: 'no db' })); return; }
        const ref = (payload.ref || '').trim();
        if (!ref) { res.writeHead(400); res.end(JSON.stringify({ error: 'ref requise' })); return; }
        // Préfixe : couvre les variantes couleur (QD101-3/6 → QD101-3/6 VERT KAKI…)
        const q = await pool.query(
          `SELECT numero_dossier, piece, decision, date_reception, departement_ville, tracking
           FROM dossiers
           WHERE ref_produit ILIKE $1
           ORDER BY date_reception DESC NULLS LAST
           LIMIT 500`, [ref + '%']);
        const rows = q.rows || [];

        const stats = { ref, total: rows.length, envois: 0, remboursements: 0,
                        top_pieces: [], par_mois: [], par_magasin: [], derniers: [] };
        const pieces = {}, mois = {}, magasins = {};
        rows.forEach(r => {
          if (r.decision === 'remboursement') stats.remboursements++; else stats.envois++;
          const p = (r.piece || '').trim();
          if (p) pieces[p.toUpperCase()] = (pieces[p.toUpperCase()] || 0) + 1;
          const m = (r.date_reception || '').slice(0, 7);
          if (/^\d{4}-\d{2}$/.test(m)) mois[m] = (mois[m] || 0) + 1;
          // Agrégation magasin sur l'INTÉGRALITÉ des dossiers (pas seulement l'échantillon détaillé)
          const v = (r.departement_ville || '').trim().toUpperCase();
          if (v) {
            if (!magasins[v]) magasins[v] = { n: 0, envois: 0, remb: 0 };
            magasins[v].n++;
            if (r.decision === 'remboursement') magasins[v].remb++; else magasins[v].envois++;
          }
        });
        stats.par_magasin = Object.entries(magasins)
          .sort((a, b) => b[1].n - a[1].n)
          .map(([ville, o]) => ({ ville, n: o.n, envois: o.envois, remboursements: o.remb }));
        // Liste complète compacte : permet au cerveau de répondre aux questions
        // par magasin, par mois, par pièce sur TOUS les dossiers de la référence
        stats.tous = rows.map(r => [
          (r.date_reception || '').slice(0, 10),
          (r.departement_ville || '').trim(),
          (r.piece || '').trim(),
          r.decision === 'remboursement' ? 'R' : 'E'
        ]);
        stats.top_pieces = Object.entries(pieces).sort((a, b) => b[1] - a[1]).slice(0, 10)
          .map(([piece, n]) => ({ piece, n }));
        stats.par_mois = Object.entries(mois).sort((a, b) => a[0].localeCompare(b[0]))
          .map(([m, n]) => ({ mois: m, n }));
        stats.derniers = rows.slice(0, 30).map(r => ({
          date: r.date_reception, ville: r.departement_ville, piece: r.piece, decision: r.decision
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
        return;
      }

      // Notices actives par défaut. Pour les couper sans toucher au code :
      // définir NOTICES_ENABLED=false dans les variables Railway.
      const NOTICES_ENABLED = (process.env.NOTICES_ENABLED !== 'false');

      let noticeInfo = null;
      if (NOTICES_ENABLED && req.url === '/analyze-with-notice' && payload.ref_produit) {
        const raw = payload.ref_produit.trim();
        let pdfBuffer = null, foundRef = null;

        // 0. Association manuelle prioritaire (onglet Cerveau)
        let fileName = null;
        if (pool) {
          try {
            const ov = await pool.query('SELECT notice_file FROM notices_override WHERE ref = $1', [raw]);
            if (ov.rows.length) {
              fileName = ov.rows[0].notice_file;
              console.log('Association manuelle utilisée:', raw, '→', fileName);
            }
          } catch(e) {}
        }
        // 1. Sinon : matching flou contre l'index réel des fichiers du repo
        if (!fileName) fileName = await findNoticeFile(raw);

        // ── 🧠 CERVEAU PRODUIT : transcription mémorisée ──────────
        // Si on a déjà lu cette notice (même fichier, < 45 jours), on injecte
        // la transcription texte au lieu de reconvertir le PDF en images.
        // payload.force_reread = true (bouton "Relire") court-circuite le cache.
        let kbHit = null;
        if (pool && fileName && !payload.force_reread) {
          try {
            const kb = await pool.query('SELECT notice_file, transcription, updated_at FROM produits_kb WHERE ref = $1', [raw]);
            if (kb.rows.length) {
              const row = kb.rows[0];
              const ageJours = (Date.now() - new Date(row.updated_at).getTime()) / 86400000;
              if (row.notice_file === fileName && ageJours < 45 &&
                  row.transcription && row.transcription.length > 150 &&
                  (row.transcription.match(/ILLISIBLE/g) || []).length < 5) {
                kbHit = row;
              }
            }
          } catch(e) { console.warn('KB lecture:', e.message); }
        }

        if (kbHit) {
          const noticeContent = [{ type: 'text', text:
            'NOTICE TECHNIQUE du produit ' + raw + ' — TRANSCRIPTION MÉMORISÉE (lue précédemment sur le fichier "' + kbHit.notice_file + '") :\n\n' +
            kbHit.transcription +
            '\n\nCette transcription est ta référence fiable des repères, désignations et quantités de ce produit — elle remplace les pages images de la notice. Dans ta réponse, la section TRANSCRIPTION peut reprendre ces données telles quelles.' }];
          const lastMsg = payload.messages[payload.messages.length - 1];
          const orig = Array.isArray(lastMsg.content) ? lastMsg.content : [{ type: 'text', text: lastMsg.content }];
          lastMsg.content = [...noticeContent, ...orig];
          noticeInfo = { attached: true, ref: kbHit.notice_file.replace(/\.pdf$/i, ''), pages: 0, cached: true };
          console.log('🧠 Cerveau produit — transcription mémorisée injectée pour:', raw);
        } else {

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
        } // fin else kbHit (chemin lecture complète)
      }

      // ── ANALYSE STANDARD ──────────────────────────────────
      if (payload.task === 'light') payload.model = MODEL_LIGHT;
      delete payload.task;
      const data = await callAnthropic(payload);

      // ── 🧠 CERVEAU PRODUIT : mémoriser la transcription ───────
      // Après une lecture COMPLÈTE (images) réussie, on extrait la section
      // TRANSCRIPTION de la réponse et on la sauvegarde pour les prochains scans.
      // En arrière-plan, sans bloquer ni faire échouer la réponse.
      if (pool && noticeInfo && noticeInfo.attached && !noticeInfo.cached && payload.ref_produit) {
        try {
          const full = (data.content || []).map(b => b.text || '').join('');
          const m = full.match(/TRANSCRIPTION\s*[—–:-]*\s*([\s\S]*?)(?=IDENTIFICATION|```|\{\s*")/);
          const transcription = m ? m[1].trim().slice(0, 8000) : '';
          const illisibles = (transcription.match(/ILLISIBLE/g) || []).length;
          if (transcription.length > 150 && illisibles < 5) {
            pool.query(`
              INSERT INTO produits_kb (ref, notice_file, transcription, updated_at)
              VALUES ($1, $2, $3, NOW())
              ON CONFLICT (ref) DO UPDATE SET notice_file = $2, transcription = $3, updated_at = NOW()
            `, [payload.ref_produit.trim(), noticeInfo.ref + '.pdf', transcription])
              .then(() => console.log('🧠 Transcription mémorisée:', payload.ref_produit, '(' + transcription.length + ' car.)'))
              .catch(e => console.warn('KB sauvegarde:', e.message));
          } else {
            console.log('🧠 Transcription non mémorisée (trop courte ou illisible):', payload.ref_produit);
          }
        } catch(e) { console.warn('KB extraction:', e.message); }
      }

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
