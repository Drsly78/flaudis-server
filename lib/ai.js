// lib/ai.js — extraction structurée des offres par Claude + filet de sécurité déterministe
// Principe : l'IA propose, le code vérifie. Chaque produit extrait doit avoir sa
// référence présente TELLE QUELLE dans le fichier, sinon il est rejeté.
const { refPresente } = require('./extract');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODELE = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MODELE_EXTRACTION = process.env.ANTHROPIC_MODEL_EXTRACTION || MODELE; // extraction des offres : montable en gamme indépendamment
let PREFILL_OK = true; // certains modèles refusent l'amorce assistant : on le découvre au 1er appel et on s'en souvient

const PROMPT_SYSTEME = `Tu es l'extracteur de la base produits de Flaudis, importateur pour Système U.
FORMAT DE RÉPONSE : ta réponse COMMENCE par { et se termine par } — pas un seul mot avant ni après, jamais d'analyse en prose.
TA MISSION : qu'AUCUNE information présente dans le fichier ne soit perdue. Les usines écrivent
n'importe comment — plusieurs infos entassées dans une cellule, étiquettes variables, blocs verticaux —
toi tu ranges chaque morceau au bon endroit du schéma. Un champ ne reste null QUE si l'information
n'existe nulle part dans le bloc du produit.
On te donne le contenu brut (TSV) d'un fichier d'offre envoyé par le bureau de Hong Kong :
tableaux de produits sourcés en usine (Chine, Vietnam...), aux mises en page très variables
(colonnes horizontales, fiches verticales "Item No.: XXX", plusieurs produits ou un seul).

Mais tous les fichiers reçus ne sont pas des offres : il circule aussi des documents INTERNES
Flaudis (récaps de pricing, tableaux de sélection, plans de chargement). On les reconnaît à leur
CONTENU, jamais à leur nom : présence de gencodes Flaudis (13 chiffres commençant par 3700442),
de prix DDP en euros, de répartitions de quantités par entrepôt/opération, de colonnes de thèmes
(JARDIN, PLEIN AIR...), ou l'absence des caractéristiques d'usine (packing, volume, MOQ, port FOB).

Ta réponse est UN OBJET JSON, sans texte autour, sans balises markdown :
{
 "nature": "offre" ou "interne",
 "motif": "en une phrase, ce qui dans le CONTENU t'a fait trancher (null si offre évidente)",
 "produits": [ ... ]
}
Le tri se fait LIGNE PAR LIGNE, pas par fichier : n'extrais dans "produits" QUE les lignes qui
sont de vraies offres de produits par une usine (référence + caractéristiques/prix usine).
Les lignes de récapitulatif interne, de sélection ou de logistique ne deviennent JAMAIS des
produits, même si le reste du fichier est une offre. Si le document entier est interne,
"produits" est [].

Schéma par produit (mets null si l'info est absente) :
{
 "reference": "référence usine EXACTEMENT comme écrite (ex: WH141443, TG52506-0A/4B/1). ATTENTION : certaines offres n'ont AUCUNE référence (produits juste numérotés 1, 2… ou décrits sans code). Dans ce cas mets null et remplis le reste — ne saute JAMAIS un produit pour absence de référence",
 "ligne": numéro de ligne approximatif où commence le produit (le préfixe LN du TSV),
 "feuille": "nom de la feuille",
 "fournisseur": "nom de l'usine/fournisseur si présent dans le fichier",
 "description": "description technique complète en anglais",
 "taille_produit": "dimensions produit",
 "matiere": "matériau(x)",
 "pcb": "pièces par carton (et inner si présent, ex: '16 / 4')",
 "colisage_cm": "dimensions carton en cm",
 "volume_m3": "volume carton (CBM)",
 "poids_nb": "poids net / brut (N.W/G.W)",
 "prix": "prix unitaire (NOMBRE SEUL, jamais de texte). Si l'offre donne PLUSIEURS prix pour une même référence — selon le conteneur (20GP/40HQ), un palier de quantité, une matière/version (housse PVC vs PE), une couleur… — mets ici UNIQUEMENT le premier/moins cher, et reporte CHAQUE prix en extras, TOUJOURS apparié à ce qui l'explique — jamais un prix nu (ex: {\"intitule\":\"Prix 20GP\",\"valeur\":\"63 $ — 280 pcs/ctn\"}, {\"intitule\":\"Prix 40HQ\",\"valeur\":\"55.7 $ — 680 pcs/ctn\"} ; ou {\"intitule\":\"Prix housse PVC\",\"valeur\":\"7.93 $\"}, {\"intitule\":\"Prix housse PE\",\"valeur\":\"8.9 $\"}). Si les autres caractéristiques (taille, poids, colisage) diffèrent aussi selon la version, c'est que ce sont DEUX PRODUITS : fais deux entrées distinctes en suffixant la référence",
 "devise": "USD ou EUR si identifiable",
 "variante_de": "si ce produit est une DÉCLINAISON (autre taille, autre couleur, autre conditionnement) d'un produit listé plus haut dans CE fichier, mets la référence EXACTE de ce produit principal ; sinon null. Ex : TG4001013-60X90 décliné de TG4001013-45X75 ; JY-JH2505-B décliné de JY-JH2505.",
  "port": "port de chargement (NINGBO, XIAMEN, QINGDAO, SHANGHAI, HAIPHONG...). Souvent en colonne FOB PORT, ou indiqué UNE SEULE FOIS dans l'entête du document (ex 'FOB XIAMEN IN USD') : dans ce cas applique-le à TOUTES les lignes. ATTENTION : 'FOB' seul est un incoterm, PAS un port — 'FOB NINGBO' -> port NINGBO, mais 'FOB' sans ville -> null",
 "moq": "quantité minimum de commande",
 "code_hs_usine": "code douanier HS si l'usine en donne un",
 "kd": true si le produit est signalé knock-down / à monter (colonne KD, 'KD OR NOT'...), sinon false,
 "extras": [{"intitule": "nom court", "valeur": "valeur"}] — les infos restantes en paires étiquetées, CONCISES (6 paires max par produit, valeurs courtes) (ex: {"intitule":"Certification","valeur":"CE, EN71"}, {"intitule":"Piles","valeur":"2xAA non incluses"}, {"intitule":"Délai","valeur":"45 jours"}). Tableau vide si rien.
 "remarques": "UNIQUEMENT l'inclassable même avec une étiquette — la plupart du temps null"
}
DÉCOMPOSE LES CELLULES COMPOSITES — cas réels rencontrés dans nos fichiers :
- "Size: 45.1X22.9X123.8CM   950G" -> taille_produit: "45.1X22.9X123.8CM" ET poids_nb: "950G"
  (le poids unitaire est très souvent collé aux dimensions : des grammes ou kilos en fin de cellule Size = poids_nb, jamais ignoré)
- "Packing: 0/2 PCS/CTN/0.102CBM/3.599CFT" -> pcb: "2" ET volume_m3: "0.102" (l'inner avant le / s'il est non nul : "6/24 PCS/CTN" -> pcb "24 / 6")
- "Ctn Dim.: 108.0x25.5x37.0CM" ou "Carton size" ou "MEAS" -> colisage_cm
- "Price: FOB XIAMEN   $10.88/PC" -> prix: 10.88, devise: "USD", port: "XIAMEN"
- "N.W./G.W.: 8.5/9.6KGS" -> poids_nb: "8.5/9.6KG"
- "Loading: 20':554 PCS / 40':1148 PCS / 40'HQ:1274 PCS" -> extras [{"intitule":"Loading","valeur":"20':554 / 40':1148 / 40'HQ:1274"}]
- "QTY/CTN: 12PCS  CBM: 0.065" sur une même ligne -> pcb ET volume_m3
- DEUX prix « with EUDR » / « without EUDR » (produits bois, règlement européen anti-déforestation) :
  prends TOUJOURS le prix WITH EUDR comme "prix" (seul valable pour l'import UE),
  et range l'autre dans extras [{"intitule":"Prix without EUDR","valeur":"1.49"}]
Le même produit peut étaler ses infos sur PLUSIEURS lignes consécutives (bloc "Item No.:" vertical) :
tout ce qui est entre deux "Item No." appartient au même produit. Relis le bloc entier avant de conclure
qu'une info manque.

Règles impératives :
- La référence doit être recopiée CARACTÈRE PAR CARACTÈRE. Jamais inventée, jamais complétée.
- Deux références qui diffèrent d'un suffixe sont DEUX produits distincts (WH141445 ≠ WH141445B).
- Ignore les lignes d'entête, de conditions générales, de totaux.
- Si le fichier ne contient aucun produit identifiable, "produits" est [].`;

