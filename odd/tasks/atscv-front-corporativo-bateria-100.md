# Feature — ATSCV front corporate polish + 100-round live E2E battery

- **Feature id**: `atscv-front-corporativo-bateria-100`
- **Repository**: `/home/test/test/atscv-independent` (canonical front, remote `github.com/jacktravolta/atscv.djlabs.cl.git`)
- **Branch**: `feat/atscv-front-corporativo-bateria-100` (branched from `origin/main` = `6905c33`)
- **Production surface under test**: `https://atscv.djlabs.cl/`
- **Engram mirror**: `odd/atscv-front-corporativo-bateria-100/tasks`

## Objective

Make the CV ATS Match front correct on mobile and visually corporate, then prove the
whole product path with a real browser against the **production domain**, repeated
100 times, with every test account removed from the front before the session closes.

## Problem

1. **Mobile navigation**: the landing `index.html` has **no burger at all** — the nav is
   `hidden … md:flex` (`index.html:81-87`). Under 768 px the five section links
   (Cómo funciona / Qué ofrece / Analizar mi CV / Recargas / Contáctanos) leave the flow
   with no replacement, so the lower links are unreachable on a phone.
2. **Colour flip**: the page paints with `data-skin="teal"` (`index.html:2`), then
   `js/inline/index-2.js:10-18` fetches `GET /ui/theme?heart=atscv` and **overwrites**
   `data-skin` with the server value (`indigo`) **after the first paint**. Tailwind's
   `transition` utility includes `background-color` (150 ms), so the whole brand colour
   animates from teal to indigo seconds after load. The same fetch also writes the
   admin's day/night default over the visitor's stored preference.
3. **Template**: the landing is flat (cards without elevation while the panel uses
   `shadow-sm`), card backgrounds are inverted between sections, the accent is spelled
   two ways (`brand-*` vs `blue-*`), `/cv-ats/` looks like a different product, and the
   two brand typefaces (`Newsreader`, `Public Sans`) declared in `css/tokens.css` are
   **never loaded** (no `@font-face`, CSP `font-src 'self' data:`), so the design system
   falls back to Georgia/system-ui.
4. **No live battery**: the existing harnesses (`api-independent/scripts/test_atscv_40usuarios.sh`,
   `test_atscv_e2e.sh`) drive the **API** with curl against `127.0.0.1`. Nothing drives
   the real front in a real browser against the real domain.

## Why

The owner asked for a full journey proof on the live domain, repeated 100 times, with
failures fixed in the loop and no database litter. A front that cannot be navigated on a
phone and that repaints its brand colour after load is not shippable to 100 real users.

## Scope

**In scope**

- Front changes in this repository only: `index.html`, `app.html`, `cv-ats/index.html`,
  `js/inline/index-*.js`, `css/tokens.css`, `css/input.css`, `tailwind.build.config.js`,
  and new self-hosted fonts under `fonts/`.
- A CDP harness under `tests/` in this repository, driving `https://atscv.djlabs.cl/`.
- Publish through the repository's own pipeline: push to `main` → GitHub Pages workflow
  `pages-build-deployment` → `atscv.djlabs.cl`.

**Out of scope**

- The API repository (`api-independent`) is read-only for this feature. Product rate
  limits, credits and heart behaviour are not modified.
- `controldecarroceria/atscv.djlabs.cl` is a stale, git-ignored copy. Never edited, never
  published.
- The stale second surface `https://api.djlabs.cl/atscv/` is **not** refreshed by this
  feature (separate publish path, `scripts/publish-atscv-front.sh`).

## Constraints

- **Deployment chain**: `atscv.djlabs.cl` = GitHub Pages of the private repo, branch
  `main`, root `/`. Verified: the live `index.html` sha256 equals `git show main:index.html`,
  and `gh api repos/jacktravolta/atscv.djlabs.cl/pages` reports `source.branch=main`,
  `source.path=/`, workflow `pages-build-deployment`.
- **API calls come from the browser**: `api-config.js` pins `https://api.djlabs.cl`, and
  the API resolves the client IP from `CF-Connecting-IP` behind the Cloudflare tunnel, so
  IP-scoped buckets (`auth:login`, `contact`) are shared by the whole battery.
  Only those two **test-artifact** buckets may be cleared between rounds; the product
  buckets (`atscv_match`, `atscv_generate`, `atscv_url`) are per user and must stay.
- **Real model calls**: every round costs real LLM calls (3 for the match, 2 for the
  generation). 100 rounds = ~500 real calls.
- **RDD is off** (`gentle-ai review mode status` → `off`, decided by global). No native
  review gate; ordinary functional checks apply.
- **TDD**: no `strict_tdd` configuration exists for this project. Checks are the existing
  `node --test` unit tests plus the CDP battery.
- Style: the live page must keep the plain-Spanish, empathetic voice of the product.

## Tasks

- [ ] **T1 — Mobile navigation on the landing.** Add a real burger to `index.html`
      (button + panel with the five section links + auth actions + theme toggle), wire it
      in the inline boot, close on link click and on Escape, keep the desktop nav at
      `lg:flex`. Panel must have an opaque background. Duplicate `#btn-enter-panel` must
      become a unique id so both header copies react to the session.
