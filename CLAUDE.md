# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Two halves of one system, in sibling folders:

- `scraper/` — a Node 20+ ESM CLI (one dependency: Playwright) that scrapes 14 job
  boards and generates an Obsidian vault from the results.
- `JobVault/` — that vault. Half of it is generated output, half is hand-written
  input, and the scraper is *driven from inside it* (`Profile/Scraper.md` is a
  working control panel, not documentation).

`scraper/README.md` is long and accurate; read it before changing behaviour that
it describes. The root `README.md` is the one written for other people — the
dependency table there and `install-windows.bat` (a Windows dependency installer
driven by yes/no questions) have to keep saying the same thing as each other. `.claude/skills/apply/` and `.claude/agents/cv-writer.md` are part
of the product, not tooling — they are versioned here so the application-writing
workflow travels with the scraper.

## Commands

All run from `scraper/`:

```bash
npm install                               # also downloads Playwright's Chromium
npm run scrape                            # every enabled source × every configured query
npm run scrape -- --source noorderlink    # one board (runs even if enabled:false)
npm run scrape -- --sources remotive,jobicy --max-pages 3 --scrape-only
npm run scrape -- --list-sources
npm run scrape -- --help
npm run vault                             # rebuild JobVault from data/jobs.json, no network
npm run apply -- --list                   # what's marked `status: apply`
npm run apply -- --json                   # the queue the /apply skill consumes
npm run panel pull|push|run|stop|status   # the Obsidian panel's back end
```

There is no test suite, linter or build step. Verify a change by running one
cheap board end to end and rebuilding the vault:

```bash
npm run scrape -- --source remotive --max-pages 1 --scrape-only
npm run vault
```

Never use `--source indeed` for a smoke test: it drives real Chromium, takes ~30
minutes for a full sweep, and burns the rate limit. `noorderlink` (one API, a few
seconds) is the local-board equivalent; `striive` is off by default and costs
~20 MB per page.

`data/jobs.json` is the durable store and is gitignored. It is never rebuilt from
scratch — deleting it loses `firstSeen` dates and closed-job history.

## Architecture

Pipeline: `cli.js` → source adapters → `store.js` → `dedupe.js` → `vault.js`.
Only the adapters know anything about a board; everything downstream is
source-agnostic. Keep it that way — a `if (source === "indeed")` outside
`src/sources/` is a design bug.

**Source adapters** (`src/sources/*.js`) export `id, label, kind, supportsQueries,
geoFiltered, blurb, defaults, scrape(cfg, { log, onPage })` and are registered in
`src/sources/index.js`. `scrape` calls `onPage(jobs)` per result page with jobs
shaped by `baseJob()` (`src/sources/util.js`); the store checkpoints on every
call, which is why an interrupted run keeps everything fetched so far. Shared
machinery is in `src/sources/lib/`: `http.js` (retries, back-off, User-Agent —
every HTTP adapter must go through it), `feed.js`, `jsonld.js`, `region.js`.

**Config precedence** (`configFor` in `src/sources/index.js`):
`global config.json < the source's own defaults < sourceOptions[id] < CLI flags`.
A source declares a default precisely because the global value is meaningless for
it. `loadConfig` resolves `vaultPath`/`dataFile` to absolute paths against
`ROOT`; `regionInclude: undefined` means "use the shared default", `null` means
"no filter" — that distinction is load-bearing.

**Two geographies.** `geoFiltered: true` boards (indeed, noorderlink, striive)
have real addresses and get `radius` around `center` — a true haversine circle
where the board returns coordinates. `geoFiltered: false` boards are worldwide,
where a radius is meaningless; they filter on stated candidate eligibility via
`makeRegionFilter` instead. The rule: regions stated and one matches → keep;
stated and none match → drop; nothing stated → keep unless
`keepUnknownRegion: false`.

**Keys.** A job's identity is `<source>:<board's own id>` (`makeKey`), so boards
can never collide; `fileKey` swaps the colon for a dash in vault file names.
`migrateStore` rekeys pre-multi-source records on load.

**Deduplication** (`dedupe.js`) is a second layer on top: a fingerprint of
normalised company + title + place clusters the same vacancy across boards. For
remote jobs the place is dropped (every board words it differently) and
company + title carry the match. A cluster forms *only* across different sources
with at most one posting each — same fingerprint on the same board means two real
vacancies, not a duplicate.

**Vault generation** (`vault.js`) rewrites `Jobs/`, `Companies/`, `Indexes/` and
`Dashboard.md` wholesale on every run, but merges rather than clobbers each job
note: it preserves `status:`, `applied:`, and everything under `## Notes`, and
carries those across file renames (via `legacyFileName` and cluster re-anchoring).
Any change to note layout must keep that preservation intact — it is where all
the user's own work lives. `Profile/` and `Applications/` are never regenerated;
`profile.js` only scaffolds missing templates.

**Panel round-trip.** `Profile/Scraper.md`'s frontmatter *is* `config.json`.
`panel.js` owns both directions of the translation plus the note layout;
`vault-ui.js` is the executable the Obsidian Shell-commands plugin invokes and
owns the detached run loop (PID file, `run.json` queue, log note). `yaml-lite.js`
exists so the project keeps its single dependency — it deliberately throws on
YAML shapes Obsidian/Meta Bind don't emit rather than guessing. Two values are
spelled differently in the note because an empty string is invisible in a form:
query `*` = `""`, jobType `any` = `""`. The panel touches only the keys it owns
and leaves every other config key untouched.

**Applying** is a deterministic half and a written half. `apply.js`/`apply-cli.js`
find notes marked `status: apply`, gather each vacancy into `Brief.md`, and lay
out `Applications/<company> - <role>/` with CV and letter stubs. The `/apply`
skill then spawns one `cv-writer` subagent per vacancy. `npm run apply` never
overwrites a written draft — only an untouched stub, and only with `--force`.

## Constraints worth knowing before changing things

- Adding a board: prefer a JSON API, then `fetch` + JSON-LD, then Playwright.
  Playwright exists for Indeed alone. Adapters must stay deterministic — no LLM
  in the scraping loop; the dedup depends on stable extraction.
- Indeed's location must be a postcode (`9711 Groningen`); a bare city name gets
  normalised to the province. It also caps a search at ~1000 results.
- `finalizeRun` only ages the sources that actually ran, so scraping one board
  must never close another's listings. Preserve that when touching run bookkeeping.
- The frequent cron runs use `--scrape-only`; the vault is rebuilt once at the end.
