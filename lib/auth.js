// lib/auth.js — protection par mot de passe (variable MOT_DE_PASSE sur Railway).
// Sans variable définie (dev local), l'app reste ouverte.
const crypto = require('crypto');

const MDP = process.env.MOT_DE_PASSE || '';
const SECRET = crypto.createHash('sha256').update('flaudis|' + MDP).digest();

const signer = (val) => crypto.createHmac('sha256', SECRET).update(val).digest('hex');
const jetonValide = (jeton) => {
  if (!jeton) return false;
  const [val, sig] = jeton.split('.');
  if (!val || !sig) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(signer(val)), Buffer.from(sig));
  } catch { return false; }
};

const PAGE_CONNEXION = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Flaudis — Connexion</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#16233b;font-family:-apple-system,"Segoe UI",Arial,sans-serif}
form{background:#fff;border-radius:14px;padding:36px 40px;box-shadow:0 8px 40px rgba(0,0,0,.4);text-align:center;width:min(92vw,360px)}
h1{font-size:16px;letter-spacing:.14em;color:#16233b;margin:0 0 4px}
p{color:#67708a;font-size:13px;margin:0 0 20px}
input{width:100%;box-sizing:border-box;font-size:17px;padding:11px 14px;border:1.5px solid #d5dae4;border-radius:8px;text-align:center}
input:focus{outline:3px solid #ffd400;border-color:#ffd400}
button{margin-top:14px;width:100%;padding:11px;background:#ffd400;border:none;border-radius:8px;font-weight:700;font-size:14.5px;color:#4a3a00;cursor:pointer}
.err{color:#c8511b;font-size:13px;margin-top:10px}</style></head><body>
<form method="POST" action="/connexion">
  <h1>FLAUDIS</h1><p>Base produits — accès protégé</p>
  <input type="password" name="mdp" placeholder="Mot de passe" autofocus>
  <button>Entrer</button>__ERREUR__
</form></body></html>`;

function proteger(app, express) {
  if (!MDP) return; // dev local sans mot de passe
  app.use(express.urlencoded({ extended: false }));
  app.post('/connexion', (req, res) => {
    if ((req.body.mdp || '') === MDP) {
      const val = Date.now().toString(36);
      res.setHeader('Set-Cookie',
        `flaudis=${val}.${signer(val)}; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}; Path=/`);
      return res.redirect('/');
    }
    res.status(401).send(PAGE_CONNEXION.replace('__ERREUR__', '<div class="err">Mot de passe incorrect</div>'));
  });
  app.use((req, res, next) => {
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')));
    if (jetonValide(cookies.flaudis)) return next();
    res.status(401).send(PAGE_CONNEXION.replace('__ERREUR__', ''));
  });
}

module.exports = { proteger };
