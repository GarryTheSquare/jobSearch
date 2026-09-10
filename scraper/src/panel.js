/* The Obsidian control panel: Profile/Scraper.md and Profile/Scraper Log.md.

   The panel note's front matter *is* the form. Meta Bind renders an input per
   property, the Buttons plugin fires a Shell command, and that command is
   src/vault-ui.js, which reads the front matter back and folds it into
   config.json. This module owns both directions of that translation and the
   look of the two notes; vault-ui.js owns the running.

   Two values are spelled differently in the note than in config.json, because
   an empty string is invisible in a form:

     queries  — "*" in the note means "" in the config: every job, no search term
     jobType  — "any" in the note means "": no job-type filter

   Everything else is passed through untouched, and every config key the panel
   does not know about is left exactly as it was found. */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { splitFrontMatter, withFrontMatter } from "./yaml-lite.js";
import { describeSources, sourceIds } from "./sources/index.js";
import { ROOT } from "./config.js";

export const PANEL_FILE = join("Profile", "Scraper.md");
export const LOG_FILE = join("Profile", "Scraper Log.md");
export const CONFIG_FILE = join(ROOT, "config.json");

export const panelPath = (vault) => join(vault, PANEL_FILE);
export const logPath = (vault) => join(vault, LOG_FILE);

export const ALL_JOBS = "*";   // how "search for everything" is written in the note
export const ANY_TYPE = "any"; // how "no job-type filter" is written in the note

/* Config keys the panel owns. Anything else in config.json — center, pageSize,
   host, regionInclude, dataFile — is never touched by a save. */
const NUMBERS = ["radius", "maxAgeDays", "maxPagesPerQuery", "startPage", "staleAfterDays", "recycleEvery"];
const BOOLEANS = ["headless", "dedupeAcrossSources", "keepUnknownRegion"];
const STRINGS = ["location", "sort", "locationInclude", "locationExclude", "vaultPath"];

const FALLBACKS = {
  location: "9711 Groningen", radius: 25, sort: "date", jobType: "",
  maxAgeDays: null, maxPagesPerQuery: 80, startPage: 0,
  locationInclude: null, locationExclude: null, staleAfterDays: 45,
  dedupeAcrossSources: true, keepUnknownRegion: true, headless: true,
  recycleEvery: 20, delayMs: [7000, 14000], vaultPath: "../JobVault",
};

export function readConfigFile() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return {};
  }
}

/* ---------- config.json → note ---------- */

export function configToPanel(raw) {
  const value = (key) => (raw[key] === undefined ? FALLBACKS[key] : raw[key]);
  const delay = Array.isArray(value("delayMs")) ? value("delayMs") : FALLBACKS.delayMs;
  return {
    tags: ["scraper"],
    sources: enabledSources(raw),
    queries: (Array.isArray(raw.queries) && raw.queries.length ? raw.queries : [""]).map((q) => (q === "" ? ALL_JOBS : q)),
    location: value("location"),
    radius: value("radius"),
    sort: value("sort") || "date",
    jobType: value("jobType") || ANY_TYPE,
    maxAgeDays: value("maxAgeDays"),
    maxPagesPerQuery: value("maxPagesPerQuery"),
    startPage: value("startPage"),
    locationInclude: value("locationInclude"),
    locationExclude: value("locationExclude"),
    staleAfterDays: value("staleAfterDays"),
    dedupeAcrossSources: value("dedupeAcrossSources"),
    keepUnknownRegion: value("keepUnknownRegion"),
    headless: value("headless"),
    delayMinMs: delay[0],
    delayMaxMs: delay[1],
    recycleEvery: value("recycleEvery"),
    vaultPath: value("vaultPath"),
  };
}

/* A board counts as ticked when it is in `sources` *and* nothing has switched
   it off underneath — otherwise the tick would promise a run that never
   happens. See resolveSources() in sources/index.js for the same rule. */
export function enabledSources(raw) {
  const listed = Array.isArray(raw.sources) ? raw.sources : [];
  const known = new Set(sourceIds());
  return listed.filter((id) => {
    if (!known.has(id)) return false;
    const override = raw.sourceOptions?.[id]?.enabled;
    if (override !== undefined) return override !== false;
    return describeSources().find((s) => s.id === id)?.defaultEnabled !== false;
  });
}

/* ---------- note → config.json ---------- */

