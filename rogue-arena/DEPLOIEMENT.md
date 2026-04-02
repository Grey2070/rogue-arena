# Rogue Arena — Déploiement Multijoueur

## Prérequis
- Node.js 18+
- npm

## Installation locale
```bash
npm install
node server.js
# Serveur disponible sur ws://localhost:8080
```

## Déploiement gratuit sur Railway

1. Créer un compte sur https://railway.app
2. "New Project" → "Deploy from GitHub repo"
3. Pousser les fichiers sur GitHub :
   ```
   arena-iso-game.html
   server.js
   package.json
   ```
4. Railway détecte automatiquement Node.js et lance `npm start`
5. Récupérer l'URL publique (ex: `rogue-arena.up.railway.app`)
6. Dans `arena-iso-game.html`, modifier la ligne SERVER_URL :
   ```javascript
   return 'wss://rogue-arena.up.railway.app';
   ```

## Déploiement sur Render (alternative gratuite)

1. https://render.com → "New Web Service"
2. Connecter GitHub, choisir le repo
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Plan: Free (512MB RAM, suffisant pour ~200 joueurs)

## Déploiement sur Fly.io

```bash
npm install -g flyctl
fly launch
fly deploy
```

## Configuration HTTPS/WSS

En production, le serveur doit utiliser WSS (WebSocket Secure).
Railway et Render gèrent le SSL automatiquement.
L'URL devient : `wss://ton-domaine.up.railway.app`

## Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| PORT | 8080 | Port du serveur |

## Capacité estimée

| Plan | RAM | Joueurs simultanés |
|------|-----|-------------------|
| Railway Free | 512MB | ~150-200 |
| Render Free | 512MB | ~150-200 |
| Fly.io Free | 256MB | ~80-100 |
| VPS basique (5$/mois) | 1GB | ~500+ |

## Architecture

```
Client (navigateur) ──WS──► Serveur Node.js
                              │
                              ├── Matchmaking (file 1v1 / 2v2)
                              ├── Rooms (état des parties)
                              └── Timeout 60s → IA de remplacement
```

## Cross-plateforme

Le jeu fonctionne sur PC et mobile via navigateur.
Même URL, même serveur, matchmaking cross-plateforme natif.

Pour une PWA (installation sur écran d'accueil mobile) :
Ajouter dans le <head> de arena-iso-game.html :
```html
<link rel="manifest" href="manifest.json">
<meta name="theme-color" content="#050e18">
```
