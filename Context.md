# Add Show — NCPA Sound Manager

## What This Is

A Progressive Web App (PWA) for NCPA sound crew to add shows to the scheduling system. It checks live crew availability across two Cloudflare D1 databases and submits new events directly into the ncpa-sound-manager database.

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Pages Functions (Hono on Workers) |
| Frontend | Hono JSX + plain JS, served as a static SPA |
| Build | Vite + `@hono/vite-build` (cloudflare-pages adapter) |
| Databases | Cloudflare D1 (two bindings) |
| Deploy | GitHub Actions → `wrangler pages deploy` |
| PWA | Service worker + Web App Manifest |

## D1 Database Bindings

| Binding | Database Name | Purpose |
|---------|--------------|---------|
| `DB_SOUND` | `ncpa-sound-crew-db` | Stores events; shared with ncpa-sound-manager |
| `DB_CREW` | `ncpa-crew-db` | Crew unavailability; shared with crew-assignment-automation |

Database IDs are in `wrangler.jsonc`. Bindings are wired automatically — no extra `--binding` flags needed in the deploy command.

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Main HTML app |
| `GET` | `/icon.svg` | PWA icon (served from worker) |
| `GET` | `/api/crew-availability?dates=YYYY-MM-DD,...` | Returns available / assigned / unavailable crew for given dates |
| `POST` | `/api/events` | Inserts one event per date into `DB_SOUND.events` |

## GitHub Actions Deploy

**File:** `.github/workflows/deploy.yml`

Triggers on push to `main` or any `claude/**` branch. Every deployment targets the production URL (`add-show.pages.dev`) via `--branch=main`.

### Required Repository Secrets

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | API token with Cloudflare Pages edit permission |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |

### Manual Deploy (local)

```bash
npm run build
wrangler pages deploy dist --project-name add-show --branch main
```

## Local Development

```bash
npm install
npm run dev        # Vite dev server with Cloudflare adapter (needs wrangler login)
```

D1 bindings are available locally via `wrangler pages dev` — see `npm run preview`.

## Crew Roster

Defined in `src/index.tsx` as `VALID_CREW`. Mirrors the list in `ncpa-sound-manager`. Update both if the roster changes.

## Venues & Teams

Also defined in `src/index.tsx` (`VENUES`, `TEAMS`). Add entries there to expand the dropdowns.
