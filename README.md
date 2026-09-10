# jobSearch

Scrapes fourteen job boards and turns what they carry into an Obsidian vault you
can actually work from: one note per vacancy, one per employer, indexes and a
dashboard on top, and your own status and notes on each job surviving every
re-run. Marked vacancies can then be handed to an agent that drafts a CV and a
cover letter for each of them.

It is two halves of one system, in sibling folders:

| | |
|---|---|
| `scraper/` | A Node CLI. One dependency (Playwright), no database, no API keys, no accounts. |
| `JobVault/` | The Obsidian vault it fills — and the place you drive it from: `Profile/Scraper.md` is a working control panel, not documentation. |

The boards split into **local** ones around a city (Indeed NL, Noorderlink,
Striive), filtered by a real radius, and **remote** ones worldwide (Remotive,
Himalayas, RemoteOK, We Work Remotely, Jobicy, Working Nomads, RemoteYeah,
4 Day Week, DailyRemote, Landing.jobs, Hoofdkraan), filtered on whether they'll
take a candidate where you live. A vacancy syndicated to six remote boards
becomes one note listing all six — which is most of them, most of the time.

The defaults are aimed at Groningen, the Netherlands. Two settings move that
anywhere: `location`/`center` for the local boards, `regionInclude` for the
remote ones.

## What you need

