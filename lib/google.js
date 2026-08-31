// lib/google.js — Drive/Sheets en deux modes : OAuth (ton Drive, recommandé) ou compte de service (Workspace)
const crypto = require('crypto');

let cache = { token: null, expire: 0, mode: null };
let params = { lire: () => null, ecrire: () => {} }; // injecté par le serveur (stockage du refresh token)

function configurer(p) { params = p; }

function cleSA() {
  const brut = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!brut) return null;
  try { const j = JSON.parse(brut); return (j.client_email && j.private_key) ? j : null; } catch { return null; }
}
function oauthPret() {
  return !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && params.lire('google_refresh_token'));
}
function oauthConfigurable() {
  return !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}
function mode() {
  if (oauthPret()) return 'oauth';
  if (cleSA()) return 'sa';
  return null;
}
function dispo() { return mode() !== null; }

const b64u = (x) => Buffer.from(x).toString('base64url');

async function jetonAcces() {
  const m = mode();
  if (!m) throw new Error(oauthConfigurable()
    ? "connexion Google requise — ouvre /google/connexion pour autoriser l'app sur ton Drive."
    : "Google n'est pas configuré (variables GOOGLE_OAUTH_CLIENT_ID et GOOGLE_OAUTH_CLIENT_SECRET).");
  if (cache.token && cache.mode === m && Date.now() < cache.expire) return cache.token;
  let rep;
  if (m === 'oauth') {
    rep = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
        refresh_token: params.lire('google_refresh_token'),
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (rep.status === 400 || rep.status === 401) {
      params.ecrire('google_refresh_token', null); // token révoqué : on redemandera la connexion
      throw new Error("connexion Google requise — l'autorisation a expiré, ouvre /google/connexion.");
    }
  } else {
    const k = cleSA();
    const maintenant = Math.floor(Date.now() / 1000);
    const entete = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const corps = b64u(JSON.stringify({ iss: k.client_email, scope: 'https://www.googleapis.com/auth/drive',
      aud: 'https://oauth2.googleapis.com/token', iat: maintenant, exp: maintenant + 3500 }));
    const signeur = crypto.createSign('RSA-SHA256');
    signeur.update(entete + '.' + corps);
    const signature = signeur.sign(k.private_key).toString('base64url');
    rep = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${entete}.${corps}.${signature}`,
    });
  }
  if (!rep.ok) throw new Error('Auth Google refusée (' + rep.status + ') : ' + (await rep.text()).slice(0, 200));
  const d = await rep.json();
  cache = { token: d.access_token, expire: Date.now() + 50 * 60 * 1000, mode: m };
  return cache.token;
}

/** Échange le code de retour OAuth contre les tokens ; enregistre le refresh token. */
async function echangerCode(code, redirectUri) {
  const rep = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      code, grant_type: 'authorization_code', redirect_uri: redirectUri,
    }).toString(),
  });
  if (!rep.ok) throw new Error('Échange OAuth refusé (' + rep.status + ') : ' + (await rep.text()).slice(0, 250));
  const d = await rep.json();
  if (!d.refresh_token) throw new Error("Google n'a pas renvoyé de refresh token — retente la connexion (l'écran doit redemander le consentement).");
  params.ecrire('google_refresh_token', d.refresh_token);
  cache = { token: d.access_token, expire: Date.now() + 50 * 60 * 1000, mode: 'oauth' };
  return true;
}

function urlConnexion(redirectUri) {
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file',
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
}

let dossierCache = null;
/** En mode OAuth : les fichiers éphémères vont dans un dossier dédié de TON Drive. */
async function assurerDossier(token) {
  if (mode() !== 'oauth') return null;
  if (dossierCache) return dossierCache;
  const q = encodeURIComponent("name='Flaudis — temporaire' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const rep = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, { headers: { authorization: 'Bearer ' + token } });
  if (rep.ok) {
    const d = await rep.json();
    if (d.files && d.files.length) { dossierCache = d.files[0].id; return dossierCache; }
  }
  const cr = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Flaudis — temporaire', mimeType: 'application/vnd.google-apps.folder' }),
  });
  if (!cr.ok) return null;
  dossierCache = (await cr.json()).id;
  return dossierCache;
}

async function creerSheetDepuisXlsx(buffer, nom) {
  const token = await jetonAcces();
  const dossier = await assurerDossier(token);
  const frontiere = 'flaudis' + Date.now();
  const meta = JSON.stringify({ name: nom, mimeType: 'application/vnd.google-apps.spreadsheet', ...(dossier ? { parents: [dossier] } : {}) });
  const corps = Buffer.concat([
    Buffer.from(`--${frontiere}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${frontiere}\r\ncontent-type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${frontiere}--`),
  ]);
  const rep = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': `multipart/related; boundary=${frontiere}` },
    body: corps,
  });
  if (!rep.ok) {
    const txt = (await rep.text()).slice(0, 250);
    if (rep.status === 403 && /quota/i.test(txt))
      throw new Error("le compte de service n'a pas de stockage Drive (politique Google) — passe en connexion OAuth : /google/connexion");
    throw new Error('Création du Sheet refusée (' + rep.status + ') : ' + txt);
  }
  const d = await rep.json();
  return { id: d.id, url: `https://docs.google.com/spreadsheets/d/${d.id}/edit` };
}

/** OAuth : ton Drive, rien à partager. SA : partage à l'email configuré ou au lien. */
async function partager(fileId, modeRole) {
  if (mode() === 'oauth') return;
  const token = await jetonAcces();
  const email = (process.env.GOOGLE_PARTAGE_EMAIL || '').trim();
  const perm = email ? { role: modeRole, type: 'user', emailAddress: email } : { role: modeRole, type: 'anyone' };
  const rep = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(perm),
  });
  if (!rep.ok) throw new Error('Partage refusé (' + rep.status + ') : ' + (await rep.text()).slice(0, 200));
}

async function exporterXlsx(fileId) {
  const token = await jetonAcces();
  const rep = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}`, {
    headers: { authorization: 'Bearer ' + token },
  });
  if (!rep.ok) throw new Error('Export du Sheet refusé (' + rep.status + ')');
  return Buffer.from(await rep.arrayBuffer());
}

async function supprimer(fileId) {
  const token = await jetonAcces();
  const rep = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE', headers: { authorization: 'Bearer ' + token },
  });
  if (!rep.ok && rep.status !== 404) throw new Error('Suppression Drive refusée (' + rep.status + ')');
}

module.exports = { configurer, dispo, mode, oauthConfigurable, urlConnexion, echangerCode, creerSheetDepuisXlsx, partager, exporterXlsx, supprimer };
