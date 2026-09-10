# Job scraper → Obsidian vault

Scrapes a set of job boards — local vacancies around Groningen, Dutch ZZP assignment
marketplaces, and remote boards that will take someone based in the Netherlands — and
turns the results into an Obsidian vault you can browse, tag and use to track
applications.

Each board is a small adapter in `src/sources/`; everything downstream — the store, the
deduplication, the vault — is source-agnostic. A vacancy posted on more than one board
becomes a single note that links to all of them, which matters a great deal on the remote
boards: the same role is routinely syndicated to five or six of them at once.

## Sources

**Local** — a real address, filtered by the `radius` circle around `center`:

| Source | Kind | Notes |
|---|---|---|
| `indeed` | browser | Indeed NL. Plain HTTP gets a `403`, so this one drives a real Chromium through Playwright and reads the JSON payload Indeed embeds in the search page. Slow, memory-hungry, rate-limited. |
| `noorderlink` | api | [Noorderlink](https://noorderlink.nl), the HR network of the northern Netherlands. Nuxt front end over a public JSON API — the whole board is 8 requests. Real salary figures, hours, coordinates and full advert text. |
| `striive` | api | [Striive](https://striive.com) (HeadFirst Group), the highest-volume serious ZZP board in the country. **Off by default:** there is no API, only Angular's server-side TransferState, and every assignment carries base64 logos, so a page of 25 weighs ~20 MB. Its distance filter is also off by default — these assignments are national and often hybrid. |

**Remote** — worldwide boards, filtered on stated candidate eligibility instead:

| Source | Kind | Notes |
|---|---|---|
| `hoofdkraan` | api | [Hoofdkraan](https://www.hoofdkraan.nl) — Dutch ZZP marketplace, public RSS of open *opdrachten*. You invoice; no employment contract. |
| `landingjobs` | api | [Landing.jobs](https://landing.jobs) — public v1 API, European tech roles and projects. Carries on-site roles too, so its own country codes decide eligibility. |
| `himalayas` | api | [Himalayas](https://himalayas.app) — cursor-paginated public API with the best per-job country eligibility data of any board here. Very large (100k+), so the page budget decides the yield. |
| `remotive` | api | [Remotive](https://remotive.com) — public API, whole board in one request, per-job candidate location. |
| `jobicy` | api | [Jobicy](https://jobicy.com) — public API with Netherlands/Europe/Anywhere region endpoints and a Contract job type. |
| `remoteok` | api | [RemoteOK](https://remoteok.com) — public JSON dump of the board. Region often unstated. |
| `workingnomads` | api | [Working Nomads](https://www.workingnomads.com) — one public endpoint returning the current board. |
| `weworkremotely` | api | [We Work Remotely](https://weworkremotely.com) — HTML is bot-blocked, but the RSS feeds are public and state a region per item. |
| `remoteyeah` | api | [RemoteYeah](https://remoteyeah.com) — RSS feed of ~300 recent listings with company and location fields. |
| `fourdayweek` | api | [4 Day Week](https://4dayweek.io) — RSS feed plus per-job JSON-LD. Rebuilt daily, so listings stay fresh. One request per listing, hence the `detailLimit` cap. |
| `dailyremote` | api | [DailyRemote](https://dailyremote.com) — no API, but every listing page embeds schema.org JSON-LD with explicit applicant-location requirements. Some employers are hidden behind its paid tier. |

Boards on the shortlist this was built from that are **not** implemented, and why:

| Board | Reason |
|---|---|
| EnglishJobSearch.nl | Affiliate wrapper — listings link out through `/clickout/<hash>` with no stable job id. |
| IamExpat, Remote.com, Arc.dev, Real Work From Anywhere | Next.js flight payloads only; no public API, feed or JSON-LD found. |
| JustRemote, RemoteJobs.com, NoDesk | No feed or API; HTML has no structured data. |
| Wellfound | GraphQL behind authentication. |
| Malt | Cloudflare challenge on every automated request (`403`). |
| Freelance.nl, Jellow, Yacht | No public listing endpoint. |
| lemon.io, Contra, Braintrust | Talent marketplaces — you are matched, there is no public board to read. |
| EU Remote Jobs | Only a blog feed; the job feed is empty and `wp-json` 404s. |
| Remote in Tech | A directory of companies, not of vacancies. |
| Jobgether, Europe Remotely, Remote Rocketship | Marked unverified in the source document; both block or gate automated access. |

## Install

```bash
npm install                              # also downloads the Playwright Chromium build
cp config.example.json config.json       # your settings; config.json is gitignored
```

Node 20+. See the [top-level README](../README.md) for the dependencies in full and a
first run that doesn't involve Indeed.

## Use

```bash
npm run scrape                            # every enabled source, every configured query
npm run scrape -- --source noorderlink    # one board only
npm run scrape -- --sources remotive,jobicy,himalayas
npm run scrape -- --source striive        # a source that is off by default runs when named
npm run scrape -- --list-sources
npm run scrape -- --max-pages 10          # short run
npm run scrape -- --query "developer" --query "data"
npm run vault                             # rebuild the vault from stored data only
npm run apply                             # gather the vacancies you marked in Obsidian
npm run scrape -- --help
```

Which boards run by default is the `sources` list in `config.json`; `--source` overrides
it for one invocation. A source whose module sets `enabled: false` (only `striive` today)
is skipped by the config list but runs when you name it explicitly.

Boards that ignore search terms — most of the remote ones — are run once rather than once
per query; `--list-sources` and the panel's board table both say which.

Indeed is the slow one — a full sweep is ~72 pages and takes about half an hour. On a
memory-tight host (Chromium is the hungry part) split it into chunks; the store is
written after every page, so picking up where you left off just works:

```bash
node src/cli.js --source indeed --start-page 0  --max-pages 12 --scrape-only
node src/cli.js --source indeed --start-page 12 --max-pages 12 --scrape-only
...
npm run vault
```

Noorderlink needs none of that — the whole board comes back in a few seconds.

### The control panel, in Obsidian

The whole scraper is drivable from the vault it fills — there is no separate web UI.
`Profile/Scraper.md` is the control panel: tick the **boards** and the **queries** you
want, edit the search settings, press **Run**, and watch the output stream into
`Profile/Scraper Log.md`, which the panel embeds.

The note's own properties **are** `config.json`. Meta Bind draws an input field per
property, the Buttons plugin fires a Shell command, and that command is
`src/vault-ui.js`, which folds the properties back into the file:

```bash
npm run panel pull      # config.json → Profile/Scraper.md
npm run panel push      # Profile/Scraper.md → config.json
npm run panel run       # push, then scrape in the background
npm run panel stop      # stop the run that is going
npm run panel status    # refresh the log note's numbers
```

Runs are detached, so Obsidian is never blocked by a scrape that takes half an hour, and
they survive closing it. Every ticked query runs against every ticked board, one CLI
invocation at a time, so the log always says which board is busy and a stop only loses
the page in flight — everything scraped before it is already saved. Boards that ignore
search terms are run once rather than once per query.

Editing `config.json` by hand still works; press **Reload settings** in the panel
afterwards to pull the changes into the note.

#### Setting it up

The panel needs three community plugins. Their settings are committed with the vault, but
the plugins themselves are not — in a fresh clone, open `JobVault/` in Obsidian and install
them from *Settings → Community plugins*, then enable them. Their configuration in
`.obsidian/` is picked up as they load, so the nine Scraper commands and every field in the
panel are there the moment they are on:

| Plugin | Does |
|---|---|
| [Buttons](https://github.com/shabegom/buttons) | Draws the buttons in the note |
| [Shell commands](https://github.com/Taitava/obsidian-shellcommands) | Runs them — nine commands, all calling `../scraper/src/vault-ui.js` from the vault folder |
| [Meta Bind](https://github.com/mProjectsCode/obsidian-meta-bind-plugin) | Draws the tick lists, toggles and number fields |

The Shell commands themselves live in
`JobVault/.obsidian/plugins/obsidian-shellcommands/data.json`, and they are also in the
command palette (*Shell commands: Execute: Scraper: …*), so any of them can take a
hotkey. They need `node` on the `PATH` of whatever launched Obsidian.

Two values read differently in the note than in the config file, because an empty string
is invisible in a form: a query of `*` means *every job* (`""` in `config.json`), and a
job type of `any` means *no filter*.

Everything lands in two places:

- `data/jobs.json` — the durable store, keyed by `<source>:<the board's own id>`
- `../JobVault/` — the generated Obsidian vault (`vaultPath` in `config.json`)

## Configuration

Top-level keys in `config.json` are the **global** settings, shared by every source:

| Key | Default | Meaning |
|---|---|---|
| `sources` | `["indeed"]` | Which boards to scrape |
| `sourceOptions` | `{}` | Per-source overrides, keyed by source id (see below) |
| `dedupeAcrossSources` | `true` | Merge the same vacancy found on several boards into one note |
| `location` | `9711 Groningen` | Search location — a postcode keeps it a real circle around the city (see below) |
| `center` | Groningen 9711 | `{lat, lng}` behind `location`, for the sources that return coordinates and can filter on true distance |
| `radius` | `25` | Search radius in km, applied by the local sources only |
| `regionInclude` | see below | Regex deciding which stated candidate regions count as reachable from here. `null` disables the filter |
| `regionExclude` | `null` | Regex that overrides an include match |
| `keepUnknownRegion` | `true` | Keep listings that state no region at all |
| `queries` | `[""]` | Search terms; empty string means *every* job |
| `maxAgeDays` | `null` | Only jobs newer than N days |
| `maxPagesPerQuery` | `80` | Page cap per query |
| `locationInclude` | `null` | Regex — keep only jobs whose location matches |
| `locationExclude` | `null` | Regex — drop jobs whose location matches (e.g. `"Nederland"`) |
| `staleAfterDays` | `45` | Mark a job closed after this long unseen |
| `vaultPath` | `../JobVault` | Where the vault is written |

Indeed-specific (they are top-level for historical reasons, and only Indeed reads them):
`host`, `sort`, `jobType`, `pageSize`, `delayMs`, `recycleEvery`, `headless`.

### Two kinds of geography

The boards split into two groups and the pipeline treats them differently.

**Local boards** (`indeed`, `noorderlink`, `striive`) list jobs with a real address.
`radius` applies to them as a circle around `center`. Where a board returns coordinates
— Noorderlink and Striive both do — that is a true great-circle distance rather than a
match on place names, which is far more accurate: 727 Noorderlink vacancies board-wide
come back as ~350 within 25 km.

**Remote boards** (everything else) are worldwide, and a radius means nothing to them.
What matters instead is whether a listing will take someone based here — "Remote (US
only)" is the single most common listing on every one of them. Each adapter reduces the
board's own way of saying this (Himalayas' `locationRestrictions`, Remotive's
comma-joined `candidate_required_location`, We Work Remotely's `<region>` element) to
plain place names, and `regionInclude` decides. The rule:

- the listing names regions and one matches → keep
- the listing names regions and none match → drop
- the listing names nothing → keep, unless `keepUnknownRegion` is `false`

The default pattern covers the Netherlands, Europe/EU/EMEA/EEA, the worldwide wordings
("Anywhere", "Global", "Worldwide"), Central-European timezones, and the individual
Western European countries. It is a plain regex in `src/sources/lib/region.js` — override
it with `regionInclude` in `config.json` if your situation differs. Typical yields per
run: RemoteOK keeps ~11%, Himalayas ~22%, Remotive ~80%, We Work Remotely ~95%.

### Per-source settings

A source declares its own defaults for any key whose global value is meaningless for it —
Indeed's seven-second delay makes no sense against a JSON API. Precedence is:

```
global config  <  the source's own defaults  <  sourceOptions[<id>]
```

so a change to a genuinely shared key like `radius` still reaches every board, while
`sourceOptions` remains the escape hatch:

```json
"sourceOptions": {
  "noorderlink": {
    "center": { "lat": 53.2194, "lng": 6.5665 },
    "pageSize": 100,
    "includeExpired": false,
    "enabled": true
  }
}
```

Setting `"enabled": false` leaves a source out of every run without removing it from
`sources`.

## The vault

```
JobVault/
├── Dashboard.md          counts, per-board totals, top employers, newest postings
├── Indexes/              All Jobs · New This Week · Remote Jobs · With Salary · By Company · By Source · To Apply · Closed Jobs
├── Jobs/                 one note per vacancy, with YAML frontmatter
├── Companies/            one note per employer, listing its jobs
├── Profile/              your experience, skills and education — hand-written, never regenerated
│   ├── Scraper.md        the control panel: settings and buttons (see above)
│   └── Scraper Log.md    what the last run said — generated, rewritten as it goes
└── Applications/         one folder per vacancy you marked, with its CV and cover letter
```

The first four are generated: they are rebuilt wholesale from `data/jobs.json` on
every run and are not a place to keep anything. The last two are the other half
of the vault — your side of the application rather than the board's — and the
scraper only ever adds to them. The two `Scraper` notes are the exception inside
`Profile/`: they belong to the control panel, and it maintains them.

Each job note carries frontmatter (`title`, `company`, `location`, `salary`, `hours`,
`job_types`, `categories`, `education`, `remote`, `posted`, `expires`, `sources`,
`source_urls`, `status`, …) so Obsidian properties, search and Dataview all work on it.

**Your edits survive re-runs.** On every rebuild the scraper rewrites only the
generated part of a note. It preserves:

- the `status:` field — set it to `interested`, `applied`, `interview`, `rejected`
- the `applied:` field
- anything you write under the `## Notes` heading

This holds across renames too: when a note's file name changes — because a key gained
its source prefix, or because two postings merged into one note — the edits are carried
over from the old file before it is removed.

Jobs that stop appearing are kept and marked `closed: true` after `staleAfterDays`, so
your history doesn't evaporate. Only the sources that actually ran are aged, so scraping
one board never quietly closes another's listings.

## The profile

`JobVault/Profile/` is the global answer to "what could go on my CV". It is
written once, as a set of empty templates on the first vault build, and after
that it is yours — nothing in it is ever regenerated, overwritten or removed.
(`Scraper.md` and `Scraper Log.md` share the folder but are not part of it; they
are the control panel.)

| Note | Holds |
|---|---|
| `Profile Basics.md` | Name, contact, links, headline, availability, languages, what you're looking for |
| `Experience.md` | Every role, with the raw material for bullets — write more of them than a CV would hold |
| `Skills.md` | What you can do, grouped, with an honest level and the years behind it |
| `Education.md` | Degrees, certifications, courses |
| `Projects.md` | Side projects and portfolio pieces — often the only evidence for a skill nobody has paid you for yet |
| `Voice.md` | How a CV and a letter of yours should read, and what to leave out |

Write it as a superset rather than as a CV. An application selects from it, so a
fact left out here can never appear on any CV, while one nobody needs is simply
not chosen. Each note carries `template: true` in its frontmatter until you
delete that line; the tooling warns while it is still there, because a CV
generated from placeholders is worse than no CV.

## Applying

The vacancies worth answering are picked by you, in Obsidian, and acted on by an
agent. The handover between the two is one field.

**1. Mark the job.** Open its note in `Jobs/` and change `status: new` to
`status: apply`. `status` is one of the fields the generator preserves, so the
mark survives every rescrape — and every marked vacancy shows up in
`Indexes/To Apply.md`. Anything you want the writer to know about this vacancy
in particular goes under `## Notes` in the same file; that is preserved too, and
copied into the brief.

**2. Gather them.** Press **Prepare the marked applications** in `Profile/Scraper.md`,
or from the shell:

```bash
npm run apply             # prepare a folder per marked vacancy
npm run apply -- --list   # just show me what I've marked
npm run apply -- --json   # the queue, for the agent
```

Each marked vacancy gets `Applications/<company> - <role>/`, containing:

- `Brief.md` — the job side of the application, gathered from the store: the
  advert text at its longest across every board that carried it, salary, hours,
  eligibility, benefits, the direct apply link, and your own notes on it.
  Regenerated on every run.
- `CV.md` and `Cover Letter.md` — empty stubs, for the writer.

**3. Write them.** In Claude Code, from the project root:

```
/apply
```

The skill reads the queue and spawns one `cv-writer` subagent per vacancy, in
parallel. Each one reads the brief, reads your whole `Profile/` folder, fetches
the live advert (boards abridge their listing pages, and the requirements are
what gets cut), and writes the CV and the letter in the language of the
vacancy. Both live in `.claude/` in the project root, so they are versioned with
the scraper rather than configured per machine.

The constraint the writer works under is that every fact it uses comes from
`Profile/`. It selects, orders and rephrases; it does not invent an employer, a
date, a number or a technology, and where the vacancy asks for something you
don't have it either says nothing or names the nearest real thing. Each writer
reports the gaps it found, which is usually the most useful output of the run —
a requirement that several vacancies ask for and your profile can't answer is
either a skill you have described badly or a real hole in your search.

**4. Edit them.** They are drafts. `npm run apply` never overwrites a CV or a
letter that has been written — only an untouched stub — so rerunning after
another scrape is safe. Anything you dislike about the writing belongs in
`Profile/Voice.md` as a rule, where it holds for every application after it.

When you send one, set `status: applied` and `applied: 2026-09-06` in the job
note. Both survive the next scrape, and the Dataview query on the dashboard
turns the vault into a pipeline.

### Deduplication

Two layers:

- **Within a board**, by that board's own id, so the store key is `indeed:3ec199e4…` or
  `noorderlink:82452`. Two boards can never collide.
- **Across boards**, by a fingerprint of company + title + place, normalised for the noise
  that differs between sites (`(m/v)`, `36 uur`, `B.V.`, postcodes, accents). Matching
  postings share one note that lists every place the vacancy was found, taking each field
  from whichever board gave the most.

  For remote work there is no city to compare and every board words the location
  differently, so the place is dropped from the fingerprint and company + title carry the
  match. This is where the deduplication earns its keep: one remote role is commonly
  listed on Remotive, RemoteOK, We Work Remotely and Himalayas at once, and without it the
  vault would carry four notes for one job.

The cross-board rule is deliberately conservative: a merge happens only when the postings
come from *different* boards and no board contributes more than one. Two listings with the
same fingerprint on the same board are much more likely to be two genuine vacancies than a
duplicate, so those stay separate. Set `dedupeAcrossSources: false` to turn it off.

## Adding a source

Drop a module in `src/sources/` exporting `id`, `label`, `kind`, `supportsQueries`,
`geoFiltered`, `blurb`, `defaults` and `scrape(cfg, { log, onPage })`, and add it to the
array in `src/sources/index.js`. The CLI, the panel's board list and the vault pick it up
from there.
Most of the work is already done for you in `src/sources/lib/`: `http.js` (retries,
back-off, User-Agent), `feed.js` (RSS/Atom), `jsonld.js` (schema.org JobPosting) and
`region.js` (eligibility). A feed-backed adapter is about 60 lines. `scrape` calls `onPage(jobs)` with a
batch of normalized jobs (see `baseJob` in `src/sources/util.js`) as often as it can — the
store checkpoints on every call, so an interrupted run keeps what it fetched.

Prefer, in order:

1. **A JSON API.** Most ATS-backed boards have one (Greenhouse, Lever, Recruitee, Workable,
   Personio), and so did Noorderlink. Plain `fetch`, milliseconds, nothing to block.
2. **`fetch` plus the `JobPosting` JSON-LD** most job pages embed.
3. **Playwright**, only when the first two fail. Indeed is the reason this tier exists.

Finding out which tier a new board is in is a job for a browser agent (Claude in Chrome):
point it at the site once, have it locate the embedded payload or the API call behind the
listing page, then hand-write the adapter from what it found. That is a development-time
tool, not a runtime one — an LLM in the loop per result page would be orders of magnitude
slower and more expensive than the adapter it writes, and the vault's dedup depends on
deterministic extraction.

## Known limits

- **Indeed caps a search at roughly 1000 results.** "Every job within 25 km of Groningen"
  is more than that, so a single empty query cannot return all of them. To go wider, give
  each slice its own 1000-result budget — results from every run merge into the same store:

  ```bash
  for t in fulltime parttime contract temporary internship; do
    npm run scrape -- --source indeed --job-type $t --scrape-only
  done
  npm run vault
  ```

- **The Indeed location has to be a postcode.** `l=Groningen` is normalised by Indeed to
  the *province*, which drags in Delfzijl, Eemshaven and Ter Apel — all well past 25 km.
  `l=9711 Groningen` (the city centre postcode) gives a genuine 25 km circle.
- **Noorderlink filters by real distance.** Its API returns coordinates, so the adapter
  applies `radius` as an actual circle around `sourceOptions.noorderlink.center` rather
  than matching place names — 727 vacancies board-wide came back as 349 within 25 km. A
  listing with no coordinates at all is kept rather than guessed at.
- **The remote boards do not all state eligibility.** RemoteOK in particular often leaves
  the location blank; with `keepUnknownRegion: true` (the default) those are kept, so some
  US-only roles get through. Set it to `false` to be strict at the cost of losing genuine
  worldwide listings.
- **DailyRemote hides some employers** behind its paid tier — the JSON-LD says
  "[Unlock with Premium]". Those are stored as `Onbekend` rather than as one giant fake
  employer, which would otherwise wreck the cross-board clustering.
- **Himalayas caps a page at 20** whatever `limit` asks for, and the board is very large
  (100k+ listings, roughly a fifth open to this region), so `maxPagesPerQuery` is what
  decides how much of it you see. Its default is 40 pages.
- **Striive is expensive.** ~20 MB per page of 25 assignments, because every one embeds
  its client logo and recruiter photo as base64. It is off by default; if you turn it on,
  give it its own schedule rather than running it beside everything else.
- **`noorderlink.nl/robots.txt` disallows `/api/*` for crawlers.** This adapter reads eight
  pages for one person's job search, identifies itself in the `User-Agent` and pauses
  between requests — considerably less traffic than paging the HTML would cost. If you'd
  rather not, set `"enabled": false` under `sourceOptions.noorderlink`.
- **A few promoted Indeed listings ignore the radius** and show up as "Nederland" or another
  province. Indeed's payload no longer distinguishes promoted from organic results, so
  there is nothing reliable to filter on — use `locationExclude` if they bother you.
- Indeed serves the same jobs at slightly different offsets, so ~1080 result cards came back
  as 911 unique listings on the first full run. The scraper stops once a page adds nothing new.
- Every result page is written straight to `data/jobs.json`, so an interrupted run (or an
  OOM kill) keeps everything fetched up to that point. Just run it again to carry on.
- Indeed blocks obvious automation. This scraper spaces requests out, reuses a browser
  profile in `.browser-profile/`, and backs off when it hits a challenge page. Hammering it
  will still get you a temporary block; the run reports which queries were cut short.

## Scheduling

The boards cost wildly different amounts, so splitting them by schedule beats one daily
sweep. The cheap ones are a handful of HTTP requests; Indeed is half an hour of Chromium.

```bash
# Remote boards and the cheap local ones — seconds, safe to run often
0  */4 * * * /usr/bin/node src/cli.js --sources noorderlink,hoofdkraan,landingjobs,remotive,jobicy,remoteok,workingnomads,weworkremotely,remoteyeah --scrape-only >> data/scrape.log 2>&1

# The ones that fetch per listing — slower, once a day is plenty
30 6   * * * /usr/bin/node src/cli.js --sources himalayas,fourdayweek,dailyremote --scrape-only >> data/scrape.log 2>&1

# Indeed: the expensive one
0  7   * * * /usr/bin/node src/cli.js --source indeed >> data/scrape.log 2>&1

# Striive, if you want it: 20 MB a page, so weekly and on its own
0  5   * * 1 /usr/bin/node src/cli.js --source striive >> data/scrape.log 2>&1
```

Note the `--scrape-only` on the frequent runs: the vault is rebuilt once, by the Indeed
run at the end, rather than 6 times a day. `finalizeRun` only ages the sources that
actually ran, so a partial run never closes another board's listings.