async function appelExtraction(contenu, nomFichier, avecPrefill) {
  const messages = [{ role: 'user', content: `Fichier : ${nomFichier}\n\n${contenu}` }];
  if (avecPrefill) messages.push({ role: 'assistant', content: '{' }); // amorce : réponse en JSON dès le 1er caractère
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODELE_EXTRACTION,
      max_tokens: 32000,
      system: [{ type: 'text', text: PROMPT_SYSTEME, cache_control: { type: 'ephemeral' } }],
      messages,
    }),
  });
}

async function extraireProduitsIAUnEssai(texteTsv, nomFichier) {
  if (!API_KEY) {
    return { produits: [], erreur: "ANTHROPIC_API_KEY manquante — extraction IA désactivée, fichier indexé en texte seul." };
  }
  // On tronque prudemment les très gros fichiers (l'essentiel des offres tient très en dessous)
  const contenu = texteTsv.length > 180000 ? texteTsv.slice(0, 180000) + '\n[... tronqué ...]' : texteTsv;
  let avecPrefill = PREFILL_OK;
  let reponse = await appelExtraction(contenu, nomFichier, avecPrefill);
  if (!reponse.ok) {
    const t = await reponse.text();
    if (reponse.status === 400 && /prefill/i.test(t)) {
      // ce modèle refuse l'amorce : on s'en souvient et on refait l'appel sans, immédiatement
      PREFILL_OK = false; avecPrefill = false;
      reponse = await appelExtraction(contenu, nomFichier, false);
      if (!reponse.ok) {
        const t2 = await reponse.text();
        return { produits: [], erreur: `API Anthropic ${reponse.status} : ${t2.slice(0, 300)}` };
      }
    } else {
      return { produits: [], erreur: `API Anthropic ${reponse.status} : ${t.slice(0, 300)}` };
    }
  }
  const data = await reponse.json();
  const texte = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  let propre = ((avecPrefill ? '{' : '') + texte).replace(/```json|```/g, '').trim(); // ré-attache l'amorce si utilisée
  // si du texte entoure le JSON, vise l'OBJET RACINE par ses clés (pas le premier { venu :
  // la prose peut citer un petit objet d'exemple avant le vrai résultat)
  if (!/^\{\s*"(nature|produits|motif)"/.test(propre)) {
    let ancre = -1;
    for (const cle of ['"nature"', '"produits"', '"motif"']) {
      const i = propre.indexOf(cle);
      if (i !== -1 && (ancre === -1 || i < ancre)) ancre = i;
    }
    if (ancre !== -1) {
      const debut = propre.lastIndexOf('{', ancre);
      if (debut !== -1) propre = propre.slice(debut);
    }
  }
  try {
    let rep;
    let repare = false;
    try { rep = JSON.parse(propre); }
    catch (e1) {
      // réponse vraisemblablement tronquée (plafond de tokens) : on sauve les produits complets
      const sauve = reparerJsonTronque(propre);
      if (!sauve) throw e1;
      rep = sauve; repare = true;
    }
    if (repare) rep.erreur_partielle = `Réponse IA tronquée — ${rep.produits.length} produit(s) récupéré(s), le fichier peut en contenir davantage. Redépose-le via « reclasser » si besoin.`;
    if (Array.isArray(rep)) return { nature: 'offre', motif: null, produits: rep }; // tolérance ancien format
    return { nature: rep.nature === 'interne' ? 'interne' : 'offre', motif: rep.motif || null,
             produits: Array.isArray(rep.produits) ? rep.produits : [], erreur_partielle: rep.erreur_partielle };
  } catch (e) {
    return { nature: 'offre', produits: [], erreur: `Réponse IA illisible : ${propre.slice(0, 160)}` };
  }
}

/** Filet déterministe : rejette/annote ce que l'IA aurait halluciné */
/** Répare un JSON tronqué en plein vol : coupe au dernier produit complet et referme. */
function reparerJsonTronque(txt) {
  const i = txt.indexOf('"produits"');
  if (i === -1) return null;
  const crochet = txt.indexOf('[', i);
  if (crochet === -1) return null;
  // parcourir les objets produits complets
  let profondeur = 0, dansChaine = false, echappe = false, finDernier = -1;
  for (let j = crochet + 1; j < txt.length; j++) {
    const c = txt[j];
    if (echappe) { echappe = false; continue; }
    if (c === '\\') { echappe = true; continue; }
    if (c === '"') { dansChaine = !dansChaine; continue; }
    if (dansChaine) continue;
    if (c === '{') profondeur++;
    else if (c === '}') { profondeur--; if (profondeur === 0) finDernier = j; }
  }
  if (finDernier === -1) return null;
  const tentative = txt.slice(0, crochet + 1) + txt.slice(crochet + 1, finDernier + 1) + ']}';
  try {
    const rep = JSON.parse(tentative);
    return rep && Array.isArray(rep.produits) && rep.produits.length ? rep : null;
  } catch { return null; }
}

function verifierProduits(produits, texteBrut) {
  const gardes = [];
  const rejets = [];
  for (const p of produits) {
    const avert = [];
    if (!p.reference || typeof p.reference !== 'string' || p.reference.trim().length < 2
        || /^\d{1,3}$/.test(p.reference.trim())) {
      // offre sans référence usine : on garde le produit, l'app créera une référence provisoire
      p.reference = null;
      p.sans_ref = true;
      avert.push("l'offre ne donne pas de référence usine — référence provisoire créée par l'app, à remplacer si l'usine en fournit une");
      gardes.push(Object.assign(p, { avertissements: avert }));
      continue;
    }
    p.reference = p.reference.trim();
    if (p.port) {
      p.port = String(p.port).replace(/^\s*FOB\s*/i, '').trim();
      if (!p.port || /^FOB$/i.test(p.port)) { p.port = null; }
    }
    if (!refPresente(texteBrut, p.reference)) {
      // pas de rejet automatique : la fiche est créée AVEC alerte, l'opérateur tranche à l'import (🗑 pour refuser)
      p.suspecte = true;
      avert.push(`référence non retrouvée telle quelle dans le fichier — possible erreur de lecture IA : vérifie dans l'aperçu 👁, corrige via ✎ ou refuse via 🗑`);
    }
    if (p.prix != null && p.prix !== '' && !String(texteBrut).includes(String(p.prix).replace(',', '.').replace(/\.0$/, ''))
        && !String(texteBrut).includes(String(p.prix))) {
      avert.push(`prix "${p.prix}" non retrouvé à l'identique dans le fichier — à vérifier`);
    }
    p.avertissements = avert;
    gardes.push(p);
  }
  return { gardes, rejets };
}

const PROMPT_ASSISTANT = `Tu es l'assistant de recherche de la base produits de Flaudis (importateur
pour Système U). On te donne le catalogue (une ligne par fiche : id, référence, fournisseur, prix,
matière, description en anglais) et une question d'opérateur, souvent en français.

Ta mission : retrouver les fiches qui répondent à la question. Pense traduction (panier en osier =
wicker basket), synonymes, catégories implicites (« pour animaux » couvre niches, gamelles...),
critères chiffrés (prix, dimensions). N'invente jamais d'id : uniquement ceux du catalogue.

Réponds UNIQUEMENT par un objet JSON, sans texte autour, sans balises markdown :
{
 "ids": [liste des id des fiches pertinentes, du plus au moins pertinent, max 40],
 "reponse": "une phrase courte en français qui résume ce que tu as trouvé (ou pas trouvé)"
}`;

async function repondreAssistant(question, catalogueTsv) {
  if (!API_KEY) return { ids: [], reponse: null, erreur: 'ANTHROPIC_API_KEY manquante' };
  const contenu = catalogueTsv.length > 350000 ? catalogueTsv.slice(0, 350000) + '\n[... tronqué ...]' : catalogueTsv;
  const reponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODELE, max_tokens: 1500, system: PROMPT_ASSISTANT,
      messages: [{ role: 'user', content: `CATALOGUE :\n${contenu}\n\nQUESTION : ${question}` }],
    }),
  });
  if (!reponse.ok) return { ids: [], reponse: null, erreur: `API ${reponse.status}` };
  const data = await reponse.json();
  const texte = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  try {
    const rep = JSON.parse(texte.replace(/```json|```/g, '').trim());
    return { ids: (rep.ids || []).map(Number).filter(Boolean), reponse: rep.reponse || null };
  } catch { return { ids: [], reponse: null, erreur: 'Réponse IA non-JSON' }; }
}

