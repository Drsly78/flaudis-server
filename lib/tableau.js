// lib/tableau.js — moteur SELECTION INTERNE : lecteurs des documents U
// Lecture de la commande PDF (bons par entrepôt/date, lignes produits, astérisque catalogue)
// et de la sélection U (EAN, DDP, opés tractées/complémentaires, formats).
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');

const ENTREPOTS = ['LES HERBIERS', 'CLERMONT', 'SAINT VIT'];

/** Commande U (PDF) -> { lignes, dates_themes, avertissements } */
async function lireCommandePdf(buffer) {
  const d = await pdfParse(buffer);
  const lignes = [];
  const avertissements = [];
  let entrepot = null, date = null, courant = null, enRecap = false;
  const lignesRecap = [];
  for (const brute of d.text.split('\n')) {
    const l = brute;
    if (/R[ée]capitulatif des commandes/i.test(l)) { enRecap = true; }
    // un nouveau bon (bloc adresse + Livré le) fait sortir du récapitulatif
    if (enRecap && /Livré le\s*:/.test(l)) enRecap = false;
    // contexte : entrepôt (bloc adresse du bon) et date de livraison
    for (const e of ENTREPOTS) if (l.toUpperCase().includes(e)) entrepot = e;
    const md = l.match(/Livré le\s*:\s*([\d/]+)/);
    if (md) date = md[1];
    // ligne Thème : nom + n° présentation + EAN + UVC + colis + astérisque tract
    const mt = l.match(/\|\s*Thème\s*:\s*(.+?)\s+N°\s*présentation\s*:\s*(\d+)\s*\|\s*\d*\s*\|\s*(\d{13})\s*\|\s*([\d\s]+)\|\s*([\d\s]+)\|\s*(\*?)\s*\|/);
    if (mt) {
      courant = {
        recap: enRecap,
        theme: mt[1].replace(/\s+/g, ' ').trim(),
        n_presentation: mt[2],
        ean: mt[3],
        uvc: parseInt(mt[4].replace(/\s/g, ''), 10),
        colis: parseInt(mt[5].replace(/\s/g, ''), 10),
        tracte: mt[6] === '*',
        entrepot, date,
        reference: null, pcb: null, pa_net: null,
      };
      continue;
    }
    // ligne Réf. Fourn : référence + PCB
    const mr = l.match(/\|\s*Réf\.\s*Fourn\s*:\s*([^|]+?)\s*\|\s*(\d+)\s*\|/);
    if (mr && courant && !courant.reference) {
      courant.reference = mr[1].replace(/\s+/g, ' ').trim();
      courant.pcb = parseInt(mr[2], 10);
      (courant.recap ? lignesRecap : lignes).push(courant);
      continue;
    }
    // prix d'achat net
    const mp = l.match(/P\.A\s*net\s*:\s*([\d\s,.]+)\s*EUR/);
    const cible = enRecap ? lignesRecap : lignes;
    if (mp && cible.length) {
      cible[cible.length - 1].pa_net = parseFloat(mp[1].replace(/\s/g, '').replace(',', '.'));
    }
  }
  for (const li of lignes) {
    if (!li.entrepot) avertissements.push(`Ligne ${li.reference} : entrepôt non identifié`);
    if (!li.date) avertissements.push(`Ligne ${li.reference} : date de livraison non identifiée`);
  }
  // carte date -> thèmes (contrôle 1:1 attendu)
  const dates_themes = {};
  for (const li of lignes) (dates_themes[li.date] ||= new Set()).add(li.theme);
  for (const k of Object.keys(dates_themes)) dates_themes[k] = [...dates_themes[k]];
  return { lignes, lignes_recap: lignesRecap, dates_themes, avertissements, pages: d.numpages };
}

/** Sélection U (.xls) -> { produits: {ref: {...}}, avertissements }
    Une réf peut occuper plusieurs lignes (une par opé tractée) : fusion par référence. */
