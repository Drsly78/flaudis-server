// server.js — Flaudis Base Produits
// Dépôt d'offres usines (xls/xlsx/pptx/msg/pdf) -> extraction -> base -> recherche
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { db, DATA_DIR } = require('./lib/db');
const ex = require('./lib/extract');
const ia = require('./lib/ai');
const { proteger } = require('./lib/auth');

// Auto-réparation : ces migrations idempotentes tournent à chaque démarrage,
// même si lib/db.js n'est pas à jour sur le déploiement.
try { db.exec("ALTER TABLE fichiers ADD COLUMN dossier TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE fichiers ADD COLUMN mode TEXT NOT NULL DEFAULT 'offre'"); } catch {}
try { db.exec("ALTER TABLE produits ADD COLUMN dossier TEXT"); } catch {}
try { db.exec("ALTER TABLE produits ADD COLUMN extras TEXT"); } catch {}
try { db.exec("ALTER TABLE produits ADD COLUMN modifie_le TEXT"); } catch {}
try { db.exec("ALTER TABLE fichiers ADD COLUMN date_document TEXT"); } catch {}
db.exec(`CREATE TABLE IF NOT EXISTS listes (id INTEGER PRIMARY KEY, nom TEXT NOT NULL, creee_le TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS liste_items (id INTEGER PRIMARY KEY, liste_id INTEGER NOT NULL REFERENCES listes(id) ON DELETE CASCADE,
  produit_id INTEGER NOT NULL REFERENCES produits(id) ON DELETE CASCADE, ajoute_le TEXT DEFAULT (datetime('now','localtime')), UNIQUE(liste_id, produit_id));
CREATE TABLE IF NOT EXISTS doublons_valides (reference TEXT PRIMARY KEY, signature TEXT NOT NULL, valide_le TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS dossiers (chemin TEXT PRIMARY KEY, cree_le TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS produit_images (
  produit_id INTEGER NOT NULL REFERENCES produits(id) ON DELETE CASCADE,
  image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  UNIQUE(produit_id, image_id));`);
try { db.exec("ALTER TABLE produits ADD COLUMN ean TEXT"); } catch {}
try { db.exec("ALTER TABLE listes ADD COLUMN systeme INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE produit_images ADD COLUMN principale INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE listes ADD COLUMN enregistree INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE produits ADD COLUMN note TEXT"); } catch {}
try { db.exec("ALTER TABLE fichiers ADD COLUMN valide INTEGER NOT NULL DEFAULT 1"); } catch {}
db.exec("UPDATE fichiers SET valide=1 WHERE valide=0 AND mode IN ('interne','document')");
db.exec("UPDATE fichiers SET statut='en_attente' WHERE statut='en_cours'");
db.exec(`CREATE TABLE IF NOT EXISTS usines (
  id INTEGER PRIMARY KEY,
  nom_norm TEXT UNIQUE NOT NULL,
  nom_affiche TEXT NOT NULL,
  port TEXT, adresse TEXT, contact TEXT, telephone TEXT, email TEXT, messagerie TEXT, site TEXT,
  conditions TEXT, notes TEXT,
  enrichie_le TEXT, modifie_le TEXT,
  cree_le TEXT DEFAULT (datetime('now','localtime'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS tableaux (
  id INTEGER PRIMARY KEY, nom TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'retour_selection',
  sources TEXT NOT NULL DEFAULT '[]', resultat TEXT, statut TEXT NOT NULL DEFAULT 'vide',
  cree_le TEXT DEFAULT (datetime('now','localtime')), modifie_le TEXT DEFAULT (datetime('now','localtime')))`);
fs.mkdirSync(path.join(DATA_DIR, 'tableaux'), { recursive: true });
try { db.exec("ALTER TABLE tableaux ADD COLUMN journal TEXT NOT NULL DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE tableaux ADD COLUMN ajustements TEXT NOT NULL DEFAULT '{}'"); } catch {}
db.exec("INSERT INTO listes (nom, systeme) SELECT 'À trier', 1 WHERE NOT EXISTS (SELECT 1 FROM listes WHERE systeme=1)");
if (db.pragma('user_version', { simple: true }) < 1) {
  db.exec("INSERT OR IGNORE INTO produit_images (produit_id, image_id) SELECT produit_id, id FROM images WHERE produit_id IS NOT NULL");
  db.pragma('user_version = 1');
}
db.exec("UPDATE fichiers SET mode='document' WHERE type NOT IN ('xls','xlsx') AND mode != 'document'");
fs.mkdirSync(path.join(DATA_DIR, 'apercus'), { recursive: true });

