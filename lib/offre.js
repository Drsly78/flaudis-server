// lib/offre.js — lecture des modèles d'offre U (fichiers Excel fournis par le client, changeants)
const XLSX = require('xlsx');

/** Digest structuré d'un modèle U : tout ce que l'IA doit voir pour cartographier, en compact. */
function lireModeleU(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellStyles: true });
  const cachees = new Set((wb.Workbook?.Sheets || []).filter(s => s.Hidden).map(s => s.name));
  const feuilles = wb.SheetNames.map(n => {
    const ws = wb.Sheets[n];
    const g = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    return { nom: n, cachee: cachees.has(n), lignes: g.length, grille: g };
  });
  // feuille principale : la plus grande visible
  const principale = feuilles.filter(f => !f.cachee).sort((a, b) => (b.lignes * (b.grille[1] || []).length) - (a.lignes * (a.grille[1] || []).length))[0];
  const g = principale.grille;
  const colsMeta = wb.Sheets[principale.nom]['!cols'] || [];
  const masquees = new Set(colsMeta.map((c2, i) => c2 && c2.hidden ? i + 1 : null).filter(Boolean));
  const nbCols = Math.max(...g.slice(0, 12).map(l => l.length));
  const colonnes = [];
  for (let c = 0; c < nbCols; c++) {
    if (masquees.has(c + 1)) continue; // règle maison : on n'écrit que dans les colonnes visibles
    const morceaux = [];
    for (let li = 0; li < 8; li++) {
      const v = String((g[li] || [])[c] || '').replace(/\s+/g, ' ').trim();
      if (v && !morceaux.some(m => m.endsWith(v.slice(0, 60)))) morceaux.push('L' + (li + 1) + ':' + v.slice(0, 70));
    }
    const exemples = [8, 9].map(li => String((g[li] || [])[c] || '').replace(/\s+/g, ' ').trim().slice(0, 45)).filter(Boolean);
    if (!morceaux.length && !exemples.length) continue;
    colonnes.push({ col: c + 1, entetes: morceaux, exemples });
  }
  // listes autorisées (feuilles masquées type "menu deroulant")
  const menus = [];
  for (const f of feuilles.filter(x => x.cachee)) {
    const gm = f.grille;
    const nc = Math.max(0, ...gm.slice(0, 3).map(l => l.length));
    for (let c = 0; c < nc; c++) {
      const vals = [];
      for (let li = 0; li < Math.min(gm.length, 40); li++) {
        const v = String((gm[li] || [])[c] || '').replace(/\s+/g, ' ').trim();
        if (v) vals.push(v.slice(0, 50));
        if (vals.length >= 9) break;
      }
      if (vals.length > 1) menus.push({ feuille: f.nom, col: c + 1, valeurs: vals });
    }
  }
  // annexes visibles (consignes, composants…) : aperçu texte
  const annexes = feuilles.filter(f => !f.cachee && f !== principale).map(f => ({
    nom: f.nom, lignes: f.lignes,
    apercu: f.grille.slice(0, 14).map(l => l.filter(x => String(x).trim()).map(x => String(x).replace(/\s+/g, ' ').slice(0, 60)).join(' | ')).filter(Boolean).join('\n').slice(0, 1200),
  }));
  // densité : entêtes/exemples sont denses ; les lignes vierges U gardent quelques miettes pré-remplies (codes, formules)
  const densites = [];
  for (let li = 0; li < Math.min(g.length, 30); li++) densites.push((g[li] || []).filter(x => String(x).trim() !== '').length);
  const seuil = Math.max(6, Math.round(Math.max(...densites, 1) * 0.3));
  let derniereNonVide = 0;
  densites.forEach((d, li) => { if (d >= seuil) derniereNonVide = li + 1; });
  return { feuille_principale: principale.nom, nb_lignes: principale.lignes, colonnes, menus, annexes,
    ligne_donnees: derniereNonVide + 1,
    colonnes_masquees: [...masquees].sort((a2, b2) => a2 - b2),
    exemples_lignes: [9, 10].filter(li => (g[li - 1] || []).some(x => String(x).trim())) };
}

