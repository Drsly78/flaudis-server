// lib/extract.js — lecture des fichiers déposés
// - cellules des .xls et .xlsx (SheetJS)
// - images des .xlsx avec leur ligne d'ancrage (ExcelJS)
// - texte brut des .pptx (xml) et .msg (latin-1) pour l'index de recherche
const XLSX = require('xlsx');
const { spawnSync, spawn } = require('child_process');
function spawnP(bin, args, timeout) {
  return new Promise((resoudre) => {
    const p = spawn(bin, args);
    const minuteur = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resoudre({ status: -1 }); }, timeout);
    p.on('error', () => { clearTimeout(minuteur); resoudre({ status: -1 }); });
    p.on('close', (code) => { clearTimeout(minuteur); resoudre({ status: code }); });
  });
}
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const crypto = require('crypto');

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

/** Cellules de toutes les feuilles -> [{feuille, ligne, colonne, valeur}] + dump TSV par feuille */
/** Date du document : nom du fichier d'abord, sinon métadonnées internes Excel. Renvoie 'YYYY-MM-DD' ou null. */
function dateDocument(buffer, nom) {
  // 1. date dans le nom : 26.08.2025, 30-01-26, 12_11_2025, 2026.4.2…
  const n = nom.replace(/[_]/g, '.');
  let m = n.match(/(\d{1,2})[.\-](\d{1,2})[.\-](\d{4})/); // jj.mm.aaaa
  if (m) { const [j, mo, a] = [+m[1], +m[2], +m[3]]; if (mo <= 12) return `${a}-${String(mo).padStart(2,'0')}-${String(j).padStart(2,'0')}`; }
  m = n.match(/(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})/); // aaaa.mm.jj
  if (m) { const [a, mo, j] = [+m[1], +m[2], +m[3]]; if (mo <= 12 && j <= 31 && a > 2000) return `${a}-${String(mo).padStart(2,'0')}-${String(j).padStart(2,'0')}`; }
  m = n.match(/(\d{1,2})[.\-](\d{1,2})[.\-](\d{2})(?![\d])/); // jj.mm.aa
  if (m) { const [j, mo, a] = [+m[1], +m[2], 2000 + +m[3]]; if (mo <= 12 && j <= 31) return `${a}-${String(mo).padStart(2,'0')}-${String(j).padStart(2,'0')}`; }
  // 2. métadonnées internes (date du dernier enregistrement par Excel)
  try {
    const wb = XLSX.read(buffer, { type: 'buffer', bookProps: true, bookSheets: true });
    let d = wb.Props && wb.Props.ModifiedDate;
    if (d && !(d instanceof Date)) d = new Date(d);
    if (d instanceof Date && !isNaN(d) && d.getFullYear() > 2000) return d.toISOString().slice(0, 10);
  } catch {}
  return null;
}

/** Noms des feuilles masquées du classeur (les fournisseurs y laissent parfois des données) */
function feuillesMasquees(buffer) {
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const etats = (wb.Workbook && wb.Workbook.Sheets) || [];
    return wb.SheetNames.filter((n, i) => etats[i] && etats[i].Hidden);
  } catch { return []; }
}