process.on('unhandledRejection', (e) => console.error('[filet] promesse rejetée :', e && e.message || e));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } });
// page publique (exigée par Google pour la publication OAuth) — placée AVANT le mot de passe
app.get('/confidentialite', (req, res) => {
  res.type('html').send(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Règles de confidentialité — Flaudis Base Produits</title>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1c2742">
<h1>Règles de confidentialité</h1>
<p><b>Flaudis Base Produits</b> est un outil interne de gestion de base produits utilisé par Flaudis.</p>
<h2>Données traitées</h2>
<p>L'application traite des fichiers d'offres fournisseurs (tableurs, présentations, documents) déposés par ses utilisateurs autorisés,
ainsi que les fiches produits qui en sont extraites. Ces données sont stockées sur l'infrastructure d'hébergement de l'application et
ne sont ni vendues, ni partagées avec des tiers.</p>
<h2>Accès Google Drive</h2>
<p>Lorsque l'utilisateur connecte son compte Google, l'application demande uniquement le droit d'accéder aux fichiers
qu'elle crée elle-même (portée <code>drive.file</code>). Elle crée des feuilles de calcul temporaires dans un dossier dédié
(« Flaudis — temporaire ») du Drive de l'utilisateur, à des fins d'aperçu et d'édition, puis les supprime automatiquement.
L'application n'accède à aucun autre fichier du Drive de l'utilisateur.</p>
<h2>Cookies et suivi</h2>
<p>L'application n'utilise aucun outil publicitaire ni traceur tiers.</p>
<h2>Contact</h2>
<p>Pour toute question relative à ces règles, contactez l'administrateur de l'application.</p>
</body></html>`);
});
proteger(app, express);   // mot de passe si MOT_DE_PASSE est défini
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- INGESTION ----------
app.post('/api/depot', upload.array('fichiers', 40), async (req, res) => {
  // dossier de rangement : "2027/GARDEN/VERTAK" — nettoyé, créé implicitement
  const dossier = String(req.body.dossier || '')
    .replace(/\\/g, '/').split('/').map(s => s.trim()).filter(Boolean)
    .map(s => s.replace(/[^\w\s.\-()&+]/g, '')).join('/').slice(0, 200);
  const mode = ['interne', 'offre', 'auto'].includes(req.body.mode) ? req.body.mode : 'auto';
  const rapports = [];
  const fichiersRecus = req.files || [];
  let datesClient = [];
  try { datesClient = JSON.parse(req.body.dates_modif || '[]'); } catch {}
  // enregistrement immédiat (hash, copie disque, ligne en base) — l'analyse lourde part en file d'attente
  for (let i = 0; i < fichiersRecus.length; i++) {
    const f = fichiersRecus[i];
    rapports.push(ingererFichier(f.originalname, f.buffer, dossier, mode, datesClient[i]));
  }
  res.json({ rapports });
  setTimeout(pomperFile, 400); // laisse la réponse partir avant d'attaquer l'analyse (lectures Excel bloquantes)
});

/** Document interne détecté : refusé — la base ne conserve que des offres usines. */
function refuserInterne(fichierId, rapport, nomDisque, motif) {
  rapport.statut = 'refuse';
  rapport.produits = 0; rapport.images = 0;
  rapport.infos.push(`Document interne Flaudis détecté${motif ? ' (' + motif + ')' : ''} — fichier NON conservé : la base est réservée aux offres usines.`);
  try { if (nomDisque) fs.unlinkSync(path.join(DATA_DIR, 'fichiers', nomDisque)); } catch {}
  db.prepare("UPDATE fichiers SET statut='refuse', rapport=? WHERE id=?").run(JSON.stringify(rapport), fichierId);
  return rapport;
}

/** Filet déterministe de contenu : les gencodes Flaudis n'existent que dans nos documents internes */
function filetInterne(texteBrut) {
  const eans = (texteBrut.match(/3700442\d{6}/g) || []).length;
  if (eans >= 2) return `le contenu comporte ${eans} gencodes Flaudis (3700442…), que les offres usines n'ont jamais`;
  return null;
}

function ingererFichier(nom, buffer, dossier = '', mode = 'auto', dateClient) {
  // fichiers système (caches Windows/Mac, temporaires Office) : écartés d'office, non stockés
  const nomBas = nom.toLowerCase().replace(/^_+/, '');
  if (['thumbs.db', 'desktop.ini', '.ds_store', 'ehthumbs.db'].includes(nomBas) || /^~\$/.test(nom)) {
    return { fichier: nom, produits: 0, images: 0, statut: 'ignore', rejets: [], avertissements: [],
      infos: ['Fichier système (cache de vignettes Windows / temporaire) — écarté automatiquement, non conservé.'] };
  }
  const rapport = { fichier: nom, produits: 0, images: 0, infos: [], avertissements: [], rejets: [], statut: 'ok' };
  try {
    const hash = ex.md5(buffer);
    const deja = db.prepare('SELECT id, nom FROM fichiers WHERE hash=?').get(hash);
    if (deja) {
      compacterInfosImages(rapport);
  rapport.statut = 'doublon';
      rapport.infos.push(`Fichier identique déjà en base sous « ${deja.nom} » — ignoré.`);
      return rapport;
    }
    const type = (nom.split('.').pop() || '').toLowerCase();
    // 1. copie brute conservée (la preuve source)
    const nomDisque = `${Date.now()}_${nom.replace(/[^\w.\-]+/g, '_')}`;
    fs.writeFileSync(path.join(DATA_DIR, 'fichiers', nomDisque), buffer);
    const modeEffectif = ['xls', 'xlsx'].includes(type) ? mode : 'document';
    const dateDoc = (['xls', 'xlsx'].includes(type) ? ex.dateDocument(buffer, nom) : ex.dateDocument(Buffer.alloc(0), nom))
      || (dateClient ? new Date(Number(dateClient)).toISOString().slice(0, 10) : null)
      || new Date().toISOString().slice(0, 10);
    const valide = ['xls', 'xlsx', 'pptx', 'msg'].includes(type) ? 0 : 1;
    const fi = db.prepare('INSERT INTO fichiers (nom, hash, taille, type, rapport, dossier, mode, date_document, valide) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(nom, hash, buffer.length, type, null, dossier, modeEffectif, dateDoc, valide);
    rapport.date_document = dateDoc;
    rapport.mode = modeEffectif;
    const fichierId = fi.lastInsertRowid;
    db.prepare('UPDATE fichiers SET rapport=? WHERE id=?').run(JSON.stringify({ disque: nomDisque }), fichierId);
    rapport.fichierId = fichierId;
    rapport.statut = 'en_attente';
    db.prepare("UPDATE fichiers SET statut='en_attente' WHERE id=?").run(fichierId);
  } catch (e) {
    rapport.statut = 'erreur';
    rapport.avertissements.push(String(e.message || e));
  }
  return rapport;
}

// ---------- FILE DE TRAITEMENT (un fichier à la fois : ménage la mémoire et l'IA) ----------
let analysesEnCours = 0;
const ANALYSES_MAX = Math.max(1, Number(process.env.FLAUDIS_PARALLELE || 2));
const goog = require('./lib/google');
db.exec("CREATE TABLE IF NOT EXISTS parametres (cle TEXT PRIMARY KEY, valeur TEXT)");
goog.configurer({
  lire: (cle) => (db.prepare('SELECT valeur FROM parametres WHERE cle=?').get(cle) || {}).valeur || null,
  ecrire: (cle, valeur) => valeur == null
    ? db.prepare('DELETE FROM parametres WHERE cle=?').run(cle)
    : db.prepare('INSERT INTO parametres (cle, valeur) VALUES (?,?) ON CONFLICT(cle) DO UPDATE SET valeur=excluded.valeur').run(cle, valeur),
});
db.exec(`CREATE TABLE IF NOT EXISTS sheets_sessions (
  id INTEGER PRIMARY KEY, genre TEXT NOT NULL, ref_id INTEGER NOT NULL,
  file_id TEXT NOT NULL, url TEXT NOT NULL,
  cree_le TEXT DEFAULT (datetime('now','localtime')), expire_le TEXT NOT NULL
)`);
try { db.exec("ALTER TABLE sheets_sessions ADD COLUMN extra TEXT"); } catch {}
try { db.exec("ALTER TABLE produits ADD COLUMN variante_de TEXT"); } catch {}
try { db.exec("ALTER TABLE produits ADD COLUMN maj_de TEXT"); } catch {}
try { db.exec("ALTER TABLE tableaux ADD COLUMN finalise INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE tableaux ADD COLUMN codes_proposes TEXT"); } catch {}
try { db.exec("ALTER TABLE tableaux ADD COLUMN dossier TEXT"); } catch {}
try { db.exec("ALTER TABLE tableaux ADD COLUMN genre TEXT DEFAULT 'selection'"); } catch {}
try { db.exec("ALTER TABLE tableaux ADD COLUMN selection_id INTEGER"); } catch {}
try { db.exec("ALTER TABLE tableaux ADD COLUMN cartographie TEXT"); } catch {}
try { db.exec("ALTER TABLE tableaux ADD COLUMN selection_fob_id INTEGER"); } catch {}
try { db.exec("ALTER TABLE tableaux ADD COLUMN selections_json TEXT"); } catch {}
async function nettoyerSheets() {
  if (!goog.dispo()) return;
  for (const s of db.prepare("SELECT * FROM sheets_sessions WHERE expire_le < datetime('now','localtime')").all()) {
    try { await goog.supprimer(s.file_id); } catch (e) { console.error('nettoyage Sheet:', e.message); }
    db.prepare('DELETE FROM sheets_sessions WHERE id=?').run(s.id);
  }
}
setInterval(() => nettoyerSheets().catch(() => {}), 10 * 60 * 1000);
setTimeout(() => nettoyerSheets().catch(() => {}), 20 * 1000);

const normUsine = x => String(x || '').trim().toUpperCase().replace(/\s+/g, ' ');
function synchroUsines() {
  // l'annuaire se construit tout seul depuis les fiches : une entrée par usine, port majoritaire proposé
  try {
    const lignes = db.prepare("SELECT fournisseur, port, COUNT(*) n FROM produits WHERE fournisseur IS NOT NULL AND TRIM(fournisseur)<>'' GROUP BY fournisseur, port").all();
    const parNorm = {};
    for (const l of lignes) {
      const k = normUsine(l.fournisseur);
      if (!k || k === 'FOURNISSEUR ?') continue;
      (parNorm[k] ||= { variantes: {}, ports: {} });
      parNorm[k].variantes[l.fournisseur.trim()] = (parNorm[k].variantes[l.fournisseur.trim()] || 0) + l.n;
      if (l.port) parNorm[k].ports[String(l.port).trim().toUpperCase()] = (parNorm[k].ports[String(l.port).trim().toUpperCase()] || 0) + l.n;
    }
    const ins = db.prepare('INSERT INTO usines (nom_norm, nom_affiche, port) VALUES (?,?,?) ON CONFLICT(nom_norm) DO NOTHING');
    const majPort = db.prepare("UPDATE usines SET port=? WHERE nom_norm=? AND (port IS NULL OR port='')");
    for (const [k, v] of Object.entries(parNorm)) {
      const affiche = Object.entries(v.variantes).sort((a, b) => b[1] - a[1])[0][0];
      const portMaj = (Object.entries(v.ports).sort((a, b) => b[1] - a[1])[0] || [null])[0];
      ins.run(k, affiche, portMaj);
      if (portMaj) majPort.run(portMaj, k); // ne touche jamais un port saisi à la main
    }
  } catch (e) { console.error('synchroUsines:', e.message); }
}
synchroUsines();

async function pomperFile() {
  while (analysesEnCours < ANALYSES_MAX) {
    const suivant = db.prepare("SELECT id FROM fichiers WHERE statut='en_attente' ORDER BY id LIMIT 1").get();
    if (!suivant) return;
    analysesEnCours++;
    db.prepare("UPDATE fichiers SET statut='en_cours' WHERE id=?").run(suivant.id);
    (async () => {
      try {
        await traiterFichierEnFile(suivant.id);
      } catch (e) {
        const f = db.prepare('SELECT nom, rapport FROM fichiers WHERE id=?').get(suivant.id);
        let j = {}; try { j = JSON.parse(f?.rapport || '{}'); } catch {}
        const rap = { fichier: f?.nom || '?', fichierId: suivant.id, produits: 0, images: 0, infos: [],
          avertissements: [String(e.message || e)], rejets: [], statut: 'erreur', disque: j.disque };
        db.prepare("UPDATE fichiers SET statut='erreur', rapport=? WHERE id=?").run(JSON.stringify(rap), suivant.id);
      }
      analysesEnCours--;
      try { synchroUsines(); } catch {}
      // enrichissement auto (fond) : les usines jamais enrichies liées à ce fichier
      const fichierTraite = suivant.id;
      setImmediate(async () => {
        try {
          const fours = db.prepare('SELECT DISTINCT fournisseur FROM produits WHERE fichier_id=? AND fournisseur IS NOT NULL').all(fichierTraite);
          const norms = new Set(fours.map(f => normUsine(f.fournisseur)));
          for (const u of db.prepare('SELECT id, nom_norm FROM usines WHERE enrichie_le IS NULL').all()) {
            if (!norms.has(u.nom_norm)) continue;
            const rep = await fetch(`http://127.0.0.1:${PORT}/api/usines/${u.id}/enrichir`, { method: 'POST' }).catch(() => null);
            if (!rep || !rep.ok) db.prepare("UPDATE usines SET enrichie_le=datetime('now','localtime') WHERE id=?").run(u.id);
          }
        } catch (e) { console.error('auto-enrichissement:', e.message); }
      });
      setImmediate(pomperFile);
    })();
  }
}
setInterval(pomperFile, 3000);

const LIBELLES_CHAMPS = { description: 'description', taille_produit: 'dimensions', matiere: 'matière', pcb: 'PCB', colisage_cm: 'colisage', volume_m3: 'volume', poids_nb: 'poids', prix: 'prix', devise: 'devise', port: 'port', moq: 'MOQ', code_hs_usine: 'code douanier usine', code_douanier: 'code douanier', kd: 'KD', remarques: 'remarques', extras: 'infos annexes', ean: 'EAN', fournisseur: 'fournisseur', variante_de: 'variante' };
async function traiterFichierEnFile(fichierId) {
  const f = db.prepare('SELECT * FROM fichiers WHERE id=?').get(fichierId);
  if (!f) return;
  let disque = null; try { disque = JSON.parse(f.rapport || '{}').disque; } catch {}
  const chemin = disque ? path.join(DATA_DIR, 'fichiers', disque) : null;
  if (!chemin || !fs.existsSync(chemin)) throw new Error('copie source introuvable sur le disque');
  const buffer = fs.readFileSync(chemin);
  const rapport = { fichier: f.nom, fichierId, produits: 0, images: 0, infos: [], avertissements: [], rejets: [],
    statut: 'ok', date_document: f.date_document, mode: f.mode };
  await analyserContenu({ fichierId, nom: f.nom, buffer, type: f.type, mode: f.mode, rapport, nomDisque: disque, dossier: f.dossier || '' });
}

async function analyserContenu({ fichierId, nom, buffer, type, mode, rapport, nomDisque, dossier = '' }) {
  {
    let texteBrut = '';
    if (type === 'xlsx' || type === 'xls') {
      const feuilles = ex.lireCellules(buffer);
      texteBrut = ex.texteDesFeuilles(feuilles);
      if (mode === 'auto') {
        const motif = filetInterne(texteBrut);
        if (motif) {
          return refuserInterne(fichierId, rapport, nomDisque, motif);
          db.prepare('UPDATE fichiers SET mode=? WHERE id=?').run(mode, fichierId);
        }
        // sinon : c'est l'IA qui tranchera en lisant le contenu, ligne par ligne
      }
    }
    if (type === 'pptx') {
      const slides = await ex.textePptxParSlides(buffer);
      texteBrut = slides.map(sl => `=== Slide ${sl.slide} ===\n${sl.texte}`).join('\n');
      const motif = filetInterne(texteBrut);
      if (motif) return refuserInterne(fichierId, rapport, nomDisque, motif);
    }
    if (type === 'msg') {
      let piecesMail = [];
      try {
        const m = ex.lireMsg(buffer);
        texteBrut = m.corps ? '=== CORPS DU MAIL ===\n' + m.corps : ex.texteMsg(buffer);
        piecesMail = m.pieces;
      } catch { texteBrut = ex.texteMsg(buffer); }
      // pièces jointes utiles : déposées comme fichiers autonomes (elles portent leurs propres photos)
      for (const pj of piecesMail) {
        const t2 = (String(pj.nom).split('.').pop() || '').toLowerCase();
        if (!['xls', 'xlsx', 'pptx', 'docx', 'pdf'].includes(t2) || pj.buffer.length < 300) continue;
        const h2 = ex.md5(pj.buffer);
        if (db.prepare('SELECT id FROM fichiers WHERE hash=?').get(h2)) {
          rapport.infos.push(`Pièce jointe « ${pj.nom} » déjà en base — non redéposée.`);
          continue;
        }
        const nd2 = `${h2}.${t2}`;
        fs.writeFileSync(path.join(DATA_DIR, 'fichiers', nd2), pj.buffer);
        const dd2 = (['xls', 'xlsx'].includes(t2) ? ex.dateDocument(pj.buffer, pj.nom) : ex.dateDocument(Buffer.alloc(0), pj.nom)) || rapport.date_document || null;
        const fi2 = db.prepare('INSERT INTO fichiers (nom, hash, taille, type, rapport, dossier, mode, date_document, valide) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(pj.nom, h2, pj.buffer.length, t2, JSON.stringify({ disque: nd2 }), dossier || null, mode || 'offre', dd2, ['xls', 'xlsx', 'pptx'].includes(t2) ? 0 : 1);
        db.prepare("UPDATE fichiers SET statut='en_attente' WHERE id=?").run(fi2.lastInsertRowid);
        rapport.infos.push(`Pièce jointe extraite du mail et mise en analyse : « ${pj.nom} ».`);
      }
    }
    if ((type === 'xlsx' || type === 'xls') && mode === 'interne') {
      return refuserInterne(fichierId, rapport, nomDisque, 'classement manuel « interne » (mode retiré : la base est réservée aux offres usines)');
    }
    if (false) {
      // document interne : conservé + indexé texte, AUCUNE fiche produit créée
      if (!rapport.avertissements.some(a => a.startsWith('Classé automatiquement')))
        rapport.infos.push('Document interne : indexé pour la recherche, aucune fiche produit créée.');
    } else if (type === 'xlsx' || type === 'xls' || type === 'pptx' || type === 'msg') {
      // 2. extraction IA (qui juge aussi la nature du document, au contenu) + filet déterministe
      const masquees = (type === 'xlsx' || type === 'xls') ? ex.feuillesMasquees(buffer) : [];
      if (masquees.length) rapport.infos.push(`Feuille(s) masquée(s) IGNORÉE(S) à l'import : ${masquees.join(', ')} — masquées par le fournisseur, donc non destinées au client (ni produits ni photos extraits ; pour contrôler leur contenu, télécharge l'original — l'aperçu 👁 reste fidèle au fichier tel que le client le voit).`);
      const { nature, motif, produits, erreur, erreur_partielle } = await ia.extraireProduitsIA(texteBrut, nom);
      if (erreur) rapport.avertissements.push(erreur);
      if (erreur_partielle) rapport.avertissements.push(erreur_partielle);
      if (mode === 'auto' || ((type === 'pptx' || type === 'msg') && mode === 'document')) {
        if ((type === 'pptx' || type === 'msg') && !produits.length) {
          rapport.infos.push('Aucune ligne d\u2019offre détectée dans ce PPTX — conservé comme document annexe (texte indexé pour la recherche).');
          mode = 'document';
          db.prepare('UPDATE fichiers SET valide=1 WHERE id=?').run(fichierId); // annexe : pas de récap à valider
        } else if (nature === 'interne' && !produits.length)
          return refuserInterne(fichierId, rapport, nomDisque, motif || 'jugé document interne par l\u2019analyse du contenu');
        else mode = 'offre';
        db.prepare('UPDATE fichiers SET mode=? WHERE id=?').run(mode, fichierId);
        if (nature === 'interne')
          rapport.infos.push(`L'IA a jugé ce document « interne » au contenu${motif ? ' : ' + motif : ''}${produits.length ? ' — mais y a tout de même trouvé des lignes d\u2019offre, extraites ci-dessous' : '. Aucune fiche produit créée.'}`);
      }
      const { gardes, rejets } = ia.verifierProduits(produits, texteBrut);
      rapport.rejets = rejets.map(r => `${r.produit?.reference || '(sans ref)'} : ${r.raison}`);

      const ins = db.prepare(`INSERT INTO produits
        (reference, fichier_id, feuille, ligne, fournisseur, description, taille_produit, matiere,
         pcb, colisage_cm, volume_m3, poids_nb, prix, devise, port, moq, code_hs_usine, kd, remarques, avertissements, extras)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const lignesProduits = {};
      const heritagesImages = new Map(); // nouvelleFicheId -> images de la fiche remplacée
      const reversements = []; // fiche plus ancienne arrivée après coup -> complète la fiche récente // feuille -> [{ligne, id}]
      // références provisoires pour les offres sans référence usine
      const sansRef = gardes.filter(p => p.sans_ref || !p.reference);
      if (sansRef.length) {
        const base = nom.replace(/\.[^.]+$/, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 14);
        sansRef.forEach((p, i) => { p.reference = `PROV-${base}-${i + 1}`; });
        rapport.infos.push(`${sansRef.length} produit(s) sans référence usine : références provisoires créées (${sansRef.map(p => p.reference).join(', ')}).`);
      }
      // doublons de référence AU SEIN du fichier (coquille usine probable, ex: Grade A/B)
      const vues = {};
      for (const p of gardes) if (p.reference) (vues[p.reference] ||= []).push(p.ligne || '?');
      for (const [refD, lignesD] of Object.entries(vues)) if (lignesD.length > 1)
        rapport.avertissements.push(`${refD} apparaît ${lignesD.length} fois dans CE fichier (lignes ${lignesD.join(', ')}) — coquille usine probable (variante Grade A/B ?), à vérifier/corriger via ✎.`);
      for (const p of gardes) {
        const r = ins.run(p.reference, fichierId, p.feuille || null, p.ligne || null,
          p.fournisseur || null, p.description || null, p.taille_produit || null, p.matiere || null,
          p.pcb != null ? String(p.pcb) : null, p.colisage_cm || null,
          p.volume_m3 != null ? String(p.volume_m3) : null, p.poids_nb || null,
          p.prix != null ? String(p.prix) : null, p.devise || null, p.port || null,
          p.moq != null ? String(p.moq) : null, p.code_hs_usine != null ? String(p.code_hs_usine) : null,
          p.kd ? 1 : 0, p.remarques || null, JSON.stringify(p.avertissements || []),
          p.extras && p.extras.length ? JSON.stringify(p.extras) : null);
        if (dossier) db.prepare('UPDATE produits SET dossier=? WHERE id=?').run(dossier, r.lastInsertRowid);
        if (p.variante_de) db.prepare('UPDATE produits SET variante_de=? WHERE id=?').run(String(p.variante_de).trim(), r.lastInsertRowid);
        (lignesProduits[p.feuille || ''] ||= []).push({ ligne: p.ligne || 0, id: r.lastInsertRowid, ref: p.reference, variante_de: p.variante_de ? String(p.variante_de).trim() : null });
        for (const a of p.avertissements || []) rapport.avertissements.push(`${p.reference} : ${a}`);
        // alerte doublon de référence (autre fichier) — non bloquant : peut être une offre mise à jour
        // règle métier : entre deux fichiers, seule la fiche la plus récente est conservée
        const maDate = rapport.date_document || '';
        const anciens = db.prepare(`SELECT pr.id, pr.dossier, pr.fichier_id AS fid, f.nom AS fnom, COALESCE(f.date_document, substr(f.depose_le,1,10)) AS fdate FROM produits pr
          JOIN fichiers f ON f.id = pr.fichier_id
          WHERE pr.reference = ? AND pr.fichier_id != ?`).all(p.reference, fichierId);
        for (const anc of anciens) {
          if (anc.fdate > maDate) {
            heritagesImages.delete(r.lastInsertRowid);
            // on garde la fiche entrante jusqu'à la fin du traitement (le temps que ses images s'associent),
            // puis elle COMPLÈTE la fiche récente avant de disparaître
            reversements.push({ recente: anc.id, entrante: r.lastInsertRowid, fnom: anc.fnom, fdate: anc.fdate });
            break;
          }
          if (anc.dossier && !dossier) db.prepare('UPDATE produits SET dossier=? WHERE id=?').run(anc.dossier, r.lastInsertRowid);
          // FUSION : les infos produit PERSISTENT — seules les valeurs réellement renseignées
          // par le fichier plus récent les remplacent (un update de prix ne vide pas la fiche)
          try {
            const ancienne = db.prepare('SELECT * FROM produits WHERE id=?').get(anc.id);
            const nouvelle = db.prepare('SELECT * FROM produits WHERE id=?').get(r.lastInsertRowid);
            const NON_HERITES = new Set(['id', 'reference', 'fichier_id', 'feuille', 'ligne', 'dossier', 'avertissements', 'maj_de']);
            const estVide = (v) => v == null || String(v).trim() === '' || String(v).trim() === '[]';
            const herites = [];
            for (const col of db.prepare('PRAGMA table_info(produits)').all().map(x => x.name)) {
              if (NON_HERITES.has(col)) continue;
              if (estVide(nouvelle[col]) && !estVide(ancienne[col])) {
                db.prepare(`UPDATE produits SET ${col}=? WHERE id=?`).run(ancienne[col], r.lastInsertRowid);
                herites.push(col);
              }
            }
            // les listes qui contenaient l'ancienne fiche suivent la nouvelle
            db.prepare('UPDATE OR IGNORE liste_items SET produit_id=? WHERE produit_id=?').run(r.lastInsertRowid, anc.id);
            if (herites.length) {
              rapport.infos.push(`${p.reference} : ${herites.length} info(s) conservée(s) de la version précédente (${herites.map(c => LIBELLES_CHAMPS[c] || c).join(', ')}) — ce fichier ne les renseignait pas.`);
            }
          } catch (e) { rapport.avertissements.push(`${p.reference} : fusion avec la version précédente incomplète (${e.message})`); }
          db.prepare('UPDATE produits SET maj_de=? WHERE id=?').run(`${anc.fnom} · ${anc.fdate}`, r.lastInsertRowid);
          // photos de l'ancienne fiche : gardées de côté (une version « update de prix » a souvent des photos dégradées)
          const imgsAnc = db.prepare(`SELECT pi.image_id, pi.principale, i.chemin FROM produit_images pi JOIN images i ON i.id=pi.image_id WHERE pi.produit_id=?`).all(anc.id);
          if (imgsAnc.length) heritagesImages.set(r.lastInsertRowid, { ref: p.reference, images: imgsAnc });
          db.prepare('DELETE FROM produits WHERE id=?').run(anc.id);
          rapport.infos.push(`${p.reference} : remplace la fiche plus ancienne (${anc.fnom}, daté du ${anc.fdate})${anc.dossier && !dossier ? ' — classement « ' + anc.dossier + ' » hérité' : ''}.`);
          // trace symétrique sur le rapport du fichier dont la fiche vient de sauter
          try {
            const ra = db.prepare('SELECT rapport FROM fichiers WHERE id=?').get(anc.fid);
            const j = JSON.parse(ra.rapport || '{}');
            (j.avertissements = j.avertissements || []).push(`${p.reference} : fiche remplacée par la version plus récente de « ${nom} » (daté du ${maDate}).`);
            if (typeof j.produits === 'number' && j.produits > 0) j.produits--;
            db.prepare('UPDATE fichiers SET rapport=? WHERE id=?').run(JSON.stringify(j), anc.fid);
          } catch {}
        }
      }
      rapport.produits = gardes.length;

      // 3. images : xlsx natif, ou .xls converti via LibreOffice, ou repli binaire
      let bufferImages = null, sansAncrage = false;
      if (type === 'pptx') bufferImages = Object.values(lignesProduits).flat().length ? buffer : null;
      else if (type === 'xlsx') bufferImages = buffer;
      else if (type === 'xls') {
        bufferImages = await ex.convertirXlsEnXlsx(buffer);
        if (bufferImages) rapport.infos.push('Fichier .xls converti automatiquement : photos et positions extraites.');
        else {
          const brutes = ex.imagesBinairesXls(buffer);
          if (brutes.length) { sansAncrage = true; rapport.avertissements.push(`Photos récupérées du .xls sans leur position (${brutes.length}) — ${''}associées seulement si le fichier n'a qu'un produit.`); }
          bufferImages = null;
          // insertion directe des images sans ancrage
          const insImg0 = db.prepare(`INSERT INTO images (fichier_id, produit_id, hash, chemin, feuille, ligne_ancrage, ambigue)
                                      VALUES (?,?,?,?,?,?,?)`);
          const seuls = Object.values(lignesProduits).flat();
          const associeA = seuls.length === 1 ? seuls[0] : null;
          const vus0 = new Set();
          for (const img of brutes) {
            if (vus0.has(img.hash)) continue; vus0.add(img.hash);
            const dejaImg = db.prepare('SELECT chemin FROM images WHERE hash=?').get(img.hash);
            const chemin = dejaImg ? dejaImg.chemin : `${img.hash}.${img.ext}`;
            if (!dejaImg) fs.writeFileSync(path.join(DATA_DIR, 'images', chemin), img.buffer);
            const assoc0Vivant = associeA && db.prepare('SELECT 1 FROM produits WHERE id=?').get(associeA.id) ? associeA : null;
            const rimg0 = insImg0.run(fichierId, assoc0Vivant ? assoc0Vivant.id : null, img.hash, chemin, null, null, assoc0Vivant ? 1 : 0);
            if (assoc0Vivant)
              db.prepare('INSERT OR IGNORE INTO produit_images (produit_id, image_id) VALUES (?,?)').run(assoc0Vivant.id, rimg0.lastInsertRowid);
            rapport.images++;
          }
        }
      }
      if (bufferImages) {
        try {
          const images = type === 'pptx' ? await ex.imagesPptx(buffer) : await ex.lireImagesXlsx(bufferImages);
          const insImg = db.prepare(`INSERT INTO images (fichier_id, produit_id, hash, chemin, feuille, ligne_ancrage, ambigue)
                                     VALUES (?,?,?,?,?,?,?)`);
          const vus = new Set();
          for (const img of images) {
            if (vus.has(img.hash)) continue; // dédoublonnage intra-fichier (les fameuses carafes)
            vus.add(img.hash);
            const dejaImg = db.prepare('SELECT id FROM images WHERE hash=?').get(img.hash);
            const chemin = dejaImg
              ? db.prepare('SELECT chemin FROM images WHERE hash=?').get(img.hash).chemin
              : `${img.hash}.${img.ext}`;
            if (!dejaImg) fs.writeFileSync(path.join(DATA_DIR, 'images', chemin), img.buffer);
            // association par TERRITOIRES : chaque produit possède [sa ligne - 1 ; ligne du produit suivant - 1[
            // (les blocs verticaux type Win Hang ancrent la photo plusieurs lignes sous la ligne « Item No. »)
            const cand = (lignesProduits[img.feuille] || []);
            let assoc = cand.find(p => p.ligne === img.ligneAncrage);
            let ambigue = 0;
            if (!assoc && Number.isFinite(img.ligneAncrage) && !/^Slide/i.test(String(img.feuille || ''))) {
              const tries = [...cand].filter(p => Number.isFinite(p.ligne)).sort((a, b) => a.ligne - b.ligne);
              for (let i = 0; i < tries.length; i++) {
                const debut = tries[i].ligne - 1;
                const fin = i + 1 < tries.length ? tries[i + 1].ligne : tries[i].ligne + 12; // tout le bloc jusqu'au produit suivant
                if (img.ligneAncrage >= debut && img.ligneAncrage < fin) { assoc = tries[i]; ambigue = img.ligneAncrage === tries[i].ligne ? 0 : 1; break; }
              }
            }
            if (!assoc) {
              const proches = cand.filter(p => Math.abs(p.ligne - img.ligneAncrage) <= 2)
                                  .sort((a, b) => Math.abs(a.ligne - img.ligneAncrage) - Math.abs(b.ligne - img.ligneAncrage));
              if (proches.length) { assoc = proches[0]; ambigue = 1; }
            }
            if (assoc && !db.prepare('SELECT 1 FROM produits WHERE id=?').get(assoc.id)) { assoc = null; ambigue = 0; }
            const rimg = insImg.run(fichierId, assoc ? assoc.id : null, img.hash, chemin, img.feuille, img.ligneAncrage, ambigue);
            if (assoc)
              db.prepare('INSERT OR IGNORE INTO produit_images (produit_id, image_id) VALUES (?,?)').run(assoc.id, rimg.lastInsertRowid);
            rapport.images++;
            if (ambigue && assoc) rapport.infos.push(`Image L${img.ligneAncrage} (${img.feuille}) associée à ${assoc.ref} par proximité — vérifiable via 🖼 Photo.`);
            if (!assoc) rapport.infos.push(`Image L${img.ligneAncrage} (${img.feuille}) sans fiche — associable via 🖼 Photo.`);
          }
        } catch (e) {
          rapport.avertissements.push(`Images non extraites : ${e.message}`);
        }
      }
      // PARTAGE entre variantes : un même produit décliné (tailles, couleurs) n'a souvent QU'UNE photo,
      // posée sur n'importe quel membre du groupe -> chaque membre sans photo reçoit celles du membre le plus proche
      try {
        const tous = Object.values(lignesProduits).flat().filter(p => db.prepare('SELECT 1 FROM produits WHERE id=?').get(p.id));
        const aImages = new Map(tous.map(p => [p.id, db.prepare('SELECT COUNT(*) n FROM produit_images WHERE produit_id=?').get(p.id).n]));
        const parRef = new Map(tous.map(p => [String(p.ref).trim().toUpperCase(), p]));
        const racine = (x) => { const u = String(x).trim().toUpperCase(); const m = u.match(/^(.*?)[-_ ][A-Z0-9./X]{1,10}$/); return m ? m[1] : u; };
        // groupes (union-find) : liens IA « variante_de » (bidirectionnels) + même racine de réf à proximité
        const chef = new Map(tous.map(p => [p.id, p.id]));
        const trouver = (i) => { while (chef.get(i) !== i) { chef.set(i, chef.get(chef.get(i))); i = chef.get(i); } return i; };
        const unir = (a, b) => { const ra = trouver(a.id), rb = trouver(b.id); if (ra !== rb) chef.set(ra, rb); };
        for (const p of tous) {
          if (p.variante_de && parRef.has(p.variante_de.toUpperCase())) unir(p, parRef.get(p.variante_de.toUpperCase()));
        }
        for (let i = 0; i < tous.length; i++) for (let j = i + 1; j < tous.length; j++) {
          const a = tous[i], b = tous[j], ra = racine(a.ref);
          if (ra.length >= 6 && ra === racine(b.ref) && Math.abs((a.ligne || 0) - (b.ligne || 0)) <= 12) unir(a, b);
        }
        const groupes = {};
        for (const p of tous) (groupes[trouver(p.id)] ||= []).push(p);
        for (const membres of Object.values(groupes)) {
          const avec = membres.filter(m => aImages.get(m.id));
          if (!avec.length || avec.length === membres.length) continue;
          for (const p of membres) {
            if (aImages.get(p.id)) continue;
            const source = [...avec].sort((a, b) => Math.abs((a.ligne || 0) - (p.ligne || 0)) - Math.abs((b.ligne || 0) - (p.ligne || 0)))[0];
            for (const li of db.prepare('SELECT image_id, principale FROM produit_images WHERE produit_id=?').all(source.id))
              db.prepare('INSERT OR IGNORE INTO produit_images (produit_id, image_id, principale) VALUES (?,?,?)').run(p.id, li.image_id, li.principale);
            aImages.set(p.id, aImages.get(source.id));
            rapport.infos.push(`${p.ref} : photo partagée avec ${source.ref} (même produit décliné).`);
          }
        }
      } catch (e) { rapport.avertissements.push('Partage de photos entre variantes : ' + e.message); }
      // héritage : si la nouvelle version a des photos absentes ou nettement plus légères, on garde celles d'origine
      for (const [nouveauId, h] of heritagesImages) {
        try {
          if (!db.prepare('SELECT 1 FROM produits WHERE id=?').get(nouveauId)) continue;
          const poids = ch => { try { return fs.statSync(path.join(DATA_DIR, 'images', ch)).size; } catch { return 0; } };
          const imgsNouv = db.prepare(`SELECT pi.image_id, i.chemin FROM produit_images pi JOIN images i ON i.id=pi.image_id WHERE pi.produit_id=?`).all(nouveauId);
          const maxNouv = Math.max(0, ...imgsNouv.map(x => poids(x.chemin)));
          const maxAnc = Math.max(0, ...h.images.map(x => poids(x.chemin)));
          if (!imgsNouv.length) {
            for (const im of h.images) db.prepare('INSERT OR IGNORE INTO produit_images (produit_id, image_id, principale) VALUES (?,?,?)').run(nouveauId, im.image_id, im.principale || 0);
            rapport.infos.push(`${h.ref} : photo(s) de la version précédente conservées (la nouvelle version n'en avait pas).`);
          } else if (maxAnc > 0 && maxNouv < 0.3 * maxAnc) {
            // les photos recompressées de l'update sont DÉLIÉES (pas de doublons) — les originales prennent leur place
            db.prepare('DELETE FROM produit_images WHERE produit_id=?').run(nouveauId);
            for (const im of h.images) db.prepare('INSERT OR IGNORE INTO produit_images (produit_id, image_id, principale) VALUES (?,?,?)').run(nouveauId, im.image_id, im.principale || 0);
            rapport.infos.push(`${h.ref} : photos d'origine conservées (meilleure qualité) — les versions recompressées de ce fichier n'ont pas été rattachées (récupérables via 🖼 si besoin).`);
          }
        } catch {}
      }
      heritagesImages.clear();
      // reversement : l'ordre d'upload est indifférent — un fichier ancien enrichit la fiche récente
      for (const rv of reversements) {
        try {
          const entrante = db.prepare('SELECT * FROM produits WHERE id=?').get(rv.entrante);
          if (!entrante) continue;
          const recente = db.prepare('SELECT * FROM produits WHERE id=?').get(rv.recente);
          if (!recente) continue;
          const NON = new Set(['id', 'reference', 'fichier_id', 'feuille', 'ligne', 'dossier', 'avertissements', 'maj_de']);
          const vide = v => v == null || String(v).trim() === '' || String(v).trim() === '[]';
          const completes = [];
          for (const col of db.prepare('PRAGMA table_info(produits)').all().map(x => x.name)) {
            if (NON.has(col)) continue;
            if (vide(recente[col]) && !vide(entrante[col])) {
              db.prepare(`UPDATE produits SET ${col}=? WHERE id=?`).run(entrante[col], rv.recente);
              completes.push(LIBELLES_CHAMPS[col] || col);
            }
          }
          const nbRec = db.prepare('SELECT COUNT(*) n FROM produit_images WHERE produit_id=?').get(rv.recente).n;
          if (!nbRec) db.prepare('UPDATE OR IGNORE produit_images SET produit_id=? WHERE produit_id=?').run(rv.recente, rv.entrante);
          db.prepare('UPDATE OR IGNORE liste_items SET produit_id=? WHERE produit_id=?').run(rv.recente, rv.entrante);
          if (!String(recente.maj_de || '').trim()) db.prepare('UPDATE produits SET maj_de=? WHERE id=?').run(`${nom} · ${rapport.date_document || '?'}`, rv.recente);
          db.prepare('DELETE FROM produits WHERE id=?').run(rv.entrante);
          rapport.infos.push(`${entrante.reference} : une fiche plus récente existe (${rv.fnom}, ${rv.fdate}) — conservée${completes.length ? ` et COMPLÉTÉE par ${completes.length} info(s) de ce fichier (${completes.slice(0, 10).join(', ')})` : ''}${!nbRec ? ' ; photos de ce fichier reprises' : ''}.`);
        } catch (e) { rapport.avertissements.push('Complément de la fiche récente : ' + e.message); }
      }
    } else if (type === 'pptx' || type === 'docx') {
      texteBrut = await ex.textePptx(buffer);
      rapport.infos.push('Fichier bureautique : indexé en texte pour la recherche (pas d\u2019extraction produit).');
    } else {
      rapport.infos.push('Document annexe : conservé et téléchargeable, non indexé (format sans texte lisible).');
    }
    if (texteBrut) db.prepare('INSERT OR REPLACE INTO textes (fichier_id, contenu) VALUES (?,?)').run(fichierId, texteBrut);
    if (rapport.avertissements.length || rapport.rejets.length) rapport.statut = 'avertissements';
    db.prepare('UPDATE fichiers SET statut=?, rapport=? WHERE id=?')
      .run(rapport.statut, JSON.stringify({ ...rapport, disque: nomDisque }), fichierId);
  }
}

// ---------- RECHERCHE ----------
app.get('/api/recherche', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) {
    const derniers = db.prepare(`SELECT p.*, f.nom AS fichier_nom FROM produits p
      JOIN fichiers f ON f.id = p.fichier_id ORDER BY p.id DESC LIMIT 30`).all();
    return res.json({ produits: derniers.map(enrichir), plein_texte: [] });
  }
  const like = `%${q}%`;
  const produits = db.prepare(`SELECT p.*, f.nom AS fichier_nom, f.dossier AS fichier_dossier FROM produits p
    JOIN fichiers f ON f.id = p.fichier_id
    WHERE p.reference LIKE ? OR p.description LIKE ? OR p.fournisseur LIKE ? OR p.remarques LIKE ?
    ORDER BY (p.reference = ?) DESC, length(p.reference) ASC LIMIT 100`)
    .all(like, like, like, like, q);
  // chasse plein-texte : fichiers dont le contenu contient la requête (règle des frontières)
  const pt = db.prepare(`SELECT f.id, f.nom, f.type, f.depose_le FROM textes t JOIN fichiers f ON f.id=t.fichier_id
    WHERE t.contenu LIKE ? LIMIT 60`).all(like)
    .filter(f => !produits.some(p => p.fichier_id === f.id));
  res.json({ produits: produits.map(enrichir), plein_texte: pt });
});

function compacterInfosImages(rapport) {
  const motif = /^Image L\d+ .* sans fiche — associable via/;
  const orphelines = rapport.infos.filter(i => motif.test(i));
  if (orphelines.length > 6) {
    rapport.infos = rapport.infos.filter(i => !motif.test(i));
    rapport.infos.push(`${orphelines.length} photos extraites sans fiche associée — associables via 🖼 Photo (ou vérifie l'extraction si le fichier devait donner des produits).`);
  }
}

function enrichir(p) {
  p.images = db.prepare(`SELECT i.id, i.ambigue, pi.principale FROM produit_images pi JOIN images i ON i.id = pi.image_id
    WHERE pi.produit_id = ? ORDER BY pi.principale DESC, i.id LIMIT 6`).all(p.id);
  p.en_selection = !!db.prepare(`SELECT 1 FROM liste_items li JOIN listes l ON l.id = li.liste_id
    WHERE li.produit_id = ? AND l.systeme = 1`).get(p.id);
  try { p.avertissements = JSON.parse(p.avertissements || '[]'); } catch { p.avertissements = []; }
  try { p.extras = JSON.parse(p.extras || '[]'); } catch { p.extras = []; }
  p.autres_occurrences = db.prepare(`SELECT pr.id, pr.prix, pr.devise, f.nom AS fichier_nom, f.depose_le
    FROM produits pr JOIN fichiers f ON f.id = pr.fichier_id
    WHERE pr.reference = ? AND pr.id != ? ORDER BY pr.id DESC LIMIT 10`).all(p.reference, p.id);
  return p;
}

const CHAMPS_EDITABLES = ['reference', 'ean', 'note', 'fournisseur', 'description', 'taille_produit', 'matiere', 'pcb',
  'colisage_cm', 'volume_m3', 'poids_nb', 'prix', 'devise', 'port', 'moq', 'code_hs_usine', 'kd', 'remarques'];
app.patch('/api/produits/:id/champs', (req, res) => {
  const p = db.prepare('SELECT * FROM produits WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ erreur: 'Fiche introuvable' });
  const maj = {};
  for (const c of CHAMPS_EDITABLES) if (c in req.body) {
    let v = req.body[c];
    if (c === 'reference') {
      v = String(v || '').replace(/\s+/g, ' ').trim();
      if (!v) return res.status(400).json({ erreur: 'La référence ne peut pas être vide' });
    } else if (c === 'kd') v = v ? 1 : 0;
    else v = v === '' || v == null ? null : String(v);
    maj[c] = v;
  }
  if ('extras' in req.body) {
    const ex2 = Array.isArray(req.body.extras)
      ? req.body.extras.filter(e => e && (String(e.intitule || '').trim() || String(e.valeur || '').trim()))
          .map(e => ({ intitule: String(e.intitule || '').trim().slice(0, 60), valeur: String(e.valeur || '').trim().slice(0, 300) }))
      : [];
    maj.extras = ex2.length ? JSON.stringify(ex2) : null;
  }
  if (!Object.keys(maj).length) return res.status(400).json({ erreur: 'Rien à modifier' });
  maj.modifie_le = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const setSql = Object.keys(maj).map(k => k + '=?').join(', ');
  db.prepare('UPDATE produits SET ' + setSql + ' WHERE id=?').run(...Object.values(maj), req.params.id);
  let doublon = null;
  if (maj.reference && maj.reference !== p.reference) {
    const autres = db.prepare('SELECT COUNT(*) n FROM produits WHERE reference=? AND id!=?').get(maj.reference, req.params.id).n;
    if (autres) doublon = `Attention : ${autres} autre(s) fiche(s) porte(nt) déjà la référence ${maj.reference}`;
  }
  res.json({ ok: true, doublon, produit: enrichir(db.prepare('SELECT * FROM produits WHERE id=?').get(req.params.id)) });
});

app.get('/api/produit/:id', (req, res) => {
  const p = db.prepare(`SELECT p.*, f.nom AS fichier_nom, f.id AS fid FROM produits p
    JOIN fichiers f ON f.id=p.fichier_id WHERE p.id=?`).get(req.params.id);
  if (!p) return res.status(404).json({ erreur: 'Produit introuvable' });
  res.json(enrichir(p));
});

app.get('/image/:id', (req, res) => {
  const img = db.prepare('SELECT chemin FROM images WHERE id=?').get(req.params.id);
  if (!img) return res.status(404).end();
  res.sendFile(path.join(DATA_DIR, 'images', img.chemin));
});

app.get('/fichier/:id', (req, res) => {
  const f = db.prepare('SELECT nom, rapport FROM fichiers WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).end();
  const disque = JSON.parse(f.rapport || '{}').disque;
  if (!disque) return res.status(404).end();
  res.download(path.join(DATA_DIR, 'fichiers', disque), f.nom);
});

// ---------- ASSISTANT ----------
app.post('/api/assistant', async (req, res) => {
  const question = String(req.body.question || '').trim().slice(0, 500);
  if (!question) return res.status(400).json({ erreur: 'Question vide' });
  const lignes = db.prepare(`SELECT id, reference, fournisseur, prix, devise, matiere, taille_produit, description
    FROM produits ORDER BY id DESC LIMIT 4000`).all()
    .map(p => [p.id, p.reference, p.fournisseur || '', p.prix ? (p.devise === 'EUR' ? p.prix + 'EUR' : p.prix + 'USD') : '',
               p.matiere || '', p.taille_produit || '', (p.description || '').replace(/[\t\n]/g, ' ').slice(0, 220)].join('\t'));
  const { ids, reponse, erreur } = await ia.repondreAssistant(question,
    'id\treference\tfournisseur\tprix\tmatiere\ttaille\tdescription\n' + lignes.join('\n'));
  if (erreur) return res.status(502).json({ erreur });
  // seules les fiches réellement en base sont retournées (filet anti-invention)
  const fiches = ids.map(id => db.prepare(`SELECT p.*, f.nom AS fichier_nom, f.dossier AS fichier_dossier
    FROM produits p JOIN fichiers f ON f.id=p.fichier_id WHERE p.id=?`).get(id)).filter(Boolean).map(enrichir);
  res.json({ reponse, produits: fiches });
});

// ---------- DOSSIERS ----------
app.post('/api/dossiers', (req, res) => {
  const chemin = nettoyerChemin(req.body.chemin);
  if (!chemin) return res.status(400).json({ erreur: 'Chemin vide' });
  db.prepare('INSERT OR IGNORE INTO dossiers (chemin) VALUES (?)').run(chemin);
  res.json({ ok: true, chemin });
});
app.patch('/api/dossiers/deplacer', (req, res) => {
  const source = nettoyerChemin(req.body.source);
  const destination = nettoyerChemin(req.body.destination); // '' = racine
  if (!source) return res.status(400).json({ erreur: 'Source vide' });
  if (destination === source || destination.startsWith(source + '/'))
    return res.status(409).json({ erreur: 'Impossible de déplacer un dossier dans lui-même.' });
  const base = source.split('/').pop();
  const nouveau = destination ? destination + '/' + base : base;
  if (nouveau === source) return res.json({ ok: true, nouveau });
  if (db.prepare("SELECT 1 FROM dossiers WHERE chemin=?").get(nouveau)
      || db.prepare("SELECT 1 FROM produits WHERE dossier=? LIMIT 1").get(nouveau))
    return res.status(409).json({ erreur: `Un dossier « ${nouveau} » existe déjà.` });
  const tx = db.transaction(() => {
    db.prepare(`UPDATE produits SET dossier = ? || substr(dossier, ?) WHERE dossier = ? OR dossier LIKE ?`)
      .run(nouveau, source.length + 1, source, source + '/%');
    db.prepare(`UPDATE OR IGNORE dossiers SET chemin = ? || substr(chemin, ?) WHERE chemin = ? OR chemin LIKE ?`)
      .run(nouveau, source.length + 1, source, source + '/%');
    db.prepare('INSERT OR IGNORE INTO dossiers (chemin) VALUES (?)').run(nouveau);
    db.prepare('DELETE FROM dossiers WHERE chemin = ?').run(source);
  });
  tx();
  res.json({ ok: true, nouveau });
});

app.delete('/api/dossiers', (req, res) => {
  const chemin = nettoyerChemin(req.query.chemin);
  if (!chemin) return res.status(400).json({ erreur: 'Chemin vide' });
  const nb = db.prepare("SELECT COUNT(*) n FROM produits WHERE dossier = ? OR dossier LIKE ?").get(chemin, chemin + '/%').n;
  const sous = db.prepare("SELECT COUNT(*) n FROM dossiers WHERE chemin LIKE ?").get(chemin + '/%').n;
  if ((nb || sous) && req.query.force !== '1')
    return res.status(409).json({ erreur: 'non vide', fiches: nb, sous_dossiers: sous });
  const tx = db.transaction(() => {
    db.prepare("UPDATE produits SET dossier = NULL WHERE dossier = ? OR dossier LIKE ?").run(chemin, chemin + '/%');
    db.prepare("DELETE FROM dossiers WHERE chemin = ? OR chemin LIKE ?").run(chemin, chemin + '/%');
  });
  tx();
  res.json({ ok: true, fiches_declassees: nb });
});

// ---------- EXPLORATEUR ----------
app.get('/api/arbre', (req, res) => {
  const chemins = db.prepare(`SELECT dossier FROM (SELECT chemin AS dossier FROM dossiers
      UNION SELECT DISTINCT dossier FROM produits WHERE dossier IS NOT NULL AND dossier != '')
    ORDER BY dossier`).all().map(r => r.dossier);
  res.json({ chemins });
});

const nettoyerChemin = (d) => String(d || '')
  .replace(/\\/g, '/').split('/').map(x => x.trim()).filter(Boolean)
  .map(x => x.replace(/[^\w\s.\-()&+]/g, '')).join('/').slice(0, 200);

app.patch('/api/produits/dossier', (req, res) => {
  const ids = (req.body.ids || []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ erreur: 'Aucune fiche sélectionnée' });
  const dossier = nettoyerChemin(req.body.dossier);
  const maj = db.prepare('UPDATE produits SET dossier=? WHERE id=?');
  let n = 0;
  for (const id of ids) n += maj.run(dossier || null, id).changes;
  res.json({ ok: true, classees: n, dossier: dossier || null });
});

app.patch('/api/produits/:id/dossier', (req, res) => {
  const p = db.prepare('SELECT id, reference FROM produits WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ erreur: 'Fiche introuvable' });
  const dossier = nettoyerChemin(req.body.dossier);
  db.prepare('UPDATE produits SET dossier=? WHERE id=?').run(dossier || null, p.id);
  res.json({ ok: true, reference: p.reference, dossier: dossier || null });
});

app.get('/api/sante', (req, res) => {
  const CLES = { port: 'port', prix: 'prix', dimensions: 'taille_produit', poids: 'poids_nb', volume: 'volume_m3', colisage: 'colisage_cm', pcb: 'pcb' };
  const parFichier = {};
  for (const p of db.prepare(`SELECT p.id, p.reference, p.fichier_id, f.nom, p.port, p.prix, p.taille_produit, p.poids_nb, p.volume_m3, p.colisage_cm, p.pcb
      FROM produits p JOIN fichiers f ON f.id=p.fichier_id`).all()) {
    const e = (parFichier[p.fichier_id] ||= { fichier_id: p.fichier_id, nom: p.nom, total: 0, manques: {}, refs_incompletes: new Set() });
    e.total++;
    for (const [lib, col] of Object.entries(CLES)) {
      const v = p[col];
      if (v == null || String(v).trim() === '') { e.manques[lib] = (e.manques[lib] || 0) + 1; e.refs_incompletes.add(p.reference); }
    }
  }
  const liste = Object.values(parFichier).filter(e => Object.keys(e.manques).length)
    .map(e => ({ ...e, refs_incompletes: [...e.refs_incompletes].slice(0, 40) }))
    .sort((a, b) => Object.values(b.manques).reduce((x, y) => x + y, 0) - Object.values(a.manques).reduce((x, y) => x + y, 0));
  res.json(liste);
});

app.get('/api/dossiers/arbre', (req, res) => {
  const chemins = db.prepare('SELECT chemin FROM dossiers ORDER BY chemin').all().map(x => x.chemin);
  const comptes = {};
  for (const l of db.prepare("SELECT dossier, COUNT(*) n FROM produits WHERE dossier IS NOT NULL AND dossier<>'' GROUP BY dossier").all())
    comptes[l.dossier] = l.n;
  res.json({ chemins, comptes });
});

app.get('/api/explorateur', (req, res) => {
  const d = String(req.query.d || '').replace(/^\/+|\/+$/g, '');
  const tous = db.prepare(`SELECT chemin AS dossier FROM dossiers
      UNION SELECT DISTINCT dossier FROM produits WHERE dossier IS NOT NULL AND dossier != ''`).all().map(r => r.dossier);
  const sousDossiers = new Set();
  for (const c of tous) {
    if (d === '' ) { sousDossiers.add(c.split('/')[0]); }
    else if (c === d) continue;
    else if (c.startsWith(d + '/')) sousDossiers.add(c.slice(d.length + 1).split('/')[0]);
  }
  const produitsClasses = d === '' ? [] : db.prepare(`SELECT p.*, f.nom AS fichier_nom, f.dossier AS fichier_dossier
    FROM produits p JOIN fichiers f ON f.id = p.fichier_id WHERE p.dossier = ? ORDER BY p.reference`).all(d).map(enrichir);
  const supprimable = d !== '' && !produitsClasses.length && ![...sousDossiers].length;
  res.json({ dossier: d, sous_dossiers: [...sousDossiers].sort(), produits_classes: produitsClasses, supprimable });
});

app.get('/api/fichier/:id/images', (req, res) => {
  const pid = Number(req.query.pid) || 0;
  const imgs = db.prepare(`SELECT i.id, i.ligne_ancrage, i.ambigue,
      (SELECT GROUP_CONCAT(p.reference, ' · ') FROM produit_images pi JOIN produits p ON p.id = pi.produit_id WHERE pi.image_id = i.id) AS refs,
      (SELECT COUNT(*) FROM produit_images WHERE image_id = i.id AND produit_id = :pid) AS associee_cible,
      (SELECT principale FROM produit_images WHERE image_id = i.id AND produit_id = :pid) AS principale_cible
    FROM images i WHERE i.fichier_id = :fid ORDER BY i.ligne_ancrage, i.id`).all({ pid, fid: req.params.id });
  res.json(imgs);
});

app.post('/api/produits/:pid/images/:iid', (req, res) => {
  if (!db.prepare('SELECT id FROM produits WHERE id=?').get(req.params.pid)) return res.status(404).json({ erreur: 'Fiche introuvable' });
  if (!db.prepare('SELECT id FROM images WHERE id=?').get(req.params.iid)) return res.status(404).json({ erreur: 'Image introuvable' });
  db.prepare('INSERT OR IGNORE INTO produit_images (produit_id, image_id) VALUES (?,?)').run(req.params.pid, req.params.iid);
  db.prepare('UPDATE images SET ambigue=0 WHERE id=?').run(req.params.iid);
  res.json({ ok: true, associee: true });
});
app.delete('/api/produits/:pid/images/:iid', (req, res) => {
  db.prepare('DELETE FROM produit_images WHERE produit_id=? AND image_id=?').run(req.params.pid, req.params.iid);
  res.json({ ok: true, associee: false });
});

app.patch('/api/images/:id', (req, res) => {
  const img = db.prepare('SELECT id FROM images WHERE id=?').get(req.params.id);
  if (!img) return res.status(404).json({ erreur: 'Image introuvable' });
  const pid = req.body.produit_id == null ? null : Number(req.body.produit_id);
  if (pid != null && !db.prepare('SELECT id FROM produits WHERE id=?').get(pid))
    return res.status(404).json({ erreur: 'Fiche introuvable' });
  db.prepare('UPDATE images SET produit_id=?, ambigue=0 WHERE id=?').run(pid, req.params.id);
  res.json({ ok: true });
});

app.get('/api/fichier/:id/produits', (req, res) => {
  const f = db.prepare('SELECT id, nom, dossier, type, mode, depose_le, statut FROM fichiers WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ erreur: 'Fichier introuvable' });
  const produits = db.prepare(`SELECT p.*, ? AS fichier_nom, ? AS fichier_dossier FROM produits p
    WHERE p.fichier_id = ? ORDER BY p.ligne, p.id`).all(f.nom, f.dossier, f.id).map(enrichir);
  res.json({ fichier: f, produits });
});

// ---------- LISTES DE SÉLECTION ----------
app.post('/api/fichiers/:id/valider', (req, res) => {
  db.prepare('UPDATE fichiers SET valide=1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/produits/:id/selections', (req, res) => {
  res.json(db.prepare(`SELECT l.id, l.nom, (SELECT COUNT(*) FROM liste_items WHERE liste_id = l.id) AS nb
    FROM listes l JOIN liste_items li ON li.liste_id = l.id
    WHERE li.produit_id = ? AND l.enregistree = 1 ORDER BY l.nom`).all(req.params.id));
});

app.get('/api/produits/:id/commandes', (req, res) => {
  const p = db.prepare('SELECT reference FROM produits WHERE id=?').get(req.params.id);
  if (!p) return res.json([]);
  const sorties = [];
  for (const t of db.prepare('SELECT id, nom, resultat, dossier FROM tableaux WHERE resultat IS NOT NULL').all()) {
    let r2 = null; try { r2 = JSON.parse(t.resultat); } catch {}
    if (!r2 || !r2.parRef) continue;
    const o = r2.parRef[p.reference] || Object.values(r2.parRef).find(x => x.refCatalogue === p.reference);
    if (!o) continue;
    const grille = o.grille || {};
    const parPeriode = {};
    for (const [cle, v] of Object.entries(grille)) {
      const [theme] = cle.split('|');
      parPeriode[theme] = parPeriode[theme] || { uvc: 0, colis: 0 };
      parPeriode[theme].uvc += Number(v.uvc) || 0;
      parPeriode[theme].colis += Number(v.colis) || 0;
    }
    const fobCom = Number(o.fob_com) || 0;
    const ddp = Number(o.ddp) || 0;
    const caTotal = ddp && o.final ? +(ddp * o.final).toFixed(2) : null;      // ce que U paie (DDP € × FINAL)
    const achatTotal = fobCom && o.final ? +(fobCom * o.final).toFixed(2) : null; // coût d'achat usine (FOB USD × FINAL)
    sorties.push({
      tableau_id: t.id, tableau_nom: t.nom, dossier: t.dossier || null, etape: r2.etape || null,
      commande: r2.etape && r2.etape !== 'partie1',
      final: o.final ?? null, estim: o.estim ?? null,
      fob_com: o.fob_com ?? null, ddp: o.ddp ?? null, promotion: o.promotion || null,
      ca_total: caTotal, achat_total: achatTotal,
      periodes: Object.entries(parPeriode).map(([theme, v]) => ({ theme, ...v })),
    });
  }
  res.json(sorties);
});

app.post('/api/selection/basculer', (req, res) => {
  const pid = Number(req.body.id);
  if (!pid) return res.status(400).json({ erreur: 'id manquant' });
  const atrier = db.prepare('SELECT id FROM listes WHERE systeme=1').get();
  const deja = db.prepare('SELECT 1 FROM liste_items WHERE liste_id=? AND produit_id=?').get(atrier.id, pid);
  if (deja) db.prepare('DELETE FROM liste_items WHERE liste_id=? AND produit_id=?').run(atrier.id, pid);
  else db.prepare('INSERT INTO liste_items (liste_id, produit_id) VALUES (?,?)').run(atrier.id, pid);
  res.json({ ok: true, en_selection: !deja });
});

app.post('/api/selection/enregistrer', (req, res) => {
  const groupeId = Number(req.body.groupe_id);
  const groupe = db.prepare('SELECT * FROM listes WHERE id=? AND systeme=0 AND enregistree=0').get(groupeId);
  if (!groupe) return res.status(404).json({ erreur: 'Groupe de travail introuvable' });
  let cible;
  if (req.body.vers_id) {
    cible = db.prepare('SELECT * FROM listes WHERE id=? AND enregistree=1').get(Number(req.body.vers_id));
    if (!cible) return res.status(404).json({ erreur: 'Sélection cible introuvable' });
  } else {
    const nom = String(req.body.nouveau_nom || '').trim();
    if (!nom) return res.status(400).json({ erreur: 'Nom de la nouvelle sélection manquant' });
    const r = db.prepare('INSERT INTO listes (nom, enregistree) VALUES (?, 1)').run(nom);
    cible = { id: r.lastInsertRowid, nom };
  }
  const items = db.prepare('SELECT produit_id FROM liste_items WHERE liste_id=?').all(groupeId);
  const tx = db.transaction(() => {
    const ins = db.prepare('INSERT OR IGNORE INTO liste_items (liste_id, produit_id) VALUES (?,?)');
    for (const it of items) ins.run(cible.id, it.produit_id);
    db.prepare('DELETE FROM liste_items WHERE liste_id=?').run(groupeId);
    db.prepare('DELETE FROM listes WHERE id=?').run(groupeId);
  });
  tx();
  res.json({ ok: true, selection: cible, transferes: items.length });
});

app.post('/api/selection/atrier', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ erreur: 'Aucune fiche' });
  const atrier = db.prepare('SELECT id FROM listes WHERE systeme=1').get();
  const ins = db.prepare('INSERT OR IGNORE INTO liste_items (liste_id, produit_id) VALUES (?,?)');
  let n = 0;
  for (const id of ids) n += ins.run(atrier.id, id).changes;
  res.json({ ok: true, ajoutes: n, liste_id: atrier.id });
});

app.patch('/api/listes/deplacer-item', (req, res) => {
  const { produit_id, de, vers } = req.body;
  if (!produit_id || !vers) return res.status(400).json({ erreur: 'Paramètres manquants' });
  if (!db.prepare('SELECT id FROM listes WHERE id=?').get(vers)) return res.status(404).json({ erreur: 'Groupe cible introuvable' });
  const deja = db.prepare('SELECT 1 FROM liste_items WHERE liste_id=? AND produit_id=?').get(vers, produit_id);
  if (deja) return res.json({ ok: true, deja: true });
  const tx = db.transaction(() => {
    if (de) db.prepare('DELETE FROM liste_items WHERE liste_id=? AND produit_id=?').run(de, produit_id);
    db.prepare('INSERT INTO liste_items (liste_id, produit_id) VALUES (?,?)').run(vers, produit_id);
  });
  tx();
  res.json({ ok: true });
});

app.post('/api/produits/:pid/images/:iid/principale', (req, res) => {
  const assoc = db.prepare('SELECT 1 FROM produit_images WHERE produit_id=? AND image_id=?').get(req.params.pid, req.params.iid);
  if (!assoc) return res.status(404).json({ erreur: 'Photo non associée à cette fiche' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE produit_images SET principale=0 WHERE produit_id=?').run(req.params.pid);
    db.prepare('UPDATE produit_images SET principale=1 WHERE produit_id=? AND image_id=?').run(req.params.pid, req.params.iid);
  });
  tx();
  res.json({ ok: true });
});

app.get('/api/listes', (req, res) => {
  let listes = db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM liste_items WHERE liste_id = l.id) AS nb
    FROM listes l ORDER BY l.id DESC`).all();
  if (!listes.length) {
    db.prepare('INSERT INTO listes (nom) VALUES (?)').run('Ma sélection');
    listes = db.prepare(`SELECT l.*, 0 AS nb FROM listes l`).all();
  }
  res.json(listes);
});
app.post('/api/listes', (req, res) => {
  const nom = String(req.body.nom || '').trim().slice(0, 80);
  if (!nom) return res.status(400).json({ erreur: 'Nom vide' });
  const r = db.prepare('INSERT INTO listes (nom, enregistree) VALUES (?,?)').run(nom, req.body.enregistree ? 1 : 0);
  res.json({ id: r.lastInsertRowid, nom });
});
app.patch('/api/listes/:id', (req, res) => {
  const nom = String(req.body.nom || '').trim().slice(0, 80);
  if (!nom) return res.status(400).json({ erreur: 'Nom vide' });
  const r = db.prepare('UPDATE listes SET nom=? WHERE id=?').run(nom, req.params.id);
  if (!r.changes) return res.status(404).json({ erreur: 'Liste introuvable' });
  res.json({ ok: true, nom });
});
app.delete('/api/listes/:id', (req, res) => {
  const l = db.prepare('SELECT nom, (SELECT COUNT(*) FROM liste_items WHERE liste_id=listes.id) AS nb FROM listes WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ erreur: 'Liste introuvable' });
  db.prepare('DELETE FROM listes WHERE id=?').run(req.params.id); // items en cascade
  res.json({ ok: true, nom: l.nom, items_supprimes: l.nb });
});

app.get('/api/listes/:id', (req, res) => {
  const liste = db.prepare('SELECT * FROM listes WHERE id=?').get(req.params.id);
  if (!liste) return res.status(404).json({ erreur: 'Liste introuvable' });
  const items = db.prepare(`SELECT li.id AS item_id, li.ajoute_le, p.*, f.nom AS fichier_nom, f.dossier AS fichier_dossier
    FROM liste_items li JOIN produits p ON p.id = li.produit_id JOIN fichiers f ON f.id = p.fichier_id
    WHERE li.liste_id = ? ORDER BY li.id DESC`).all(liste.id).map(enrichir);
  res.json({ liste, items });
});
app.post('/api/listes/:id/items', (req, res) => {
  const pid = Number(req.body.produit_id);
  if (!db.prepare('SELECT id FROM produits WHERE id=?').get(pid)) return res.status(404).json({ erreur: 'Produit introuvable' });
  try {
    db.prepare('INSERT INTO liste_items (liste_id, produit_id) VALUES (?,?)').run(req.params.id, pid);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true, deja: true }); // déjà dans la liste : pas une erreur
  }
});
app.delete('/api/listes/:id/items/:pid', (req, res) => {
  db.prepare('DELETE FROM liste_items WHERE liste_id=? AND produit_id=?').run(req.params.id, req.params.pid);
  res.json({ ok: true });
});

// ---------- DOUBLONS ----------
function groupesDoublons() {
  const refs = db.prepare(`SELECT reference, COUNT(*) n, GROUP_CONCAT(id) ids FROM produits
    GROUP BY reference HAVING n > 1 ORDER BY reference`).all();
  const groupes = [];
  for (const r of refs) {
    const signature = r.ids.split(',').map(Number).sort((a,b)=>a-b).join(',');
    const valide = db.prepare('SELECT signature FROM doublons_valides WHERE reference=?').get(r.reference);
    if (valide && valide.signature === signature) continue; // déjà tranché, rien de nouveau
    const occurrences = db.prepare(`SELECT p.*, f.nom AS fichier_nom, f.dossier AS fichier_dossier, f.depose_le
      FROM produits p JOIN fichiers f ON f.id = p.fichier_id WHERE p.reference = ? ORDER BY p.id`)
      .all(r.reference).map(enrichir);
    groupes.push({ reference: r.reference, signature, occurrences });
  }
  return groupes;
}
app.get('/api/doublons', (req, res) => res.json(groupesDoublons()));
app.post('/api/doublons/garder-recents', (req, res) => {
  // pour chaque réf en doublon entre fichiers : on ne garde que la plus récente
  const groupes = db.prepare(`SELECT reference FROM produits GROUP BY reference HAVING COUNT(DISTINCT fichier_id) > 1`).all();
  let resolues = 0, supprimees = 0;
  for (const g of groupes) {
    const fiches = db.prepare(`SELECT pr.id, pr.dossier, f.depose_le FROM produits pr JOIN fichiers f ON f.id=pr.fichier_id
      WHERE pr.reference = ? ORDER BY f.depose_le DESC, pr.id DESC`).all(g.reference);
    const [gardee, ...vieilles] = fiches;
    if (!vieilles.length) continue;
    const dossierHerite = !gardee.dossier ? (vieilles.find(v => v.dossier) || {}).dossier : null;
    if (dossierHerite) db.prepare('UPDATE produits SET dossier=? WHERE id=?').run(dossierHerite, gardee.id);
    for (const v of vieilles) { db.prepare('DELETE FROM produits WHERE id=?').run(v.id); supprimees++; }
    resolues++;
  }
  res.json({ ok: true, resolues, supprimees });
});
app.post('/api/doublons/garder', (req, res) => {
  const ref = String(req.body.reference || '');
  const g = groupesDoublons().find(x => x.reference === ref);
  if (!g) return res.status(404).json({ erreur: 'Groupe introuvable' });
  db.prepare('INSERT OR REPLACE INTO doublons_valides (reference, signature) VALUES (?,?)').run(ref, g.signature);
  res.json({ ok: true });
});
function relancerFichier(f, mode) {
  const disque = (() => { try { return JSON.parse(f.rapport || '{}').disque; } catch { return null; } })();
  if (!disque || !fs.existsSync(path.join(DATA_DIR, 'fichiers', disque))) return false;
  const hashes = db.prepare('SELECT DISTINCT hash FROM images WHERE fichier_id=?').all(f.id).map(r => r.hash);
  db.prepare('DELETE FROM images WHERE fichier_id=?').run(f.id);
  db.prepare('DELETE FROM produits WHERE fichier_id=?').run(f.id);
  for (const h of hashes) {
    if (!db.prepare('SELECT 1 FROM images WHERE hash=? LIMIT 1').get(h)) {
      for (const fchr of fs.readdirSync(path.join(DATA_DIR, 'images')))
        if (fchr.startsWith(h)) { try { fs.unlinkSync(path.join(DATA_DIR, 'images', fchr)); } catch {} }
    }
  }
  db.prepare("UPDATE fichiers SET mode=?, statut='en_attente', valide=0, rapport=? WHERE id=?")
    .run(mode || f.mode || 'offre', JSON.stringify({ disque }), f.id);
  return true;
}
app.post('/api/fichiers/:id/reclasser', async (req, res) => {
  const f = db.prepare('SELECT * FROM fichiers WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ erreur: 'Fichier introuvable' });
  const mode = req.body.mode === 'interne' ? 'interne' : 'offre';
  if (!relancerFichier(f, mode)) return res.status(409).json({ erreur: 'Copie source introuvable sur le disque' });
  res.json({ ok: true, en_file: true });
  setTimeout(pomperFile, 400);
});

app.delete('/api/fichiers/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM fichiers WHERE id=?').get(req.params.id);
  if (f) { try { fs.unlinkSync(path.join(DATA_DIR, 'apercus', (f.hash || '') + '.html')); } catch {}
    try { fs.unlinkSync(path.join(DATA_DIR, 'apercus', req.params.id + '.html')); } catch {} }
  if (!f) return res.status(404).json({ erreur: 'Fichier introuvable' });
  const nbProduits = db.prepare('SELECT COUNT(*) n FROM produits WHERE fichier_id=?').get(f.id).n;
  const imgs = db.prepare('SELECT DISTINCT hash, chemin FROM images WHERE fichier_id=?').all(f.id);
  db.prepare('DELETE FROM fichiers WHERE id=?').run(f.id); // cascade : produits, images, textes, liste_items
  // fichiers physiques : original + images devenues orphelines (partage par hash)
  const disque = JSON.parse(f.rapport || '{}').disque;
  if (disque) { try { fs.unlinkSync(path.join(DATA_DIR, 'fichiers', disque)); } catch {} }
  for (const im of imgs) {
    const encore = db.prepare('SELECT COUNT(*) n FROM images WHERE hash=?').get(im.hash).n;
    if (!encore) { try { fs.unlinkSync(path.join(DATA_DIR, 'images', im.chemin)); } catch {} }
  }
  res.json({ ok: true, nom: f.nom, produits_supprimes: nbProduits });
});

app.get('/api/fichiers/:id/resume', (req, res) => {
  const f = db.prepare('SELECT id, nom FROM fichiers WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ erreur: 'Fichier introuvable' });
  res.json({
    nom: f.nom,
    produits: db.prepare('SELECT COUNT(*) n FROM produits WHERE fichier_id=?').get(f.id).n,
    images: db.prepare('SELECT COUNT(*) n FROM images WHERE fichier_id=?').get(f.id).n,
    en_listes: db.prepare(`SELECT COUNT(*) n FROM liste_items li JOIN produits p ON p.id=li.produit_id WHERE p.fichier_id=?`).get(f.id).n,
  });
});

app.delete('/api/fichiers/:id', (req, res) => {
  const f = db.prepare('SELECT id, nom, rapport FROM fichiers WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ erreur: 'Fichier introuvable' });
  const hashes = db.prepare('SELECT DISTINCT hash FROM images WHERE fichier_id=?').all(f.id).map(r => r.hash);
  const disque = (() => { try { return JSON.parse(f.rapport || '{}').disque; } catch { return null; } })();
  db.prepare('DELETE FROM fichiers WHERE id=?').run(f.id); // cascades : produits, images, textes, liste_items
  // fichiers image orphelins sur le disque (le hash peut être partagé entre fichiers)
  for (const h of hashes) {
    const encore = db.prepare('SELECT chemin FROM images WHERE hash=? LIMIT 1').get(h);
    if (!encore) {
      const uneImg = db.prepare('SELECT 1').get; // no-op
      // le chemin est <hash>.<ext> : on cherche le fichier correspondant
      for (const fchr of fs.readdirSync(path.join(DATA_DIR, 'images'))) {
        if (fchr.startsWith(h)) { try { fs.unlinkSync(path.join(DATA_DIR, 'images', fchr)); } catch {} }
      }
    }
  }
  if (disque) { try { fs.unlinkSync(path.join(DATA_DIR, 'fichiers', disque)); } catch {} }
  res.json({ ok: true, nom: f.nom });
});

app.post('/api/produits/refuser', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ erreur: 'Aucune fiche à refuser' });
  const marques = ids.map(() => '?').join(',');
  const refs = db.prepare(`SELECT reference FROM produits WHERE id IN (${marques})`).all(...ids).map(r => r.reference);
  db.prepare(`DELETE FROM produits WHERE id IN (${marques})`).run(...ids);
  res.json({ ok: true, refusees: refs.length, references: refs });
});

app.delete('/api/produits/:id', (req, res) => {
  const p = db.prepare('SELECT reference FROM produits WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ erreur: 'Fiche introuvable' });
  db.prepare('DELETE FROM produits WHERE id=?').run(req.params.id); // images -> produit_id NULL, listes -> cascade
  res.json({ ok: true, reference: p.reference });
});

app.get('/apercu/:id', async (req, res) => {
  const f = db.prepare('SELECT id, nom, type, rapport, hash FROM fichiers WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).send('Fichier introuvable');
  const echap = (x) => String(x || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  if (f.type === 'msg') {
    let disqueM = null; try { disqueM = JSON.parse(f.rapport || '{}').disque; } catch {}
    if (!disqueM || !fs.existsSync(path.join(DATA_DIR, 'fichiers', disqueM))) return res.status(404).send('Copie source introuvable');
    const bufM = fs.readFileSync(path.join(DATA_DIR, 'fichiers', disqueM));
    let m = { corps: '', pieces: [] };
    try { m = ex.lireMsg(bufM); } catch {}
    const corps = m.corps || ex.texteMsg(bufM);
    return res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${echap(f.nom)}</title>
<body style="font-family:system-ui,sans-serif;max-width:860px;margin:26px auto;padding:0 18px;color:#1c2742">
<div style="background:#f2f5fb;border:1.5px solid #c6cede;border-radius:12px;padding:14px 18px;margin-bottom:16px">
  <div style="font-weight:700;font-size:15px">✉ ${echap(f.nom)}</div>
  ${m.pieces.length ? `<div style="font-size:12.5px;margin-top:6px">📎 ${m.pieces.length} pièce(s) jointe(s) : ${m.pieces.map(p => echap(p.nom)).join(', ')}</div>` : ''}
</div>
<pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.55">${echap(corps)}</pre>`);
  }
  const convertibles = ['xls', 'xlsx', 'pptx', 'docx'];
  const disquePdf = (() => { try { return JSON.parse(f.rapport || '{}').disque; } catch { return null; } })();
  if (f.type === 'pdf') {
    if (!disquePdf) return res.status(404).send('Copie source introuvable');
    res.type('application/pdf');
    res.setHeader('content-disposition', 'inline; filename="' + encodeURIComponent(f.nom) + '"');
    return res.send(fs.readFileSync(path.join(DATA_DIR, 'fichiers', disquePdf)));
  }
  if (!convertibles.includes(f.type)) return res.type('html').send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:60px auto;text-align:center;color:#1c2742">
    <h3>Pas d'aperçu pour ce format (.${echap(f.type)})</h3>
    <p><a href="/fichier/${f.id}" style="display:inline-block;background:#ffd400;color:#1c2742;font-weight:700;padding:10px 22px;border-radius:10px;text-decoration:none">⬇ Télécharger « ${echap(f.nom)} »</a></p>`);
  const cache = path.join(DATA_DIR, 'apercus', f.hash + '-v3.html');
  if (fs.existsSync(cache)) return res.type('html').send(fs.readFileSync(cache, 'utf8'));
  const disque = (() => { try { return JSON.parse(f.rapport || '{}').disque; } catch { return null; } })();
  if (!disque) return res.status(404).send('Copie source introuvable');
  if (f.type === 'pptx') {
    return ex.apercuPptx(fs.readFileSync(path.join(DATA_DIR, 'fichiers', disque)), f.nom)
      .then(h => { fs.writeFileSync(cache, h); res.type('html').send(h); })
      .catch(e => res.status(500).send('Aperçu impossible : ' + e.message));
  }
  const html = await ex.genererApercuHtml(fs.readFileSync(path.join(DATA_DIR, 'fichiers', disque)), f.type);
  if (!html) return res.status(503).send('Aperçu indisponible (LibreOffice absent du serveur)');
  fs.writeFileSync(cache, html);
  res.type('html').send(html);
});

app.get('/api/stats', (req, res) => {
  res.json({
    doublons: db.prepare(`SELECT COUNT(*) n FROM (SELECT reference FROM produits GROUP BY reference HAVING COUNT(*)>1)`).get().n
      - db.prepare(`SELECT COUNT(*) n FROM doublons_valides dv WHERE dv.signature =
          (SELECT GROUP_CONCAT(id) FROM (SELECT id FROM produits WHERE reference = dv.reference ORDER BY id))`).get().n,
    fichiers: db.prepare('SELECT COUNT(*) n FROM fichiers').get().n,
    produits: db.prepare('SELECT COUNT(*) n FROM produits').get().n,
    references: db.prepare('SELECT COUNT(DISTINCT reference) n FROM produits').get().n,
    images: db.prepare('SELECT COUNT(*) n FROM images').get().n,
  });
});

// ---------- ESPACE TABLEAUX ----------
const tb = require('./lib/tableau');

function construireCatalogue() {
  const fiches = db.prepare(`SELECT p.*, (SELECT i.id FROM produit_images pi JOIN images i ON i.id = pi.image_id
      WHERE pi.produit_id = p.id ORDER BY pi.principale DESC, i.id LIMIT 1) AS image_id
    FROM produits p ORDER BY p.id`).all();
  const cat = {}, doublons = new Set();
  for (const p of fiches) {
    if (!p.reference) continue;
    if (cat[p.reference]) { doublons.add(p.reference); continue; }
    cat[p.reference] = {
      code_douanier: p.code_hs_usine || '', description: p.description || '', kd: p.kd ? 'KD' : '',
      taille_produit: p.taille_produit || '', pcb: p.pcb ? Number(p.pcb) || p.pcb : null,
      colisage_cm: p.colisage_cm || '', volume_m3: p.volume_m3 || '', poids_nb: p.poids_nb || '',
      fob_com: p.prix != null && p.prix !== '' && !isNaN(Number(p.prix)) ? Number(p.prix) : null,
      port: p.port || '', fournisseur: p.fournisseur || '', produit_id: p.id, image_id: p.image_id || null, ean_fiche: p.ean || null };
  }
  // une fiche sans port récupère le port de l'ANNUAIRE de son usine (onglet Fournisseurs)
  try {
    const portsAnnuaire = {};
    for (const u of db.prepare("SELECT nom_norm, port FROM usines WHERE port IS NOT NULL AND port<>''").all())
      portsAnnuaire[u.nom_norm] = u.port;
    const multiPorts = new Set();
    const vus = {};
    for (const c of Object.values(cat)) {
      if (!c.port || !c.fournisseur) continue;
      const k = normUsine(c.fournisseur), p = String(c.port).trim().toUpperCase();
      (vus[k] ||= new Set()).add(p);
      if (vus[k].size > 1) multiPorts.add(k);
    }
    for (const c of Object.values(cat)) {
      if (c.port || !c.fournisseur) continue;
      const k = normUsine(c.fournisseur);
      c.port = portsAnnuaire[k] || '';
      if (c.port && multiPorts.has(k)) c.port_ambigu = true; // repli appliqué mais l'usine a chargé depuis plusieurs ports
    }
  } catch {}
  return { cat, doublons: [...doublons] };
}

function journal(tid, action, detail) {
  const t = db.prepare('SELECT journal FROM tableaux WHERE id=?').get(tid);
  let j = []; try { j = JSON.parse(t.journal); } catch {}
  j.push({ quand: new Date().toISOString().slice(0, 16).replace('T', ' '), action, detail: detail || '' });
  db.prepare('UPDATE tableaux SET journal=? WHERE id=?').run(JSON.stringify(j), tid);
}

// ---------- annuaire des usines ----------
app.get('/api/usines', (req, res) => {
  const usines = db.prepare('SELECT * FROM usines ORDER BY nom_affiche COLLATE NOCASE').all();
  const comptes = {}, fichiersU = {}, portsObs = {};
  for (const l of db.prepare("SELECT fournisseur, port, COUNT(*) n FROM produits WHERE port IS NOT NULL AND TRIM(port)<>'' GROUP BY fournisseur, port").all()) {
    const k = normUsine(l.fournisseur);
    ((portsObs[k] ||= {})[String(l.port).trim().toUpperCase()] = (portsObs[k][String(l.port).trim().toUpperCase()] || 0) + l.n);
  }
  for (const l of db.prepare("SELECT fournisseur, COUNT(*) n, GROUP_CONCAT(DISTINCT fichier_id) fids FROM produits WHERE fournisseur IS NOT NULL GROUP BY fournisseur").all()) {
    const k = normUsine(l.fournisseur);
    comptes[k] = (comptes[k] || 0) + l.n;
    (fichiersU[k] ||= new Set());
    for (const fid of String(l.fids || '').split(',')) if (fid) fichiersU[k].add(Number(fid));
  }
  const nomsF = {};
  for (const f of db.prepare('SELECT id, nom FROM fichiers').all()) nomsF[f.id] = f.nom;
  res.json(usines.map(u => ({ ...u, nb_refs: comptes[u.nom_norm] || 0,
    ports_observes: Object.entries(portsObs[u.nom_norm] || {}).sort((a, b) => b[1] - a[1]).map(([p, n]) => ({ port: p, n })),
    fichiers: [...(fichiersU[u.nom_norm] || [])].map(id => ({ id, nom: nomsF[id] })).filter(x => x.nom) })));
});
app.patch('/api/usines/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM usines WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ erreur: 'Usine inconnue' });
  const CHAMPS = ['nom_affiche', 'port', 'adresse', 'contact', 'telephone', 'email', 'messagerie', 'site', 'conditions', 'notes'];
  const sets = [], vals = { id: u.id };
  for (const c of CHAMPS) if (c in req.body) { sets.push(`${c}=@${c}`); vals[c] = String(req.body[c] ?? '').trim() || null; }
  if (!sets.length) return res.json(u);
  db.prepare(`UPDATE usines SET ${sets.join(', ')}, modifie_le=datetime('now','localtime') WHERE id=@id`).run(vals);
  res.json(db.prepare('SELECT * FROM usines WHERE id=?').get(u.id));
});
app.post('/api/usines/nettoyer', (req, res) => {
  const comptes = {};
  for (const l of db.prepare("SELECT fournisseur, COUNT(*) n FROM produits WHERE fournisseur IS NOT NULL GROUP BY fournisseur").all())
    comptes[normUsine(l.fournisseur)] = (comptes[normUsine(l.fournisseur)] || 0) + l.n;
  const orphelines = db.prepare('SELECT id, nom_affiche, nom_norm FROM usines').all().filter(u => !comptes[u.nom_norm]);
  for (const u of orphelines) db.prepare('DELETE FROM usines WHERE id=?').run(u.id);
  res.json({ retirees: orphelines.length, noms: orphelines.map(u => u.nom_affiche) });
});

app.post('/api/usines/:id/fusionner', (req, res) => {
  const a = db.prepare('SELECT * FROM usines WHERE id=?').get(req.params.id);
  const b = db.prepare('SELECT * FROM usines WHERE id=?').get(req.body.cible_id);
  if (!a || !b || a.id === b.id) return res.status(400).json({ erreur: 'Usines invalides' });
  const prods = db.prepare('SELECT id, fournisseur FROM produits WHERE fournisseur IS NOT NULL').all()
    .filter(p => normUsine(p.fournisseur) === a.nom_norm);
  const tx = db.transaction(() => {
    const maj = db.prepare('UPDATE produits SET fournisseur=? WHERE id=?');
    for (const p of prods) maj.run(b.nom_affiche, p.id);
    // les infos de l'absorbée comblent les vides de la cible
    for (const c of ['port', 'adresse', 'contact', 'telephone', 'email', 'messagerie', 'site', 'conditions', 'notes'])
      if (!String(b[c] || '').trim() && String(a[c] || '').trim())
        db.prepare(`UPDATE usines SET ${c}=? WHERE id=?`).run(a[c], b.id);
    db.prepare('DELETE FROM usines WHERE id=?').run(a.id);
  });
  tx();
  res.json({ ok: true, refs_deplacees: prods.length, cible: db.prepare('SELECT * FROM usines WHERE id=?').get(b.id) });
});

// morceaux de texte pertinents d'un fichier : début + fin de chaque feuille + toute ligne "candidate" où qu'elle soit
function morceauxPourUsine(buffer) {
  const morceaux = [];
  const candidate = l => /@|www\.|http|tel|mob|phone|fax|add\b|address|wechat|whatsapp|contact|attn|邮|电话|地址/i.test(l);
  try {
    for (const f of ex.lireCellules(buffer)) {
      const lignes = f.lignes.map(v => v.filter(x => x !== '' && x != null).join(' | ')).filter(l => l.trim());
      const debut = lignes.slice(0, 14), fin = lignes.slice(-10);
      const ailleurs = lignes.length > 24 ? lignes.slice(14, -10).filter(candidate).slice(0, 20) : [];
      morceaux.push(`[feuille ${f.nom}]\n` + [...debut, ...ailleurs, ...fin].join('\n').slice(0, 3200));
    }
  } catch {}
  return morceaux.slice(0, 6);
}
app.post('/api/usines/:id/enrichir', async (req, res) => {
  try {
    const u = db.prepare('SELECT * FROM usines WHERE id=?').get(req.params.id);
    if (!u) return res.status(404).json({ erreur: 'Usine inconnue' });
    const fids = [...new Set(db.prepare('SELECT fichier_id, fournisseur FROM produits WHERE fournisseur IS NOT NULL').all()
      .filter(p => normUsine(p.fournisseur) === u.nom_norm).map(p => p.fichier_id))].slice(-5);
    if (!fids.length) return res.status(400).json({ erreur: 'Aucun fichier lié à cette usine.' });
    const morceaux = [];
    for (const fid of fids) {
      const f = db.prepare('SELECT * FROM fichiers WHERE id=?').get(fid);
      if (!f) continue;
      let disque = null; try { disque = JSON.parse(f.rapport || '{}').disque; } catch {}
      if (!disque || !fs.existsSync(path.join(DATA_DIR, 'fichiers', disque))) continue;
      const buf = fs.readFileSync(path.join(DATA_DIR, 'fichiers', disque));
      if (['xls', 'xlsx'].includes(f.type)) morceaux.push(...morceauxPourUsine(buf).map(m => `=== ${f.nom} ===\n${m}`));
      else if (f.type === 'pptx') { try { const sl = await ex.textePptxParSlides(buf); morceaux.push(`=== ${f.nom} ===\n` + sl.slice(0, 2).concat(sl.slice(-1)).map(x => x.texte).join('\n').slice(0, 2500)); } catch {} }
      else if (f.type === 'msg') { try { morceaux.push(`=== ${f.nom} ===\n` + String(ex.texteMsg(buf)).slice(0, 2500)); } catch {} }
    }
    if (!morceaux.length) return res.status(400).json({ erreur: 'Fichiers sources introuvables sur le disque.' });
    const infos = await ia.extraireInfosUsine(u.nom_affiche, morceaux);
    if (infos.erreur) return res.status(502).json({ erreur: infos.erreur });
    // on ne remplit que les cases vides : jamais d'écrasement d'une saisie manuelle
    const CHAMPS = ['adresse', 'contact', 'telephone', 'email', 'messagerie', 'site', 'port', 'conditions'];
    const sets = [], vals = { id: u.id };
    for (const c of CHAMPS) {
      const v = String(infos[c] ?? '').trim();
      if (v && !String(u[c] || '').trim()) { sets.push(`${c}=@${c}`); vals[c] = v; }
    }
    db.prepare(`UPDATE usines SET ${sets.length ? sets.join(', ') + ',' : ''} enrichie_le=datetime('now','localtime') WHERE id=@id`).run(vals);
    res.json({ ok: true, remplis: sets.map(x => x.split('=')[0]), usine: db.prepare('SELECT * FROM usines WHERE id=?').get(u.id) });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});
app.post('/api/usines/enrichir-lot', async (req, res) => {
  try {
    const aFaire = db.prepare("SELECT id FROM usines WHERE enrichie_le IS NULL ORDER BY id").all().slice(0, 10);
    let faites = 0;
    for (const u of aFaire) {
      const rep = await fetch(`http://127.0.0.1:${PORT}/api/usines/${u.id}/enrichir`, { method: 'POST' });
      if (rep.ok) faites++;
      else db.prepare("UPDATE usines SET enrichie_le=datetime('now','localtime') WHERE id=?").run(u.id);
    }
    const restantes = db.prepare('SELECT COUNT(*) n FROM usines WHERE enrichie_le IS NULL').get().n;
    res.json({ faites, restantes });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});