const COLONNES_FORMATS = { 15: '?15', 16: 'HU2', 17: 'HU1', 18: 'SU5', 19: 'SU4', 20: '?20', 21: '?21', 22: 'UE2' };

function lireSelectionU(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const nomFeuille = wb.SheetNames.find(n => n.toLowerCase() === 'file') || wb.SheetNames[0];
  const ws = wb.Sheets[nomFeuille];
  const grille = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const produits = {};
  const avertissements = [];
  const nettoyerOp = (v) => String(v).replace(/^\s*\d+\s*/, '').replace(/\s+/g, ' ').trim(); // "27296 FETE ÉTÉ" -> "FETE ÉTÉ"
  for (const ligne of grille) {
    const ref = String(ligne[9] ?? '').replace(/\s+/g, ' ').trim();
    if (!ref || ref.length < 3 || !/\d/.test(ref) || /r[ée]f[ée]rence/i.test(ref)) continue;
    const ean = String(ligne[8] ?? '').replace(/\.0$/, '').trim();
    const ddp = parseFloat(String(ligne[23] ?? '').replace(',', '.')) || null;
    const p = (produits[ref] ||= { reference: ref, ean: null, ddp: null, pcb: null,
      description: null, tractes: [], comps: [], lignes_source: 0 });
    p.lignes_source++;
    if (ean && /^\d{13}$/.test(ean)) {
      if (p.ean && p.ean !== ean) avertissements.push(`${ref} : deux EAN différents dans la sélection (${p.ean} / ${ean})`);
      p.ean = ean;
    }
    if (ddp != null) {
      if (p.ddp != null && p.ddp !== ddp) avertissements.push(`${ref} : deux DDP différents (${p.ddp} / ${ddp})`);
      p.ddp = ddp;
    }
    if (ligne[10] !== '' && p.pcb == null) p.pcb = Number(ligne[10]) || null;
    if (!p.description && ligne[7]) p.description = String(ligne[7]).trim();
    if (!p.vendu_par && ligne[2]) p.vendu_par = String(ligne[2]).replace(/\s+/g, ' ').trim(); // colonne FR : FLAUDIS (BLS) / WISEN Ltd
    // opé tractée de cette ligne + format = colonne cochée la plus à droite
    const tracte = String(ligne[13] ?? '').trim();
    if (tracte) {
      let format = null, inconnue = false;
      for (let c = 15; c <= 22; c++) {
        if (String(ligne[c] ?? '').trim() !== '' && Number(ligne[c]) !== 0) {
          format = COLONNES_FORMATS[c];
          if (format.startsWith('?')) inconnue = true;
        }
      }
      if (inconnue) avertissements.push(`ℹ ${ref} : la sélection U mentionne une opé dans une colonne de format que je ne connais pas encore (${format}) — la promotion est reprise telle quelle, vérifie sa ligne PROMOTION si besoin.`);
      p.tractes.push({ op: nettoyerOp(tracte), format });
    }
    const comp = String(ligne[14] ?? '').trim();
    if (comp) {
      const opComp = nettoyerOp(comp);
      if (!p.comps.includes(opComp)) p.comps.push(opComp);
    }
  }
  const refsLues = Object.keys(produits);
  const avecLettres = refsLues.filter(x => /[A-Za-z]/.test(x)).length;
  if (refsLues.length >= 4 && avecLettres / refsLues.length < 0.4)
    throw new Error('Ce fichier ne ressemble pas à une sélection U (références non reconnues) — est-ce la bonne pièce ? Les sélections DDP WISEN ont un autre format, non géré ici.');
  return { produits, avertissements, feuille: nomFeuille };
}

/** Colonne Q (PROMOTION) d'un produit : opés tractées avec format + complémentaires en OC.
    Le format est "sujet à caution" (donné par le chef produit) -> signalé pour marquage orange. */
