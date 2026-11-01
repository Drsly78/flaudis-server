// ── 📦 App préparateurs ─────────────────────────────────────────────
// Liste des dossiers « envoi pièce » (onglet SYSTEME U) pas encore expédiés,
// enrichis des infos et pièces jointes captées au scan Revers.io.
//   GET  /prepa                     → la page de l'app (aucun secret dedans)
//   /prepa-api/*                    → routes de l'app, protégées par le CODE préparateurs
//   /prepa-ext/*                    → routes de l'extension, protégées par APP_SECRET (contrôlé par server.js)
// Règles Sheet SYSTEME U : A date récep · B date expé (« x » = préparé) · C réf · D pièce
//                         E enseigne · F dépt+ville · G emplacement puis tracking · H USV · I FLA
'use strict';
const crypto = require('crypto');

let D = null;     // dépendances injectées par server.js
let pret = null;  // promesse d'init DB (une seule fois)

const DEBUT_REVERS = '2026-07-01';            // avant : pas de Revers.io
const PURGE_EXPEDIE_JOURS = 30;
const PURGE_ORPHELIN_JOURS = 60;
const MAX_FICHIER = 9 * 1024 * 1024;
const EAN_CSV = 'https://raw.githubusercontent.com/Drsly78/flaudis-notices/main/ean-ref.csv';

function init(deps) { D = deps; }