/** Interprète une mise à jour de sélection en texte libre (mail, consigne, extrait de tableau)
    -> opérations structurées sur le tableau. */
async function interpreterMaj(texte, refsActuelles, contexte) {
  const lignesCtx = Array.isArray(contexte) && contexte.length
    ? '\nVALEURS ACTUELLES (REF | FOB NET | FOB COM | PORT | QTE FINALE) :\n' + contexte.map(c => `${c.ref} | ${c.fob_net ?? '?'} | ${c.fob_com ?? '?'} | ${c.port || '?'} | ${c.final ?? '?'}`).join('\n')
    : '';
  const prompt = `Tu gères un tableau de sélection de produits (import Chine pour la grande distribution).
Références ACTUELLEMENT dans le tableau :
${refsActuelles.join(', ')}
${lignesCtx}

Voici une mise à jour reçue (mail, message ou extrait de document) :
---
${String(texte).slice(0, 12000)}
---
Détermine les opérations à appliquer au tableau. Réponds UNIQUEMENT en JSON strict :
{"operations":[{"op":"retirer"|"ajouter"|"modifier"|"noter","ref":"RÉFÉRENCE EXACTE","champ":"pour modifier","valeur":"pour modifier","detail":"raison courte"}],
 "resume":"une phrase en français résumant la mise à jour"}
Règles : "retirer" = le produit quitte la sélection ; "ajouter" = une nouvelle référence entre en sélection ;
"modifier" = changer UNE valeur d'une référence déjà au tableau. "champ" parmi :
fob_net (prix FOB net usine — un changement de prix sans autre précision = fob_net), fob_com (prix avec commission),
ddp, description, code_douanier, kd, product_size (dimensions), pcb_cat (pièces par carton), packing (colisage),
volume, nwgw (poids), taxe, port, promotion, final (quantité finale), sav.
"valeur" = la nouvelle VALEUR FINALE (nombre pur pour prix/quantités, sans devise, jamais une formule).
Si le texte exprime une VARIATION (« monte de 1$ », « +0.50 », « baisse de 5% »), CALCULE la valeur finale
à partir de la valeur actuelle fournie ci-dessus (ex : FOB NET actuel 12.30, « monte de 1$ » -> valeur 13.30).
"noter" = information à consigner sans toucher au tableau (date, doute, contexte…).
Pour "retirer" et "modifier", la ref DOIT être une des références actuelles (recopie-la exactement, même orthographe).
N'invente RIEN : si la mise à jour est ambiguë ou ne concerne pas la composition, renvoie des opérations "noter".`;
  const reponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODELE, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!reponse.ok) return { operations: [], resume: null, erreur: 'IA indisponible (' + reponse.status + ')' };
  const data = await reponse.json();
  let j = null;
  try { j = JSON.parse((data.content?.[0]?.text || '').replace(/```json|```/g, '').trim()); }
  catch { try { j = JSON.parse(reparerJsonTronque((data.content?.[0]?.text || '').replace(/```json|```/g, '').trim())); } catch {} }
  if (!j || !Array.isArray(j.operations)) return { operations: [], resume: null, erreur: 'Réponse IA illisible' };
  const setRefs = new Set(refsActuelles);
  for (const o of j.operations)
    if ((o.op === 'retirer' || o.op === 'modifier') && !setRefs.has(o.ref)) { o.op = 'noter'; o.detail = `(réf « ${o.ref} » introuvable dans le tableau) ${o.detail || ''}`; }
  return j;
}