async function genererModele(t) {
  let sources = [], ajust = {};
  try { sources = JSON.parse(t.sources); } catch {}
  try { ajust = JSON.parse(t.ajustements || '{}'); } catch {}
  const selections = [], commandes = [];
  for (const src of sources) {
    const buf = fs.readFileSync(path.join(DATA_DIR, 'tableaux', src.disque));
    if (src.role === 'selection') selections.push(tb.lireSelectionU(buf));
    else if (src.role === 'commande') commandes.push(await tb.lireCommandePdf(buf));
  }
  if (!selections.length) throw new Error('Aucune sélection U dans les pièces du tableau.');
  // le tableau est un document HISTORIQUE : les fiches déjà entrées gardent leurs valeurs d'origine,
  // seules les références nouvelles piochent dans la base vivante
  let figeAvant = {}; try { figeAvant = (JSON.parse(t.resultat || 'null') || {}).catalogue_fige || {}; } catch {}
  const { cat: catVivant, doublons } = construireCatalogue();
  // fusion fine : une valeur HISTORIQUE non vide prime, mais un champ resté VIDE au figeage
  // se comble depuis la base vivante (fiche complétée depuis -> le tableau se complète et se réarrange)
  const cat = { ...catVivant };
  // rapprochements manuels du tableau : la réf de la commande utilise les données d'une fiche
  // qui existe sous une autre écriture — sans jamais toucher la fiche elle-même
  let ajustTot = {}; try { ajustTot = JSON.parse(t.ajustements || 'null') || {}; } catch {}
  const infosRapproch = [];
  for (const [refCmd, refFiche] of Object.entries(ajustTot.rapprochements || {})) {
    if (catVivant[refFiche] && !catVivant[refCmd]) {
      cat[refCmd] = { ...catVivant[refFiche] };
      infosRapproch.push(`ℹ ${refCmd} : données de la fiche « ${refFiche} » (rapprochement manuel — la fiche garde sa référence).`);
    }
  }
  for (const [refF, fige] of Object.entries(figeAvant)) {
    const fusion = { ...(catVivant[refF] || {}) };
    for (const [k, v] of Object.entries(fige))
      if (v != null && String(v).trim() !== '') fusion[k] = v;
    cat[refF] = fusion;
  }
  const modele = tb.assemblerTableau({ selections, commandes, catalogue: cat });
  for (const s2 of selections) modele.avertissements.unshift(...(s2.avertissements || []));
  for (const c2 of commandes) modele.avertissements.unshift(...(c2.avertissements || []));
  modele.avertissements.push(...infosRapproch);
  // ajustements issus des mises à jour traitées (survivent aux régénérations)
  modele.annulees = modele.annulees || [];
  for (const ref of ajust.retirees || []) {
    if (modele.parRef[ref]) {
      modele.annulees.push({ ...modele.parRef[ref], annulee: 1 });
      delete modele.parRef[ref];
      for (const g of modele.groupes) g.produits = g.produits.filter(p => p.reference !== ref);
      modele.avertissements.push(`ℹ ${ref} : annulée — déplacée dans la feuille CANCELLED ITEMS.`);
    }
  }
  modele.groupes = modele.groupes.filter(g => g.produits.length);
  for (const aj of ajust.ajoutees || []) {
    const ref = aj.ref || aj;
    if (modele.parRef[ref]) continue;
    const c = cat[ref];
    const o = { reference: ref, final: null, grille: {}, catalogueU: false, ean: c?.ean_fiche || null,
      pcb: c?.pcb || null, pa_net: null, horsSelection: false, refCatalogue: c ? ref : null,
      ajoutee: true, code_douanier: c?.code_douanier || '', description: c?.description || '',
      kd: c?.kd || '', product_size: c?.taille_produit || '', pcb_cat: c?.pcb || null, packing: c?.colisage_cm || '',
      volume: c?.volume_m3 || '', nwgw: c?.poids_nb || '', fob_net: '', fob_com: c?.fob_com ?? '',
      taxe: '', port: c?.port || '', fournisseur: c?.fournisseur || 'FOURNISSEUR ?' };
    if (!c) modele.avertissements.push(`${ref} : ajoutée par mise à jour mais fiche introuvable en base — colonnes usine vides.`);
    if (c) { o.produit_id = c.produit_id; o.image_id = c.image_id; }
    modele.parRef[ref] = o;
    let g = modele.groupes.find(x => x.fournisseur === o.fournisseur);
    if (!g) { g = { fournisseur: o.fournisseur, produits: [] }; modele.groupes.push(g); }
    g.produits.push(o);
  }
  // modifications ciblées issues des mises à jour : appliquées par-dessus, cellules marquées en jaune
  const CHAMPS_MODIFIABLES = ['description', 'code_douanier', 'kd', 'product_size', 'pcb_cat', 'packing', 'volume', 'nwgw', 'fob_net', 'fob_com', 'ddp', 'taxe', 'port', 'promotion', 'final', 'sav'];
  for (const m of ajust.modifs || []) {
    const o = modele.parRef[m.ref] || Object.values(modele.parRef).find(x => x.refCatalogue === m.ref);
    if (!o || !CHAMPS_MODIFIABLES.includes(m.champ)) continue;
    o[m.champ] = m.valeur;
    (o.jaunes ||= []).push(m.champ);
  }
  const refsTableau = new Set(Object.keys(modele.parRef));
  for (const d of doublons) if (refsTableau.has(d))
    modele.avertissements.push(`${d} : plusieurs fiches portent cette référence en base — la première a été utilisée ; départage (✎) recommandé.`);
  let eansEcrits = 0;
  for (const o of Object.values(modele.parRef)) {
    if (o.ean && o.refCatalogue) {
      const fiche = cat[o.refCatalogue];
      if (fiche && !fiche.ean_fiche) {
        db.prepare("UPDATE produits SET ean=? WHERE id=? AND (ean IS NULL OR ean='')").run(String(o.ean), fiche.produit_id);
        eansEcrits++;
      }
      if (fiche) { o.produit_id = fiche.produit_id; o.image_id = fiche.image_id; }
    }
  }
  const ambigues = Object.values(modele.parRef).filter(o => o.port_ambigu).map(o => `${o.reference} (${o.port})`);
  if (ambigues.length) modele.avertissements.push(`Port par défaut de l'usine appliqué à ${ambigues.length} référence(s) alors que cette usine a déjà chargé depuis PLUSIEURS ports — à vérifier : ${ambigues.slice(0, 10).join(', ')}${ambigues.length > 10 ? '…' : ''}`);
  const sansPort = Object.values(modele.parRef).filter(o => !o.port && o.refCatalogue).map(o => o.reference);
  if (sansPort.length) modele.avertissements.push(`${sansPort.length} référence(s) sans port malgré leurs fiches (à compléter via ✎ pour un rangement par port complet) : ${sansPort.slice(0, 12).join(', ')}${sansPort.length > 12 ? '…' : ''}`);
  modele.notes = ajust.notes || [];
  modele.etape = modele.periodes.length ? 'complet' : 'partie1';
  const REQUIS_TAB = { description: 'description', product_size: 'dimensions', pcb_cat: 'PCB', packing: 'colisage', volume: 'volume', nwgw: 'poids', fob_com: 'prix FOB', port: 'port' };
  modele.completude = { sans_fiche: [], incompletes: [] };
  for (const o of Object.values(modele.parRef)) {
    if (!o.refCatalogue) {
      const dans = db.prepare("SELECT DISTINCT f.nom FROM textes t2 JOIN fichiers f ON f.id=t2.fichier_id WHERE t2.contenu LIKE ?").all('%' + o.reference + '%').map(x => x.nom);
      modele.completude.sans_fiche.push({ ref: o.reference, dans_fichiers: dans });
      continue;
    }
    const manques = Object.entries(REQUIS_TAB).filter(([c]) => o[c] == null || String(o[c]).trim() === '').map(([, l]) => l);
    if (!(cat[o.refCatalogue] || {}).image_id) manques.push('photo');
    if (manques.length) modele.completude.incompletes.push({ ref: o.reference, manques });
  }
  const fige = {};
  for (const o of Object.values(modele.parRef)) if (o.refCatalogue && cat[o.refCatalogue]) fige[o.refCatalogue] = cat[o.refCatalogue];
  modele.catalogue_fige = fige;
  return { ...modele, eans_ecrits: eansEcrits, genere_le: new Date().toISOString().slice(0, 16).replace('T', ' ') };
}