function lireCellules(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const masquees = new Set(feuillesMasquees(buffer));
  const feuilles = [];
  for (const nom of wb.SheetNames) {
    if (masquees.has(nom)) continue; // feuille masquée par le fournisseur : pas destinée au client
    const ws = wb.Sheets[nom];
    if (!ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const lignes = [];
    for (let r = range.s.r; r <= Math.min(range.e.r, 3000); r++) {
      const vals = [];
      for (let c = range.s.c; c <= Math.min(range.e.c, 80); c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        vals.push(cell && cell.v != null ? String(cell.v).replace(/[\t\r]/g, ' ') : '');
      }
      lignes.push(vals);
    }
    feuilles.push({ nom, lignes });
  }
  return feuilles;
}

/** Texte brut complet (pour l'index plein-texte et les vérifications) */
function texteDesFeuilles(feuilles) {
  return feuilles.map(f =>
    `### FEUILLE: ${f.nom}\n` +
    f.lignes.map((vals, i) => vals.some(v => v) ? `L${i + 1}\t` + vals.join('\t') : '')
      .filter(Boolean).join('\n')
  ).join('\n\n');
}

/** Images d'un .xlsx : [{feuille, ligneAncrage, buffer, hash, ext}] */
async function lireImagesXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = [];
  for (const ws of wb.worksheets) {
    if (ws.state && ws.state !== 'visible') continue; // feuille masquée : images ignorées aussi
    for (const img of ws.getImages()) {
      const media = wb.model.media.find(m => m.index === Number(img.imageId));
      if (!media || !media.buffer) continue;
      const buf = Buffer.from(media.buffer);
      out.push({
        feuille: ws.name,
        ligneAncrage: Math.floor(img.range.tl.nativeRow) + 1, // 1-indexé comme Excel
        buffer: buf,
        hash: md5(buf),
        ext: media.extension || 'png',
      });
    }
  }
  return out;
}

/** Texte d'un .pptx slide par slide : [{slide, texte}] dans l'ordre */
async function textePptxParSlides(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const noms = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const out = [];
  for (const n of noms) {
    const num = Number(n.match(/slide(\d+)\.xml/)[1]);
    const xml = await zip.files[n].async('string');
    out.push({ slide: num, texte: xml.replace(/<\/a:p>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim() });
  }
  return out;
}

/** Images d'un .pptx, ancrées à leur slide (feuille='Slide N', ligneAncrage=N) */
async function imagesPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const out = [];
  const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  for (const s of slides) {
    const num = Number(s.match(/slide(\d+)\.xml/)[1]);
    const rel = zip.files['ppt/slides/_rels/slide' + num + '.xml.rels'];
    if (!rel) continue;
    const rels = await rel.async('string');
    for (const m of [...rels.matchAll(/Target="\.\.\/media\/([^"]+)"/g)].map(x => x[1])) {
      const f = zip.files['ppt/media/' + m];
      if (!f || !/\.(png|jpe?g|gif|bmp|webp)$/i.test(m)) continue;
      const buf = Buffer.from(await f.async('nodebuffer'));
      if (buf.length < 3000) continue; // logos et pictos minuscules
      out.push({ feuille: 'Slide ' + num, ligneAncrage: num, buffer: buf, hash: md5(buf), ext: (m.split('.').pop() || 'png').toLowerCase() });
    }
  }
  return out;
}

/** Aperçu HTML autonome d'un .pptx : chaque slide = ses photos + son texte (sans LibreOffice) */
async function apercuPptx(buffer, nomFichier) {
  const slides = await textePptxParSlides(buffer);
  const imgs = await imagesPptx(buffer);
  const parSlide = {};
  for (const i of imgs) (parSlide[i.ligneAncrage] = parSlide[i.ligneAncrage] || []).push(i);
  const echap = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let html = `<!doctype html><meta charset="utf-8"><title>${echap(nomFichier)}</title><style>
    body{font-family:system-ui,sans-serif;background:#eef0f5;margin:0;padding:20px;color:#1c2434}
    h1{font-size:15px;color:#555;font-weight:600;margin:0 0 16px}
    .slide{background:#fff;border-radius:12px;box-shadow:0 2px 10px rgba(20,30,60,.08);padding:18px 22px;margin-bottom:18px;max-width:940px}
    .num{font-size:11px;letter-spacing:.1em;color:#98a0b3;font-weight:700;margin-bottom:10px}
    .imgs{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px}
    .imgs img{max-width:300px;max-height:260px;object-fit:contain;border:1px solid #e3e6ee;border-radius:8px;background:#fff}
    .txt{font-size:13.5px;line-height:1.55;white-space:pre-wrap}
  </style><h1>📽 ${echap(nomFichier)} — aperçu (photos et textes des diapositives)</h1>`;
  for (const s2 of slides) {
    const im = (parSlide[s2.slide] || []).map(i =>
      `<img src="data:image/${i.ext === 'jpg' ? 'jpeg' : i.ext};base64,${i.buffer.toString('base64')}">`).join('');
    html += `<div class="slide"><div class="num">DIAPOSITIVE ${s2.slide}</div>` +
      (im ? `<div class="imgs">${im}</div>` : '') +
      `<div class="txt">${echap(s2.texte)}</div></div>`;
  }
  return html;
}