/** Texte compact envoyé à l'IA. */
function digestPourIA(lecture) {
  const parts = [];
  parts.push(`FEUILLE PRINCIPALE : « ${lecture.feuille_principale} » (${lecture.nb_lignes} lignes). Colonnes (entêtes lignes 1-8, exemples lignes 9-10) :`);
  for (const c of lecture.colonnes) parts.push(`COL${c.col} | ${c.entetes.join(' § ')}${c.exemples.length ? ' | ex: ' + c.exemples.join(' / ') : ''}`);
  if (lecture.menus.length) {
    parts.push(`\nLISTES DÉROULANTES AUTORISÉES (feuille masquée) :`);
    for (const m of lecture.menus.slice(0, 40)) parts.push(`${m.feuille} col${m.col} : ${m.valeurs.join(' • ')}`);
  }
  for (const a of lecture.annexes) parts.push(`\nFEUILLE ANNEXE « ${a.nom} » (${a.lignes} lignes) :\n${a.apercu}`);
  return parts.join('\n');
}

/** Gabarit maison de rédaction des désignations produit (communiqué par l'équipe Flaudis).
 *  Utilisé par le moteur de remplissage (étape C) pour rédiger la colonne Désignation. */
const CONSIGNE_DESIGNATION = `Structure OBLIGATOIRE du descriptif produit, dans cet ordre :
1. LIBELLÉ COURT EN CAPITALES + dimensions (ex: SCEN.LED NOEL 9,5X5,5X12,5CM)
2. Titre – désignation du produit
3. Dimensions L x l x H
4. Matériau principal
5. Autres informations utiles du descriptif (fonctions, coloris, usage…)
6. « À monter soi-même » ou « Assemblé »
7. Si multi-colis : « nombre de colis : N »
8. Si piles : « piles fournies : N x TYPE » (ou « piles non fournies : N x TYPE nécessaires »)
Cas particulier des LOTS (ex: chaises vendues par lot de 2 ou 4) : terminer le descriptif par
« Prix unitaire de la chaise : X,XX € » (adapter le nom du produit ; le prix unitaire = tarif du lot / quantité).`;

// ---------- ÉTAPE C : l'état d'offre (nos infos, prêtes pour leurs colonnes) ----------

function colLettre(n) { let r = ''; while (n > 0) { const m = (n - 1) % 26; r = String.fromCharCode(65 + m) + r; n = Math.floor((n - 1) / 26); } return r; }
function lettreCol(x) { const t = String(x || '').trim().toUpperCase(); if (/^\d+$/.test(t)) return Number(t); if (!/^[A-Z]+$/.test(t)) return 0; let n = 0; for (const c of t) n = n * 26 + (c.charCodeAt(0) - 64); return n; }
const num = (x) => { const n = parseFloat(String(x ?? '').replace(',', '.').replace(/[^\d.]/g, ' ').trim().split(/\s+/)[0]); return isNaN(n) ? null : n; };
/** "67 × 51 x 113 cm" / "34.5*15.5*16.3CM" -> [mm, mm, mm] */
function dimsEnMm(txt) {
  if (!txt) return null;
  const m = String(txt).match(/(\d+[.,]?\d*)\s*[x×*]\s*(\d+[.,]?\d*)\s*[x×*]\s*(\d+[.,]?\d*)/i);
  if (!m) return null;
  let d = [1, 2, 3].map(i => parseFloat(m[i].replace(',', '.')));
  const enMm = /mm/i.test(txt) && !/cm/i.test(txt);
  if (!enMm) d = d.map(x => x * 10); // cm (défaut usines) -> mm
  return d.map(x => Math.round(x));
}
/** "5/6KG" -> {nw, gw} (kg, niveau carton) */
function poidsCarton(txt) {
  if (!txt) return { nw: null, gw: null };
  const m = String(txt).match(/(\d+[.,]?\d*)\s*[\/|]\s*(\d+[.,]?\d*)/);
  if (m) return { nw: parseFloat(m[1].replace(',', '.')), gw: parseFloat(m[2].replace(',', '.')) };
  const seul = num(txt);
  return { nw: seul, gw: seul };
}
const PORTS_CHINE = ['NINGBO', 'XIAMEN', 'SHANGHAI', 'SHENZHEN', 'QINGDAO', 'YIWU', 'GUANGZHOU', 'TIANJIN', 'FUZHOU', 'CANTON'];

/** Calcul d'empilage : colis (l×L×h mm) sur palette Europe 1200×800, hauteur utile donnée. */
function calculerPalette(dimsColisMm, { hauteurMaxMm = 1800, hauteurSupportMm = 144 } = {}) {
  if (!dimsColisMm || dimsColisMm.length !== 3 || dimsColisMm.some(d => !d)) return null;
  const [a, b, c] = dimsColisMm;
  const orientations = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
  const utile = hauteurMaxMm - hauteurSupportMm;
  let best = null;
  for (const [L, l, h] of orientations) {
    const parCouche = Math.floor(1200 / L) * Math.floor(800 / l);
    const couches = Math.floor(utile / h);
    if (parCouche < 1 || couches < 1) continue;
    const total = parCouche * couches;
    if (!best || total > best.total) best = { total, parCouche, couches, orientation: [L, l, h], hauteurMm: couches * h + hauteurSupportMm };
  }
  return best;
}