app.get('/api/tableaux', (req, res) => {
  res.json(db.prepare('SELECT * FROM tableaux ORDER BY modifie_le DESC').all().map(t => {
    let sources = [], resultat = null;
    try { sources = JSON.parse(t.sources); } catch {}
    try { resultat = JSON.parse(t.resultat || 'null'); } catch {}
    return { id: t.id, nom: t.nom, type: t.type, genre: t.genre || 'selection', dossier: t.dossier || null, statut: t.statut, cree_le: t.cree_le, modifie_le: t.modifie_le,
      nb_sources: sources.length, nb_refs: resultat ? Object.keys(resultat.parRef || {}).length : 0 };
  }));
});

app.post('/api/tableaux', (req, res) => {
  const nom = String(req.body.nom || '').trim().slice(0, 120);
  const type = ['retour_selection', 'offre', 'suivi'].includes(req.body.type) ? req.body.type : 'retour_selection';
  if (!nom) return res.status(400).json({ erreur: 'Nom manquant' });
  if (type === 'suivi') return res.status(400).json({ erreur: 'Les tableaux de suivi arrivent bientôt.' });
  const genre = type === 'offre' ? 'offre' : 'selection';
  const selectionId = Number(req.body.selection_id) || null;
  let selections = Array.isArray(req.body.selections) ? req.body.selections
    .map(x => ({ liste_id: Number(x.liste_id) || 0, circuit: x.circuit === 'fob' ? 'fob' : 'ddp' }))
    .filter(x => x.liste_id) : [];
  if (!selections.length && selectionId) selections = [{ liste_id: selectionId, circuit: 'ddp' }];
  for (const x of selections) if (!db.prepare('SELECT 1 FROM listes WHERE id=? AND enregistree=1').get(x.liste_id))
    return res.status(400).json({ erreur: 'Sélection enregistrée introuvable (id ' + x.liste_id + ').' });
  const r = db.prepare('INSERT INTO tableaux (nom, type, genre, selection_id, selections_json) VALUES (?,?,?,?,?)')
    .run(nom, type, genre, selections[0]?.liste_id || null, selections.length ? JSON.stringify(selections) : null);
  res.json(db.prepare('SELECT * FROM tableaux WHERE id=?').get(r.lastInsertRowid));
});

