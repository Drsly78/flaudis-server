// lib/db.js — base SQLite (fichier unique sur le volume persistant Railway)
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'fichiers'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'images'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'flaudis.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON'); // suppressions en cascade effectives
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS fichiers (
  id INTEGER PRIMARY KEY,
  nom TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,          -- dédoublonnage : même fichier déposé 2x = ignoré
  taille INTEGER,
  type TEXT,                          -- xlsx | xls | pptx | msg | pdf | autre
  depose_le TEXT DEFAULT (datetime('now','localtime')),
  statut TEXT DEFAULT 'ok',           -- ok | avertissements | erreur
  rapport TEXT                        -- JSON du rapport d'ingestion
);
CREATE TABLE IF NOT EXISTS produits (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL,
  fichier_id INTEGER NOT NULL REFERENCES fichiers(id) ON DELETE CASCADE,
  feuille TEXT, ligne INTEGER,
  fournisseur TEXT, description TEXT, taille_produit TEXT, matiere TEXT,
  pcb TEXT, colisage_cm TEXT, volume_m3 TEXT, poids_nb TEXT,
  prix TEXT, devise TEXT, port TEXT, moq TEXT, code_hs_usine TEXT,
  kd INTEGER DEFAULT 0,
  remarques TEXT,
  avertissements TEXT,                -- JSON [] : contrôles non passés
  extrait_le TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_produits_ref ON produits(reference);
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY,
  fichier_id INTEGER NOT NULL REFERENCES fichiers(id) ON DELETE CASCADE,
  produit_id INTEGER REFERENCES produits(id) ON DELETE SET NULL,
  hash TEXT NOT NULL,
  chemin TEXT NOT NULL,               -- relatif à DATA_DIR/images
  feuille TEXT, ligne_ancrage INTEGER,
  ambigue INTEGER DEFAULT 0           -- 1 si l'ancrage ne tombe pas pile sur une ligne produit
);
CREATE INDEX IF NOT EXISTS idx_images_hash ON images(hash);
-- texte brut indexé de chaque fichier (pour la "chasse" plein-texte, y compris pptx/msg)
CREATE TABLE IF NOT EXISTS textes (
  fichier_id INTEGER PRIMARY KEY REFERENCES fichiers(id) ON DELETE CASCADE,
  contenu TEXT
);

-- listes de sélection (préparation d'offres)
`);
db.exec(`
CREATE TABLE IF NOT EXISTS listes (
  id INTEGER PRIMARY KEY,
  nom TEXT NOT NULL,
  creee_le TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS liste_items (
  id INTEGER PRIMARY KEY,
  liste_id INTEGER NOT NULL REFERENCES listes(id) ON DELETE CASCADE,
  produit_id INTEGER NOT NULL REFERENCES produits(id) ON DELETE CASCADE,
  ajoute_le TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(liste_id, produit_id)
);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS doublons_valides (
  reference TEXT PRIMARY KEY,
  signature TEXT NOT NULL,           -- ids des fiches au moment de la validation
  valide_le TEXT DEFAULT (datetime('now','localtime'))
);
`);
// migration douce : colonne dossier sur les bases déjà créées
try { db.exec("ALTER TABLE fichiers ADD COLUMN dossier TEXT NOT NULL DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE fichiers ADD COLUMN mode TEXT NOT NULL DEFAULT 'offre'"); } catch (e) {}
try { db.exec("ALTER TABLE produits ADD COLUMN dossier TEXT"); } catch (e) {} // classement libre des fiches

module.exports = { db, DATA_DIR };