function composerPromotion(p) {
  const morceaux = [];
  for (const t of p.tractes) morceaux.push(`${t.op}${t.format ? ' ' + t.format : ''}`);
  for (const c of p.comps) if (!p.tractes.some(t => t.op === c)) morceaux.push(`${c} OC`);
  return morceaux.join('\n');
}

/** Rapprocher une réf du PDF (potentiellement tronquée par la largeur de colonne)
    avec les réfs de la sélection. Exact d'abord ; sinon préfixe UNIQUE (les variantes
    de suffixe restent distinctes : un préfixe qui matche 2 réfs = pas de rapprochement). */
function rapprocherRef(refPdf, refsSelection) {
  const norm = (x) => x.replace(/[·]/g, ' ').replace(/\s+/g, ' ').trim();
  const nCherche = norm(refPdf);
  const table = refsSelection.map(r => ({ r, n: norm(r) }));
  const exact = table.find(x => x.n === nCherche);
  if (exact) return { ref: exact.r, exact: exact.r === refPdf,
    note: exact.r === refPdf ? undefined : `réf « ${refPdf} » reconnue sous l'écriture « ${exact.r} »` };
  // troncature (dans un sens ou dans l'autre) : préfixe unique suffisamment long
  const parPrefixe = table.filter(x => (x.n.startsWith(nCherche) || nCherche.startsWith(x.n)) && x.n !== nCherche);
  if (parPrefixe.length === 1 && Math.min(nCherche.length, parPrefixe[0].n.length) >= 8)
    return { ref: parPrefixe[0].r, exact: false, note: `réf « ${refPdf} » rapprochée de « ${parPrefixe[0].r} » (troncature)` };
  // alias : la réf cherchée est un token entier d'une réf composée (JY-JH2502X (KB108-7520))
  const parToken = table.filter(x => x.n.split(/[\s\/()]+/).filter(Boolean).includes(nCherche));
  if (parToken.length === 1)
    return { ref: parToken[0].r, exact: false, note: `réf « ${refPdf} » reconnue comme alias de « ${parToken[0].r} »` };
  return { ref: null, exact: false };
}

// ============================================================
// ASSEMBLAGE : croiser sélection(s) + commande(s) + catalogue produits
// ============================================================
function parseDateFr(d) { const [j, m, a] = d.split('/').map(Number); return new Date(2000 + (a % 100), m - 1, j); }