app.get('/api/tableaux/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ erreur: 'Tableau introuvable' });
  try { // les propositions de codes gagnent leur lien fiche à la lecture (même les anciennes)
    const props = JSON.parse(t.codes_proposes || 'null');
    if (Array.isArray(props) && props.some(p => !p.produit_id)) {
      for (const p of props) if (!p.produit_id) p.produit_id = (db.prepare('SELECT id FROM produits WHERE reference=? ORDER BY id DESC').get(p.ref) || {}).id || null;
      t.codes_proposes = JSON.stringify(props);
    }
  } catch {}
  let sources = [], resultat = null;
  try { sources = JSON.parse(t.sources); } catch {}
  try { resultat = JSON.parse(t.resultat || 'null'); } catch {}
  const sessionSheet = db.prepare("SELECT id, url FROM sheets_sessions WHERE genre=? AND ref_id=? AND expire_le > datetime('now','localtime')").get(t.genre === 'offre' ? 'offre' : 'tableau', t.id) || null;
  let selectionLiee = null;
  if (t.selection_id) {
    const l = db.prepare('SELECT id, nom, (SELECT COUNT(*) FROM liste_items WHERE liste_id=listes.id) AS nb FROM listes WHERE id=?').get(t.selection_id);
    if (l) selectionLiee = l;
  }
  let selectionsListe = [];
  try { selectionsListe = JSON.parse(t.selections_json || 'null') || []; } catch {}
  if (!selectionsListe.length) { // rétro-compat : anciennes offres
    if (t.selection_id) selectionsListe.push({ liste_id: t.selection_id, circuit: 'ddp' });
    if (t.selection_fob_id) selectionsListe.push({ liste_id: t.selection_fob_id, circuit: 'fob' });
  }
  const selectionsLiees = selectionsListe.map(x => {
    const l = db.prepare('SELECT id, nom, (SELECT COUNT(*) FROM liste_items WHERE liste_id=listes.id) AS nb FROM listes WHERE id=?').get(x.liste_id);
    return l ? { ...l, circuit: x.circuit } : null;
  }).filter(Boolean);
  let offreNouvelles = 0;
  if (t.genre === 'offre' && resultat && resultat.type === 'offre') {
    const presentes = new Set(resultat.lignes.map(l => l.reference));
    const vues = new Set();
    for (const x of selectionsListe) for (const p of db.prepare('SELECT p.reference FROM liste_items li JOIN produits p ON p.id=li.produit_id WHERE li.liste_id=?').all(x.liste_id)) {
      if (!presentes.has(p.reference) && !vues.has(p.reference)) { offreNouvelles++; vues.add(p.reference); }
    }
  }
  res.json({ ...t, sources, resultat, sheet: sessionSheet, selection_liee: selectionLiee, selections_liees: selectionsLiees, offre_nouvelles: offreNouvelles });
});