export function panelToConfig(front, raw) {
  const next = { ...raw };
  const missing = (key) => front[key] === undefined;

  if (Array.isArray(front.sources)) {
    const unknown = front.sources.filter((id) => !sourceIds().includes(id));
    if (unknown.length) throw new Error(`unknown board(s) in "sources": ${unknown.join(", ")}`);
    if (!front.sources.length) throw new Error(`no boards ticked — pick at least one under "Boards"`);
    next.sources = [...new Set(front.sources)];
    // A board that is off by default, or was switched off by hand, has to be
    // switched back on explicitly or ticking it would do nothing.
    const options = { ...(next.sourceOptions || {}) };
    for (const id of next.sources) {
      const isDefaultOff = describeSources().find((s) => s.id === id)?.defaultEnabled === false;
      if (options[id]?.enabled === false || (isDefaultOff && options[id]?.enabled !== true)) {
        options[id] = { ...options[id], enabled: true };
      }
    }
    next.sourceOptions = options;
  }

  if (Array.isArray(front.queries)) {
    const queries = [...new Set(front.queries.map((q) => String(q ?? "").trim()).map((q) => (q === ALL_JOBS ? "" : q)))];
    if (!queries.length) throw new Error(`no queries listed — "${ALL_JOBS}" means every job`);
    next.queries = queries;
  }

  for (const key of NUMBERS) {
    if (missing(key)) continue;
    if (front[key] === null || front[key] === "") next[key] = key === "startPage" ? 0 : null;
    else if (typeof front[key] === "number") next[key] = front[key];
    else throw new Error(`"${key}" must be a number, got ${JSON.stringify(front[key])}`);
  }

  for (const key of BOOLEANS) {
    if (missing(key)) continue;
    if (typeof front[key] !== "boolean") throw new Error(`"${key}" must be true or false`);
    next[key] = front[key];
  }

  for (const key of STRINGS) {
    if (missing(key)) continue;
    const text = front[key] === null ? null : String(front[key]).trim();
    next[key] = text === "" ? null : text;
  }
  if (!next.location) throw new Error(`"location" cannot be empty`);
  if (!next.vaultPath) next.vaultPath = FALLBACKS.vaultPath;
  if (next.sort !== "date" && next.sort !== "relevance") throw new Error(`"sort" must be date or relevance`);

  if (!missing("jobType")) {
    const type = String(front.jobType ?? "").trim();
    next.jobType = type === ANY_TYPE || type === "" ? "" : type;
  }

  if (!missing("delayMinMs") || !missing("delayMaxMs")) {
    const current = Array.isArray(raw.delayMs) ? raw.delayMs : FALLBACKS.delayMs;
    const min = Number(front.delayMinMs ?? current[0]);
    const max = Number(front.delayMaxMs ?? current[1]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error(`the delay has to be two numbers`);
    next.delayMs = [min, Math.max(min, max)];
  }

  return next;
}

export function writeConfigFile(config) {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

/* ---------- the notes ---------- */

export function readPanel(vault) {
  const path = panelPath(vault);
  if (!existsSync(path)) throw new Error(`${PANEL_FILE} does not exist yet — press "Reload settings", or run: npm run panel pull`);
  const { data, body, hasFrontMatter } = splitFrontMatter(readFileSync(path, "utf8"));
  if (!hasFrontMatter) throw new Error(`${PANEL_FILE} has no properties block — press "Reload settings" to rebuild it`);
  return { front: data, body, path };
}

export function writePanel(vault, front) {
  const path = panelPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, withFrontMatter(front, panelBody()));
  return path;
}

/* Called by the vault build so a fresh vault comes with the panel already in
   it, without ever overwriting one that exists — the values in it may be
   newer than the ones on disk. */
export function writePanelIfMissing(vault) {
  if (existsSync(panelPath(vault))) return null;
  return writePanel(vault, configToPanel(readConfigFile()));
}

const BUTTON = (name, alias, color) =>
  ["```button", `name ${name}`, "type command", `action Shell commands: Execute: ${alias}`, ...(color ? [`color ${color}`] : []), "```"].join("\n");

function sourceOptions() {
  return describeSources()
    .map((s) => `option(${s.id}, ${s.label} · ${s.geoFiltered ? "local" : "remote"})`)
    .join(", ");
}

function boardTable() {
  const rows = describeSources().map(
    (s) =>
      `| ${s.label} | \`${s.id}\` | ${s.geoFiltered ? "local" : "remote"} | ${s.kind === "browser" ? "browser" : "api"} | ${s.blurb} |`,
  );
  return ["| Board | id | Geography | How | What it is |", "|---|---|---|---|---|", ...rows].join("\n");
}

function panelBody() {
  return `
# Job scraper

The control panel for the scraper that fills this vault. The properties of this
note **are** \`scraper/config.json\`: change one below, press **Save settings**,
and the file is rewritten. **Run** saves first, so you never need both.

Runs happen in the background — Obsidian is free while a scrape that takes half
an hour goes on. The output lands in [[Scraper Log]], live, and the vault is
rebuilt when the queue empties.

> [!info]- Which plugins this note needs
> **Buttons** draws the buttons, **Shell commands** is what they run, and
> **Meta Bind** draws the input fields. All three are installed and enabled in
> this vault; nothing here works with them switched off. The commands
> themselves are configured under *Settings → Shell commands* and all call
> \`../scraper/src/vault-ui.js\` from the vault folder.

## Run

${BUTTON("▶ Run — every ticked board", "Scraper: run", "blue")}

${BUTTON("Run the local boards only", "Scraper: run local boards")}

${BUTTON("Run the remote boards only", "Scraper: run remote boards")}

${BUTTON("■ Stop", "Scraper: stop", "red")}

${BUTTON("Rebuild the vault from stored jobs", "Scraper: rebuild vault")}

${BUTTON("Refresh the status", "Scraper: refresh status")}

Every ticked query runs against every ticked board, one board at a time, so the
log always says which one is busy and a stop only loses the page in flight.
Everything scraped before a stop is already saved.

## Settings

${BUTTON("Save settings → config.json", "Scraper: save settings", "green")}

${BUTTON("Reload settings from config.json", "Scraper: reload settings")}

Reloading throws away edits made here that were never saved.

### Boards

Which job boards to search. All of them write into the same store and the same
vault; a vacancy found on more than one board becomes a single note that lists
them all.

\`\`\`meta-bind
INPUT[multiSelect(${sourceOptions()}):sources]
\`\`\`

${boardTable()}

*Local* boards are filtered by the radius below. *Remote* boards are worldwide,
so they are filtered on whether the listing says someone here may apply.
*Browser* means the board is scraped with Chromium — slow, memory-hungry, and
rate-limited; the rest are plain HTTP.

### Queries

Every query runs against every board. \`${ALL_JOBS}\` is not a search term: it
means *every job*, no keyword. Boards that ignore search terms are run once
rather than once per query.

\`\`\`meta-bind
INPUT[list:queries]
\`\`\`

### Where

- **Location** \`INPUT[text:location]\` — a postcode keeps it a real circle around the city
- **Radius (km)** \`INPUT[number:radius]\` — local boards only
- **Keep listings that state no region** \`INPUT[toggle:keepUnknownRegion]\` — remote boards only
- **Only keep locations matching (regex)** \`INPUT[text:locationInclude]\`
- **Drop locations matching (regex)** \`INPUT[text:locationExclude]\`

### What

- **Sort** \`INPUT[inlineSelect(option(date, newest first), option(relevance, best match)):sort]\`
- **Job type** \`INPUT[inlineSelect(option(any), option(fulltime), option(parttime), option(contract), option(temporary), option(internship)):jobType]\`
- **Only jobs posted in the last … days** \`INPUT[number:maxAgeDays]\` — empty means any age
- **Merge the same vacancy across boards** \`INPUT[toggle:dedupeAcrossSources]\`
- **Mark a job closed after … days unseen** \`INPUT[number:staleAfterDays]\`

Sort and job type are Indeed's; the other boards ignore them.

### How hard to go

- **Pages per query** \`INPUT[number:maxPagesPerQuery]\` — 15 jobs a page; a full Indeed sweep is ~72
- **Start at page** \`INPUT[number:startPage]\` — for splitting a long run in half
- **Wait between pages, from** \`INPUT[number:delayMinMs]\` **to** \`INPUT[number:delayMaxMs]\` **ms**
- **Restart the browser every … pages** \`INPUT[number:recycleEvery]\`
- **Hide the browser window** \`INPUT[toggle:headless]\` — a visible one needs a display
- **Vault folder** \`INPUT[text:vaultPath]\` — relative to \`scraper/\`; this vault is the default

## Applying

Mark a vacancy by setting \`status: apply\` in its note; it then shows up in
[[To Apply]]. This gathers each marked job into an application folder with the
facts a CV needs:

${BUTTON("Prepare the marked applications", "Scraper: prepare applications")}

Then, in Claude Code from the project root, run \`/apply\` to have the CV and
the letter written from your [[README|Profile]] notes.

## Status

![[Scraper Log]]
`;
}

/* ---------- the log note ---------- */

const pad = (n) => String(n).padStart(2, "0");
const stamp = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

export function renderLogNote({ state, headline, rows, log }) {
  const front = { tags: ["scraper"], state, updated: stamp(new Date()) };
  const table = ["| | |", "|---|---|", `| Status | ${headline} |`, ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join("\n");
  const body = `
# Scraper log

*Generated — the scraper rewrites this note. The controls are in [[Scraper]].*

${table}

\`\`\`text
${log.trim() || "Nothing has run yet."}
\`\`\`
`;
  return withFrontMatter(front, body);
}

/* The log block of an existing log note, so a status refresh can rewrite the
   table above it without throwing the last run's output away. */
export function existingLog(vault) {
  try {
    const text = readFileSync(logPath(vault), "utf8");
    return text.match(/```text\n([\s\S]*?)```/)?.[1] ?? "";
  } catch {
    return "";
  }
}

export function writeLogNote(vault, note) {
  const path = logPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, note);
  return path;
}

export const relativeToRoot = (path) => resolve(path).replace(resolve(ROOT, ".."), "").replace(/^\//, "");