async function extraireInfosUsine(nomUsine, morceaux) {
  const prompt = `Voici des extraits de fichiers d'offres de l'usine « ${nomUsine} » (import Chine).
Les coordonnées peuvent se trouver n'importe où : entête, pied de page, colonne isolée, dernière feuille.
---
${morceaux.join('\n\n').slice(0, 16000)}
---
Extrais les informations de CETTE usine. Réponds UNIQUEMENT en JSON strict :
{"adresse":"adresse postale complète ou null","contact":"nom de la personne ou null","telephone":"tél/mobile/fax ou null",
 "email":"ou null","messagerie":"WeChat/WhatsApp/QQ ou null","site":"site web ou null",
 "port":"port FOB de chargement (NINGBO, XIAMEN...) ou null",
 "conditions":"MOQ, conditions de paiement, délais s'ils sont indiqués, en une phrase, ou null"}
N'invente RIEN : null si l'information n'apparaît pas. Ignore les coordonnées de Flaudis/JML (le client français).`;
  const reponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODELE, max_tokens: 900, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!reponse.ok) return { erreur: 'IA indisponible (' + reponse.status + ')' };
  const data = await reponse.json();
  try { return JSON.parse((data.content?.[0]?.text || '').replace(/```json|```/g, '').trim()); }
  catch { return { erreur: 'Réponse IA illisible' }; }
}