/** Nos informations de fiche, présentées à l'opérateur pour validation d'écriture. */
const CHAMPS_FICHE = [
  { champ: 'reference', libelle: 'Référence produit', sources: ['reference'] },
  { champ: 'fournisseur', libelle: 'Fournisseur (FLAUDIS ou WISEN selon circuit)', sources: ['fournisseur'] },
  { champ: 'designation', libelle: 'Désignation (description de la fiche)', sources: ['designation_courte', 'description'] },
  { champ: 'ean', libelle: 'EAN', sources: ['ean'] },
  { champ: 'code_douanier', libelle: 'Code douanier', sources: ['code_douanier'] },
  { champ: 'pcb', libelle: 'PCB (UVC par colis)', sources: ['pcb'] },
  { champ: 'poids_net_uvc', libelle: 'Poids net UVC (poids carton ÷ PCB)', sources: ['poids_net_uvc'] },
  { champ: 'poids_brut_colis', libelle: 'Poids brut colis', sources: ['poids_brut_colis'] },
  { champ: 'volume_net_uvc', libelle: 'Volume UVC en litres (m³ carton ÷ PCB)', sources: ['volume_net_uvc'] },
  { champ: 'dims_produit_mm', libelle: 'Dimensions produit (mm)', sources: ['dimensions_produit_mm'] },
  { champ: 'dims_colis_mm', libelle: 'Dimensions colis (mm)', sources: ['dimensions_colis_mm'] },
  { champ: 'garantie_mois', libelle: 'Garantie (mois, si dans la fiche)', sources: ['garantie_mois'] },
  { champ: 'conditionnement', libelle: 'Conditionnement (COLIS/CARTON)', sources: ['conditionnement'] },
];
/** Inverse la cartographie validée : pour chaque info de NOS fiches, les colonnes U où l'écrire. */
function proposerMapping(carto) {
  const colsDe = (srcs) => (carto.colonnes || []).filter(c => srcs.includes(String(c.source || ''))).map(c => ({ col: c.col, entete: c.entete || '' }));
  return CHAMPS_FICHE.map(f => {
    const cibles = colsDe(f.sources);
    return { champ: f.champ, libelle: f.libelle, cols: cibles.map(c => c.col), entetes: cibles.map(c => c.entete), actif: cibles.length > 0 };
  });
}

/** Construit l'état d'offre : une ligne par produit, valeurs par CHAMP canonique + provenance. */
function construireEtatOffre({ produits, circuits = {}, constantes = {}, params = {}, champsActifs = null }) {
  const CST = { fournisseur_flaudis: 'FLAUDIS', fournisseur_wisen: 'WISEN', conditionnement: 'COLIS/CARTON', ...constantes };
  const lignes = [];
  for (const p of produits) {
    const circuit = circuits[p.reference] || 'flaudis';
    const pcb = num(p.pcb);
    const { nw, gw } = poidsCarton(p.poids_nb);
    const volM3 = num(p.volume_m3);
    const dimsProd = dimsEnMm(p.taille_produit);
    const dimsColis = dimsEnMm(p.colisage_cm);
    let extras = []; try { extras = JSON.parse(p.extras || '[]') || []; } catch {}
    const chercherExtra = (re) => { const e = extras.find(x => re.test(x.intitule + ' ' + x.valeur)); return e ? `${e.intitule}: ${e.valeur}` : null; };
    const V = {};
    const pose = (champ, v, etat) => { V[champ] = { v: v == null || v === '' ? null : v, etat: v == null || v === '' ? 'vide' : etat }; };
    pose('reference', p.reference, 'fiche');
    pose('fournisseur', circuit === 'wisen' ? CST.fournisseur_wisen : CST.fournisseur_flaudis, 'constante');
    pose('ean', p.ean, 'fiche');
    pose('designation', p.description, 'fiche'); // v1 : la description brute — la rédaction gabarit (gras + structure) viendra du module dédié
    pose('code_douanier', p.code_hs_usine, 'fiche');
    pose('garantie_mois', (() => { const g = chercherExtra(/garantie|warranty/i); const n = g ? num(g) : null; return n; })(), 'fiche');
    pose('pcb', pcb, 'fiche');
    pose('poids_net_uvc', nw != null && pcb ? +(nw / pcb).toFixed(3) : null, 'deduit');
    pose('poids_brut_colis', gw, 'fiche');
    pose('volume_net_uvc', volM3 != null && pcb ? +(volM3 / pcb * 1000).toFixed(2) : null, 'deduit'); // litres
    pose('dims_produit_mm', dimsProd ? dimsProd.join(' × ') : null, 'fiche');
    pose('dims_colis_mm', dimsColis ? dimsColis.join(' × ') : null, 'fiche');
    pose('conditionnement', CST.conditionnement, 'constante');
    pose('piles', chercherExtra(/pile|batter/i), 'fiche');
    if (champsActifs) for (const k of Object.keys(V)) if (k !== 'reference' && !champsActifs.includes(k)) delete V[k];
    const manques = ['ean', 'designation', 'code_douanier', 'pcb', 'poids_net_uvc', 'dims_produit_mm', 'dims_colis_mm'].filter(c => V[c] && V[c].etat === 'vide');
    lignes.push({ produit_id: p.id, reference: p.reference, circuit, valeurs: V, manques,
      dims_colis: dimsColis, image_id: p.image_id || null });
  }
  return { type: 'offre', lignes, genere_le: new Date().toISOString().slice(0, 16).replace('T', ' ') };
}