| | | |
|---|---|---|
| **Node.js 20+** | required | ESM, `node:` built-ins, native `fetch`. Developed on 22. |
| **npm** | required | Ships with Node. |
| **Playwright + Chromium** | for Indeed only | `npm install` downloads it (a few hundred MB) via the `postinstall` hook. Every other board is plain HTTP — skip Indeed and you never launch a browser. |
| **Obsidian** | strongly recommended | The vault is plain Markdown and readable in anything, but the control panel, the dashboard and the indexes are built for it. |
| **Three Obsidian community plugins** | for the control panel | [Buttons](https://github.com/shabegom/buttons), [Shell commands](https://github.com/Taitava/obsidian-shellcommands), [Meta Bind](https://github.com/mProjectsCode/obsidian-meta-bind-plugin). Their settings are committed here; the plugins themselves you install from the community store. |
| **Claude Code** | optional | Only for `/apply`, the CV and cover-letter writer. Everything else works without it. |

No API keys, no logins, no paid tiers, nothing to host. Every board here is read
through a public API, a public feed, or the structured data its own pages embed.

## Install

```bash
git clone git@github.com:GarryTheSquare/jobSearch.git
cd jobSearch/scraper
npm install                      # also downloads Playwright's Chromium
cp config.example.json config.json
```

Then scaffold the vault — this writes the `Profile/` templates and the control
panel without touching the network:

```bash
npm run vault
```

Open `JobVault/` as a vault in Obsidian, enable the three plugins under
*Settings → Community plugins*, and `Profile/Scraper.md` becomes the panel.

## First run

Start with the cheap boards. Noorderlink is one API and a few seconds; Remotive
hands over its whole board in a single request:

```bash
npm run scrape -- --sources noorderlink,remotive --max-pages 1
```

That scrapes, stores and rebuilds the vault. Open `JobVault/Dashboard.md` and
there are jobs in it.

**Don't smoke-test with Indeed.** It drives a real Chromium, a full sweep is
~72 pages and half an hour, and hammering it earns a temporary block.

## Running it

Everything is run from `scraper/`:

```bash
npm run scrape                            # every enabled board × every configured query
npm run scrape -- --source noorderlink    # one board (runs even if it's off by default)
npm run scrape -- --sources remotive,jobicy --max-pages 3 --scrape-only
npm run scrape -- --query "developer" --query "data"
npm run scrape -- --list-sources          # what exists, and what each one costs
npm run scrape -- --help
npm run vault                             # rebuild the vault from the store, no network
npm run apply -- --list                   # what you've marked `status: apply`
npm run panel pull|push|run|stop|status   # the Obsidian panel's back end
```

`--scrape-only` skips the vault rebuild — worth it when several boards run back
to back on a schedule, so the vault is built once at the end. There is a cron
layout for exactly that at the end of [`scraper/README.md`](scraper/README.md).

### Or from Obsidian

`Profile/Scraper.md` is the whole CLI as a form: tick the boards and the queries,
edit the settings, press **Run**. The note's properties *are* `config.json` —
Meta Bind draws a field per setting, Buttons fires a Shell command, and that
command folds the properties back into the file. Runs are detached, so a
half-hour Indeed sweep never blocks Obsidian and survives closing it; the output
streams into `Profile/Scraper Log.md`, which the panel embeds.

The Shell commands need `node` on the `PATH` of whatever launched Obsidian.

## Configuring it

`scraper/config.json` — copied from `config.example.json`, and gitignored, so
your search is yours. The settings that matter most:

| Key | Meaning |
|---|---|
| `sources` | Which boards run by default |
| `location`, `center` | The local boards' search point. Indeed needs a **postcode** (`9711 Groningen`) — a bare city name gets widened to the province |
| `radius` | Kilometres around `center`, local boards only |
| `regionInclude` | Regex deciding which stated candidate regions count as reachable from you. The default covers NL, Europe/EU/EMEA, worldwide wordings and CET |
| `keepUnknownRegion` | Keep listings that state no region at all (`true` by default) |
| `queries` | Search terms; `""` means *every* job |
| `maxPagesPerQuery` | The page budget, which is what decides your yield on the very large boards |
| `staleAfterDays` | How long a vacancy may go unseen before it's marked closed |

Per-board overrides go under `sourceOptions.<id>`. The full table, the precedence
rule and the reasoning behind both are in
[`scraper/README.md`](scraper/README.md#configuration).

## Applying

1. In Obsidian, set `status: apply` on a job note — it shows up in
   `Indexes/To Apply.md`. Anything you want the writer to know goes under
   `## Notes` in that same note.
2. `npm run apply` lays out `JobVault/Applications/<company> - <role>/` with a
   `Brief.md` gathered from every board that carried the vacancy, plus CV and
   letter stubs.
3. In Claude Code, from the repo root, run `/apply`. One `cv-writer` subagent per
   vacancy reads the brief, reads your `Profile/` notes, fetches the live advert
   and writes both documents in the language of the vacancy.

Every fact a draft uses has to come from `Profile/` — the writer selects,
orders and rephrases, and never invents an employer, a date, a number or a
technology. Fill in `Profile/` before you run it; each note carries
`template: true` until you delete that line, and the tooling warns while it's
still there. What you dislike about a draft belongs in `Profile/Voice.md` as a
rule, where it holds for every application after it.

## What's in the repo, and what isn't

```
jobSearch/
├── scraper/            the CLI — src/sources/ is one small adapter per board
├── JobVault/           the vault: Obsidian settings and the panel's commands
├── .claude/            the /apply skill and the cv-writer agent
├── CLAUDE.md           notes for Claude Code working on this repo
└── README.md
```

Generated or personal, and therefore not committed — a clone rebuilds all of it:

- `scraper/data/jobs.json`, the durable store. Never rebuilt from scratch;
  deleting it loses your `firstSeen` dates and closed-job history.
- `scraper/config.json`, your settings.
- `JobVault/Jobs/`, `Companies/`, `Indexes/`, `Dashboard.md` — rewritten
  wholesale on every run.
- `JobVault/Profile/` and `JobVault/Applications/` — yours. Scaffolded as empty
  templates on the first build and never touched again.

Your edits inside a job note *are* safe: on every rebuild the generator
preserves `status:`, `applied:` and everything under `## Notes`, and carries
them across file renames and cross-board merges.

## Being a good citizen

These are other people's servers. Every HTTP adapter goes through one client
that retries with back-off, spaces its requests and identifies itself; Indeed
gets seven to fourteen seconds between pages. Boards where automated reading is
unwelcome are either absent or off by default, and any board can be switched off
with `"enabled": false` under `sourceOptions`. Please keep it that way — it is
one person's job search, not a crawler.

The scraped adverts are the boards' and the employers' content. The vault is for
your own use; don't republish it.

## Further reading

[`scraper/README.md`](scraper/README.md) is the long one and it is accurate:
every board and why it's implemented the way it is, the boards deliberately left
out, the two geographies, the deduplication rules, the note layout, how to add a
source, the known limits, and a scheduling layout that splits the cheap boards
from the expensive ones.

MIT licensed. Have at it.