async function extraireProduitsIA(texteTsv, nomFichier) {
  const essai1 = await extraireProduitsIAUnEssai(texteTsv, nomFichier);
  if (!essai1.erreur || !/illisible/i.test(essai1.erreur)) return essai1;
  // réponse illisible : on retente une fois (les modèles dérapent rarement deux fois de suite)
  const essai2 = await extraireProduitsIAUnEssai(texteTsv, nomFichier);
  if (essai2.erreur && /illisible/i.test(essai2.erreur)) essai2.erreur = 'Lecture IA échouée (2 tentatives) — réponse hors format. Utilise « ↺ Relancer l\'analyse » : ' + essai2.erreur.slice(0, 140);
  return essai2;
}

/** Rédige les désignations produit en FRANÇAIS selon le gabarit maison Flaudis. */
async function redigerDesignations(produits) {
  if (!process.env.ANTHROPIC_API_KEY) return { erreur: 'ANTHROPIC_API_KEY manquante' };
  const { CONSIGNE_DESIGNATION } = require('./offre');
  const rep = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODELE_EXTRACTION, max_tokens: 8000,
      system: `Tu rédiges les désignations produit d'un importateur français (bazar/jardin/Noël) pour une offre à la grande distribution. Les descriptions sources viennent des usines chinoises, souvent en anglais : tout doit sortir en FRANÇAIS commercial correct.
${CONSIGNE_DESIGNATION}
Pas d'invention : si une info (matériau, montage…) n'est pas dans la source, ne la mentionne pas. Pas de mention de prix (les tarifs ne sont pas encore fixés).
Format de chaque désignation : 1re ligne = LIBELLÉ COURT EN CAPITALES + dimensions ; à la ligne : le descriptif complet en une phrase fluide.
Réponds UNIQUEMENT en JSON strict commençant par { : {"designations": {"<reference>": "<désignation>", ...}}`,
      messages: [{ role: 'user', content: JSON.stringify(produits) }],
    }),
  });
  if (!rep.ok) return { erreur: 'API Anthropic ' + rep.status };
  const texte = ((await rep.json()).content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let propre = texte.replace(/```json|```/g, '').trim();
  const a = propre.indexOf('{');
  if (a > 0) propre = propre.slice(a);
  try { return JSON.parse(propre); } catch (e) { return { erreur: 'Réponse IA illisible : ' + e.message }; }
}