function assemblerTableau({ selections = [], commandes = [], catalogue = {} }) {
  const avertissements = [];
  const sel = {};
  for (const s of selections) for (const [ref, p] of Object.entries(s.produits)) {
    if (sel[ref]) avertissements.push(`${ref} présent dans plusieurs sélections — fusion`);
    sel[ref] = Object.assign(sel[ref] || {}, p, {
      tractes: [...(sel[ref]?.tractes || []), ...p.tractes],
      comps: [...new Set([...(sel[ref]?.comps || []), ...p.comps])] });
  }
  const refsSel = Object.keys(sel);
  const periodes = [];
  const lignesCmd = commandes.flatMap(c => c.lignes);
  for (const l of lignesCmd) {
    let p = periodes.find(x => x.theme === l.theme);
    if (!p) { p = { theme: l.theme, date: l.date }; periodes.push(p); }
    else if (parseDateFr(l.date) < parseDateFr(p.date)) p.date = l.date;
  }
  periodes.sort((a, b) => parseDateFr(a.date) - parseDateFr(b.date));
  const parRef = {};
  // PARTIE 1 (aucune commande déposée) : le tableau naît des sélections seules —
  // toutes les réfs sélectionnées, colonnes usine remplies, grilles/FINAL vides en attente des bons de commande
  const wisenDirect = [];
  const estWisen = ref => /WISEN/i.test(sel[ref]?.vendu_par || '');
  if (!lignesCmd.length) {
    for (const ref of refsSel) {
      if (estWisen(ref)) { wisenDirect.push({ reference: ref, description: sel[ref].description || '', ean: sel[ref].ean || null }); continue; }
      const p = sel[ref];
      parRef[ref] = { reference: ref, final: null, grille: {}, catalogueU: !!(p.tractes && p.tractes.length),
        ean: p.ean || null, pcb: p.pcb || null, pa_net: p.pa_net ?? p.prix ?? null, horsSelection: false };
    }
  }
  for (const l of lignesCmd) {
    const { ref: refSel, note } = rapprocherRef(l.reference, refsSel);
    if (note && !avertissements.includes(note)) avertissements.push(note);
    const ref = refSel || l.reference;
    const o = (parRef[ref] ||= { reference: ref, final: 0, grille: {}, catalogueU: false, ean: null, pcb: null, pa_net: null, horsSelection: !refSel });
    o.final += l.uvc;
    const k = l.theme + '|' + l.entrepot;
    const g = (o.grille[k] ||= { uvc: 0, colis: 0 });
    g.uvc += l.uvc; g.colis += l.colis || 0;
    if (l.tracte) o.catalogueU = true;
    o.ean ||= l.ean; o.pcb ||= l.pcb; o.pa_net ||= l.pa_net;
  }
  const clesCat = Object.keys(catalogue);
  for (const [ref, o] of Object.entries(parRef)) {
    if (o.horsSelection) avertissements.push(`${ref} commandée mais absente des sélections déposées (sélection partielle ?)`);
    const s2 = sel[ref];
    o.promotion = s2 ? composerPromotion(s2) : '';
    o.ddp = s2?.ddp ?? null;
    o.ean = s2?.ean || o.ean;
    o.sav = Math.round(o.final * 0.01); // base 1 %, ajustable par l'opérateur
    const rc = rapprocherRef(ref, clesCat);
    if (rc.note) avertissements.push('catalogue : ' + rc.note);
    const c = catalogue[rc.ref] || {};
    o.refCatalogue = rc.ref || null;
    if (!o.refCatalogue) avertissements.push(`${ref} : fiche produit introuvable dans la base — colonnes usine vides`);
    Object.assign(o, { code_douanier: c.code_douanier || '', description: c.description || s2?.description?.split('\n')[0] || '',
      kd: c.kd || '', product_size: c.taille_produit || '', pcb_cat: c.pcb || o.pcb, packing: c.colisage_cm || '',
      volume: c.volume_m3 || '', nwgw: c.poids_nb || '', fob_net: c.fob_net ?? '', fob_com: c.fob_com ?? '',
      taxe: c.taxe ?? '', port: c.port || '', port_ambigu: c.port_ambigu || false, fournisseur: c.fournisseur || 'FOURNISSEUR ?' });
  }
  // produits vendus par Wisen en direct (colonne FR de la sélection) : hors tableau Flaudis, listés à part
  for (const ref of Object.keys(parRef)) {
    const rSel = parRef[ref].refCatalogue || ref;
    if (estWisen(rSel) || estWisen(ref)) {
      wisenDirect.push({ reference: ref, description: sel[rSel]?.description || sel[ref]?.description || '', ean: parRef[ref].ean || null });
      delete parRef[ref];
    }
  }
  for (const ref of refsSel) // les Wisen non commandés apparaissent aussi dans le volet
    if (estWisen(ref) && !wisenDirect.some(w => w.reference === ref))
      wisenDirect.push({ reference: ref, description: sel[ref].description || '', ean: sel[ref].ean || null });
  const selectionnesNonCommandes = refsSel.filter(r => !parRef[r] && !estWisen(r));
  const groupes = [];
  // ordre du tableau fini : consolidation logistique — groupes par PORT (remontée de la côte, sud -> nord),
  // fournisseurs A->Z dans chaque port, références dans l'ordre de la sélection U
  const ORDRE_PORTS = ['SHENZHEN', 'GUANGZHOU', 'SHANTOU', 'XIAMEN', 'QUANZHOU', 'FUZHOU', 'WENZHOU', 'NINGBO', 'SHANGHAI', 'QINGDAO', 'TIANJIN'];
  const rangPort = p => { const i = ORDRE_PORTS.findIndex(x => String(p || '').toUpperCase().includes(x)); return i === -1 ? 500 : i; };
  const rangSel = o => { const i = refsSel.indexOf(o.refCatalogue || o.reference); return i === -1 ? 1e9 : i; };
  const produitsTries = Object.values(parRef).sort((a, b) => rangSel(a) - rangSel(b));
  for (const o of produitsTries) {
    const cle = String(o.fournisseur || '').trim().toUpperCase();
    let g = groupes.find(x => x.cle === cle);
    if (!g) { g = { cle, fournisseur: o.fournisseur, port: o.port || '', produits: [] }; groupes.push(g); }
    if (!g.port && o.port) g.port = o.port;
    g.produits.push(o);
  }
  groupes.sort((a, b) => (rangPort(a.port) - rangPort(b.port))
    || String(a.fournisseur).localeCompare(String(b.fournisseur), 'fr', { sensitivity: 'base' }));
  for (const g of groupes) delete g.cle;
  if (wisenDirect.length) avertissements.push(`${wisenDirect.length} produit(s) de la sélection vendus par WISEN en direct (colonne FR) — écartés de ce tableau Flaudis, listés dans le volet dédié.`);
  return { periodes, groupes, parRef, selectionnesNonCommandes, wisenDirect, avertissements };
}