- [ ] **T2 — Fixed brand colour.** One source of truth: `data-skin="indigo"` in the markup
      of `index.html`, `app.html`, `cv-ats/index.html`; the `/ui/theme` fetch must not
      repaint the accent after the first paint, and must not overwrite the visitor's stored
      day/night preference. `/cv-ats/` must honour the stored `aj:tema` before paint.
- [ ] **T3 — Corporate template.** Load the declared brand typefaces (self-hosted woff2,
      `font-src 'self'` already allows it), give the landing cards the same border +
      elevation as the panel, unify the card background logic across sections, give the
      page a section rhythm, unify the accent label (`brand-*`), and give `/cv-ats/` the
      same header identity as the landing.
- [x] **T4 — Live CDP battery harness.** `tests/atscv-battery.mjs` driving a real Chrome
      over CDP against `https://atscv.djlabs.cl/`: contact form → register → login →
      panel → CV + offer in the three input modes (PDF upload, URL, typed text) →
      match report → template selection → adapted CV + cover letter (DOCX and PDF) →
      **delete the account from the front** (typed `BORRAR` confirmation) → verify the
      account is gone → close the session. One round = one new user, one deletion.
      Written in `a0e671d` (branch `feat/atscv-bateria-100-cdp`, **not published**): a
      self-contained CDP client on Node 22's global `WebSocket`, no new dependencies,
      resumable JSONL log under `tests/artifacts/` (git-ignored), one round per user,
      and the deletion check runs in the database as well as in the API.
- [x] **T4b — API: resolve relative redirects before the SSRF recheck.**
      `UrlAnalyzerService::fetch()` copied the raw `Location` header into `final_url`, so
      a **relative** redirect (`Location: /ruta`) reached `assertSafeUrl()` without a
      scheme or host and the read failed with `URL_INVALID`. Every site that redirects
      relatively was affected, not only the fixtures: GitHub Pages answers
      `307 location: /tests/fixtures/cv-battery` for the published fixture.
      Fixed in `api-independent` (commit `314fb42`, live in production): each `Location`
      is resolved against the effective URL of the previous hop, the absolute final URL
      still goes through the anti-SSRF check, and `tests/url_analyzer_redirect_test.php`
      proves the relative hop works, the absolute/protocol-relative forms resolve and a
      redirect to an internal target is still rejected (fail-closed).
- [ ] **T5 — Run 100 rounds and fix what breaks.** Loop until the battery is green or a
      blocker is proven to be a product limit. Log every round, keep the failure report
      honest.
- [x] **T6 — Flow return lands on the product wallet with the real outcome.**
      Owner-reported: cancelling a payment returned to a broken, unstyled page at
      `https://api.djlabs.cl/wallet`. Root cause: `FlowReturnService::frontFor()` only
      read the `front_url` database setting (ATSCV has none) and fell back to
      `Cors::siteUrl('/wallet')`; `FlowProvider::walletReturnUrl()` forced `/#/wallet`,
      a route the ATSCV front does not have, and the redirect carried no status.
      Fixed in `api-independent` (commit `42c5ec9`) and in this front (commit `4597ee7`):
      the return now goes to `https://atscv.djlabs.cl/app.html?pago=<estado>#billetera`,
      the fallback is always a product front (never the API domain), and the front
      explains approved / rejected / cancelled / pending / unknown in the wallet.
      Credits still only move on `APPROVED`, through the signed webhook.
- [x] **T7 — Panel sin restos del producto anterior + asistente con voz propia.**
      Owner-reported (live screenshots): the header still showed an **"Ocultar
      adjuntos"** button, the **"Conversaciones"** link, a messy row of chat action
      icons, and the assistant answered with a curt, canned 5-point list.
      - The "Ocultar adjuntos" button was the leftover of the collapsible-inputs
        feature: it looked for "the previous heading" with
        `querySelectorAll('h1, h2, h3')`, grabbed the panel's `<h1>` in the header and
        therefore rendered **in the top bar**. The whole feature is gone (wrapper,
        button, `setInputsCollapsed`, `state.inputsCollapsed`); the CV and offer
        blocks stay visible and behave as before.
      - "Conversaciones" is gone from the desktop nav and from the mobile pill strip
        (`#panel-conversaciones` stays: the informe deep link still opens it).
      - The chat action icons are now one single strip per bubble (Escuchar, Editar y
        descargar, Eliminar), same size, same style, each with its tooltip; the icons
        went from 14 px unlabelled to 16 px grouped.
      - New switch **"Usar mi informe como contexto"** in `#chat-section`, **active by
        default**: the analyzer announces its report (`cv-ats:informe`) and every chat
        message carries that report as context — no extra call, no extra charge. Off
        means general employment answers.
      - **First entry**: a registered user who has never opened the panel lands
        straight on `app.html` (flag `aj:primer-acceso-panel`); after that the landing
        stays reachable, and flows with return parameters (`?pago=`, `?token=`, anchors)
        are never redirected.
      - **Assistant voice** (in `api-independent`): the `atscv` persona's mandatory
        5-point format (`**1. En simple:** … **2. Lo que te falta:** …`) was what made
        every answer feel like a form. The persona now keeps every hard rule (only the
        delivered data, only the delivered BCN context, the exact "no base legal"
        sentence, cite norma + artículo, never promise the ATS result) and replaces the
        fixed shape with a flexible one: adapt the form to the question, always bring
        something concrete, vary the opening, one clarifying question at most, warm
        without pressure.