app.patch('/api/tableaux/:id', (req, res) => {
  const nom = String(req.body.nom || '').trim().slice(0, 120);
  if (!nom) return res.status(400).json({ erreur: 'Nom manquant' });
  db.prepare("UPDATE tableaux SET nom=?, modifie_le=datetime('now','localtime') WHERE id=?").run(nom, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/tableaux/:id', (req, res) => {
  const t = db.prepare('SELECT sources FROM tableaux WHERE id=?').get(req.params.id);
  if (t) { try { for (const s of JSON.parse(t.sources)) fs.unlinkSync(path.join(DATA_DIR, 'tableaux', s.disque)); } catch {} }
  db.prepare('DELETE FROM tableaux WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/tableaux/:id/sources', upload.array('fichiers', 10), (req, res) => {
  const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ erreur: 'Tableau introuvable' });
  const role = ['commande', 'maj', 'selection', 'modele'].includes(req.body.role) ? req.body.role : 'selection';
  let sources = []; try { sources = JSON.parse(t.sources); } catch {}
  const infos = [];
  for (const f of req.files || []) {
    const hash = ex.md5(f.buffer);
    if (sources.some(s => s.hash === hash)) { infos.push(`${f.originalname} : déjà déposé dans ce tableau — ignoré.`); continue; }
    const type = (f.originalname.split('.').pop() || '').toLowerCase();
    if (role === 'commande' && type !== 'pdf') { infos.push(`${f.originalname} : une commande doit être un PDF — ignoré.`); continue; }
    if (role === 'selection' && !['xls', 'xlsx'].includes(type)) { infos.push(`${f.originalname} : une sélection doit être un Excel — ignoré.`); continue; }
    if (role === 'modele' && !['xls', 'xlsx', 'xlsm'].includes(type)) { infos.push(`${f.originalname} : le modèle U doit être un Excel — ignoré.`); continue; }
    if (role === 'maj' && !['xls', 'xlsx', 'msg', 'txt', 'pdf', 'eml'].includes(type)) { infos.push(`${f.originalname} : format de mise à jour non lu (xls, msg, txt, pdf) — ignoré.`); continue; }
    const disque = `t${t.id}_${Date.now()}_${f.originalname.replace(/[^\w.\-]+/g, '_')}`;
    fs.writeFileSync(path.join(DATA_DIR, 'tableaux', disque), f.buffer);
    sources.push({ role, nom: f.originalname, disque, hash, taille: f.buffer.length,
      ajoute_le: new Date().toISOString().slice(0, 16).replace('T', ' ') });
  }
  db.prepare("UPDATE tableaux SET sources=?, modifie_le=datetime('now','localtime') WHERE id=?").run(JSON.stringify(sources), t.id);
  for (const f of req.files || []) journal(t.id, 'pièce ajoutée', `${role} : ${f.originalname}`);
  res.json({ ok: true, sources, infos });
});

app.delete('/api/tableaux/:id/sources/:hash', (req, res) => {
  const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ erreur: 'Tableau introuvable' });
  let sources = []; try { sources = JSON.parse(t.sources); } catch {}
  const src = sources.find(s => s.hash === req.params.hash);
  if (src) { try { fs.unlinkSync(path.join(DATA_DIR, 'tableaux', src.disque)); } catch {} }
  sources = sources.filter(s => s.hash !== req.params.hash);
  db.prepare("UPDATE tableaux SET sources=?, modifie_le=datetime('now','localtime') WHERE id=?").run(JSON.stringify(sources), t.id);
  res.json({ ok: true, sources });
});

app.post('/api/tableaux/:id/generer', async (req, res) => {
  const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ erreur: 'Tableau introuvable' });
  let sources = []; try { sources = JSON.parse(t.sources); } catch {}
  if (!sources.some(s => s.role === 'selection')) return res.status(400).json({ erreur: 'Dépose au moins une sélection U.' });
  try {
    db.prepare('UPDATE tableaux SET finalise=0 WHERE id=?').run(t.id);
    for (const sh of db.prepare("SELECT * FROM sheets_sessions WHERE genre='apercu-tableau' AND ref_id=?").all(t.id)) {
      db.prepare('DELETE FROM sheets_sessions WHERE id=?').run(sh.id);
      goog.supprimer(sh.file_id).catch(() => {});
    }
    const resultat = await genererModele(t);
    db.prepare("UPDATE tableaux SET resultat=?, statut='genere', modifie_le=datetime('now','localtime') WHERE id=?")
      .run(JSON.stringify(resultat), t.id);
    journal(t.id, 'génération', `${Object.keys(resultat.parRef).length} références · ${resultat.etape === 'partie1' ? 'partie 1 (sélection seule)' : resultat.periodes.length + ' périodes'}`);
    res.json({ ok: true, resultat });
  } catch (e) {
    res.status(500).json({ erreur: 'Génération impossible : ' + (e.message || e) });
  }
});