/** Cartographie un modèle d'offre U : plan de remplissage colonne par colonne, validé ensuite par l'opérateur. */
async function cartographierModeleU(digest) {
  if (!process.env.ANTHROPIC_API_KEY) return { erreur: 'ANTHROPIC_API_KEY manquante' };
  const rep = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODELE_EXTRACTION, max_tokens: 20000,
      system: `Tu cartographies un modèle Excel d'offre fourni par un client de la grande distribution française (Système U) à son fournisseur (Flaudis, importateur de produits de bazar/jardin/Noël).
Le fournisseur devra remplir UNE LIGNE PAR PRODUIT dans la feuille principale. Ton travail : dire pour CHAQUE colonne documentée d'où viendra la valeur.
Sources possibles (vocabulaire FERMÉ pour "source") :
- "reference" (réf produit du fournisseur), "ean" (GTIN EAN13 de l'UVC), "ancien_ean", "description", "designation_courte" (libellé capitales + dimensions, cf exemples), "code_douanier" (TARIC 10 chiffres), "pays_origine", "fournisseur", "marque", "pcb" (nb UVC par colis), "poids_net_uvc", "poids_brut_colis", "volume_net_uvc", "dimensions_produit_mm", "dimensions_colis_mm", "garantie_mois", "date_dispo", "conditionnement" (COLIS/CARTON, BOX, PRESENTOIR…), "prix:operateur" (tarifs décidés en interne — à saisir par l'opérateur)
- "extras:<intitulé>" : info à chercher dans les caractéristiques annexes des fiches (ex: "extras:piles", "extras:certificat")
- "ia:<précision>" : à déduire par IA depuis la fiche (ex: "ia:piles oui/non", "ia:nombre de piles")
- "calcul:palette" : nb de colis par palette Europe 80x120 (calcul d'empilage)
- "operateur" : décision humaine, à saisir
- "vide" : à laisser vide
- "ignorer" : colonne interne du client (mentions "SUPP", zone de calcul…), ne pas toucher
Réponds UNIQUEMENT en JSON strict, ta réponse COMMENCE par { :
{"ligne_debut": <n° de la 1re ligne où écrire les produits (après les exemples du fournisseur s'il y en a)>,
 "colonnes":[{"col":<n°>,"entete":"résumé court","source":"<du vocabulaire>","format":"contrainte de format ou valeur de liste autorisée si pertinent","note":"subtilité éventuelle"}],
 "ignorees":[<n°s des colonnes à ignorer>],
 "photos":{"col":<n° colonne visuel ou null>,"consignes":"résumé des consignes photos"},
 "incertitudes":["points où tu hésites, à trancher par l'opérateur"]}
Règles : les colonnes listées dans "ignorees" n'apparaissent PAS dans "colonnes". Utilise les listes déroulantes autorisées pour "format" (recopie la valeur exacte, ex "CHN - Chine"). Sois exhaustif : chaque COL documentée est soit dans "colonnes", soit dans "ignorees".
IMPORTANT : le modèle arrive normalement VIERGE (sans lignes d'exemple). Si des exemples remplis apparaissent quand même dans le digest, sers-t'en pour calibrer style et formats. Dans tous les cas, distingue bien :
- "vide" = manifestement NON APPLICABLE à des produits bazar/jardin/Noël importés (DLC produits frais, précurseurs d'explosifs, EAN de palette qu'un importateur n'a pas…) — sois volontariste ici, chaque colonne inutile épargnée est du temps gagné ;
- "operateur" / "prix:operateur" = une VRAIE décision humaine récurrente (tarifs, remises négociées, échantillon oui/non) ;
- au moindre doute entre les deux, choisis "vide" et signale-le dans "incertitudes" : le tableau reste modifiable après coup.`,
      messages: [{ role: 'user', content: digest }],
    }),
  });
  if (!rep.ok) return { erreur: 'API Anthropic ' + rep.status };
  const texte = ((await rep.json()).content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let propre = texte.replace(/```json|```/g, '').trim();
  const a = propre.indexOf('{');
  if (a > 0) propre = propre.slice(a);
  try {
    const j = JSON.parse(propre);
    if (!Array.isArray(j.colonnes)) return { erreur: 'Plan illisible (pas de colonnes)' };
    return j;
  } catch (e) { return { erreur: 'Réponse IA illisible : ' + e.message }; }
}

