// ═══════════════════════════════════════════════════════════════════
// 🧾 Outil AVOIRS SU — espace de dépôt partagé des fichiers sources
//   • FOB : sélections « OUTDOOR FOB AND DDP » (prix FOB par EAN)
//   • DDP : classeurs « FACTURES SU » (n° de facture / avoir par EAN)
// Le navigateur lit les Excel et n'envoie qu'un index compact ; le
// serveur le garde (Postgres) pour que tout le monde ait les mêmes sources.
// API protégée par un code propre à l'outil (header x-avoirs-code).
// ═══════════════════════════════════════════════════════════════════
let D = null, pret = null, cacheCode = { t: 0, v: null };

function init(deps) { D = deps; }

async function initDB() {
  if (pret) return pret;
  pret = (async () => {
    await D.pool.query(`CREATE TABLE IF NOT EXISTS app_meta (cle TEXT PRIMARY KEY, valeur TEXT)`);
    await D.pool.query(`CREATE TABLE IF NOT EXISTS avoirs_sources (
      nom TEXT PRIMARY KEY, type TEXT NOT NULL, annee INT, nb INT DEFAULT 0,
      maj TIMESTAMPTZ DEFAULT NOW(), data JSONB NOT NULL)`);
  })().catch(e => { pret = null; throw e; });
  return pret;
}

function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}
async function codeActuel() {
  if (cacheCode.v && Date.now() - cacheCode.t < 30000) return cacheCode.v;
  await initDB();
  await D.pool.query("INSERT INTO app_meta (cle, valeur) VALUES ('avoirs_code', $1) ON CONFLICT (cle) DO NOTHING", [genCode()]);
  const r = await D.pool.query("SELECT valeur FROM app_meta WHERE cle = 'avoirs_code'");
  cacheCode = { t: Date.now(), v: r.rows[0].valeur };
  return cacheCode.v;
}

function json(res, st, o) {
  res.writeHead(st, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(o));
}
function lireCorps(req, max) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0, trop = false;
    req.on('data', c => { n += c.length; if (n > max) { trop = true; return; } parts.push(c); });
    req.on('end', () => {
      if (trop) return reject(new Error('fichier trop volumineux'));
      try { const s = Buffer.concat(parts).toString('utf8'); resolve(s ? JSON.parse(s) : {}); }
      catch (e) { reject(new Error('JSON invalide')); }
    });
    req.on('error', reject);
  });
}

// Routes publiques de l'outil (protégées par le code avoirs)
async function handleApp(req, res) {
  const u = req.url || '';
  if (!u.startsWith('/avoirs-api/')) return false;
  try {
    if (!D || !D.pool) { json(res, 503, { error: 'Base de données indisponible' }); return true; }
    const code = String(req.headers['x-avoirs-code'] || '').trim().toUpperCase();
    if (!code || code !== String(await codeActuel()).toUpperCase()) {
      await new Promise(r => setTimeout(r, 400));
      json(res, 401, { error: 'code' }); return true;
    }
    const p = req.method === 'POST' ? await lireCorps(req, 40 * 1024 * 1024) : {};

    if (u.startsWith('/avoirs-api/sources')) {
      const r = await D.pool.query('SELECT nom, type, annee, nb, maj FROM avoirs_sources ORDER BY type, annee DESC NULLS LAST, nom');
      json(res, 200, { ok: true, sources: r.rows }); return true;
    }
    if (u.startsWith('/avoirs-api/index')) {
      const r = await D.pool.query('SELECT nom, type, annee, maj, data FROM avoirs_sources');
      json(res, 200, { ok: true, sources: r.rows }); return true;
    }
    if (u.startsWith('/avoirs-api/deposer')) {
      const nom = String(p.nom || '').trim().slice(0, 200);
      const type = p.type === 'DDP' ? 'DDP' : p.type === 'FOB' ? 'FOB' : '';
      if (!nom || !type || !Array.isArray(p.data)) { json(res, 400, { error: 'nom, type et data requis' }); return true; }
      const annee = parseInt(p.annee, 10) || null;
      await D.pool.query(`INSERT INTO avoirs_sources (nom, type, annee, nb, maj, data) VALUES ($1,$2,$3,$4,NOW(),$5)
        ON CONFLICT (nom) DO UPDATE SET type=$2, annee=$3, nb=$4, maj=NOW(), data=$5`,
        [nom, type, annee, p.data.length, JSON.stringify(p.data)]);
      json(res, 200, { ok: true, nom, nb: p.data.length }); return true;
    }
    if (u.startsWith('/avoirs-api/supprimer')) {
      const r = await D.pool.query('DELETE FROM avoirs_sources WHERE nom = $1', [String(p.nom || '')]);
      json(res, 200, { ok: true, supprime: r.rowCount }); return true;
    }
    json(res, 404, { error: 'route inconnue' }); return true;
  } catch (e) {
    json(res, 500, { error: e.message }); return true;
  }
}

// Routes internes (APP_SECRET déjà vérifié par server.js)
async function handleExt(req, res) {
  if (req.url.startsWith('/avoirs-ext/code')) { json(res, 200, { ok: true, code: await codeActuel() }); return; }
  json(res, 404, { error: 'route inconnue' });
}

module.exports = { init, handleApp, handleExt };