/** Texte d'un .pptx / .docx : concat des xml débalisés */
async function textePptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const parts = [];
  for (const name of Object.keys(zip.files)) {
    if (name.endsWith('.xml')) {
      const xml = await zip.files[name].async('string');
      parts.push(xml.replace(/<[^>]+>/g, ' '));
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ');
}

/** Texte grossier d'un .msg Outlook (suffisant pour retrouver des références).
    Les .msg stockent l'essentiel en UTF-16 : on indexe les deux décodages. */
function texteMsg(buffer) {
  const l1 = buffer.toString('latin1').replace(/[^\x20-\x7EÀ-ÿ]/g, ' ');
  const u16 = buffer.toString('utf16le').replace(/[^\x20-\x7EÀ-ÿ]/g, ' ');
  return (l1 + ' ' + u16).replace(/\s+/g, ' ');
}

/** Corps + pièces jointes d'un mail Outlook .msg (format CFB) */
function lireMsg(buffer) {
  const CFB = require('cfb');
  const c = CFB.read(buffer, { type: 'buffer' });
  const contenu = (chemin) => { const e = CFB.find(c, chemin); return e && e.content ? Buffer.from(e.content) : null; };
  let corps = null;
  const bU = c.FullPaths.find(p => /__substg1\.0_1000001F$/.test(p));
  const bA = c.FullPaths.find(p => /__substg1\.0_1000001E$/.test(p));
  if (bU) corps = (contenu(bU) || Buffer.alloc(0)).toString('utf16le');
  else if (bA) corps = (contenu(bA) || Buffer.alloc(0)).toString('latin1');
  const pieces = [];
  const dossiers = [...new Set(c.FullPaths
    .filter(p => /__attach_version1\.0_#\d+\//.test(p))
    .map(p => p.match(/^(.*__attach_version1\.0_#\d+\/)/)[1]))];
  for (const d of dossiers) {
    const bin = contenu(d + '__substg1.0_37010102');
    if (!bin || !bin.length) continue;
    let nomPJ = null;
    const nU = contenu(d + '__substg1.0_3707001F');
    const nA = contenu(d + '__substg1.0_3707001E') || contenu(d + '__substg1.0_3704001E');
    if (nU) nomPJ = nU.toString('utf16le');
    else if (nA) nomPJ = nA.toString('latin1');
    if (nomPJ) pieces.push({ nom: nomPJ.replace(/\0/g, '').trim(), buffer: bin });
  }
  return { corps: (corps || '').replace(/\0/g, '').trim(), pieces };
}

/** Une référence est-elle présente telle quelle dans un texte ? (frontières alphanum) */
function refPresente(texte, ref) {
  const chercher = (t, r) => {
    const esc2 = r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9])${esc2}($|[^A-Za-z0-9])`, 'i').test(t);
  };
  if (chercher(texte, ref)) return true;
  // les espaces de la réf peuvent être des retours à la ligne dans la cellule d'origine
  // (ex: "110G1-2514\nMULTICOLOR" que l'IA lit "110G1-2514 MULTICOLOR")
  return chercher(texte.replace(/\s+/g, ' '), ref.replace(/\s+/g, ' '));
}

/** LibreOffice est-il disponible ? (installé via nixpacks.toml sur Railway) */
let _soffice;
function sofficeDisponible() {
  if (_soffice !== undefined) return _soffice;
  const bin = process.env.SOFFICE_BIN || 'soffice';
  try { _soffice = spawnSync(bin, ['--version'], { timeout: 15000 }).status === 0 ? bin : null; }
  catch { _soffice = null; }
  return _soffice;
}

/** Convertit un .xls en .xlsx via LibreOffice ; retourne le buffer xlsx ou null */
async function convertirXlsEnXlsx(buffer) {
  const bin = sofficeDisponible();
  if (!bin) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flaudis-conv-'));
  try {
    const src = path.join(dir, 'f.xls');
    fs.writeFileSync(src, buffer);
    const r = await spawnP(bin, ['--headless', '--convert-to', 'xlsx', '--outdir', dir,
      `-env:UserInstallation=file://${dir}/profil`, src], 120000);
    const out = path.join(dir, 'f.xlsx');
    if (r.status === 0 && fs.existsSync(out)) return fs.readFileSync(out);
    return null;
  } catch { return null; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

/** Repli : extraction des images par signatures binaires (JPEG/PNG) — sans position */
function imagesBinairesXls(buffer) {
  const out = [];
  // PNG : lecture chunk par chunk jusqu'au vrai IEND (les octets "IEND" peuvent
  // apparaître par hasard dans les données compressées — une recherche naïve tronque l'image)
  let i = 0;
  const pngSig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  while ((i = buffer.indexOf(pngSig, i)) !== -1) {
    let p = i + 8, ok = false;
    while (p + 12 <= buffer.length) {
      const long = buffer.readUInt32BE(p);
      const type = buffer.toString('ascii', p + 4, p + 8);
      p += 12 + long; // longueur + type + données + CRC
      if (type === 'IEND') { ok = true; break; }
      if (long > 50e6) break; // chunk aberrant : pas un vrai PNG
    }
    if (ok) {
      const buf = buffer.slice(i, p);
      if (buf.length > 1500 && buf.length < 15e6) out.push({ buffer: buf, ext: 'png', hash: md5(buf) });
      i = p;
    } else i += 8;
  }
  // JPEG : FFD8FF … FFD9
  i = 0;
  const jpgSig = Buffer.from([0xFF, 0xD8, 0xFF]);
  while ((i = buffer.indexOf(jpgSig, i)) !== -1) {
    const fin = buffer.indexOf(Buffer.from([0xFF, 0xD9]), i + 3);
    if (fin === -1) break;
    const buf = buffer.slice(i, fin + 2);
    if (buf.length > 1500 && buf.length < 15e6) out.push({ buffer: buf, ext: 'jpg', hash: md5(buf) });
    i = fin + 2;
  }
  return out;
}

/** Aperçu HTML autonome du tableur (images incorporées) via LibreOffice */
async function genererApercuHtml(buffer, extension) {
  const bin = sofficeDisponible();
  if (!bin) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flaudis-ap-'));
  try {
    // aperçu FIDÈLE : le fichier tel que le client le voit (feuilles masquées non révélées, images intactes)
    const src = path.join(dir, 'f.' + extension);
    fs.writeFileSync(src, buffer);
    const filtre = ['pptx', 'docx'].includes(extension) ? 'html' : 'xhtml';
    const r = await spawnP(bin, ['--headless', '--convert-to', filtre, '--outdir', dir,
      `-env:UserInstallation=file://${dir}/profil`, src], 120000);
    const out = path.join(dir, 'f.' + filtre);
    if (r.status !== 0 || !fs.existsSync(out)) return null;
    let html = fs.readFileSync(out, 'utf8');
    // incorporer les images référencées en data-URI pour une page autonome
    html = html.replace(/src="([^"]+\.(?:png|jpg|jpeg|gif))"/gi, (m, nom) => {
      try {
        const chemin = path.join(dir, decodeURIComponent(nom));
        const ext2 = nom.split('.').pop().toLowerCase();
        const mime = ext2 === 'jpg' || ext2 === 'jpeg' ? 'image/jpeg' : 'image/' + ext2;
        return `src="data:${mime};base64,${fs.readFileSync(chemin).toString('base64')}"`;
      } catch { return m; }
    });
    return html;
  } catch { return null; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

module.exports = {
  lireMsg, lireCellules, texteDesFeuilles, lireImagesXlsx, textePptx, texteMsg, refPresente, md5,
  convertirXlsEnXlsx, imagesBinairesXls, sofficeDisponible, genererApercuHtml, feuillesMasquees, dateDocument, textePptxParSlides, imagesPptx, apercuPptx };