/** Propose des codes douaniers TARIC (UE) pour des produits jardin sans code. */
async function proposerCodesDouaniers(produits) {
  if (!process.env.ANTHROPIC_API_KEY) return { propositions: [], erreur: 'ANTHROPIC_API_KEY manquante' };
  const liste = produits.map(p => `- ref: ${p.ref} | description: ${p.description || '?'} | matiere: ${p.matiere || '?'} | dimensions: ${p.taille || '?'} | poids: ${p.poids || '?'}${p.extras ? ' | caractéristiques: ' + p.extras : ''}${p.remarques ? ' | remarques: ' + p.remarques : ''}`).join('\n');
  const rep = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODELE, max_tokens: 8000,
      system: `Tu es un spécialiste du classement tarifaire douanier de l'Union européenne (nomenclature TARIC).
On te donne des produits de jardin importés de Chine/Vietnam pour la grande distribution française.
Pour CHACUN, propose le code TARIC à 10 chiffres le plus probable.
Réponds UNIQUEMENT en JSON strict, ta réponse COMMENCE par { :
{"propositions":[{"ref":"...","code":"10 chiffres sans espaces","libelle":"intitulé officiel court de la position, en français","confiance":"haute"|"moyenne"|"faible","raison":"1 phrase : pourquoi ce code (matière/fonction déterminante)","manque":"si confiance non haute : QUELLE info précise permettrait de trancher (ex : matière exacte du plateau, électrifié ou non), sinon null"}]}
Règles : la matière constitutive et la fonction priment ; produits solaires d'éclairage -> 9405 41/42 ; céramique déco -> 6913 ; bois -> chap. 44/46 ; acier -> 73 ; plastique -> 39 ; textile jardin -> chap. 63 ; outils -> 82. Si tu hésites entre deux chapitres, confiance "faible" et dis l'alternative dans raison.`,
      messages: [{ role: 'user', content: liste }],
    }),
  });
  if (!rep.ok) return { propositions: [], erreur: 'API Anthropic ' + rep.status };
  const texte = ((await rep.json()).content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let propre = texte.replace(/```json|```/g, '').trim();
  const a = propre.indexOf('{"propositions"') !== -1 ? propre.indexOf('{"propositions"') : propre.indexOf('{');
  if (a > 0) propre = propre.slice(a);
  try { const j = JSON.parse(propre); return { propositions: Array.isArray(j.propositions) ? j.propositions : [] }; }
  catch { return { propositions: [], erreur: 'Réponse IA illisible' }; }
}

module.exports = {
  redigerDesignations,
  cartographierModeleU,
  proposerCodesDouaniers, extraireProduitsIA, verifierProduits, repondreAssistant, interpreterMaj, extraireInfosUsine };
