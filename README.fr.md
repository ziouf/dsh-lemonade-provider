# dsh-lemonade-provider

Plugin **dsh** qui intègre [Lemonade Server](https://lemonade-server.ai) comme
fournisseur de modèles du DeepSeek Harness.

Lemonade expose une API compatible OpenAI (Chat Completions). Ce plugin branche
cette API sur le service `ctx.llm` du Harness sous la route provider
**`lemonade`** :

- **Chat Completions** en streaming (SSE) via `POST {baseURL}/chat/completions`
- **Découverte de modèles** live depuis `GET {baseURL}/models`
- **Clé API optionnelle** (`LEMONADE_API_KEY`) — utile seulement quand le
  serveur est configuré avec authentification
- Support **vision** : les blocs image du Harness sont envoyés en `image_url`
  (data URL) aux modèles `vision`
- **Tool calling** au format OpenAI standard

## Prérequis

- Un Lemonade Server en cours d'exécution (par défaut `http://localhost:13305`)
- Node.js ≥ 22
- Une installation dsh (profil), par ex. le profil `web`

> Le paquet doit être **compilé au préalable** : `pnpm install && pnpm build`
> (volet « Développement » ci-dessous) — dsh charge le code depuis `lib/`.

## Installation dans un profil

Depuis le répertoire du profil (ex. `~/.dsh/profiles/web`) :

```sh
pnpm add file:../dsh-lemonade-provider
```

ou, en ligne de commande dsh :

```sh
dsh plugin --profile web add file:../dsh-lemonade-provider
```

Ajoutez ensuite une entrée dans `cordis.patch.yml` du profil (voir
[exemple/cordis.patch.yml](exemple/cordis.patch.yml)) :

```yaml
- id: llm-lemonade
  name: 'llm-lemonade'
  config:
    baseURL: http://localhost:13305
```

> `baseURL` est la racine du serveur (un suffixe `/v1` d'anciennes configs est
> supporté). Si `LEMONADE_BASE_URL` est définie, elle est utilisée quand
> `baseURL` est omise.

## Configuration

| Champ | Type | Défaut | Description |
| --- | --- | --- | --- |
| `baseURL` | string | `http://localhost:13305` (ou `LEMONADE_BASE_URL`) | Normalisée à `scheme://host/api` — `/api` ajouté si manquant, `/v1/…` ajouté par endpoint |
| `apiKeyEnv` | string (credential-ref) | `LEMONADE_API_KEY` | Clé régulière (endpoints /v1/*) |
| `adminApiKeyEnv` | string (credential-ref) | `LEMONADE_ADMIN_API_KEY` | Clé admin optionnelle (endpoints internes /internal/* et /metrics) |
| `requireAuth` | boolean | `false` | Échouer quand la clé est absente (distant protégé) |
| `models` | array | `[]` | Catalogue advisory épinglé par l'utilisateur |
| `defaultContextWindow` | number | `32768` | Fenêtre de contexte utilisée quand le serveur n'en déclare pas |
| `maxTokens` | number | `8192` | Cap de sortie par défaut |
| `streamIdleTimeoutMs` | number | `300000` | Timeout d'inactivité du flux SSE |
| `retryPolicy` | object | valeurs par défaut | Politique de retry du provider |

Chaque entrée dans `models` : `id` (obligatoire), `name`, `description`,
`contextWindow`, `maxTokens`, `vision` (boolean).

## Découverte des modèles

La page Modèles du Harness peut interroger `GET {baseURL}/models` via la
discovery enregistrée pour l'espace de réglages `llm-lemonade`. Les modèles
non-téléchargés et ceux routés vers d'autres endpoints (embeddings, image,
TTS, transcription, …) sont exclus de la liste proposée ; la fenêtre de
contexte déclarée (`max_context_window`) est reprise quand elle est présente.

## Configuration UI (Settings → Models)

La page Settings/Models de dsh n'a pas de porte de sortie tierce : son éditeur ne
connaît que les namespaces `llm-deepseek` et `llm-pi-ai`. Le plugin branche donc
sa carte d'édition sur la carte `pi-ai` de la page Models via un patch ponctuel
du bundle vendu `dsh-client-ui-settings-models` (route `llm-lemonade` → famille
`pi-ai`). Après toute réinstallation du cache npm (`npm exec`), relancer :

```sh
node scripts/patch-models-ui.mjs
node scripts/patch-models-ui-admin.mjs
```

Le formulaire (Settings → Models -> ligne Lemonade) permet de saisir la clé API
(optionnelle, stockée via le service credentials sous `LEMONADE_API_KEY`),
la **clé admin optionnelle** (`LEMONADE_ADMIN_API_KEY` — endpoints internes
`/internal/*` et `/metrics`, via le patch `patch-models-ui-admin.mjs`),
la base URL (repli « customized »), et de sélectionner les modèles servis par
Lemonade via « Fetch available models » (découverte `llm.discoverModels`).

## Vue « Lemonade » (onglet de la conversation)

Un onglet **Lemonade** (à côté de Chat/Trajectory) expose les points d'entrée de
l'API spécifique Lemonade (health/liveness, télémétrie, modèles avec
Load/Unload/Delete/Fichiers/MAJ, téléchargements contrôlables, et clés cloud).
Le navigateur appelle le serveur dsh en même origine (`/dsh-lemonade/api/<op>`) ;
le host proxi vers Lemonade (`src/server-api.ts`) en résolvant baseURL + clé
(ceux-ci ne quittent jamais le host). La sélection de la clé est **par endpoint** : les endpoints réguliers (/v1/*, /live) s'authentifient avec `LEMONADE_API_KEY`, et les endpoints de contrôle (`/internal/*`, `/metrics`) avec `LEMONADE_ADMIN_API_KEY` (avec repli sur la clé régulière). La route est enregistrée via
`ctx.webServer.register({ kind: 'prefix', path: '/dsh-lemonade/api', ... })`
quand le service `webServer` est disponible.

### Bundle client navigateur

La moitié navigateur vit dans `src/client/index.js` et est copiée telle quelle
vers `lib/client.js` par le build (`scripts/copy-client.mjs`). Le bundle
s'enregistre auprès du module loader sous le **nom du paquet** —
`@cyrilmarin/dsh-lemonade` — car le harness identifie les modules client des plugins
par leur nom de paquet dans son manifeste de boot :

```js
window.__ModuleLoader__.load({ id: "@cyrilmarin/dsh-lemonade", factory: (require) => { /* … */ } })
```

L'id d'enregistrement doit correspondre exactement à l'id de la ligne du graphe ;
en cas de désaccord, le harness échoue avec *« loaded without registering
`<id>` via `__ModuleLoader__.load` »*. Comme `lib/` est ignoré par git (sortie de
build), pensez toujours à reconstruire après toute modification de
`src/client/index.js` et à réinstaller le paquet dans le profil avant de
recharger le GUI.

## Développement

```sh
pnpm install
pnpm build      # compile TypeScript vers lib/
pnpm test       # tests du protocole (serveur SSE simulé)
```

### Structure

- `src/index.ts` — plugin : schéma de config, `apply`, découverte, credentials
- `src/adapter.ts` — `LemonadeAdapter extends LlmAdapter` (fetch + SSE)
- `src/serialize.ts` — messages Harness → filaire OpenAI
- `src/translate.ts` — payloads SSE → chunks `StreamChunk`
- `src/client/index.js` — moitié navigateur (onglet Lemonade), copiée vers `lib/client.js`
- `test/adapter.test.mjs` — suite de tests sans dépendance (mock HTTP)

### Licence

MIT

## Release

L'automatisation de release est un script autonome sans dépendance tierce :
`scripts/release.mjs`. Commandes disponibles :

```sh
pnpm release:dry      # affiche le plan (aucun fichier écrit, aucune commande git mutative)
pnpm release          # détecte l'incrément depuis les commits conventionnels
pnpm release:major    # force un bump major
pnpm release:minor    # force un bump minor
pnpm release:patch    # force un bump patch
```

Le script de release :

1. Détermine l'incrément depuis les commits conventionnels entre le dernier
   tag (ou tout l'historique s'il n'y a aucun tag) et HEAD :

   | Commit | Bump |
   | --- | --- |
   | sujet `type(scope)!: …` ou `BREAKING CHANGE:` dans le corps | major |
   | `feat` | minor |
   | `fix`, `perf` | patch |
   | tout autre commit non encore tagué | patch (fallback) |

   S'il n'y a aucun commit à publier, il affiche un message et sort avec le
   code 0 sans rien faire.
2. Incrémente `version` dans `package.json` (un suffixe pré-release, s'il en
   existe un, est retiré — la release est finale).
3. Commite `chore(release): <version>` (ne stage que `package.json`).
4. Crée le tag annoté `v<version>` (préfixe configurable via `--tag-prefix`).
5. Pousse la branche courante et le tag vers `origin` (omis avec `--no-push`).

> La publication npm proprement dite n'est pas réalisée par le script : elle
> est déclenchée par la GitHub Release créée sur le tag poussé (workflow
> [.github/workflows/publish.yml](.github/workflows/publish.yml)).
