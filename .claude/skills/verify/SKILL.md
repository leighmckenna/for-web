---
name: verify
description: Build, launch, and drive this fork of the Stoat web client (Solid.js) to verify changes at the browser surface
---

# Verifying for-web changes

Monorepo (pnpm workspaces; upstream uses mise but every task is a thin pnpm wrapper — mise is NOT installed here, use pnpm directly).

## One-time setup after clone

```bash
pnpm install --frozen-lockfile
pnpm --filter stoat.js build
pnpm --filter solid-livekit-components build
pnpm --filter @lingui-solid/babel-plugin-lingui-macro build
pnpm --filter @lingui-solid/babel-plugin-extract-messages build
pnpm --filter client exec lingui compile --typescript   # i18n catalogs
pnpm --filter client exec node scripts/copyAssets.mjs   # symlinks public/assets (fallback = unbranded)
```

`packages/client/.env`: with the `VITE_*_URL` vars commented out, the client
falls back to the official stoat.chat backend (see
`components/common/lib/env.ts`). Brand override: `VITE_BRAND_NAME`.

## Launch

```bash
pnpm --filter client exec vite --host    # dev server on :5173
```

Vite auto-restarts on vite.config.ts / .env changes. Drive with Playwright:
`/login` (brand heading), `/login/auth` (login form), `/login/create` (signup).
Logged-in surfaces need a real account on the target instance.

## Gotchas

- Pre-existing dev-only console error: `[solid-devtools]: Debugger hasn't
  found the exposed Solid Devtools API` — noise, ignore.
- The service worker compiles in dev at `http://localhost:5173/dev-sw.js?dev-sw`
  (curl it to check SW-bundle imports resolve). Production SW bundling is only
  exercised by `pnpm --filter client exec vite build`.
- `packages/solid-livekit-components` shows as dirty (`-dirty` submodule) after
  its build — never commit it.
- i18n: changing text inside `<Trans>`/`t` macros changes msgids. **Dev mode
  falls back to source text and hides breakage — production builds render a
  raw hash id (e.g. "zAvS8w") for any string missing from the compiled
  catalogs.** After adding/changing any Trans/t string, run
  `pnpm --filter client exec lingui extract` and commit the .po files, then
  verify user-facing strings against `vite build` + `vite preview` (port
  4173, what CI's e2e drives), not just the dev server.
- CI note: `gh run watch --exit-status | tail` masks the exit code (pipeline
  returns tail's). Check the run conclusion explicitly.
