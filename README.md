# Cockpit Creatikk
Tableau de bord business en direct (Stripe + PostHog). Node pur, sans dépendance.

## Variables d'environnement (Render)
- `STRIPE_KEY` — clé restreinte Stripe **lecture seule** (`rk_live_…`)
- `POSTHOG_KEY` — clé perso PostHog **lecture** (`phx_…`)
- `POSTHOG_PROJECT` — id projet (219725)
- `POSTHOG_HOST` — `eu.posthog.com`
- `COCKPIT_PASSWORD` — mot de passe d'accès (user = `creatikk`)

## Démarrage
`npm start` (ou `node server.js`) — écoute sur `$PORT` (défaut 3200).