async function initDB() {
  if (pret) return pret;
  pret = (async () => {
    const q = s => D.pool.query(s);
    await q(`CREATE TABLE IF NOT EXISTS prepa_dossiers (
      cle TEXT PRIMARY KEY, cnb TEXT, fla TEXT, ean TEXT, modele TEXT, couleur TEXT,
      description_panne TEXT, message_magasin TEXT, revers_url TEXT, source TEXT,
      maj TIMESTAMPTZ DEFAULT NOW(), prepare_le TIMESTAMPTZ, transporteur TEXT,
      expedie_le TIMESTAMPTZ, rattrapage_le TIMESTAMPTZ)`);
    await q(`CREATE TABLE IF NOT EXISTS prepa_fichiers (
      id SERIAL PRIMARY KEY, cle TEXT NOT NULL, nom TEXT, type_doc TEXT, media TEXT,
      taille INT, empreinte TEXT, data BYTEA, cree TIMESTAMPTZ DEFAULT NOW())`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS prepa_fichiers_uniq ON prepa_fichiers (cle, empreinte)`);
    await q(`CREATE INDEX IF NOT EXISTS prepa_fichiers_cle ON prepa_fichiers (cle)`);
    await q(`CREATE TABLE IF NOT EXISTS app_meta (cle TEXT PRIMARY KEY, valeur TEXT)`);
    await q(`ALTER TABLE prepa_dossiers ADD COLUMN IF NOT EXISTS colis INT`);
    await q(`ALTER TABLE prepa_dossiers ADD COLUMN IF NOT EXISTS texte_demande TEXT`);
    await q(`ALTER TABLE prepa_dossiers ADD COLUMN IF NOT EXISTS texte_brut TEXT`);
    await q(`ALTER TABLE prepa_dossiers ADD COLUMN IF NOT EXISTS texte_le TIMESTAMPTZ`);
    await q(`ALTER TABLE prepa_dossiers ADD COLUMN IF NOT EXISTS stock_retraits JSONB`);
  })();
  try { await pret; } catch (e) { pret = null; throw e; }
}

// ── Outils ──
const N = v => String(v == null ? '' : v).trim().toUpperCase();
const cleDe = (cnb, fla) => N(cnb) || (N(fla) ? 'FLA:' + N(fla) : '');
const sansBis = v => String(v || '').trim().replace(/\/bis\d*$/i, '');
function isoDe(v) {
  const t = String(v || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (m) return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return null;
}
const estTracking = v => /^\d{8,}$/.test(String(v || '').replace(/\s/g, ''));
// Texte magasin : on retire les automatismes du formulaire Revers.io
// (« Pour traiter votre SAV, merci de… : true », cases cochées « …: true/false »)
function nettoyerMessage(t) {
  return String(t == null ? '' : t)
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^null$/i.test(l))
    .filter(l => !/pour traiter votre sav/i.test(l))
    .filter(l => !/:\s*(true|false|vrai|faux|oui|non)\s*$/i.test(l))
    .map(l => l
      .replace(/^description d[ée]taill[ée]e du probl[èe]me\s*\/?\s*(informations pour le fournisseur)?\s*:\s*/i, '')
      .replace(/^informations pour le fournisseur\s*:\s*/i, '')
      .replace(/^label de la pi[èe]ce identifi[ée]e\s*:\s*/i, 'Pièce signalée : '))
    .filter(Boolean)
    .join('\n')
    .trim();
}
// Magasin exact, lu dans la fiche client Revers.io (texte brut) : nom + e-mail + téléphone.
// Deux magasins d'une même ville ont des e-mails différents.
function magasinDe(brut) {
  const t = String(brut || '');
  const pris = re => { const m = t.match(re); return m ? m[1].trim() : ''; };
  let nom = pris(/\nNom\n([^\n]+)/);
  const email = pris(/\nE-mail\n([^\n@\s]+@[^\n\s]+)/).toLowerCase();
  let tel = pris(/\nT[ée]l[ée]phone\n([+\d][\d .]{7,})/).replace(/\D/g, '');
  if (!nom || !tel) {
    const c = t.match(/Client : Coop[ée]rative U seller (.+?) \/ (\+?\d{8,})/);
    if (c) { nom = nom || c[1].trim(); tel = tel || c[2].replace(/\D/g, ''); }
  }
  const id = tel ? 'tel:' + tel.slice(-9) : email;   // le téléphone est présent dans les 2 blocs de la fiche : le plus fiable
  return { id, nom, email, tel };
}
// « 44 NANTES » → 44 ; Corse 2A/2B → 20 ; inconnu → tout à la fin
function deptDe(ville) {
  const m = String(ville || '').trim().match(/^(2A|2B|\d{2,3})\b/i);
  if (!m) return 999;
  return /^2[AB]$/i.test(m[1]) ? 20 : parseInt(m[1], 10);
}
const sansAccent = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

// ── Code préparateurs (stocké en base, changeable depuis l'extension) ──
let cacheCode = { t: 0, v: null };
function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += A[crypto.randomInt(A.length)];
  return s;
}
async function codeActuel() {
  if (cacheCode.v && Date.now() - cacheCode.t < 30000) return cacheCode.v;
  await initDB();
  let r = await D.pool.query("SELECT valeur FROM app_meta WHERE cle = 'prepa_code'");
  if (!r.rows.length || !r.rows[0].valeur) {
    await D.pool.query("INSERT INTO app_meta (cle, valeur) VALUES ('prepa_code', $1) ON CONFLICT (cle) DO NOTHING", [genCode()]);
    r = await D.pool.query("SELECT valeur FROM app_meta WHERE cle = 'prepa_code'");
  }
  cacheCode = { t: Date.now(), v: r.rows[0].valeur };
  return cacheCode.v;
}
async function definirCode(c) {
  await initDB();
  await D.pool.query("INSERT INTO app_meta (cle, valeur) VALUES ('prepa_code', $1) ON CONFLICT (cle) DO UPDATE SET valeur = $1", [c]);
  cacheCode = { t: Date.now(), v: c };
  return c;
}

// ── Sheet SYSTEME U (cache court : l'app se rafraîchit souvent) ──
let cacheSheet = { t: 0, rows: null };
async function lignesSU(force) {
  if (!force && cacheSheet.rows && Date.now() - cacheSheet.t < 45000) return cacheSheet.rows;
  const rows = await D.lireSheet("'SYSTEME U'!A:I");
  cacheSheet = { t: Date.now(), rows };
  return rows;
}
function analyser(rows) {
  const attente = [];
  const expedies = new Set();
  (rows || []).forEach((r, i) => {
    const cnb = String(r[7] || '').trim(), fla = String(r[8] || '').trim();
    if (!cnb && !fla) return;
    const iso = isoDe(r[0]);
    if (!iso || iso < DEBUT_REVERS) return;
    const b = String(r[1] || '').trim(), g = String(r[6] || '').trim();
    if (isoDe(b) || estTracking(g)) {
      if (cnb) expedies.add(N(cnb));
      if (fla) expedies.add(N(fla));
      return;
    }
    attente.push({
      ligne: i + 1, date: String(r[0] || '').trim(), iso,
      ref: String(r[2] || '').trim(), piece: String(r[3] || '').trim(),
      enseigne: String(r[4] || '').trim(), ville: String(r[5] || '').trim(),
      emplacement: g, cnb, fla, x: /^x$/i.test(b), b, cle: cleDe(cnb, fla)
    });
  });
  return { attente, expedies };
}

// ── EAN de secours (dossiers pas encore scannés) : référentiel EAN public ──
let cacheEan = { t: 0, parRef: null };
async function eanParRef() {
  if (cacheEan.parRef && Date.now() - cacheEan.t < 6 * 3600 * 1000) return cacheEan.parRef;
  const parRef = {};
  try {
    const txt = D.chargerEanCsv ? await D.chargerEanCsv() : await fetch(EAN_CSV).then(r => r.text());
    String(txt || '').split(/\r?\n/).slice(1).forEach(l => {
      const [ean, ref] = l.split(';');
      if (ean && ref && /^\d{8,14}$/.test(ean.trim())) {
        const k = N(ref);
        if (!parRef[k]) parRef[k] = ean.trim();
      }
    });
  } catch (e) { /* pas bloquant */ }
  cacheEan = { t: Date.now(), parRef };
  return parRef;
}
function eanDeRef(parRef, ref) {
  const k = N(ref);
  if (!k) return '';
  if (parRef[k]) return parRef[k];
  const cands = Object.keys(parRef).filter(r => r.startsWith(k + ' ') || r.startsWith(k + '-'));
  return cands.length === 1 ? parRef[cands[0]] : '';
}

// ── Liste de l'app ──
async function construireListe(force) {
  await initDB();
  const rows = await lignesSU(force);
  const { attente, expedies } = analyser(rows);
  const dos = (await D.pool.query('SELECT * FROM prepa_dossiers')).rows;
  const parCnb = {}, parFla = {};
  dos.forEach(d => { if (d.cnb) parCnb[N(d.cnb)] = d; if (d.fla) parFla[N(d.fla)] = d; });
  const fich = (await D.pool.query('SELECT id, cle, nom, type_doc, media, taille FROM prepa_fichiers ORDER BY id')).rows;
  const fParCle = {};
  fich.forEach(f => { (fParCle[f.cle] = fParCle[f.cle] || []).push({ id: f.id, nom: f.nom || '', type_doc: f.type_doc || '', media: f.media || '', taille: f.taille || 0 }); });
  // URL Revers.io de secours : table dossiers remplie à chaque scan
  const urls = {};
  try {
    (await D.pool.query("SELECT numero_dossier, fla, revers_url FROM dossiers WHERE revers_url IS NOT NULL AND revers_url <> ''")).rows
      .forEach(x => { if (x.numero_dossier) urls[N(x.numero_dossier)] = x.revers_url; if (x.fla) urls[N(x.fla)] = x.revers_url; });
  } catch (e) {}
  const eans = await eanParRef();

  const items = attente.map(a => {
    const d = parCnb[N(a.cnb)] || parFla[N(a.fla)] || null;
    a.prepare = a.x || !!(d && d.prepare_le);
    const mg = magasinDe(d && d.texte_brut);
    const fichiers = (d && fParCle[d.cle]) || fParCle[a.cle] || [];
    return {
      cle: a.cle, ligne: a.ligne, date: a.date, iso: a.iso,
      cnb: a.cnb, fla: a.fla, enseigne: a.enseigne, ville: a.ville,
      ref: a.ref, piece: a.piece, emplacement: a.emplacement, prepare: a.prepare, x: a.x, b_autre: (!a.x && a.b) ? a.b : '',
      transporteur: (d && d.transporteur) || '',
      colis: (a.prepare && d && d.colis) || null,
      dept: deptDe(a.ville),
      magasin_id: mg.id, magasin_nom: mg.nom, magasin_tel: mg.tel,
      ean: (d && d.ean) || eanDeRef(eans, a.ref),
      modele: (d && d.modele) || '', couleur: (d && d.couleur) || '',
      description_panne: (d && d.description_panne) || '',
      message_magasin: nettoyerMessage(d && d.message_magasin),
      texte_demande: nettoyerMessage(d && d.texte_demande),
      prepare_le: (a.prepare && d && d.prepare_le) ? new Date(d.prepare_le).toISOString() : null,
      stock_retraits: (a.prepare && d && d.stock_retraits) || null,
      revers_url: (d && d.revers_url) || urls[N(sansBis(a.cnb))] || urls[N(sansBis(a.fla))] || '',
      avec_donnees: !!(d && (d.description_panne || d.message_magasin || d.ean)),
      fichiers
    };
  }).sort((x, y) => (x.dept - y.dept)
    || sansAccent(x.ville).localeCompare(sansAccent(y.ville))
    || sansAccent(x.enseigne).localeCompare(sansAccent(y.enseigne))
    || (x.iso < y.iso ? -1 : x.iso > y.iso ? 1 : x.ligne - y.ligne));

  // Regroupement par magasin : enseigne + ville, puis séparation si les fiches Revers.io
  // montrent plusieurs magasins distincts (e-mails différents) dans la même ville.
  const parBase = {};
  items.forEach(it => { const b = sansAccent(it.enseigne) + '|' + sansAccent(it.ville); (parBase[b] = parBase[b] || []).push(it); });
  Object.keys(parBase).forEach(b => {
    const ids = [...new Set(parBase[b].map(it => it.magasin_id).filter(Boolean))];
    parBase[b].forEach(it => {
      if (ids.length <= 1) { it.mag_cle = b; it.mag_multi = false; if (!it.magasin_nom && ids.length) it.magasin_nom = (parBase[b].find(x => x.magasin_nom) || {}).magasin_nom || ''; }
      else { it.mag_cle = b + '#' + (it.magasin_id || '?'); it.mag_multi = true; }
    });
  });

  // Ménage : marquer les expédiés, purger les vieux (jamais si le Sheet n'a pas été lu)
  try {
    const enAttente = new Set();
    attente.forEach(a => { if (a.cnb) enAttente.add(N(a.cnb)); if (a.fla) enAttente.add(N(a.fla)); });
    const aMarquer = dos.filter(d => !d.expedie_le && ((d.cnb && expedies.has(N(d.cnb))) || (d.fla && expedies.has(N(d.fla))))
      && !((d.cnb && enAttente.has(N(d.cnb))) || (d.fla && enAttente.has(N(d.fla)))));
    for (const d of aMarquer) await D.pool.query('UPDATE prepa_dossiers SET expedie_le = NOW() WHERE cle = $1', [d.cle]);
    const vieux = (await D.pool.query(
      `SELECT cle, cnb, fla FROM prepa_dossiers WHERE (expedie_le IS NOT NULL AND expedie_le < NOW() - INTERVAL '${PURGE_EXPEDIE_JOURS} days')
         OR (expedie_le IS NULL AND maj < NOW() - INTERVAL '${PURGE_ORPHELIN_JOURS} days')`)).rows
      .filter(d => !((d.cnb && enAttente.has(N(d.cnb))) || (d.fla && enAttente.has(N(d.fla)))));
    for (const d of vieux) {
      await D.pool.query('DELETE FROM prepa_fichiers WHERE cle = $1', [d.cle]);
      await D.pool.query('DELETE FROM prepa_dossiers WHERE cle = $1', [d.cle]);
    }
  } catch (e) { console.warn('Prépa ménage :', e.message); }

  return items;
}

// ── Lecture d'un corps JSON (routes de l'app, avant le parseur général) ──
function lireCorps(req, max) {
  return new Promise((resolve, reject) => {
    let s = '', n = 0, trop = false;
    req.on('data', c => { n += c.length; if (n > max) { trop = true; return; } s += c; });
    req.on('end', () => {
      if (trop) return reject(new Error('requête trop volumineuse'));
      try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('JSON invalide')); }
    });
    req.on('error', reject);
  });
}

const APP_ENTREPOT = 'https://drsly78.github.io/flaudis-notices/notices-app.html#prepa';
const ONGLET_ENTREPOT = 'Pour SAV Entrepôt';

// Retrouve la ligne Sheet d'un dossier et vérifie qu'elle n'a pas bougé
async function ligneVerifiee(cle, ligneAnnoncee) {
  const rows = await lignesSU(true);
  const ok = i => { const r = rows[i - 1]; return r && cleDe(r[7], r[8]) === cle; };
  if (ligneAnnoncee && ok(ligneAnnoncee)) return { ligne: ligneAnnoncee, r: rows[ligneAnnoncee - 1] };
  for (let i = rows.length; i >= 1; i--) if (ok(i)) return { ligne: i, r: rows[i - 1] };
  return null;
}

// ═════ Routes de l'APP (code préparateurs) ═════
async function handleApp(req, res) {
  const u = req.url || '';
  if (!(u === '/prepa' || u === '/prepa/' || u.startsWith('/prepa?') || u.startsWith('/prepa-api/'))) return false;
  try {
    if (!u.startsWith('/prepa-api/')) {
      // L'app vit désormais dans l'app Entrepôt (section 📦 Prépa SAV), à côté des notices
      res.writeHead(302, { Location: APP_ENTREPOT, 'Cache-Control': 'no-cache' });
      res.end();
      return true;
    }
    if (!D || !D.pool) { json(res, 503, { error: 'Base de données indisponible' }); return true; }
    const code = String(req.headers['x-prepa-code'] || (u.match(/[?&]c=([^&]+)/) || [])[1] || '').trim().toUpperCase();
    if (!code || code !== N(await codeActuel())) {
      await new Promise(r => setTimeout(r, 400));
      json(res, 401, { error: 'code' });
      return true;
    }

    // Fichier (photo / ticket)
    const mF = u.match(/^\/prepa-api\/fichier\/(\d+)/);
    if (mF) {
      const r = await D.pool.query('SELECT nom, media, data FROM prepa_fichiers WHERE id = $1', [parseInt(mF[1], 10)]);
      if (!r.rows.length) { json(res, 404, { error: 'introuvable' }); return true; }
      const f = r.rows[0];
      const nom = String(f.nom || 'fichier').replace(/[^\w.\- ]+/g, '_');
      res.writeHead(200, {
        'Content-Type': f.media || 'application/octet-stream',
        'Content-Disposition': 'inline; filename="' + nom + '"',
        'Cache-Control': 'private, max-age=86400'
      });
      res.end(f.data);
      return true;
    }

    const p = req.method === 'POST' ? await lireCorps(req, 64 * 1024) : {};

    if (u.startsWith('/prepa-api/liste')) {
      json(res, 200, { ok: true, items: await construireListe(!!p.force), maintenant: new Date().toISOString() });
      return true;
    }

    // ✅ Préparer un ou plusieurs dossiers dans UN colis — transporteur obligatoire.
    // Préparé = « x » en colonne B du Sheet (convention du bordereau de tracking).
    if (u.startsWith('/prepa-api/preparer')) {
      const cles = [...new Set((Array.isArray(p.cles) ? p.cles : []).map(N).filter(Boolean))];
      if (!cles.length) { json(res, 400, { error: 'Aucun dossier sélectionné.' }); return true; }
      let transp = N(p.transporteur);
      let colis = null;
      if (p.colis && p.colis !== 'nouveau') {
        colis = parseInt(p.colis, 10);
        const ex = await D.pool.query('SELECT transporteur FROM prepa_dossiers WHERE colis = $1 AND prepare_le IS NOT NULL AND expedie_le IS NULL LIMIT 1', [colis]);
        if (!ex.rows.length) { json(res, 409, { error: 'Le colis ' + colis + ' n\u2019existe plus (expédié ou défait) — rafraîchis.' }); return true; }
        transp = N(ex.rows[0].transporteur) || transp;
      }
      if (transp !== 'DSV' && transp !== 'DPD') { json(res, 400, { error: 'Choisis le transporteur (DSV ou DPD) avant de valider.' }); return true; }
      // Vérifications AVANT toute écriture : tout passe ou rien ne bouge
      const lignes = p.lignes || {};
      const plan = [];
      for (const cle of cles) {
        const v = await ligneVerifiee(cle, parseInt(lignes[cle], 10) || 0);
        if (!v) { json(res, 404, { error: cle + ' introuvable dans SYSTEME U (ligne déplacée ou supprimée ?) — rafraîchis.' }); return true; }
        const b = String(v.r[1] || '').trim();
        if (isoDe(b)) { json(res, 409, { error: cle + ' est déjà marqué expédié dans le Sheet.' }); return true; }
        if (b && !/^x$/i.test(b)) { json(res, 409, { error: cle + ' : la colonne B contient « ' + b + ' » — je ne l\u2019écrase pas. Corrige-la dans le Sheet.' }); return true; }
        plan.push({ cle, v, b });
      }
      if (!colis) {
        const r = await D.pool.query(
          `INSERT INTO app_meta (cle, valeur) VALUES ('prepa_colis_seq', '1')
           ON CONFLICT (cle) DO UPDATE SET valeur = (CAST(app_meta.valeur AS INT) + 1)::TEXT RETURNING valeur`);
        colis = parseInt(r.rows[0].valeur, 10);
      }
      const retraitsDe = cle => {
        const r = (p.retraits && typeof p.retraits === 'object') ? p.retraits[cle] : null;
        if (!r || typeof r !== 'object') return null;
        const o = {};
        Object.entries(r).forEach(([k, n]) => {
          n = parseInt(n, 10);
          if (n > 0 && n < 100000 && /^[^|.#$\[\]]+\|[^|.#$\[\]\/]+\|[^|.#$\[\]\/]+$/.test(k)) o[k] = n;
        });
        return Object.keys(o).length ? JSON.stringify(o) : null;
      };
      for (const x of plan) {
        await D.pool.query(
          `INSERT INTO prepa_dossiers (cle, cnb, fla, prepare_le, transporteur, colis, stock_retraits, maj) VALUES ($1,$2,$3,NOW(),$4,$5,$6,NOW())
           ON CONFLICT (cle) DO UPDATE SET prepare_le = NOW(), transporteur = $4, colis = $5, stock_retraits = $6, expedie_le = NULL`,
          [x.cle, String(x.v.r[7] || '').trim(), String(x.v.r[8] || '').trim(), transp, colis, retraitsDe(x.cle)]);
      }
      json(res, 200, { ok: true, colis, transporteur: transp, cles: plan.map(x => x.cle) });
      return true;
    }

    // ↩︎ Retirer « préparé » d'un dossier (il sort de son colis)
    if (u.startsWith('/prepa-api/annuler')) {
      const cle = N(p.cle);
      const v = await ligneVerifiee(cle, parseInt(p.ligne, 10) || 0);
      if (!v) { json(res, 404, { error: 'Dossier introuvable dans SYSTEME U — rafraîchis.' }); return true; }
      const b = String(v.r[1] || '').trim();
      if (isoDe(b)) { json(res, 409, { error: 'Déjà expédié dans le Sheet — rien à annuler.' }); return true; }
      if (/^x$/i.test(b)) await D.ecrireCellules([["'SYSTEME U'!B" + v.ligne, '']]);
      cacheSheet.t = 0;
      // les pièces retirées du stock à la préparation sont rendues à l'app, qui les remet dans leur carton
      const av = await D.pool.query('UPDATE prepa_dossiers d SET prepare_le = NULL, colis = NULL, stock_retraits = NULL FROM (SELECT cle, stock_retraits FROM prepa_dossiers WHERE cle = $1 FOR UPDATE) o WHERE d.cle = o.cle RETURNING o.stock_retraits', [cle]);
      json(res, 200, { ok: true, stock_retraits: (av.rows[0] && av.rows[0].stock_retraits) || null });
      return true;
    }

    // ✍️ Écrire les « x » en colonne B pour les dossiers préparés (lus par l'import des trackings).
    // Rejouable : seuls les dossiers préparés sans x sont écrits ; les colis restent ouverts.
    if (u.startsWith('/prepa-api/ecrire-x')) {
      const items = await construireListe(true);
      const voulu = Array.isArray(p.cles) && p.cles.length ? new Set(p.cles.map(N)) : null;
      const cibles = items.filter(it => it.prepare && !it.x && (!voulu || voulu.has(it.cle)));
      const ecrits = [], refuses = [];
      const aEcrire = [];
      for (const it of cibles) {
        const v = await ligneVerifiee(it.cle, it.ligne);
        if (!v) { refuses.push({ cle: it.cle, raison: 'introuvable dans SYSTEME U' }); continue; }
        const b = String(v.r[1] || '').trim();
        if (/^x$/i.test(b)) continue;
        if (b) { refuses.push({ cle: it.cle, raison: 'colonne B = « ' + b + ' »' }); continue; }
        aEcrire.push(["'SYSTEME U'!B" + v.ligne, 'x']);
        ecrits.push(it.cle);
      }
      if (aEcrire.length) await D.ecrireCellules(aEcrire);
      cacheSheet.t = 0;
      json(res, 200, { ok: true, ecrits, refuses });
      return true;
    }

    // 📋 Remplir le tableau de l'onglet « Pour SAV Entrepôt » (A2:H) avec les dossiers demandés,
    // valeurs reprises de SYSTEME U (mêmes colonnes A→H, même ordre). Mise en forme conservée.
    if (u.startsWith('/prepa-api/remplir-entrepot')) {
      const cles = (Array.isArray(p.cles) ? p.cles : []).map(N).filter(Boolean);
      if (!cles.length) { json(res, 400, { error: 'Aucun dossier à écrire.' }); return true; }
      const items = await construireListe(true);
      const parCle = {};
      items.forEach(it => { parCle[it.cle] = it; });
      const rows = await lignesSU(false);
      const lignes = [];
      let ignoresX = 0;
      cles.forEach(c => {
        const it = parCle[c];
        if (!it) return;
        if (it.x) { ignoresX++; return; }   // x déjà écrit : le colis part, il ne revient pas dans la liste de prépa
        const r = rows[it.ligne - 1] || [];
        if (cleDe(r[7], r[8]) !== c) return;
        // B : jamais le « x » (c'est la date d'expédition)
        lignes.push([r[0] || '', isoDe(r[1]) ? r[1] : '', r[2] || '', r[3] || '', r[4] || '', r[5] || '', r[6] || '', r[7] || r[8] || '']);
      });
      if (!lignes.length) { json(res, 409, { error: ignoresX ? 'Tous ces dossiers ont déjà leur x : rien à remettre dans « Pour SAV Entrepôt ».' : 'Dossiers introuvables dans SYSTEME U — rafraîchis.' }); return true; }
      const onglet = "'" + ONGLET_ENTREPOT.replace(/'/g, "''") + "'";
      const avant = await D.lireSheet(onglet + '!A2:H');
      await D.viderPlage(onglet + '!A2:H' + Math.max(2, avant.length + 1));
      await D.ecrirePlage(onglet + '!A2:H' + (lignes.length + 1), lignes);
      json(res, 200, { ok: true, ecrites: lignes.length, effacees: avant.length, ignores_x: ignoresX });
      return true;
    }

    // 🚚 Changer le transporteur d'un colis entier
    if (u.startsWith('/prepa-api/colis-transporteur')) {
      const t = N(p.transporteur);
      if (t !== 'DSV' && t !== 'DPD') { json(res, 400, { error: 'transporteur inconnu' }); return true; }
      const r = await D.pool.query('UPDATE prepa_dossiers SET transporteur = $1 WHERE colis = $2 AND prepare_le IS NOT NULL', [t, parseInt(p.colis, 10)]);
      json(res, 200, { ok: true, transporteur: t, n: r.rowCount });
      return true;
    }

    // 🚚 Transporteur choisi (DSV / DPD / aucun)
    if (u.startsWith('/prepa-api/transporteur')) {
      const t = N(p.transporteur);
      if (t && t !== 'DSV' && t !== 'DPD') { json(res, 400, { error: 'transporteur inconnu' }); return true; }
      const cle = N(p.cle) || cleDe(p.cnb, p.fla);
      if (!cle) { json(res, 400, { error: 'dossier manquant' }); return true; }
      await D.pool.query(
        `INSERT INTO prepa_dossiers (cle, cnb, fla, transporteur, maj) VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (cle) DO UPDATE SET transporteur = $4`,
        [cle, String(p.cnb || '').trim(), String(p.fla || '').trim(), t || null]);
      json(res, 200, { ok: true, transporteur: t });
      return true;
    }

    json(res, 404, { error: 'route inconnue' });
    return true;
  } catch (e) {
    console.error('Prépa app :', e.message);
    json(res, 500, { error: e.message });
    return true;
  }
}

// ── Extraction IA légère pour le rattrapage (dossiers validés avant l'app) ──
async function extraireTextes(textes) {
  if (!D.callAnthropic) return {};
  const t = String(textes || '').slice(0, 12000);
  if (t.length < 40) return {};
  const ai = await D.callAnthropic({
    model: D.MODEL_LIGHT,
    max_tokens: 1800, messages: [{ role: 'user', content: [{ type: 'text', text:
`Voici le texte brut des pages « résumé » et « produit » d'un dossier SAV Revers.io (produit défectueux signalé par un magasin Système U).

${t}

Extrais en JSON strict, sans texte autour :
{"ean":"code EAN 13 chiffres ou null","modele":"nom du produit ou null","couleur":"couleur si écrite, sinon null","description_panne":"synthèse du problème en 15 mots max, sans invention","message_magasin":"texte EXACT du commentaire écrit par le magasin, recopié tel quel, ou null","demande_complete":"TOUT le contenu de la section commentaire / description de la demande du magasin, recopié MOT POUR MOT, avec chaque champ sur sa ligne (libellé : valeur), sans résumer, sans reformuler, sans rien ajouter ; null si la section est absente"}
IGNORE les mentions automatiques du formulaire (ex : « Pour traiter votre SAV, merci de nous envoyer et entourer sur la notice… : true », toute ligne finissant par « : true » ou « : false ») : ce ne sont pas des commentaires du magasin.` }] }]
  });
  const raw = (ai.content || []).map(b => b.text || '').join('');
  const p = D.parseJsonModel ? D.parseJsonModel(raw) : null;
  return p || {};
}

// ═════ Routes de l'EXTENSION (APP_SECRET déjà vérifié par server.js) ═════
async function handleExt(req, res, p) {
  const u = req.url || '';
  try {
    if (!D || !D.pool) { json(res, 503, { error: 'Base de données indisponible' }); return; }
    await initDB();

    if (u === '/prepa-ext/code') {
      let c;
      if (p.nouveau === true) c = await definirCode(genCode());
      else if (typeof p.nouveau === 'string') {
        const v = N(p.nouveau).replace(/\s/g, '');
        if (!/^[A-Z0-9]{4,20}$/.test(v)) { json(res, 400, { error: 'Code : 4 à 20 lettres ou chiffres' }); return; }
        c = await definirCode(v);
      } else c = await codeActuel();
      json(res, 200, { ok: true, code: c });
      return;
    }

    // Texte brut d'un dossier (LECTURE SEULE, diagnostic)
    if (u === '/prepa-ext/brut') {
      const r = await D.pool.query('SELECT cle, texte_brut FROM prepa_dossiers WHERE texte_brut IS NOT NULL ORDER BY maj DESC LIMIT $1', [Math.min(parseInt(p.n, 10) || 3, 20)]);
      json(res, 200, { ok: true, dossiers: r.rows.map(x => ({ cle: x.cle, texte: String(x.texte_brut).slice(0, parseInt(p.taille, 10) || 2500) })) });
      return;
    }

    // Aperçu LECTURE SEULE d'un onglet du Sheet (entêtes + premières lignes)
    if (u === '/prepa-ext/apercu-onglet') {
      const nom = String(p.onglet || '').replace(/'/g, "''");
      const plage = /^[A-Z]{1,2}\d{1,6}:[A-Z]{1,2}\d{1,6}$/.test(String(p.plage || '')) ? p.plage : 'A1:Z' + Math.min(parseInt(p.lignes, 10) || 12, 60);
      const rows = await D.lireSheet("'" + nom + "'!" + plage);
      json(res, 200, { ok: true, rows });
      return;
    }

    if (u === '/prepa-ext/save') {
      const cnb = String(p.cnb || '').trim(), fla = String(p.fla || '').trim();
      const cle = cleDe(cnb, fla);
      if (!cle) { json(res, 400, { error: 'USV ou FLA manquant' }); return; }
      const source = p.source === 'rattrapage' ? 'rattrapage' : 'scan';
      const v = {
        ean: p.ean, modele: p.modele, couleur: p.couleur,
        description_panne: p.description_panne, message_magasin: p.message_magasin, texte_demande: p.texte_demande
      };
      if (p.textes) {
        try {
          const ex = await extraireTextes(p.textes);
          ['ean', 'modele', 'couleur', 'description_panne', 'message_magasin'].forEach(k => { if (!v[k] && ex[k]) v[k] = ex[k]; });
          if (ex.demande_complete) v.texte_demande = ex.demande_complete;
        } catch (e) { console.warn('Prépa extraction :', e.message); }
      }
      const s = x => (x == null ? '' : String(x).trim()).replace(/^null$/i, '');
      const champs = ['ean', 'modele', 'couleur', 'description_panne', 'message_magasin', 'revers_url', 'texte_demande'];
      const brut = p.textes ? String(p.textes).slice(0, 15000) : '';
      const vals = [cle, cnb, fla, s(v.ean), s(v.modele), s(v.couleur), s(v.description_panne), nettoyerMessage(v.message_magasin), s(p.revers_url), source, nettoyerMessage(v.texte_demande), brut];
      // Scan = données fraîches qui priment ; rattrapage = ne comble que les trous
      const maj = champs.map(c => source === 'scan'
        ? `${c} = COALESCE(NULLIF(EXCLUDED.${c}, ''), prepa_dossiers.${c})`
        : `${c} = COALESCE(NULLIF(prepa_dossiers.${c}, ''), EXCLUDED.${c})`).join(', ');
      await D.pool.query(
        `INSERT INTO prepa_dossiers (cle, cnb, fla, ean, modele, couleur, description_panne, message_magasin, revers_url, source, texte_demande, texte_brut, texte_le, maj, rattrapage_le)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULLIF($12,''), ${brut ? 'NOW()' : 'NULL'}, NOW(), ${source === 'rattrapage' ? 'NOW()' : 'NULL'})
         ON CONFLICT (cle) DO UPDATE SET cnb = COALESCE(NULLIF(EXCLUDED.cnb,''), prepa_dossiers.cnb), fla = COALESCE(NULLIF(EXCLUDED.fla,''), prepa_dossiers.fla),
           ${maj}, texte_brut = COALESCE(NULLIF(EXCLUDED.texte_brut, ''), prepa_dossiers.texte_brut),
           texte_le = COALESCE(EXCLUDED.texte_le, prepa_dossiers.texte_le), source = CASE WHEN prepa_dossiers.source = 'scan' THEN 'scan' ELSE EXCLUDED.source END, maj = NOW(), expedie_le = NULL
           ${source === 'rattrapage' ? ', rattrapage_le = NOW()' : ''}`, vals);
      json(res, 200, { ok: true, cle });
      return;
    }

    if (u === '/prepa-ext/fichier') {
      const cle = N(p.cle);
      if (!cle) { json(res, 400, { error: 'cle manquante' }); return; }
      let buf;
      try { buf = Buffer.from(String(p.b64 || ''), 'base64'); } catch (e) { buf = null; }
      if (!buf || buf.length < 200) { json(res, 400, { error: 'fichier vide' }); return; }
      if (buf.length > MAX_FICHIER) { json(res, 413, { error: 'fichier trop gros (max 9 Mo)' }); return; }
      const media = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(p.media || '') ? p.media : 'application/octet-stream';
      const emp = crypto.createHash('sha1').update(buf).digest('hex');
      const r = await D.pool.query(
        `INSERT INTO prepa_fichiers (cle, nom, type_doc, media, taille, empreinte, data) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (cle, empreinte) DO NOTHING RETURNING id`,
        [cle, String(p.nom || '').slice(0, 200), String(p.type_doc || '').slice(0, 100), media, buf.length, emp, buf]);
      json(res, 200, { ok: true, id: r.rows.length ? r.rows[0].id : null, doublon: !r.rows.length });
      return;
    }

    // Dossiers en attente sans pièces jointes → à compléter par l'extension
    if (u === '/prepa-ext/manquants') {
      const items = await construireListe(true);
      const etat = {};
      (await D.pool.query('SELECT cle, rattrapage_le, texte_le FROM prepa_dossiers')).rows.forEach(x => { etat[x.cle] = x; });
      const cibles = [], sansUrl = [];
      items.forEach(it => {
        const e = etat[it.cle] || {};
        let mode = null;
        if (!it.fichiers.length && (p.forcer || !e.rattrapage_le)) mode = 'complet';
        else if (!e.texte_le) mode = 'textes';      // photos déjà là, description complète jamais importée
        if (!mode) return;
        if (it.revers_url) cibles.push({ cle: it.cle, cnb: it.cnb, fla: it.fla, ref: it.ref, revers_url: it.revers_url, mode });
        else if (mode === 'complet') sansUrl.push(it.cnb || it.fla);
      });
      json(res, 200, { ok: true, cibles, sans_url: sansUrl });
      return;
    }

    json(res, 404, { error: 'route prépa inconnue' });
  } catch (e) {
    console.error('Prépa ext :', e.message);
    json(res, 500, { error: e.message });
  }
}

module.exports = { init, handleApp, handleExt, _test: { analyser, isoDe, cleDe, eanDeRef, nettoyerMessage, deptDe, magasinDe, reset: () => { cacheSheet = { t: 0, rows: null }; cacheCode = { t: 0, v: null }; cacheEan = { t: 0, parRef: null }; pret = null; } } };
