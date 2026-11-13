# Web app, accounts and sync

Inkling is web-first: the browser app is the main way in, and the Windows and Mac apps are the same notebook UI with files on disk and a tutor that can run locally. Signing in is optional on both; with an account, both sync the same notebooks.

## How it fits together

```
src/renderer/      the UI, canvas and notebook logic — one copy, used by both
src/shared/ipc.ts  InklingApi: everything the UI needs from its platform (window.inkling)
src/preload/       desktop: InklingApi over Electron IPC → src/main (files, local AI, updater)
src/web/           web: InklingApi in the page → IndexedDB, service worker, file pickers
src/shared/sync/   the sync engine, used by src/web and src/main alike
supabase/          the database schema, security rules and storage bucket
beta-server/       the AI server (unchanged API; now also answers the web app's origin)
```

| | Web | Desktop |
|---|---|---|
| Notebooks | IndexedDB, one database per account plus one for signed-out use (`src/web/idb.ts`) | Files in the library folder, unchanged (`src/main/storage.ts`) |
| Images, PDFs | IndexedDB, served by the service worker at `app/asset/…` | Files, served by `inkling-asset://` |
| Search, links, graph | `SearchIndex`, in the page | `SearchIndex`, in the main process |
| AI tutor | Inkling's cloud AI (needs internet) | Cloud AI, or Ollama on the computer |
| Offline | Service worker caches the app; everything but AI and sync works | Always |
| Backups | *Back up now* downloads one file; *Restore* reads it | Daily snapshots, as before |

Notes store image addresses as `inkling-asset://asset/<notebook>/<file>` on both platforms, so a notebook is byte-for-byte the same wherever it is opened.

## Sync

Local first: every edit is saved on the device, then synced. The engine (`src/shared/sync/engine.ts`) keeps, per document (the library, each page, each note), the server revision it is based on and whether it changed since.

