# Astro on Netlify Platform Starter

[Live Demo](https://astro-platform-starter.netlify.app/)

A modern starter based on Astro.js, Tailwind, and [Netlify Core Primitives](https://docs.netlify.com/core/overview/#develop) (Edge Functions, Image CDN, Blobs).

## Astro Commands

All commands are run from the root of the project, from a terminal:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build your production site to `./dist/`          |
| `npm run preview`         | Preview your build locally, before deploying     |
| `npm run astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `npm run astro -- --help` | Get help using the Astro CLI                     |

## Quote automatiche (Batti il Banco)

Il pulsante ⟳ accanto alla closing odds di una giocata recupera le quote correnti da [The Odds API](https://the-odds-api.com) tramite l'endpoint `/api/odds`. Per attivarlo:

1. Registrati su The Odds API e copia la tua chiave.
2. Su Netlify: **Site configuration → Environment variables → Add a variable**
    - `ODDS_API_KEY` = la chiave (obbligatoria)
    - `ODDS_BOOKMAKER` = book di riferimento iniziale, `pinnacle` se non impostata (facoltativa)
3. Rideploya il sito.

Senza `ODDS_API_KEY` l'app resta pienamente funzionante e il pulsante spiega che la funzione non è configurata.

Il bookmaker di riferimento si sceglie anche dal menu dentro la finestra delle quote, che elenca i book realmente disponibili per quel campionato e ricorda la scelta sul dispositivo: `ODDS_BOOKMAKER` serve solo a fissare il valore di partenza.

Ogni campionato richiede una sola chiamata all'API, che scarica tutti i bookmaker della regione (il costo in crediti non dipende dal loro numero): cambiare book di riferimento non consuma crediti aggiuntivi. Le risposte restano in cache per due minuti, l'elenco dei campionati per sei ore.

## Deploying to Netlify

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/netlify-templates/astro-platform-starter)

## Developing Locally

| Prerequisites                                                                |
| :--------------------------------------------------------------------------- |
| [Node.js](https://nodejs.org/) v18.20.8+.                                    |
| (optional) [nvm](https://github.com/nvm-sh/nvm) for Node version management. |

1. Clone this repository, then run `npm install` in its root directory.

2. Recommended: link your local repository to a Netlify project. This will ensure you're using the same runtime version for both local development and your deployed project.

```
netlify link
```

3. Run the Astro.js development server:

```
npm run dev
```