// ---------- Chirurgie : écrire NOS valeurs dans LEUR fichier, sans toucher au reste ----------
const echXml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function celluleXml(ref, valeur, styleAttr) {
  const s2 = styleAttr ? ' ' + styleAttr : '';
  if (valeur && typeof valeur === 'object' && valeur.formule)
    return `<c r="${ref}"${s2}><f>${echXml(valeur.formule)}</f></c>`;
  const brut = String(valeur);
  const n = Number(brut.replace(',', '.'));
  // les longs codes (EAN, TARIC…) restent du texte pour ne pas partir en notation scientifique
  if (Number.isFinite(n) && brut.trim() !== '' && !/^0\d/.test(brut.trim()) && brut.trim().length < 11 && /^[\d.,\-]+$/.test(brut.trim()))
    return `<c r="${ref}"${s2}><v>${n}</v></c>`;
  return `<c r="${ref}"${s2} t="inlineStr"><is><t xml:space="preserve">${echXml(brut)}</t></is></c>`;
}
/** Injecte des valeurs dans un xlsx/xlsm SANS reconstruire le classeur (mise en forme, macros, menus intacts).
 *  placements: [{ligne, col, valeur}] — repli .xls binaire : reconstruction xlsx valeurs seules. */
async function ecrireDansModele(buffer, { feuille, placements }) {
  const estZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (!estZip) {
    // .xls binaire : conversion (la mise en forme d'origine ne peut pas être préservée sur ce vieux format)
    const wb = XLSX.read(buffer, { type: 'buffer', cellStyles: true });
    const nomF = wb.SheetNames.includes(feuille) ? feuille : wb.SheetNames[0];
    const ws = wb.Sheets[nomF];
    for (const p of placements) {
      const ref = colLettre(p.col) + p.ligne;
      const brut = String(p.valeur);
      const n = Number(brut.replace(',', '.'));
      ws[ref] = Number.isFinite(n) && brut.trim() !== '' && brut.trim().length < 11 && /^[\d.,\-]+$/.test(brut.trim()) ? { t: 'n', v: n } : { t: 's', v: brut };
      const fin = XLSX.utils.decode_range(ws['!ref'] || 'A1');
      const c0 = { r: p.ligne - 1, c: p.col - 1 };
      if (c0.r > fin.e.r || c0.c > fin.e.c) ws['!ref'] = XLSX.utils.encode_range({ s: fin.s, e: { r: Math.max(fin.e.r, c0.r), c: Math.max(fin.e.c, c0.c) } });
    }
    return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), repli: true };
  }
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const ligneMin = Math.min(...placements.map(p => p.ligne));
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  let mSheet = new RegExp(`<sheet[^>]*name="${feuille.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*/?>`).exec(wbXml);
  if (!mSheet) mSheet = /<sheet[^>]*\/?>/.exec(wbXml); // repli : première feuille
  const rid = / r:id="(rId\d+)"/.exec(mSheet[0])[1];
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const cible = new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)[1].replace(/^\/?(xl\/)?/, 'xl/');
  let sx = await zip.file(cible).async('string');
  // héritage de style : par déclaration <col>, puis par cellules existantes autour de la zone de données
  const styleCol = {};
  for (const mc of sx.matchAll(/<col [^>]*min="(\d+)"[^>]*max="(\d+)"[^>]*style="(\d+)"[^>]*\/>/g))
    for (let c2 = Number(mc[1]); c2 <= Number(mc[2]); c2++) styleCol[c2] = 's="' + mc[3] + '"';
  const styleColDonnees = {};
  for (const mc of sx.matchAll(/<c r="([A-Z]+)(\d+)" s="(\d+)"/g)) {
    const c2 = lettreCol(mc[1]), lig2 = Number(mc[2]);
    if (lig2 >= ligneMin - 2 && lig2 <= ligneMin + 30 && styleColDonnees[c2] == null) styleColDonnees[c2] = 's="' + mc[3] + '"';
  }
  const heriteStyle = (c2) => styleColDonnees[c2] || styleCol[c2] || null;
  // gabarit de row (hauteur/format) : une row existante de la zone de données
  let gabaritRow = '';
  const mG = new RegExp(`<row [^>]*r="(${Array.from({length: 24}, (x2, i) => ligneMin + i).join('|')})"[^>]*>`).exec(sx) || /<row [^>]*r="\d+"[^>]*>/.exec(sx);
  if (mG) gabaritRow = (mG[0].match(/ (ht="[\d.]+")/) || [])[1] ? ' ' + (mG[0].match(/ht="[\d.]+"/) || [])[0] + ' customHeight="1"' : '';
  // groupement par ligne
  const parLigne = new Map();
  for (const p of placements) {
    if (p.valeur == null || p.valeur === '') continue;
    if (!parLigne.has(p.ligne)) parLigne.set(p.ligne, []);
    parLigne.get(p.ligne).push(p);
  }
  for (const [lig, ps] of [...parLigne.entries()].sort((a2, b2) => a2[0] - b2[0])) {
    const reRow = new RegExp(`<row[^>]*\\br="${lig}"[^>]*>([\\s\\S]*?)</row>|<row[^>]*\\br="${lig}"[^>]*/>`);
    const mRow = reRow.exec(sx);
    if (mRow) {
      let rowXml = mRow[0];
      let interne = mRow[1] != null ? mRow[1] : '';
      const ouvrante = mRow[1] != null ? rowXml.slice(0, rowXml.indexOf('>') + 1) : rowXml.replace(/\/>$/, '>');
      for (const p of ps) {
        const ref = colLettre(p.col) + lig;
        const reCell = new RegExp(`<c r="${ref}"[^>]*>[\\s\\S]*?</c>|<c r="${ref}"[^>]*/>`);
        const mCell = reCell.exec(interne);
        const styleAttr = mCell ? (/ (s="\d+")/.exec(mCell[0]) || [])[1] : heriteStyle(p.col);
        const neuve = celluleXml(ref, p.valeur, styleAttr);
        if (mCell) interne = interne.replace(mCell[0], neuve);
        else {
          // insertion triée par colonne
          const cells = [...interne.matchAll(/<c r="([A-Z]+)(\d+)"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)];
          let pos = interne.length;
          for (const c2 of cells) if (lettreCol(c2[1]) > p.col) { pos = interne.indexOf(c2[0]); break; }
          interne = interne.slice(0, pos) + neuve + interne.slice(pos);
        }
      }
      sx = sx.replace(mRow[0], ouvrante + interne + '</row>');
    } else {
      const cells = ps.sort((a2, b2) => a2.col - b2.col).map(p => celluleXml(colLettre(p.col) + lig, p.valeur, heriteStyle(p.col))).join('');
      const neuve = `<row r="${lig}"${gabaritRow}>${cells}</row>`;
      // insertion triée parmi les rows
      const rows = [...sx.matchAll(/<row [^>]*r="(\d+)"/g)];
      let inseree = false;
      for (const r2 of rows) if (Number(r2[1]) > lig) { sx = sx.slice(0, r2.index) + neuve + sx.slice(r2.index); inseree = true; break; }
      if (!inseree) sx = sx.replace('</sheetData>', neuve + '</sheetData>');
    }
  }
  zip.file(cible, sx);
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer: out, repli: false };
}

module.exports = { lireModeleU, digestPourIA, CONSIGNE_DESIGNATION, construireEtatOffre, calculerPalette, dimsEnMm, proposerMapping, CHAMPS_FICHE, colLettre, lettreCol, ecrireDansModele };