## Acceptance criteria

1. At 375 px width the landing exposes every section link through the burger, and the
   panel is fully visible without horizontal scroll.
2. The brand colour is identical before and after the `/ui/theme` response; no transition
   on load; the stored day/night preference survives a reload.
3. The landing reads as one system: brand typefaces active, consistent card elevation and
   borders, one accent label, and `/cv-ats/` sharing the landing header.
4. The CDP battery passes against the live domain. The front repository has **no**
   `*.test.mjs` unit suite (there is nothing for `node --test` to run), so the battery
   and the API's PHP tests are the real checks.
5. After a successful round the account no longer exists: `GET /auth/me` returns 401 and
   the user row is gone from the database.

## Checks

- `node --check tests/atscv-battery.mjs` (the harness parses).
- CDP battery against `https://atscv.djlabs.cl/` (the harness itself): one round per
  input mode, then the 100-round loop.
- API side (`api-independent`): `php tests/url_analyzer_redirect_test.php`,
  `php tests/payment_return_url_test.php`, `php tests/payment_return_endpoint_test.php`.
- After the Pages build: `sha256` of the live `index.html` equals the committed one.

## Progress

| Task | State | Evidence |
|---|---|---|
| Recon | done | Live sha256 = `main`; Pages branch = `main`; burger absent in landing; colour flip traced to `js/inline/index-2.js:10-18` |
| T1 | done | `f7cdbff` — burger `#menu-toggle` + panel `#mobile-menu`; 375/768 px: burger visible, panel opaco `rgb(244,247,246)`, sin scroll horizontal; 1024 px+: barra de escritorio; Escape cierra; sin errores de consola |
| T2 | done | `5508494` — `data-skin="indigo"` en las tres superficies; con un stub que devuelve `teal`, el DOM sigue en `indigo` antes y después de `/ui/theme`; `aj:tema` sobrevive a la recarga |
| T3 | done | `5db7354` — Newsreader + Public Sans autoalojadas (`fonts/`, `document.fonts` = loaded); tarjetas con `shadow-sm` + borde de token; banda de color + banda final; `blue-*` → `brand-*`; `/cv-ats/` con el header de la landing y sin el 404 de `js/tailwind.config.js`; `css/tailwind.css` sin cambios |
| T4 | done | `a0e671d` — `tests/atscv-battery.mjs` (self-contained CDP client, Node 22 global `WebSocket`, no new deps) + `tests/README-battery.md`; smoke round green: 1/1 ok, account deleted and verified (`users=0`, 20 user tables empty, `account_deletion_log` keeps the deletion by design), CV PDF 31.788 B and carta PDF 23.776 B, both `%PDF`; the URL mode failed → traced to the API, not the harness (see T4b) |
| T4b | done | `314fb42` (api-independent, live) — relative `Location` resolved against the effective URL before the SSRF recheck; `tests/url_analyzer_redirect_test.php` 13/13; verified live: `POST /v1/cv-ats/desde-url` on the published fixture now answers 200 with the CV and offer text, and a loopback target is still rejected (400) |
| T5 | in progress | Three-mode validation running (one round per mode), then the 100-round loop |
| T7 | done | Front: `cv-ats.js` (whole collapsible-inputs feature removed), `app.html` (nav without "Conversaciones", switch `#chat-contexto-switch`), `chat-widget.js` (single action strip per bubble, 16 px icons, `contextProvider`), `app-4.js` (switch wiring + informe context + first-entry flag), `index-4.js` (first entry → panel); local Chrome: zero "Ocultar adjuntos", nav `Home · Panel · Billetera · Uso`, switch `aria-checked=true` and toggles/persists, no console errors. API: `heart_personas` row `atscv/authenticated` rewritten (1 652 → 2 927 chars), verified in place; the previous prompt stays in `prompt_audits` |

## Route declaration

- T1–T3: **delegated writer** (touches more than two non-trivial files: three HTML
  surfaces, the inline bundle, the token layer and the build config).
- T4: **delegated writer** (new harness plus fixtures, needs the CDP reference pattern).
- T4b: **delegated writer** in `api-independent` (service + regression test); the parent
  verified the root cause, the live behaviour and the untouched anti-SSRF guard.
- T5: **parent** (execution and reporting; failures are fixed by re-entering T1–T4).
- Mapping/recon was delegated to one narrow read-only mapper; the parent verified the
  decisive claims itself (sha256 of the live document, Pages configuration, git history).

## Next step

Run the three-mode validation (one round per mode), then the 100-round loop against the
live domain with the resumable JSONL log, and report the rounds that passed, the real
LLM calls and the accounts deleted.
