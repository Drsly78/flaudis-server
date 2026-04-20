# SAV Server

Serveur proxy pour l'add-in Outlook SAV Analyser.

## Variables d'environnement à configurer sur Railway

- `ANTHROPIC_API_KEY` : ta clé API Claude (sk-ant-...)
- `APP_SECRET` : un mot de passe secret partagé avec l'add-in (choisis ce que tu veux)

## Déploiement

1. Push ce dossier sur un repository GitHub
2. Connecte le repo à Railway
3. Ajoute les variables d'environnement
4. Railway lance le serveur automatiquement

## Test

GET /health → {"status": "ok"}