- **Offline edits** are queued and pushed when the server is reachable (after each save, every minute, when the window or network comes back).
- **A push only succeeds against the revision it was based on** (`push_doc` in the migration). Otherwise the server's version is merged with the local one (`merge.ts`) and the result is pushed.
- **Merging** is per object: strokes, shapes, pages and notebooks added on either side are all kept; different fields of the same thing combine; a note's paragraphs merge as a sequence. Deleted on one device and edited on another: the edit is kept.
- **Real conflicts** (both devices changed the same stroke or paragraph): this device's version stays in the page, the other is kept in the page's history, and Settings → Account lists the page with *Earlier versions* to choose.
- **History.** The account keeps up to 20 earlier versions of each page: whatever another device replaces, both sides of a conflict, and one every ten minutes of editing. *More → Earlier versions* restores one; restoring is itself an ordinary synced edit.
- **Files** are uploaded once and never changed. Over 50 MB (the free plan's limit) a file stays on its device and the app says so.
- **A page from a newer Inkling** is never overwritten by an older one: sync reports it and asks for an update.

**Signing in on a device that already has notebooks** asks first. Yes adds them next to the account's notebooks (nothing is replaced); no leaves them on the device, untouched. Untouched starter notebooks are never copied into an account that has notebooks.

**Signing out** on the web removes the account's notebooks from the browser once everything is synced (unsynced changes are kept and go up at the next sign-in). On the desktop the notebooks stay on the computer.

## Setting it up (about 20 minutes, $0)

Nothing here is a secret except where marked. Never put a Supabase **service-role** key in any build or repository variable.

### 1. Supabase project (free plan)

1. Create a project at supabase.com. Note the **Project URL** and the **anon / publishable key** (Settings → API).
2. SQL Editor → paste and run `supabase/migrations/20261112000000_sync.sql` (or `supabase db push` with the CLI). It creates the tables, row-level security, `push_doc` and the private `assets` bucket.
3. Authentication → URL Configuration:
   - **Site URL**: the web app's address, e.g. `https://supergithubduo.github.io/inkling-notebook/app/`
   - **Redirect URLs**: that address, `http://127.0.0.1:48213/callback` (desktop Google sign-in), and `http://localhost:5174/` for development.
4. Authentication → Emails → **Magic Link** template: include the code as well as the link, e.g. `<p>Your code: {{ .Token }}</p><p><a href="{{ .ConfirmationURL }}">Sign in</a></p>`. The desktop app and installed web apps sign in with the code.
5. The built-in email sender allows only a few emails an hour. For real use add your own SMTP (Authentication → SMTP); several providers have free tiers.

### 2. Google sign-in

1. Google Cloud Console → APIs & Services → OAuth consent screen: create it (External), add your domain.
2. Credentials → Create OAuth client ID → **Web application**. Authorised redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`.
3. Supabase → Authentication → Providers → Google: paste the client ID and client secret (**secret**: it stays in Supabase, never in this repository).

### 3. Repository variables (Settings → Secrets and variables → Actions → Variables)

| Variable | Value |
|---|---|
| `INKLING_SUPABASE_URL` | the Project URL |
| `INKLING_SUPABASE_ANON_KEY` | the anon / publishable key |
| `INKLING_BETA_URL` | the AI server's address (already set for desktop releases) |

The Pages workflow builds the web app with them; the Release workflow builds the desktop apps with them. Without them the apps build and work signed-out.

### 4. AI server

Set `WEB_ORIGINS` in `beta-server/wrangler*.jsonc` to the web app's origin (e.g. `"https://supergithubduo.github.io"`) and deploy the Worker as usual (docs/RELEASING.md). Browsers on any other site still can't call it. The provider key stays a Worker secret; the web app only ever sees the server's public address. Usage limits are unchanged: per installation ID and network address.

### 5. Hosting

GitHub Pages, as for the website: Settings → Pages → Source: **GitHub Actions**. The site is published with the web app at `/app/`. Any static host works (the build is relative-path; `npm run build:web` → `out/web`).

### Local development

```
cp .env.example .env    # fill in the Supabase URL and anon key (optional)
npm run dev:web         # http://localhost:5174
npm run build:web && npm run preview:web
```

## Tests

| | |
|---|---|
| `tests/unit/sync.test.ts` | Merge rules; two and three devices against an in-memory server: offline queues, conflicts, deletes, restarts, a 300-step random simulation that must converge without losing anything |
| `tests/unit/syncPlatforms.test.ts` | Real desktop file storage and real IndexedDB code syncing one account; backup restore; newer-version pages |
| `tests/unit/supabaseSchema.test.ts` | The migration run in real Postgres (PGlite): row-level security between users, no direct writes, revision checks, history, file policies |
| `tests/unit/webCors.test.ts` | The AI server answers browsers only from allowed origins, never on `/admin` |
| `tests/e2e/web.e2e.mjs` | Chromium against the built web app and local stand-ins for Supabase and the AI model: signed-out use, offline, sign-in, migration question, two browsers syncing, phone/tablet/stylus, sign-out, CSP; then the desktop app syncing with the web app |

## Costs and limits (free tiers)

- **Supabase free**: 500 MB database, 1 GB file storage, 50 MB per file, 50,000 monthly users; projects pause after a week without activity. Guards in the schema: 8 MB per page, 20,000 pages per account, 20 versions per page.
- **GitHub Pages**: free for public repositories.
- **Cloudflare Workers / AI server**: unchanged.
- **Later**: files can move to Cloudflare R2 by replacing `uploadAsset`/`downloadAsset` in `src/shared/sync/supabase.ts` (nothing else knows where files live).

## Known limits

- Files of notebooks deleted for good stay in the account's storage (another device may still need them); there is no clean-up job yet.
- No in-app "delete my account"; delete the user in the Supabase dashboard (rows cascade; remove the user's folder in the `assets` bucket).
- The web backup file holds pictures and PDFs as base64 in memory; very large libraries may not fit.
- Changes from other devices arrive within about a minute (polling), not instantly.
- On the web, pictures a Markdown file refers to by file path can't be imported.