// ============================================================
// GÉNÉRATION EXCEL (exceljs) — styles conformes au tableau existant
// ============================================================
const ExcelJS = require('exceljs');
const S_ = { jaune: 'FFFFFF00', vert: 'FF92D050', rouge: 'FFFF0000', gris: 'FFECECEC',
  bordure: { style: 'thin', color: { argb: 'FF000000' } } };
const COULEURS_OPES = [
  [/^PRE ?SAISON/i, 'FFECECEC'], [/^JARDIN TERRASSE/i, 'FFFBE4D5'], [/^BEAUX JOURS/i, 'FFFFF2CB'],
  [/^FETE|^FÊTE/i, 'FFA8D08D'], [/^JARDIN\b/i, 'FFFFE598'], [/^PLEIN AIR/i, 'FFDDEBF7']];
function pastelDepuisNom(nom) { // les opés inconnues reçoivent une couleur douce stable (même nom = même couleur)
  let h = 0; for (const ch of String(nom).toUpperCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const t = h % 360, c = 0.18, l = 0.90;
  const f = n => { const k = (n + t / 30) % 12; const v = l - c * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(v * 255).toString(16).padStart(2, '0').toUpperCase(); };
  return 'FF' + f(0) + f(8) + f(4);
}
const couleurOpe = theme => { for (const [re, c] of COULEURS_OPES) if (re.test(String(theme).trim())) return c; return pastelDepuisNom(theme); };
const THEMES_COMPLETS = { 'PRE SAISON JARD': 'PRE SAISON JARDIN', 'JARDIN TERRASS': 'JARDIN TERRASSE' };
const completerTheme = t => THEMES_COMPLETS[String(t).trim()] || String(t).trim();
const ENTETES_FIXES = ['REFERENCE ', 'BARCODE ', 'CODE DOUANIER', 'DESCRIPTION ', 'KD', 'PICTURE ', 'PRODUCT SIZE ', 'PCB',
  'PACKING DETAILS (CM)', 'VOLUME ', 'N.W/G.W', 'FOB USD\nNET ', 'FOB USD\nWITH COM', 'DDP €', 'TAXE', 'PORT',
  'PROMOTION', 'ESTIM QTY', 'FINAL  QTY ', 'SAV', 'OK LA '];
const ENTREPOTS_COURTS = ['LES HERBIERS', 'CLERMONT', 'ST VIT'];
const LARGEURS_FIXES = [19.3, 15.1, 16.6, 29.9, 5, 24.6, 19.3, 7.6, 17.9, 9.1, 11.6, 12.1, 12.1, 12.7, 9, 12.3, 11.6, 9.6, 10.3, 11.6, 7];

async function genererXlsx(modele, options = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('SELECTED ITEMS ');
  const nbFixes = ENTETES_FIXES.length;
  const bordTout = { top: S_.bordure, left: S_.bordure, bottom: S_.bordure, right: S_.bordure };
  if (options.titre) {
    ws.mergeCells(1, 1, 1, nbFixes);
    const cel = ws.getCell(1, 1);
    cel.value = String(options.titre).toUpperCase();
    cel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00B0F0' } };
    cel.font = { name: 'Calibri', size: 36, bold: true, color: { argb: 'FFFFFFFF' } };
    cel.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 58;
    for (let c = 1; c <= nbFixes; c++) ws.getCell(1, c).border = bordTout;
  }
  modele.periodes.forEach((p, i) => {
    const c1 = nbFixes + 1 + i * 3;
    ws.mergeCells(1, c1, 1, c1 + 2);
    const cel = ws.getCell(1, c1);
    cel.value = completerTheme(p.theme);
    cel.font = { name: 'Calibri', size: 11, bold: true };
    const fondOpe = couleurOpe(p.theme);
    if (fondOpe) cel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fondOpe } };
    cel.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    for (let c = c1; c <= c1 + 2; c++) ws.getCell(1, c).border = c === c1 ? { ...bordTout, left: { style: 'medium', color: { argb: 'FF000000' } } } : bordTout;
  });
  ENTETES_FIXES.forEach((t, i) => {
    const cel = ws.getCell(2, i + 1);
    cel.value = t;
    cel.font = { name: 'Calibri', size: 11, bold: true, color: t.startsWith('FINAL') ? { argb: S_.rouge } : undefined };
    cel.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cel.border = bordTout;
    ws.getColumn(i + 1).width = LARGEURS_FIXES[i];
  });
  modele.periodes.forEach((p, i) => ENTREPOTS_COURTS.forEach((e, j) => {
    const c = nbFixes + 1 + i * 3 + j;
    const cel = ws.getCell(2, c);
    cel.value = e;
    cel.font = { name: 'Calibri', size: 11, bold: true };
    cel.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cel.border = j === 0 ? { ...bordTout, left: { style: 'medium', color: { argb: 'FF000000' } } } : bordTout;
    ws.getColumn(c).width = 11;
  }));
  const dernCol = nbFixes + modele.periodes.length * 3;
  let r = 3;
  const entrepotLong = { 'LES HERBIERS': 'LES HERBIERS', 'CLERMONT': 'CLERMONT', 'ST VIT': 'SAINT VIT' };
  for (const g of modele.groupes) {
    const lf = ws.getCell(r, 1);
    lf.value = g.fournisseur;
    lf.font = { name: 'Calibri', size: 11, bold: true, color: { argb: S_.rouge } };
    for (let c = 1; c <= dernCol; c++) {
      ws.getCell(r, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: S_.jaune } };
      ws.getCell(r, c).border = bordTout;
    }
    r++;
    for (const p of g.produits) {
      const vals = [p.refCatalogue || p.reference, p.ean && /^\d+$/.test(p.ean) ? Number(p.ean) : p.ean, p.code_douanier, p.description, p.kd, '', p.product_size, p.pcb_cat, p.packing,
        p.volume, p.nwgw, p.fob_net, p.fob_com, p.ddp, p.taxe, p.port, p.promotion, '', p.final, p.sav, ''];
      vals.forEach((v, i) => {
        const cel = ws.getCell(r, i + 1);
        if (i + 1 === 12 && !(p.jaunes || []).includes('fob_net') && p.fob_com !== '' && p.fob_com != null) cel.value = { formula: `M${r}*0.95` }; // NET = WITH COM - 5% commission (sauf NET renégocié à la main -> valeur brute jaune)
        else if (v !== '' && v != null) cel.value = v;
        cel.font = { name: 'Calibri', size: [12, 13, 14].includes(i + 1) ? 12 : 11,
          bold: [1, 2, 16, 18, 19, 20].includes(i + 1), color: i + 1 === 19 ? { argb: S_.rouge } : undefined };
        cel.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cel.border = bordTout;
      });
      const MAP_JAUNE = { code_douanier: 3, description: 4, kd: 5, product_size: 7, pcb_cat: 8, packing: 9, volume: 10, nwgw: 11, fob_net: 12, fob_com: 13, ddp: 14, taxe: 15, port: 16, promotion: 17, final: 19, sav: 20 };
      for (const ch of p.jaunes || []) { const cJ = MAP_JAUNE[ch]; if (cJ) ws.getCell(r, cJ).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }; } // modifs par mise à jour = jaune (pratique interne)
      if (p.catalogueU) ws.getCell(r, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: S_.vert } };
      const cheminImg = options.images && options.images[p.refCatalogue || p.reference];
      if (cheminImg) {
        try {
          const ext = (cheminImg.split('.').pop() || 'png').toLowerCase();
          const imgId = wb.addImage({ filename: cheminImg, extension: ext === 'jpg' ? 'jpeg' : ext });
          ws.addImage(imgId, { tl: { col: 5.08, row: r - 0.94 }, ext: { width: 84, height: 58 }, editAs: 'oneCell' });
        } catch {}
      }
      modele.periodes.forEach((per, i) => ENTREPOTS_COURTS.forEach((e, j) => {
        const k = per.theme + '|' + entrepotLong[e];
        const v = p.grille[k];
        const cel = ws.getCell(r, nbFixes + 1 + i * 3 + j);
        if (v) cel.value = `${v.uvc} PCS\n${v.colis} CTNS`;
        cel.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cel.border = j === 0 ? { ...bordTout, left: { style: 'medium', color: { argb: 'FF000000' } } } : bordTout;
      }));
      ws.getRow(r).height = 55;
      r++;
    }
    ws.mergeCells(r, 1, r, nbFixes);
    const ld = ws.getCell(r, 1);
    ld.value = 'LOADING ';
    ld.alignment = { horizontal: 'right', vertical: 'middle' };
    ld.font = { name: 'Calibri', size: 18, bold: true, color: { argb: S_.rouge } };
    for (let c = 1; c <= dernCol; c++) ws.getCell(r, c).border = bordTout;
    r++;
  }
  // feuille CANCELLED ITEMS : les réfs annulées, avec leurs données d'époque (comme le fichier officiel)
  if ((modele.annulees || []).length) {
    const wc = wb.addWorksheet('CANCELLED ITEMS');
    const entetesC = ['REFERENCE', 'BARCODE', 'CODE DOUANIER', 'DESCRIPTION', 'KD', 'PRODUCT SIZE', 'PCB', 'PACKING (CM)', 'VOLUME', 'N.W/G.W', 'FOB USD NET', 'FOB USD WITH COM', 'DDP', 'TAXE', 'PORT'];
    wc.addRow(['CANCELLED ITEMS']);
    wc.getRow(1).font = { bold: true, size: 14, color: { argb: 'FFC00000' } };
    wc.addRow(entetesC).font = { bold: true };
    for (const o of modele.annulees) {
      wc.addRow([o.reference, o.ean || o.barcode || '', o.code_douanier || '', o.description || '', o.kd || '',
        o.product_size || '', o.pcb_cat || '', o.packing || '', o.volume || '', o.nwgw || '',
        o.fob_net || '', o.fob_com || '', o.ddp || '', o.taxe || '', o.port || '']);
    }
    for (let c = 1; c <= 15; c++) wc.getColumn(c).width = c === 4 ? 40 : 16;
  }
  return wb.xlsx.writeBuffer();
}

module.exports = { lireCommandePdf, lireSelectionU, composerPromotion, rapprocherRef, assemblerTableau, genererXlsx, ENTREPOTS };