// mise à jour en langage libre (texte collé ou pièce déposée) -> IA -> ajustements + régénération
app.post('/api/tableaux/:id/rapprocher', (req, res) => {
  try {
    const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
    if (!t) return res.status(404).json({ erreur: 'Tableau introuvable' });
    const refFiche = String(req.body.ref_fiche || '').trim();
    const refCible = String(req.body.ref_cible || '').trim();
    if (!refFiche || !refCible) return res.status(400).json({ erreur: 'ref_fiche et ref_cible requis' });
    if (!db.prepare('SELECT 1 FROM produits WHERE reference=?').get(refFiche))
      return res.status(404).json({ erreur: `Aucune fiche « ${refFiche} » en base (référence exacte requise).` });
    let ajust = {}; try { ajust = JSON.parse(t.ajustements || 'null') || {}; } catch {}
    ajust.rapprochements = ajust.rapprochements || {};
    ajust.rapprochements[refCible] = refFiche;
    db.prepare('UPDATE tableaux SET ajustements=? WHERE id=?').run(JSON.stringify(ajust), t.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});
const offreU = require('./lib/offre');
function produitsDeListe(listeId) {
  return db.prepare(`SELECT p.*, (SELECT i.id FROM produit_images pi JOIN images i ON i.id=pi.image_id
      WHERE pi.produit_id=p.id ORDER BY pi.principale DESC, i.id LIMIT 1) AS image_id
    FROM liste_items li JOIN produits p ON p.id=li.produit_id WHERE li.liste_id=? ORDER BY p.fournisseur, p.reference`).all(listeId);
}
app.get('/api/tableaux/:id/mapping', (req, res) => {
  const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
  if (!t || !t.cartographie) return res.status(400).json({ erreur: 'Cartographie d\u2019abord.' });
  const carto = JSON.parse(t.cartographie);
  res.json({ mapping: carto.mapping || offreU.proposerMapping(carto), valide: !!carto.mapping_valide });
});
app.post('/api/tableaux/:id/mapping/valider', (req, res) => {
  try {
    const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
    if (!t || !t.cartographie) return res.status(400).json({ erreur: 'Cartographie d\u2019abord.' });
    const carto = JSON.parse(t.cartographie);
    const recu = Array.isArray(req.body.mapping) ? req.body.mapping : [];
    const base = offreU.proposerMapping(carto);
    carto.mapping = base.map(b => {
      const e = recu.find(x => x.champ === b.champ);
      return e ? { ...b, actif: !!e.actif, cols: (Array.isArray(e.cols) ? e.cols : b.cols).map(Number).filter(Boolean) } : b;
    });
    if (Number(req.body.ligne_debut) >= 2) carto.ligne_debut = Number(req.body.ligne_debut);
    carto.mapping_valide = true;
    db.prepare("UPDATE tableaux SET cartographie=?, modifie_le=datetime('now','localtime') WHERE id=?").run(JSON.stringify(carto), t.id);
    journal(t.id, 'écriture validée', carto.mapping.filter(m => m.actif).length + ' information(s) de fiche autorisée(s) à l\u2019écriture');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});
app.post('/api/tableaux/:id/generer-offre', (req, res) => {
  try {
    const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
    if (!t || t.genre !== 'offre') return res.status(404).json({ erreur: 'Offre introuvable' });
    let carto = null; try { carto = JSON.parse(t.cartographie || 'null'); } catch {}
    if (!carto || !carto.mapping_valide) return res.status(400).json({ erreur: 'Valide d\u2019abord les colonnes d\u2019écriture (étape 2).' });
    let sels = []; try { sels = JSON.parse(t.selections_json || 'null') || []; } catch {}
    if (!sels.length) { if (t.selection_id) sels.push({ liste_id: t.selection_id, circuit: 'ddp' }); if (t.selection_fob_id) sels.push({ liste_id: t.selection_fob_id, circuit: 'fob' }); }
    if (!sels.length) return res.status(400).json({ erreur: 'Aucune sélection liée à cette offre.' });
    let ajust = {}; try { ajust = JSON.parse(t.ajustements || 'null') || {}; } catch {}
    const produits = []; const circuits = {};
    for (const s2 of sels) for (const p of produitsDeListe(s2.liste_id)) {
      if (!produits.some(x => x.reference === p.reference)) { produits.push(p); circuits[p.reference] = s2.circuit === 'fob' ? 'wisen' : 'flaudis'; }
    }
    Object.assign(circuits, ajust.circuits || {});
    if (!produits.length) return res.status(400).json({ erreur: 'Les sélections liées sont vides.' });
    const champsActifs = carto.mapping.filter(m => m.actif).map(m => m.champ);
    const etat = offreU.construireEtatOffre({ produits, circuits, champsActifs });
    // palettes déjà calculées lors d'une génération précédente : conservées (rejouées par le module)
    let precedent = null; try { precedent = JSON.parse(t.resultat || 'null'); } catch {}
    if (precedent && precedent.type === 'offre') {
      for (const l of etat.lignes) {
        const av = precedent.lignes.find(x => x.reference === l.reference);
        if (!av) continue;
        if (av.palette) l.palette = av.palette;
        for (const [champ, v] of Object.entries(av.valeurs || {}))
          if (v && v.etat === 'operateur') { l.valeurs[champ] = v; l.manques = l.manques.filter(c2 => c2 !== champ); }
      }
      if (precedent.params_palette) etat.params_palette = precedent.params_palette;
    }
    // les aperçus Sheet deviennent périmés dès qu'on régénère
    for (const sess of db.prepare("SELECT * FROM sheets_sessions WHERE genre='apercu-offre' AND ref_id=?").all(t.id)) {
      goog.supprimer(sess.file_id).catch(() => {});
      db.prepare('DELETE FROM sheets_sessions WHERE id=?').run(sess.id);
    }
    db.prepare("UPDATE tableaux SET resultat=?, statut='genere', modifie_le=datetime('now','localtime') WHERE id=?").run(JSON.stringify(etat), t.id);
    journal(t.id, 'écriture des fiches', etat.lignes.length + ' ligne(s) — données recopiées depuis les fiches produits');
    res.json({ ok: true, resultat: etat });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});
app.post('/api/tableaux/:id/offre/circuit', (req, res) => {
  const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ erreur: 'Offre introuvable' });
  let ajust = {}; try { ajust = JSON.parse(t.ajustements || 'null') || {}; } catch {}
  ajust.circuits = ajust.circuits || {};
  ajust.circuits[String(req.body.ref)] = req.body.circuit === 'wisen' ? 'wisen' : 'flaudis';
  db.prepare('UPDATE tableaux SET ajustements=? WHERE id=?').run(JSON.stringify(ajust), t.id);
  res.json({ ok: true });
});
app.post('/api/tableaux/:id/offre/selection-fob', (req, res) => {
  const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ erreur: 'Offre introuvable' });
  const lid = Number(req.body.liste_id) || null;
  if (lid && !db.prepare('SELECT 1 FROM listes WHERE id=? AND enregistree=1').get(lid))
    return res.status(400).json({ erreur: 'Sélection enregistrée introuvable.' });
  db.prepare('UPDATE tableaux SET selection_fob_id=? WHERE id=?').run(lid, t.id);
  journal(t.id, 'sélection FOB', lid ? 'liée (ses réfs entrent en circuit WISEN)' : 'détachée');
  res.json({ ok: true });
});
function champsActifsOffre(carto) {
  const actifs = (carto.mapping || []).filter(m => m.actif && m.cols && m.cols.length && m.champ !== 'reference');
  actifs.sort((a2, b2) => (a2.cols[0] || 999) - (b2.cols[0] || 999));
  const refMap = (carto.mapping || []).find(m => m.champ === 'reference' && m.actif && m.cols && m.cols.length);
  return { actifs, colRef: refMap ? refMap.cols[0] : null };
}
function valeursPourCols(champ, v, cols) {
  if (v == null || v === '') return [];
  if (cols.length > 1 && /dims_/.test(champ)) {
    const morceaux = String(v).split(/\s*[x×]\s*/i);
    return cols.map((c2, j) => ({ col: c2, valeur: morceaux[j] != null ? morceaux[j].trim() : '' })).filter(x => x.valeur !== '');
  }
  return [{ col: cols[0], valeur: v }];
}
/** LE fichier U, injecté de nos valeurs — mise en forme, macros et menus intacts (repli .xls : valeurs seules). */
async function excelOffreDepuisModele(t, baseUrl) {
  const etat = JSON.parse(t.resultat);
  const carto = JSON.parse(t.cartographie);
  let sources = []; try { sources = JSON.parse(t.sources); } catch {}
  const modele = sources.filter(x => x.role === 'modele').slice(-1)[0];
  if (!modele) throw new Error('Aucun modèle U déposé.');
  let buf = fs.readFileSync(path.join(DATA_DIR, 'tableaux', modele.disque));
  if (!(buf[0] === 0x50 && buf[1] === 0x4b) && goog.dispo()) {
    // .xls ancien format : conversion fidèle via Google (mise en forme préservée), mise en cache
    const cache = path.join(DATA_DIR, 'tableaux', modele.disque + '.conv.xlsx');
    if (fs.existsSync(cache)) buf = fs.readFileSync(cache);
    else {
      const tmp = await goog.creerSheetDepuisXlsx(buf, '[conversion] ' + modele.nom);
      buf = await goog.exporterXlsx(tmp.id);
      goog.supprimer(tmp.id).catch(() => {});
      fs.writeFileSync(cache, buf);
    }
  }
  const { actifs, colRef } = champsActifsOffre(carto);
  const ligneDebut = Number(carto.ligne_debut) || 2;
  const colPhoto = carto.photos && carto.photos.col && !(carto.colonnes_masquees || []).includes(Number(carto.photos.col)) ? Number(carto.photos.col) : null;
  const placements = [];
  etat.lignes.forEach((l, i) => {
    const lig = ligneDebut + i;
    if (colRef) placements.push({ ligne: lig, col: colRef, valeur: l.reference });
    if (colPhoto && l.image_id && baseUrl) placements.push({ ligne: lig, col: colPhoto, valeur: { formule: `IMAGE("${baseUrl}/api/images/${l.image_id}")` } });
    for (const m of actifs) {
      const v = l.valeurs[m.champ];
      if (!v || v.v == null) continue;
      for (const pl of valeursPourCols(m.champ, v.v, m.cols)) placements.push({ ligne: lig, ...pl });
    }
  });
  const { buffer, repli } = await offreU.ecrireDansModele(buf, { feuille: carto.feuille, placements });
  return { buffer, repli, nomModele: modele.nom };
}
app.post('/api/tableaux/:id/offre/sheet', async (req, res) => {
  try {
    if (!goog.dispo() && !goog.oauthConfigurable()) return res.status(400).json({ erreur: "Google n'est pas configuré — variables GOOGLE_OAUTH_CLIENT_ID/SECRET puis /google/connexion." });
    const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
    if (!t || !t.resultat || t.genre !== 'offre') return res.status(404).json({ erreur: 'Offre non générée' });
    const active = db.prepare("SELECT * FROM sheets_sessions WHERE genre='offre' AND ref_id=? AND expire_le > datetime('now','localtime')").get(t.id);
    if (active) return res.json({ url: active.url, session_id: active.id, existante: true });
    const { buffer: buf, repli } = await excelOffreDepuisModele(t, `${(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0]}://${req.headers['x-forwarded-host'] || req.headers.host}`);
    if (repli) journal(t.id, 'sheet', 'modèle .xls ancien format : mise en forme simplifiée dans le Sheet');
    const sheet = await goog.creerSheetDepuisXlsx(buf, `${t.nom} — session du ${new Date().toLocaleDateString('fr-FR')}`);
    await goog.partager(sheet.id, 'writer');
    const r2 = db.prepare("INSERT INTO sheets_sessions (genre, ref_id, file_id, url, expire_le) VALUES ('offre', ?, ?, ?, datetime('now','localtime','+6 hours'))")
      .run(t.id, sheet.id, sheet.url);
    res.json({ url: sheet.url, session_id: r2.lastInsertRowid });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});
app.post('/api/tableaux/:id/offre/sheet-apercu', async (req, res) => {
  try {
    if (!goog.dispo() && !goog.oauthConfigurable()) return res.status(400).json({ erreur: "Google n'est pas configuré — variables GOOGLE_OAUTH_CLIENT_ID/SECRET puis /google/connexion." });
    const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
    if (!t || !t.resultat || t.genre !== 'offre') return res.status(404).json({ erreur: 'Offre non générée' });
    const active = db.prepare("SELECT * FROM sheets_sessions WHERE genre='apercu-offre' AND ref_id=? AND expire_le > datetime('now','localtime')").get(t.id);
    if (active) return res.json({ url: active.url });
    const { buffer: buf } = await excelOffreDepuisModele(t, `${(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0]}://${req.headers['x-forwarded-host'] || req.headers.host}`);
    const sheet = await goog.creerSheetDepuisXlsx(buf, `[aperçu] ${t.nom}`);
    await goog.partager(sheet.id, 'reader');
    db.prepare("INSERT INTO sheets_sessions (genre, ref_id, file_id, url, expire_le) VALUES ('apercu-offre', ?, ?, ?, datetime('now','localtime','+2 hours'))").run(t.id, sheet.id, sheet.url);
    res.json({ url: sheet.url });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});
app.post('/api/tableaux/:id/offre/selections', (req, res) => {
  try {
    const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
    if (!t || t.genre !== 'offre') return res.status(404).json({ erreur: 'Offre introuvable' });
    let sels = []; try { sels = JSON.parse(t.selections_json || 'null') || []; } catch {}
    if (!sels.length) { if (t.selection_id) sels.push({ liste_id: t.selection_id, circuit: 'ddp' }); if (t.selection_fob_id) sels.push({ liste_id: t.selection_fob_id, circuit: 'fob' }); }
    const lid = Number(req.body.liste_id) || 0;
    if (!lid) return res.status(400).json({ erreur: 'liste_id manquant' });
    if (req.body.retirer) sels = sels.filter(x => x.liste_id !== lid);
    else {
      if (!db.prepare('SELECT 1 FROM listes WHERE id=? AND enregistree=1').get(lid)) return res.status(400).json({ erreur: 'Sélection enregistrée introuvable.' });
      const ex2 = sels.find(x => x.liste_id === lid);
      if (ex2) ex2.circuit = req.body.circuit === 'fob' ? 'fob' : 'ddp';
      else sels.push({ liste_id: lid, circuit: req.body.circuit === 'fob' ? 'fob' : 'ddp' });
    }
    db.prepare("UPDATE tableaux SET selections_json=?, selection_id=?, selection_fob_id=NULL, modifie_le=datetime('now','localtime') WHERE id=?")
      .run(JSON.stringify(sels), sels[0]?.liste_id || null, t.id);
    journal(t.id, 'sélections', req.body.retirer ? 'sélection retirée' : 'sélection ajoutée/modifiée (' + sels.length + ' liée(s))');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});
app.post('/api/tableaux/:id/offre/designations', async (req, res) => {
  try {
    const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
    if (!t || !t.resultat) return res.status(400).json({ erreur: 'Génère d\u2019abord le tableau.' });
    const etat = JSON.parse(t.resultat);
    const cibles = etat.lignes.filter(l => {
      const d = l.valeurs.designation;
      return d && d.etat !== 'operateur'; // les saisies manuelles restent intouchées
    });
    if (!cibles.length) return res.json({ ok: true, faites: 0 });
    let faites = 0;
    for (let i = 0; i < cibles.length; i += 25) {
      const paquet = cibles.slice(i, i + 25).map(l => {
        const p = l.produit_id ? db.prepare('SELECT description, taille_produit, pcb, extras FROM produits WHERE id=?').get(l.produit_id) : null;
        return { reference: l.reference, description: p?.description || l.valeurs.designation?.v || '', dimensions: p?.taille_produit || '', extras: p?.extras || '[]' };
      });
      const rep = await ia.redigerDesignations(paquet);
      if (rep.erreur) return res.status(502).json({ erreur: rep.erreur });
      for (const l of cibles.slice(i, i + 25)) {
        const d = (rep.designations || {})[l.reference];
        if (d) { l.valeurs.designation = { v: String(d).trim(), etat: 'ia' }; l.manques = l.manques.filter(c2 => c2 !== 'designation'); faites++; }
      }
    }
    db.prepare("UPDATE tableaux SET resultat=?, modifie_le=datetime('now','localtime') WHERE id=?").run(JSON.stringify(etat), t.id);
    journal(t.id, 'désignations', faites + ' désignation(s) rédigée(s) en français (gabarit maison)');
    res.json({ ok: true, faites });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});
app.post('/api/tableaux/:id/offre/palettes', (req, res) => {
  try {
    const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
    if (!t || !t.resultat) return res.status(400).json({ erreur: 'Lance d\u2019abord l\u2019écriture des fiches.' });
    const etat = JSON.parse(t.resultat);
    const hauteurMaxMm = Number(req.body.hauteur_max_mm) || 1800;
    let calcules = 0, sans = [];
    for (const l of etat.lignes) {
      const pal = offreU.calculerPalette(l.dims_colis, { hauteurMaxMm });
      if (pal) {
        const pcb = l.valeurs.pcb?.v || null;
        const gw = l.valeurs.poids_brut_colis?.v || null;
        l.palette = { ...pal, hauteur_max_mm: hauteurMaxMm,
          uvc: pcb ? pal.total * pcb : null,
          poids_kg: gw ? +(pal.total * gw + 25).toFixed(1) : null };
        calcules++;
      } else sans.push(l.reference);
    }
    etat.params_palette = { hauteur_max_mm: hauteurMaxMm };
    db.prepare("UPDATE tableaux SET resultat=?, modifie_le=datetime('now','localtime') WHERE id=?").run(JSON.stringify(etat), t.id);
    journal(t.id, 'palettisation', `${calcules} ligne(s) calculée(s) (hauteur max ${hauteurMaxMm} mm)`);
    res.json({ ok: true, calcules, sans, resultat: etat });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});
app.post('/api/tableaux/:id/cartographier', async (req, res) => {
  try {
    const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
    if (!t || t.genre !== 'offre') return res.status(404).json({ erreur: 'Offre introuvable' });
    let sources = []; try { sources = JSON.parse(t.sources); } catch {}
    const modele = sources.filter(s2 => s2.role === 'modele').slice(-1)[0];
    if (!modele) return res.status(400).json({ erreur: 'Dépose d\u2019abord le modèle Excel fourni par U.' });
    const buf = fs.readFileSync(path.join(DATA_DIR, 'tableaux', modele.disque));
    const lecture = offreU.lireModeleU(buf);
    const plan = await ia.cartographierModeleU(offreU.digestPourIA(lecture));
    if (plan.erreur) return res.status(502).json({ erreur: plan.erreur });
    if (lecture.ligne_donnees) plan.ligne_debut = lecture.ligne_donnees; // le mécanique bat l'estimation IA
    const masquees = new Set(lecture.colonnes_masquees || []);
    if (masquees.size) {
      plan.colonnes = (plan.colonnes || []).filter(c2 => !masquees.has(Number(c2.col)));
      plan.ignorees = [...new Set([...(plan.ignorees || []), ...masquees])].sort((a2, b2) => a2 - b2);
    }
    const carto = { ...plan, feuille: lecture.feuille_principale, modele_nom: modele.nom, modele_hash: modele.hash,
      colonnes_masquees: lecture.colonnes_masquees || [],
      faite_le: new Date().toISOString().slice(0, 16).replace('T', ' '), validee: true };
    db.prepare("UPDATE tableaux SET cartographie=?, modifie_le=datetime('now','localtime') WHERE id=?").run(JSON.stringify(carto), t.id);
    journal(t.id, 'cartographie', `${plan.colonnes.length} colonnes cartographiées, ${(plan.ignorees || []).length} ignorées`);
    res.json({ ok: true, cartographie: carto });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});
app.post('/api/tableaux/:id/cartographie/valider', (req, res) => {
  try {
    const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
    if (!t || !t.cartographie) return res.status(404).json({ erreur: 'Pas de cartographie à valider' });
    const carto = JSON.parse(t.cartographie);
    // éditions de l'opérateur : {col: nouvelle_source}
    const editions = req.body.editions || {};
    for (const c of carto.colonnes) if (editions[c.col] != null) { c.source = String(editions[c.col]).slice(0, 80); c.editee = true; }
    carto.validee = true;
    carto.validee_le = new Date().toISOString().slice(0, 16).replace('T', ' ');
    db.prepare("UPDATE tableaux SET cartographie=?, modifie_le=datetime('now','localtime') WHERE id=?").run(JSON.stringify(carto), t.id);
    journal(t.id, 'plan validé', Object.keys(editions).length + ' colonne(s) corrigée(s) par l\u2019opérateur');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});
app.post('/api/tableaux/:id/codes/proposer', async (req, res) => {
  try {
    const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
    if (!t || !t.resultat) return res.status(404).json({ erreur: 'Tableau non généré' });
    const resultat = JSON.parse(t.resultat);
    const sansCode = Object.values(resultat.parRef || {}).filter(o => !String(o.code_douanier ?? '').trim());
    if (!sansCode.length) return res.json({ propositions: [] });
    const entree = sansCode.map(o => {
      const fiche = db.prepare('SELECT id, description, matiere, taille_produit, poids_nb, extras, remarques FROM produits WHERE reference=? ORDER BY id DESC').get(o.reference) || {};
      let extras = '';
      try { extras = (JSON.parse(fiche.extras || '[]') || []).map(x => `${x.intitule}: ${x.valeur}`).join(' ; ').slice(0, 300); } catch {}
      return { ref: o.reference, produit_id: fiche.id || null, description: fiche.description || o.description || '', matiere: fiche.matiere || '',
               taille: fiche.taille_produit || o.product_size || '', poids: fiche.poids_nb || '', extras, remarques: (fiche.remarques || '').slice(0, 200) };
    });
    const idParRef = Object.fromEntries(entree.map(e => [e.ref, e.produit_id]));
    const prop = await ia.proposerCodesDouaniers(entree);
    if (prop.erreur && !prop.propositions.length) return res.status(502).json({ erreur: prop.erreur });
    for (const p of prop.propositions) p.produit_id = idParRef[p.ref] || null;
    db.prepare('UPDATE tableaux SET codes_proposes=? WHERE id=?').run(JSON.stringify(prop.propositions), t.id);
    res.json({ propositions: prop.propositions });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});
app.post('/api/tableaux/:id/codes/appliquer', (req, res) => {
  try {
    const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
    if (!t) return res.status(404).json({ erreur: 'Tableau introuvable' });
    const choix = Array.isArray(req.body.choix) ? req.body.choix : [];
    let surFiches = 0, enModifs = 0;
    let ajustements = { modifs: [] }; try { ajustements = JSON.parse(t.ajustements || 'null') || {}; } catch {}
    ajustements.modifs = ajustements.modifs || [];
    for (const c of choix) {
      const code = String(c.code || '').replace(/\s+/g, '');
      if (!c.ref || !code) continue;
      const fiches = db.prepare('SELECT id FROM produits WHERE reference=?').all(c.ref);
      if (fiches.length) {
        for (const fch of fiches) db.prepare('UPDATE produits SET code_hs_usine=? WHERE id=?').run(code, fch.id);
        surFiches++;
      } else {
        const i = ajustements.modifs.findIndex(m => m.ref === c.ref && m.champ === 'code_douanier');
        if (i !== -1) ajustements.modifs.splice(i, 1);
        ajustements.modifs.push({ ref: c.ref, champ: 'code_douanier', valeur: code });
        enModifs++;
      }
    }
    db.prepare('UPDATE tableaux SET ajustements=?, codes_proposes=NULL WHERE id=?').run(JSON.stringify(ajustements), t.id);
    res.json({ ok: true, sur_fiches: surFiches, en_modifs: enModifs });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});
app.post('/api/tableaux/:id/classer', (req, res) => {
  const t = db.prepare('SELECT id FROM tableaux WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ erreur: 'Tableau introuvable' });
  const dossier = String(req.body.dossier || '').trim().slice(0, 60) || null;
  db.prepare('UPDATE tableaux SET dossier=? WHERE id=?').run(dossier, t.id);
  res.json({ ok: true, dossier });
});
app.post('/api/tableaux/:id/finaliser', (req, res) => {
  const t = db.prepare('SELECT id FROM tableaux WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ erreur: 'Tableau introuvable' });
  db.prepare('UPDATE tableaux SET finalise=? WHERE id=?').run(req.body.etat ? 1 : 0, t.id);
  res.json({ ok: true, finalise: req.body.etat ? 1 : 0 });
});
app.post('/api/tableaux/:id/rescan-manquants', (req, res) => {
  try {
    const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
    if (!t || !t.resultat) return res.status(404).json({ erreur: 'Tableau non généré' });
    const comp = (JSON.parse(t.resultat).completude) || { sans_fiche: [], incompletes: [] };
    const quoi = req.body.quoi === 'incompletes' ? 'incompletes' : 'sans_fiche';
    const aRelancer = new Map(); // fichier_id -> nom
    const introuvables = [];
    if (quoi === 'sans_fiche') {
      for (const ref of comp.sans_fiche) {
        const hits = db.prepare("SELECT f.id, f.nom FROM textes t2 JOIN fichiers f ON f.id=t2.fichier_id WHERE t2.contenu LIKE ?").all('%' + ref + '%');
        if (!hits.length) { introuvables.push(ref); continue; }
        for (const h of hits) aRelancer.set(h.id, h.nom);
      }
    } else {
      const refs = comp.incompletes.map(x => x.ref);
      for (const ref of refs) {
        for (const p of db.prepare('SELECT p.fichier_id, f.nom FROM produits p JOIN fichiers f ON f.id=p.fichier_id WHERE p.reference=?').all(ref))
          aRelancer.set(p.fichier_id, p.nom);
      }
    }
    let relances = 0;
    for (const [fid] of aRelancer) {
      const f = db.prepare('SELECT * FROM fichiers WHERE id=?').get(fid);
      if (f && relancerFichier(f, f.mode || 'offre')) relances++;
    }
    res.json({ ok: true, fichiers_relances: relances, noms: [...aRelancer.values()].slice(0, 12), introuvables });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});
app.post('/api/tableaux/:id/maj', async (req, res) => {
  try {
  const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
  if (!t || !t.resultat) return res.status(400).json({ erreur: 'Génère d\u2019abord le tableau (dépose sa sélection U).' });
  let texte = String(req.body.texte || '').trim();
  let sources = []; try { sources = JSON.parse(t.sources); } catch {}
  if (!texte && req.body.piece_hash) {
    const src = sources.find(x => x.hash === req.body.piece_hash);
    if (!src) return res.status(404).json({ erreur: 'Pièce introuvable' });
    const buf = fs.readFileSync(path.join(DATA_DIR, 'tableaux', src.disque));
    const type = (src.nom.split('.').pop() || '').toLowerCase();
    if (['xls', 'xlsx'].includes(type)) texte = ex.texteDesFeuilles(ex.lireCellules(buf));
    else if (type === 'msg') texte = ex.texteMsg(buf);
    else if (type === 'pdf') texte = (await require('pdf-parse')(buf)).text;
    else texte = buf.toString('utf8');
  }
  if (!texte) return res.status(400).json({ erreur: 'Aucun contenu de mise à jour.' });
  // le texte collé devient une pièce archivée du dossier
  if (req.body.texte) {
    const disque = `t${t.id}_${Date.now()}_maj.txt`;
    fs.writeFileSync(path.join(DATA_DIR, 'tableaux', disque), texte);
    sources.push({ role: 'maj', nom: 'Mise à jour saisie le ' + new Date().toISOString().slice(0, 16).replace('T', ' '), disque,
      hash: ex.md5(Buffer.from(texte)), taille: texte.length, ajoute_le: new Date().toISOString().slice(0, 16).replace('T', ' ') });
    db.prepare('UPDATE tableaux SET sources=? WHERE id=?').run(JSON.stringify(sources), t.id);
  }
  const resultat = JSON.parse(t.resultat);
  const ctx = Object.values(resultat.parRef || {}).map(o => ({ ref: o.reference,
    fob_net: (o.jaunes || []).includes('fob_net') ? o.fob_net : (o.fob_com != null && o.fob_com !== '' && !isNaN(Number(o.fob_com)) ? Number((Number(o.fob_com) * 0.95).toFixed(2)) : null),
    fob_com: o.fob_com ?? null, port: o.port || null, final: o.final ?? null }));
  const interp = await ia.interpreterMaj(texte, Object.keys(resultat.parRef || {}), ctx);
  if (interp.erreur) return res.status(502).json({ erreur: interp.erreur });
  let ajust = {}; try { ajust = JSON.parse(t.ajustements || '{}'); } catch {}
  ajust.retirees = ajust.retirees || []; ajust.ajoutees = ajust.ajoutees || []; ajust.notes = ajust.notes || []; ajust.modifs = ajust.modifs || [];
  for (const o of interp.operations) {
    if (o.op === 'retirer' && !ajust.retirees.includes(o.ref)) { ajust.retirees.push(o.ref); ajust.ajoutees = ajust.ajoutees.filter(a => (a.ref || a) !== o.ref); }
    else if (o.op === 'ajouter' && !ajust.ajoutees.some(a => (a.ref || a) === o.ref)) { ajust.ajoutees.push({ ref: o.ref, detail: o.detail || '' }); ajust.retirees = ajust.retirees.filter(r => r !== o.ref); }
    else if (o.op === 'modifier' && o.ref && o.champ) {
      // filet : si l'IA renvoie quand même un delta (+1, -0.5), on l'applique nous-mêmes à la valeur actuelle
      const NUM = ['fob_net', 'fob_com', 'ddp', 'taxe', 'final', 'sav', 'pcb_cat'];
      if (NUM.includes(o.champ) && typeof o.valeur === 'string' && /^[+-]\s*[\d.,]+$/.test(o.valeur.trim())) {
        const delta = Number(o.valeur.replace(',', '.').replace(/\s/g, ''));
        const c0 = ctx.find(c => c.ref === o.ref);
        const base = c0 ? Number(c0[o.champ === 'sav' || o.champ === 'pcb_cat' ? 'final' : o.champ] ?? NaN) : NaN;
        if (!isNaN(delta) && !isNaN(base)) o.valeur = Number((base + delta).toFixed(2));
      }
      if (typeof o.valeur === 'string' && /^[\d.,]+$/.test(o.valeur.trim())) o.valeur = Number(o.valeur.replace(',', '.'));
      ajust.modifs = ajust.modifs.filter(x => !(x.ref === o.ref && x.champ === o.champ));
      ajust.modifs.push({ ref: o.ref, champ: o.champ, valeur: o.valeur });
    }
    else if (o.op === 'noter') ajust.notes.push(`${o.ref ? o.ref + ' : ' : ''}${o.detail || ''}`);
  }
  db.prepare('UPDATE tableaux SET ajustements=? WHERE id=?').run(JSON.stringify(ajust), t.id);
  journal(t.id, 'mise à jour', (interp.resume || 'traitée') + ' — ' + interp.operations.map(o => `${o.op} ${o.ref || ''}`.trim()).join(', '));
  const t2 = db.prepare('SELECT * FROM tableaux WHERE id=?').get(t.id);
  const nouveau = await genererModele(t2);
  db.prepare("UPDATE tableaux SET resultat=?, statut='genere', modifie_le=datetime('now','localtime') WHERE id=?").run(JSON.stringify(nouveau), t.id);
  res.json({ ok: true, resume: interp.resume, operations: interp.operations, resultat: nouveau });
  } catch (e) {
    console.error('/maj:', e);
    res.status(500).json({ erreur: 'Mise à jour impossible : ' + (e.message || e) });
  }
});

// consultation des pièces du dossier
app.get('/api/tableaux/:id/pieces/:hash/fichier', (req, res) => {
  const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
  let sources = []; try { sources = JSON.parse(t?.sources || '[]'); } catch {}
  const src = sources.find(x => x.hash === req.params.hash);
  if (!src) return res.status(404).send('Pièce introuvable');
  res.setHeader('content-disposition', 'attachment; filename="' + encodeURIComponent(src.nom.replace(/[/\\]/g, '_')) + '"');
  res.send(fs.readFileSync(path.join(DATA_DIR, 'tableaux', src.disque)));
});

app.get('/api/tableaux/:id/pieces/:hash/apercu', async (req, res) => {
  const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
  let sources = []; try { sources = JSON.parse(t?.sources || '[]'); } catch {}
  const src = sources.find(x => x.hash === req.params.hash);
  if (!src) return res.status(404).send('Pièce introuvable');
  const buf = fs.readFileSync(path.join(DATA_DIR, 'tableaux', src.disque));
  const type = (src.nom.split('.').pop() || 'txt').toLowerCase();
  if (type === 'pdf') { res.type('application/pdf'); res.setHeader('content-disposition', 'inline'); return res.send(buf); }
  if (['xls', 'xlsx'].includes(type)) {
    const html = await ex.genererApercuHtml(buf, type);
    if (html) return res.type('html').send(html);
    return res.status(500).send('Aperçu indisponible — télécharge la pièce.');
  }
  res.type('html').send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:22px;background:#f4f5f8"><h3>${src.nom.replace(/</g, '&lt;')}</h3><pre style="background:#fff;border:1px solid #ddd;border-radius:9px;padding:16px;white-space:pre-wrap;font-size:13px">${buf.toString('utf8').replace(/</g, '&lt;')}</pre>`);
});

function imagesPourTableau(modele) {
  const images = {};
  for (const [ref, o] of Object.entries(modele.parRef || {})) {
    if (!o.image_id) continue;
    const img = db.prepare('SELECT hash FROM images WHERE id=?').get(o.image_id);
    if (!img) continue;
    const fichier = fs.readdirSync(path.join(DATA_DIR, 'images')).find(f => f.startsWith(img.hash));
    if (fichier) images[ref] = path.join(DATA_DIR, 'images', fichier);
  }
  return images;
}

app.get('/api/tableaux/:id/apercu', async (req, res) => {
  const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
  if (!t || !t.resultat) return res.status(404).send('Tableau non généré');
  try {
    const modele = JSON.parse(t.resultat);
    const buf = await tb.genererXlsx(modele, { titre: t.nom }); // sans photos : la conversion les éparpille hors cellules
    let html = await ex.genererApercuHtml(Buffer.from(buf), 'xlsx');
    if (!html) return res.status(500).send('Aperçu indisponible sur ce serveur — télécharge l\u2019Excel.');
    html = html.replace(/(<body[^>]*>)/i, '$1<div style="position:sticky;top:0;background:#1c2434;color:#ffd400;font:600 12.5px system-ui;padding:8px 14px;z-index:9">👁 Aperçu du tableur — les photos ne sont pas affichées ici (la conversion les déplacerait) : elles sont dans l\u2019Excel téléchargé ⬇ et dans le rendu de l\u2019app.</div>');
    res.type('html').send(html);
  } catch (e) { res.status(500).send('Aperçu impossible : ' + (e.message || e)); }
});

async function excelDuTableau(t) {
  const modele = JSON.parse(t.resultat);
  return Buffer.from(await tb.genererXlsx(modele, { images: imagesPourTableau(modele), titre: t.nom }));
}
app.get('/api/tableaux/:id/excel', async (req, res) => {
  const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
  if (!t || !t.resultat) return res.status(404).send('Tableau non généré');
  try {
    const buf = await excelDuTableau(t);
    res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(t.nom)}.xlsx"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) { res.status(500).send('Excel impossible : ' + (e.message || e)); }
});

// ---------- Google Sheets : édition temporaire d'un tableau ----------
app.post('/api/tableaux/:id/sheet', async (req, res) => {
  try {
    if (!goog.dispo() && !goog.oauthConfigurable()) return res.status(400).json({ erreur: "Google n'est pas configuré — variables GOOGLE_OAUTH_CLIENT_ID/SECRET puis /google/connexion." });
    const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
    if (!t || !t.resultat) return res.status(404).json({ erreur: 'Tableau non généré' });
    const active = db.prepare("SELECT * FROM sheets_sessions WHERE genre='tableau' AND ref_id=? AND expire_le > datetime('now','localtime')").get(t.id);
    if (active) return res.json({ url: active.url, session_id: active.id, existante: true });
    const buf = await excelDuTableau(t);
    const sheet = await goog.creerSheetDepuisXlsx(buf, `${t.nom} — session du ${new Date().toLocaleDateString('fr-FR')}`);
    await goog.partager(sheet.id, 'writer');
    const r2 = db.prepare("INSERT INTO sheets_sessions (genre, ref_id, file_id, url, expire_le) VALUES ('tableau', ?, ?, ?, datetime('now','localtime','+6 hours'))")
      .run(t.id, sheet.id, sheet.url);
    res.json({ url: sheet.url, session_id: r2.lastInsertRowid });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});
// connexion Google (OAuth) : l'app agit sur TON Drive — les fichiers éphémères vont dans « Flaudis — temporaire »
function urlRetourGoogle(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const hote = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${hote}/google/retour`;
}
app.get('/google/connexion', (req, res) => {
  if (!goog.oauthConfigurable())
    return res.status(400).send('Ajoute d\u2019abord GOOGLE_OAUTH_CLIENT_ID et GOOGLE_OAUTH_CLIENT_SECRET dans Railway (voir la marche à suivre).');
  res.redirect(goog.urlConnexion(urlRetourGoogle(req)));
});
app.get('/google/retour', async (req, res) => {
  try {
    if (req.query.error) throw new Error('Autorisation refusée : ' + req.query.error);
    await goog.echangerCode(String(req.query.code || ''), urlRetourGoogle(req));
    res.send(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;text-align:center">
      <h2>✅ Google connecté</h2><p>Les aperçus et sessions Sheets utilisent maintenant ton Drive (dossier « Flaudis — temporaire », nettoyé automatiquement).</p>
      <p><a href="/">← Retourner à l'app</a> et re-clique ton aperçu.</p>`);
  } catch (e) {
    res.status(500).send('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h2>⚠ Connexion Google échouée</h2><pre>' + String(e.message || e).replace(/</g, '&lt;') + '</pre><a href="/google/connexion">Réessayer</a>');
  }
});

app.post('/api/tableaux/:id/sheet-apercu', async (req, res) => {
  try {
    if (!goog.dispo() && !goog.oauthConfigurable()) return res.status(400).json({ erreur: "Google n'est pas configuré — variables GOOGLE_OAUTH_CLIENT_ID/SECRET puis /google/connexion." });
    const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
    if (!t || !t.resultat) return res.status(404).json({ erreur: 'Tableau non généré' });
    const active = db.prepare("SELECT * FROM sheets_sessions WHERE genre='apercu-tableau' AND ref_id=? AND expire_le > datetime('now','localtime')").get(t.id);
    if (active) return res.json({ url: active.url });
    const buf = await excelDuTableau(t);
    const sheet = await goog.creerSheetDepuisXlsx(buf, `[aperçu] ${t.nom}`);
    await goog.partager(sheet.id, 'reader');
    db.prepare("INSERT INTO sheets_sessions (genre, ref_id, file_id, url, expire_le) VALUES ('apercu-tableau', ?, ?, ?, datetime('now','localtime','+6 hours'))")
      .run(t.id, sheet.id, sheet.url);
    res.json({ url: sheet.url });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});
app.get('/api/tableaux/:id/pieces/:hash/sheet', async (req, res) => {
  try {
    if (!goog.dispo() && !goog.oauthConfigurable()) return res.status(400).json({ erreur: "Google n'est pas configuré — variables GOOGLE_OAUTH_CLIENT_ID/SECRET puis /google/connexion." });
    const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(req.params.id);
    let sources = []; try { sources = JSON.parse(t?.sources || '[]'); } catch {}
    const src = sources.find(x => x.hash === req.params.hash);
    if (!src) return res.status(404).json({ erreur: 'Pièce introuvable' });
    const type = (src.nom.split('.').pop() || '').toLowerCase();
    if (!['xls', 'xlsx'].includes(type)) return res.status(400).json({ erreur: 'Aperçu Sheets : uniquement pour les Excel.' });
    const active = db.prepare("SELECT * FROM sheets_sessions WHERE genre='apercu-piece' AND ref_id=? AND extra=? AND expire_le > datetime('now','localtime')").get(t.id, src.hash);
    if (active) return res.json({ url: active.url });
    const buf = fs.readFileSync(path.join(DATA_DIR, 'tableaux', src.disque));
    const sheet = await goog.creerSheetDepuisXlsx(buf, '[aperçu] ' + src.nom);
    await goog.partager(sheet.id, 'reader');
    db.prepare("INSERT INTO sheets_sessions (genre, ref_id, file_id, url, extra, expire_le) VALUES ('apercu-piece', ?, ?, ?, ?, datetime('now','localtime','+6 hours'))")
      .run(t.id, sheet.id, sheet.url, src.hash);
    res.json({ url: sheet.url });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});
app.post('/api/sheets/:id/terminer', async (req, res) => {
  try {
    const s = db.prepare('SELECT * FROM sheets_sessions WHERE id=?').get(req.params.id);
    if (!s) return res.status(404).json({ erreur: 'Session introuvable (déjà terminée ?)' });
    let piece = null;
    if (req.body.rapatrier && s.genre === 'offre') {
      const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(s.ref_id);
      if (t && t.resultat) {
        const buf = await goog.exporterXlsx(s.file_id);
        const nom = 'Sheet offre modifié le ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + '.xlsx';
        const disque = `t${t.id}_${Date.now()}_sheet.xlsx`;
        fs.writeFileSync(path.join(DATA_DIR, 'tableaux', disque), buf);
        let sources = []; try { sources = JSON.parse(t.sources); } catch {}
        sources.push({ role: 'maj', nom, disque, hash: ex.md5(buf), taille: buf.length,
          ajoute_le: new Date().toISOString().slice(0, 16).replace('T', ' ') });
        db.prepare('UPDATE tableaux SET sources=? WHERE id=?').run(JSON.stringify(sources), t.id);
        piece = nom;
        try {
          const etat = JSON.parse(t.resultat);
          const carto = JSON.parse(t.cartographie);
          const { actifs } = champsActifsOffre(carto);
          const ligneDebut = Number(carto.ligne_debut) || 2;
          const XLSX2 = require('xlsx');
          const wb2 = XLSX2.read(buf, { type: 'buffer' });
          const ws2 = wb2.Sheets[wb2.SheetNames.includes(carto.feuille) ? carto.feuille : wb2.SheetNames[0]];
          const grille = XLSX2.utils.sheet_to_json(ws2, { header: 1, defval: '' });
          let saisies = 0;
          etat.lignes.forEach((ligne, i) => {
            const lig = grille[ligneDebut + i - 1] || [];
            for (const m of actifs) {
              let nv;
              if (m.cols.length > 1 && /dims_/.test(m.champ))
                nv = m.cols.map(c2 => String(lig[c2 - 1] ?? '').trim()).filter(Boolean).join(' × ');
              else nv = String(lig[m.cols[0] - 1] ?? '').trim();
              const av = ligne.valeurs[m.champ]?.v;
              if (nv !== '' && nv !== String(av ?? '')) { ligne.valeurs[m.champ] = { v: nv, etat: 'operateur' }; saisies++; }
            }
            ligne.manques = ligne.manques.filter(c => !(ligne.valeurs[c] && ligne.valeurs[c].etat !== 'vide'));
          });
          if (saisies) {
            db.prepare("UPDATE tableaux SET resultat=?, modifie_le=datetime('now','localtime') WHERE id=?").run(JSON.stringify(etat), t.id);
            journal(t.id, 'saisies Sheet', saisies + ' case(s) saisie(s) ou corrigée(s) à la main');
            piece = nom + ' — ' + saisies + ' saisie(s) manuelle(s) intégrée(s)';
          }
        } catch (e2) { console.error('rapatriement offre:', e2.message); }
      }
    }
    if (req.body.rapatrier && s.genre === 'tableau') {
      const t = db.prepare('SELECT * FROM tableaux WHERE id=?').get(s.ref_id);
      if (t) {
        const buf = await goog.exporterXlsx(s.file_id);
        const nom = 'Sheet modifié le ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + '.xlsx';
        const disque = `t${t.id}_${Date.now()}_sheet.xlsx`;
        fs.writeFileSync(path.join(DATA_DIR, 'tableaux', disque), buf);
        let sources = []; try { sources = JSON.parse(t.sources); } catch {}
        sources.push({ role: 'maj', nom, disque, hash: ex.md5(buf), taille: buf.length,
          ajoute_le: new Date().toISOString().slice(0, 16).replace('T', ' ') });
        db.prepare('UPDATE tableaux SET sources=? WHERE id=?').run(JSON.stringify(sources), t.id);
        piece = nom;
        // saisies manuelles : toute case REMPLIE dans le Sheet là où le tableau était VIDE devient une modif (jaune)
        try {
          const resultat = JSON.parse(t.resultat || 'null');
          if (resultat && resultat.parRef) {
            const XLSX2 = require('xlsx');
            const wb2 = XLSX2.read(buf, { type: 'buffer' });
            const ws2 = wb2.Sheets[wb2.SheetNames[0]];
            const grille = XLSX2.utils.sheet_to_json(ws2, { header: 1, defval: '' });
            const CHAMPS_SAISIE = { code_douanier: 3, description: 4, kd: 5, product_size: 7, pcb_cat: 8, packing: 9, volume: 10, nwgw: 11, fob_com: 13, port: 16, promotion: 17, sav: 20 };
            let ajustements = { modifs: [] }; try { ajustements = JSON.parse(t.ajustements || 'null') || { modifs: [] }; } catch {}
            ajustements.modifs = ajustements.modifs || [];
            let saisies = 0;
            for (const ligne of grille) {
              const refCell = String(ligne[0] || '').trim();
              const o = resultat.parRef[refCell];
              if (!o) continue;
              for (const [champ, col] of Object.entries(CHAMPS_SAISIE)) {
                const enTableau = o[champ];
                const auSheet = String(ligne[col - 1] ?? '').trim();
                if ((enTableau == null || String(enTableau).trim() === '') && auSheet !== '') {
                  const i = ajustements.modifs.findIndex(m => m.ref === refCell && m.champ === champ);
                  if (i !== -1) ajustements.modifs.splice(i, 1);
                  ajustements.modifs.push({ ref: refCell, champ, valeur: auSheet });
                  saisies++;
                }
              }
            }
            if (saisies) {
              db.prepare('UPDATE tableaux SET ajustements=? WHERE id=?').run(JSON.stringify(ajustements), t.id);
              piece = nom + ` — ${saisies} saisie(s) manuelle(s) détectée(s) et intégrée(s) au tableau (jaune)`;
            }
          }
        } catch (e) { /* lecture du sheet rapatrié best-effort */ }
      }
    }
    await goog.supprimer(s.file_id);
    db.prepare('DELETE FROM sheets_sessions WHERE id=?').run(s.id);
    res.json({ ok: true, piece });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});
// aperçu fidèle d'un fichier déposé, converti par Google (lecture seule, éphémère)
app.get('/api/fichiers/:id/sheet', async (req, res) => {
  try {
    if (!goog.dispo() && !goog.oauthConfigurable()) return res.status(400).json({ erreur: "Google n'est pas configuré — variables GOOGLE_OAUTH_CLIENT_ID/SECRET puis /google/connexion." });
    const f = db.prepare('SELECT * FROM fichiers WHERE id=?').get(req.params.id);
    if (!f) return res.status(404).json({ erreur: 'Fichier introuvable' });
    if (!['xls', 'xlsx'].includes(f.type)) return res.status(400).json({ erreur: 'Aperçu Sheets : uniquement pour les Excel.' });
    const active = db.prepare("SELECT * FROM sheets_sessions WHERE genre='apercu' AND ref_id=? AND expire_le > datetime('now','localtime')").get(f.id);
    if (active) return res.json({ url: active.url });
    let disque = null; try { disque = JSON.parse(f.rapport || '{}').disque; } catch {}
    const chemin = disque ? path.join(DATA_DIR, 'fichiers', disque) : null;
    if (!chemin || !fs.existsSync(chemin)) return res.status(404).json({ erreur: 'Copie source introuvable sur le disque.' });
    const sheet = await goog.creerSheetDepuisXlsx(fs.readFileSync(chemin), '[aperçu] ' + f.nom);
    await goog.partager(sheet.id, 'reader');
    db.prepare("INSERT INTO sheets_sessions (genre, ref_id, file_id, url, expire_le) VALUES ('apercu', ?, ?, ?, datetime('now','localtime','+6 hours'))")
      .run(f.id, sheet.id, sheet.url);
    res.json({ url: sheet.url });
  } catch (e) { res.status(500).json({ erreur: e.message || String(e) }); }
});

app.patch('/api/dossiers/renommer', (req, res) => {
  const chemin = String(req.body.chemin || '').trim();
  const nouveauNom = String(req.body.nouveau_nom || '').trim().replace(/[\/\\]/g, '').replace(/[^\w\s.\-()&+]/g, '').slice(0, 80);
  if (!chemin || !nouveauNom) return res.status(400).json({ erreur: 'Paramètres manquants' });
  const parent = chemin.includes('/') ? chemin.slice(0, chemin.lastIndexOf('/')) : '';
  const nouveau = parent ? parent + '/' + nouveauNom : nouveauNom;
  if (nouveau === chemin) return res.json({ ok: true, chemin: nouveau });
  const tx = db.transaction(() => {
    const touches = db.prepare("SELECT chemin FROM dossiers WHERE chemin = ? OR chemin LIKE ? || '/%'").all(chemin, chemin);
    for (const d of touches) {
      const c2 = nouveau + d.chemin.slice(chemin.length);
      db.prepare('DELETE FROM dossiers WHERE chemin=?').run(d.chemin);
      db.prepare('INSERT OR IGNORE INTO dossiers (chemin) VALUES (?)').run(c2);
    }
    db.prepare("UPDATE produits SET dossier = ? || substr(dossier, ?) WHERE dossier = ? OR dossier LIKE ? || '/%'")
      .run(nouveau, chemin.length + 1, chemin, chemin);
    db.prepare("UPDATE fichiers SET dossier = ? || substr(dossier, ?) WHERE dossier = ? OR dossier LIKE ? || '/%'")
      .run(nouveau, chemin.length + 1, chemin, chemin);
  });
  tx();
  res.json({ ok: true, chemin: nouveau });
});

app.get('/api/export/audit', (req, res) => {
  const fichiers = db.prepare(`SELECT id, nom, hash, type, mode, statut, valide,
    COALESCE(date_document, substr(depose_le,1,10)) AS date_document FROM fichiers ORDER BY id`).all();
  const prods = db.prepare(`SELECT fichier_id, reference, prix, devise, pcb, moq, port, ean, dossier FROM produits ORDER BY fichier_id, id`).all();
  const parFichier = {};
  for (const p of prods) (parFichier[p.fichier_id] = parFichier[p.fichier_id] || []).push(p);
  res.json({ exporte_le: new Date().toISOString(), version: 'v0.10.5',
    fichiers: fichiers.map(f => ({ ...f, produits: parFichier[f.id] || [] })) });
});

app.get('/api/depot/rapports', (req, res) => {
  const lignes = db.prepare(`SELECT id, nom, statut, mode, rapport, COALESCE(date_document, substr(depose_le,1,10)) AS date_document
    FROM fichiers WHERE valide=0 ORDER BY id`).all();
  res.json(lignes.map(l => {
    let rap = null; try { rap = JSON.parse(l.rapport || 'null'); } catch {}
    if (rap && !rap.fichier) rap = null; // ligne fraîche : seul {disque} est stocké
    return { fichierId: l.id, fichier: l.nom, statut: l.statut, mode: l.mode, date_document: l.date_document, rapport: rap };
  }));
});

app.get('/api/fichiers', (req, res) => {
  res.json(db.prepare(`SELECT id, nom, type, mode, taille, depose_le, statut, valide, hash, COALESCE(date_document, substr(depose_le,1,10)) AS date_document,
    (SELECT COUNT(*) FROM produits WHERE fichier_id=fichiers.id) AS produits
    FROM fichiers ORDER BY id DESC LIMIT 200`).all());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Flaudis Base Produits — http://127.0.0.1:${PORT}`));
