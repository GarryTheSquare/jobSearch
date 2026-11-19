import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { clusterJobs } from "./dedupe.js";
import { labelFor, sourceIds } from "./sources/index.js";
import { fileKey } from "./sources/util.js";
import { scaffoldProfile, PROFILE_DIR } from "./profile.js";
import { writePanelIfMissing } from "./panel.js";
import { markedJobs, applicationDirName, DEFAULT_MARKS, APPLICATIONS_DIR } from "./apply.js";
import { writeBasesIfMissing, removeLegacyIndexes, JOBS_BASE, BOARDS_BASE, COMPANIES_BASE } from "./bases.js";

const NOTES_HEADING = "## Notes";
const today = () => new Date().toISOString().slice(0, 10);

/* Obsidian chokes on these in file names; a few are illegal on Windows too. */
export function safeName(str, max = 90) {
  const cleaned = String(str)
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned.length > max ? cleaned.slice(0, max).trim() : cleaned) || "Untitled";
}

const esc = (v) => `"${String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/[[\]]/g, "").replace(/\n/g, " ");
const list = (arr) => `[${(arr || []).map(esc).join(", ")}]`;
const uniq = (arr) => [...new Set((arr || []).filter(Boolean))];

/* A wikilink points at a file that already exists, so its target must be
   sanitised the same way the name was but never shortened. The 90-character cap
   belongs to name *creation*; re-applying it when linking truncated the target
   of every note whose name ran long, which was most of them. */
const linkTo = (file) => safeName(String(file).replace(/\.md$/, ""), Infinity);

export function jobFileName(job) {
  return `${safeName(`${job.company} - ${job.title}`)} (${fileKey(job.jobkey)}).md`;
}

/* What the file was called back when every job came from Indeed and the key was
   a bare jobkey. Used once, to carry hand-edited notes across the rename. */
function legacyFileName(job) {
  if (job.source !== "indeed") return null;
  return `${safeName(`${job.company} - ${job.title}`)} (${job.sourceId}).md`;
}

/* A note stands for one vacancy, which may have been found on several boards.
   `anchor` fixes the file name (earliest sighting, so it never moves), while
   `primary` supplies the content (whichever board told us the most). */
export function toEntry(cluster) {
  const anchor = cluster.members
    .slice()
    .sort((a, b) => (a.firstSeen || "").localeCompare(b.firstSeen || "") || String(a.jobkey).localeCompare(String(b.jobkey)))[0];
  return {
    anchor,
    primary: cluster.primary,
    members: cluster.members,
    file: jobFileName(anchor),
    closed: cluster.members.every((j) => j.closed),
  };
}

/* Every vacancy as the vault sees it: postings clustered across boards, one
   entry per (potential) note. The job browser builds its list from this too, so
   the two can never disagree about which postings are the same vacancy. */
export function jobEntries(cfg, store) {
  return clusterJobs(Object.values(store.jobs), { enabled: cfg.dedupeAcrossSources !== false }).map(toEntry);
}

/* Existing notes may carry hand-edited status and free-form notes; keep both. */
export function readExisting(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const frontmatter = raw.startsWith("---\n") ? raw.slice(4, raw.indexOf("\n---", 4)) : "";
  const field = (name) =>
    frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^"|"$/g, "");
  const idx = raw.indexOf(NOTES_HEADING);
  const notes = idx === -1 ? "" : raw.slice(idx + NOTES_HEADING.length).replace(/^\n+/, "").trimEnd();
  return { status: field("status"), applied: field("applied"), fit: fitValue(field("fit")), notes };
}

/* A fit rating, 0–100, as typed in a note or stored in the ratings file. */
function fitValue(value) {
  const n = Number(value);
  return value !== undefined && value !== null && value !== "" && Number.isFinite(n) && n >= 0 && n <= 100
    ? Math.round(n)
    : undefined;
}

/* How well each vacancy suits the candidate, rated against the Profile notes and
   kept in `Profile/fit.json` as { jobkey: 0–100 }. It lives in Profile/ rather
   than in the job notes because most vacancies have no note in "marked" mode,
   and Profile/ is never regenerated. A `fit:` typed into a note wins over it. */
export const FIT_FILE = "fit.json";
export function loadFit(vault) {
  try {
    const raw = JSON.parse(readFileSync(join(vault, PROFILE_DIR, FIT_FILE), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function fitFor(entry, existing, ratings) {
  if (existing?.fit !== undefined) return existing.fit;
  for (const key of [entry.anchor.jobkey, ...entry.members.map((m) => m.jobkey)]) {
    const n = fitValue(ratings?.[key]);
    if (n !== undefined) return n;
  }
  return undefined;
}

/* Statuses a note is given by this file. Any other value was typed by hand, so
   a note carrying one has been looked at and is never pruned. */
const AUTO_STATUSES = new Set(["new", "closed"]);

/* Untouched: an automatic status, no application date, and nothing written
   under `## Notes` — the three places the user's own work can be. A note that
   has never been opened reads as untouched too. */
export function untouched(existing) {
  if (!existing) return true;
  if (existing.status && !AUTO_STATUSES.has(existing.status)) return false;
  if (existing.applied && existing.applied !== "null") return false;
  return !existing.notes.trim();
}

/* A vacancy that has been delisted for a while and that nobody ever marked.
   `data/jobs.json` keeps the record — firstSeen, lastSeen, the closed flag and
   so the history — so pruning the note loses nothing, and the note is written
   again should the vacancy ever be relisted. */
function prunable(entry, existing, before) {
  if (!before || !entry.closed) return false;
  const lastSeen = entry.members.map((m) => m.lastSeen).filter(Boolean).sort().at(-1);
  if (!lastSeen || lastSeen >= before) return false;
  return untouched(existing);
}

/* Some boards attach their whole tag vocabulary to every listing — one Remotive
   job carries 54 of them — which is noise in a note. Keep a usable head. */
function capped(values, limit = 12) {
  const all = uniq(values);
  return all.length > limit ? [...all.slice(0, limit), `+${all.length - limit} more`] : all;
}

/* Remote boards state where a candidate may be based. A long eligibility list
   is noise in a table, so it is trimmed with a count of the remainder. */
function remoteRow(members) {
  if (!members.some((m) => m.remote)) return "no";
  const labels = uniq(members.flatMap((m) => m.remoteLabels));
  const regions = uniq(members.flatMap((m) => m.regions));
  const sameAsRegions = labels.length && labels.every((l) => regions.includes(l));
  return sameAsRegions || !labels.length ? "yes" : labels.slice(0, 6).join(", ");
}

function regionSummary(members) {
  const all = uniq(members.flatMap((m) => m.regions));
  if (!all.length) return "—";
  const shown = all.slice(0, 8).join(", ");
  return all.length > 8 ? `${shown} +${all.length - 8} more` : shown;
}

function hours(job) {
  if (!job.hoursMin && !job.hoursMax) return "";
  if (job.hoursMin && job.hoursMax && job.hoursMin !== job.hoursMax) return `${job.hoursMin}–${job.hoursMax} uur`;
  return `${job.hoursMax || job.hoursMin} uur`;
}

/* The hand edits for an entry: from its own note, or — on the first run after a
   rename (a key that gained its source prefix, or two postings that merged into
   one note) — from whichever old file had them. `from` names that old file. */
export function findExisting(jobsDir, entry) {
  const existing = readExisting(join(jobsDir, entry.file));
  if (existing) return { existing, from: null };
  for (const member of entry.members) {
    for (const name of [jobFileName(member), legacyFileName(member)].filter(Boolean)) {
      if (name === entry.file) continue;
      const old = join(jobsDir, name);
      if (!existsSync(old)) continue;
      const found = readExisting(old);
      if (found) return { existing: found, from: name };
    }
  }
  return { existing: null, from: null };
}

/* Which jobs get a note. "all" is the original behaviour: a note per vacancy.
   "marked" writes notes only for vacancies you have touched — a status set, an
   applied date, something under `## Notes` — and leaves the other thousands to
   the job browser (`npm run browse`), which reads the store directly. Obsidian
   indexes files, so this is the difference between a vault of 15 000 notes and
   one of a few dozen. */
export const NOTE_MODES = ["marked", "all"];
export const noteMode = (cfg) => (NOTE_MODES.includes(cfg.jobNotes) ? cfg.jobNotes : "marked");

function jobNote(entry, existing, ratings) {
  const job = entry.primary;
  const fit = fitFor(entry, existing, ratings);
  const members = entry.members;
  const closed = entry.closed;
  const status = existing?.status || (closed ? "closed" : "new");
  const tags = ["job", `job/${status}`];
  if (members.some((m) => m.remote)) tags.push("job/remote");
  if (members.some((m) => m.easyApply)) tags.push("job/easy-apply");
  for (const m of members) tags.push(`job/source/${m.source}`);

  const sources = uniq(members.map((m) => m.source));
  const found = uniq(members.flatMap((m) => m.queries || [m.query || ""]).map((q) => q || "(all jobs)"));
  const rated = members.find((m) => m.companyRating);
  const postedAt = members.map((m) => m.postedAt).filter(Boolean).sort()[0] || null;
  const firstSeen = members.map((m) => m.firstSeen).filter(Boolean).sort()[0];
  const lastSeen = members.map((m) => m.lastSeen).filter(Boolean).sort().at(-1);

  const fm = [
    "---",
    `title: ${esc(job.title)}`,
    `company: ${esc(job.company)}`,
    /* The same employer again, as a link: a Base renders it as a clickable
       column, which a plain string cannot be. The note it points at is named
       with safeName, so the link has to be spelled the same way. */
    `company_note: ${esc(`[[${safeName(job.company)}]]`)}`,
    `location: ${esc(job.location)}`,
    `city: ${esc(job.city)}`,
    `salary: ${esc(members.map((m) => m.salary).find(Boolean) || "")}`,
    `hours: ${esc(hours(job))}`,
    `job_types: ${list(uniq(members.flatMap((m) => m.jobTypes)))}`,
    `categories: ${list(capped(members.flatMap((m) => m.categories)))}`,
    `education: ${list(uniq(members.flatMap((m) => m.education)))}`,
    `remote: ${members.some((m) => m.remote)}`,
    `regions: ${list(uniq(members.flatMap((m) => m.regions)).slice(0, 12))}`,
    `easy_apply: ${members.some((m) => m.easyApply)}`,
    // Left empty rather than "unknown" when no board dated the posting: the
    // property stays a date, which is what the Bases views sort and filter on.
    postedAt ? `posted: ${postedAt}` : "posted:",
    `posted_relative: ${esc(job.postedRelative)}`,
    `expires: ${members.map((m) => m.expiresAt).filter(Boolean).sort()[0] || "null"}`,
    `url: ${job.url}`,
    `jobkey: ${entry.anchor.jobkey}`,
    `sources: ${list(sources)}`,
    `source_urls: ${list(members.map((m) => m.url))}`,
    `found_by: ${list(found)}`,
    `company_rating: ${rated?.companyRating ?? "null"}`,
    `first_seen: ${firstSeen}`,
    `last_seen: ${lastSeen}`,
    `closed: ${closed}`,
    `status: ${status}`,
    `applied: ${existing?.applied || "null"}`,
    // Left empty when the vacancy has not been rated, like `posted`: the
    // property stays a number for Bases to sort on.
    fit === undefined ? "fit:" : `fit: ${fit}`,
    `tags: ${list(tags)}`,
    "---",
    "",
  ];

  const facts = [
    // How well the vacancy suits you, from Profile/fit.json or the note's own
    // `fit:` — the same number as the property, where it can be read at a glance.
    ["Fit", fit === undefined ? "—" : `${fit} / 100`],
    ["Company", `[[${safeName(job.company)}]]`],
    ["Location", job.location || "—"],
    ["Salary", members.map((m) => m.salary).find(Boolean) || "—"],
    ["Hours", hours(job) || "—"],
    ["Type", uniq(members.flatMap((m) => m.jobTypes)).join(", ") || "—"],
    ["Field", capped(members.flatMap((m) => m.categories)).join(", ") || "—"],
    ["Education", uniq(members.flatMap((m) => m.education)).join(", ") || "—"],
    // On the remote boards the labels are the eligibility list, which the next
    // row already spells out; repeating it here says nothing.
    ["Remote", remoteRow(members)],
    ["Open to", regionSummary(members)],
    ["Posted", postedAt ? `${postedAt}${job.postedRelative ? ` (${job.postedRelative})` : ""}` : job.postedRelative || "—"],
    ["Closes", job.expiresAt || "—"],
    ["Rating", rated?.companyRating ? `${rated.companyRating} ★ (${rated.companyReviews} reviews)` : "—"],
    ["Found on", sources.map((s) => labelFor(s)).join(" · ")],
    ["Status", status + (closed ? " · no longer listed" : "")],
  ];

  const links = members
    .slice()
    .sort((a, b) => a.source.localeCompare(b.source))
    .map((m) => `- **[${labelFor(m.source)}](${m.url})**${m.applyUrl ? ` · [apply direct](${m.applyUrl})` : ""}${m.closed ? " _(delisted)_" : ""}`);

  const body = [
    "",
    `# ${job.title}`,
    "",
    ...links,
    "",
    "| | |",
    "|---|---|",
    ...facts.map(([k, v]) => `| **${k}** | ${cell(v)} |`),
    "",
    "## Summary",
    "",
    job.description || job.summary || "_No description in the search results._",
    "",
    NOTES_HEADING,
    "",
    existing?.notes || "",
    "",
  ];

  return fm.join("\n") + body.join("\n");
}

function companyNote(company, entries, existing) {
  const rated = entries.map((e) => e.members.find((m) => m.companyRating)).find(Boolean);
  const open = entries.filter((e) => !e.closed);
  const fm = [
    "---",
    `company: ${esc(company)}`,
    `open_jobs: ${open.length}`,
    `total_jobs_seen: ${entries.length}`,
    `rating: ${rated?.companyRating ?? "null"}`,
    `tags: ["company"]`,
    "---",
    "",
  ];
  const rows = entries
    .slice()
    .sort((a, b) => (b.primary.postedAt || "").localeCompare(a.primary.postedAt || ""))
    .map((e) => {
      const j = e.primary;
      return `| [[${linkTo(e.file)}\\|${cell(j.title)}]] | ${cell(j.location)} | ${cell(
        j.salary || "—"
      )} | ${j.postedAt || "—"} | ${uniq(e.members.map((m) => m.source)).join(", ")} | ${e.closed ? "closed" : "open"} |`;
    });
  const body = [
    "",
    `# ${company}`,
    "",
    rated?.companyRating ? `Rating: **${rated.companyRating} ★** (${rated.companyReviews} reviews)` : "",
    "",
    `${open.length} open, ${entries.length} seen in total.`,
    "",
    "| Job | Location | Salary | Posted | Sources | Status |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    NOTES_HEADING,
    "",
    existing?.notes || "",
    "",
  ];
  return fm.join("\n") + body.join("\n");
}

function dashboard(entries, cfg, meta) {
  const open = entries.filter((e) => !e.closed);
  const byCompany = new Map();
  for (const e of open) byCompany.set(e.primary.company, (byCompany.get(e.primary.company) || 0) + 1);
  const topCompanies = [...byCompany.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const fresh = open.filter((e) => (e.primary.postedAt || "") >= weekAgo);
  const remote = open.filter((e) => e.members.some((m) => m.remote));
  const withSalary = open.filter((e) => e.members.some((m) => m.salary));
  const merged = entries.filter((e) => e.members.length > 1);

  const sourceRows = meta.bySource.map(([id, n]) => `| ${labelFor(id)} | ${n} |`).join("\n");
  const overlap = merged.length
    ? `Boards overlap, so these add up to more than the vacancy count above — ${merged.length} ` +
      `${merged.length === 1 ? "vacancy was" : "vacancies were"} found on more than one board and ` +
      `${merged.length === 1 ? "shares" : "share"} a single note.`
    : "No vacancy has turned up on more than one board yet, so these add up to the count above.";

  return `---
tags: ["dashboard"]
updated: ${today()}
---

# Job Dashboard — ${cfg.location} (${cfg.radius} km)

Last run **${meta.scrapedAt}**${meta.lastSources.length ? ` — ${meta.lastSources.map(labelFor).join(", ")}` : ""}.

| Metric | Count |
|---|---|
| Open vacancies | ${open.length} |
| Posted in the last 7 days | ${fresh.length} |
| Remote / hybrid | ${remote.length} |
| With a salary listed | ${withSalary.length} |
| Distinct companies | ${byCompany.size} |
| Listed on more than one board | ${merged.length} |
| Closed / delisted | ${entries.length - open.length} |

## Listings per board

| Board | Postings stored |
|---|---|
${sourceRows}

${overlap}

## Browsing the vacancies

${
  meta.mode === "marked"
    ? `Only the vacancies you have marked have a note here — ${meta.notes} of ${open.length} open.
The rest live in the **job browser**, which searches all of them at once and is
where you mark one to apply:

\`\`\`bash
cd scraper && npm run browse     # then open http://localhost:${cfg.browsePort || 4173}
\`\`\`

(or the **Browse jobs** button on the [[Scraper]] panel). Marking a vacancy there
writes its note into \`Jobs/\`, so everything below keeps working on what you
picked. Set \`jobNotes: "all"\` in config.json to get a note for every vacancy back.`
    : `Every vacancy has a note in \`Jobs/\`. \`npm run browse\` gives a faster way to search
them; setting \`jobNotes: "marked"\` in config.json keeps only the ones you mark.`
}

## Indexes

- [[${JOBS_BASE}|Jobs]] — ${meta.mode === "marked" ? "the vacancies you have marked," : "every open vacancy,"} with a view per cut: posted this
  week, remote, salary stated, marked to apply, your pipeline, and the ones that
  have since been delisted.
- [[${BOARDS_BASE}|By board]] — the same vacancies, one view per board.
- [[${COMPANIES_BASE}|Companies]] — every employer seen, and how much it is hiring.
- [[To Apply]] — the shortlist, with the folder each application lands in.

Those three are [Bases](https://obsidian.md/help/bases): a query rather than a
table, built when you open the view, so filtering, sorting and adding a column
are yours to do. They are written once and never regenerated — delete one to get
the shipped views back.

## Your side of it

- [[Scraper]] — the control panel: which boards and queries to search, and the
  buttons that run them. Everything on this page comes from a run started there.
- [[README|Profile]] — your experience, skills and education, written once and
  reused by every application. Nothing in that folder is ever regenerated.
- [[To Apply]] — **${meta.marked}** ${meta.marked === 1 ? "vacancy is" : "vacancies are"} marked \`status: apply\`.

## Top employers

| Company | Open jobs |
|---|---|
${topCompanies.map(([c, n]) => `| ${meta.hasCompanyNote(c) ? `[[${safeName(c)}]]` : cell(c)} | ${n} |`).join("\n")}

${meta.mode === "marked" ? "" : `## New this week

![[${JOBS_BASE}#New this week]]

`}## Tracking your applications

Mark a vacancy in the job browser, or edit its note: every job note has a
\`status\` field in its frontmatter. Change it to \`interested\`,
\`apply\`, \`applied\`, \`interview\`, or \`rejected\` and it survives the next scrape — the
scraper only rewrites the generated parts of a note, never your edits below
\`${NOTES_HEADING}\`.

\`apply\` is the one the tooling acts on. Set it on a vacancy you want to respond
to, then run:

\`\`\`bash
cd scraper && npm run apply     # gathers each marked vacancy into ${APPLICATIONS_DIR}/
\`\`\`

and \`/apply\` in Claude Code, which writes a CV and a cover letter for each from
your [[README|Profile]] notes.

The **Pipeline** view in [[${JOBS_BASE}|Jobs]] groups every note you have
touched by its status, which turns the vault into a live pipeline — no plugin,
and nothing to rebuild:

![[${JOBS_BASE}#Pipeline]]
`;
}

/* The shortlist. Unlike the other indexes this one is built from what *you*
   wrote in the notes rather than from the store, so it doubles as a check that
   a mark took: a vacancy set to `apply` that is missing here has a typo in its
   status field. */
function toApplyNote(marked, entries) {
  const byKey = new Map(entries.map((e) => [String(e.anchor.jobkey), e]));
  const rows = marked.map((n) => {
    const e = byKey.get(String(n.fm.jobkey));
    const dir = `${APPLICATIONS_DIR}/${applicationDirName(n)}`;
    return `| [[${linkTo(n.file)}\\|${cell(n.fm.title)}]] | [[${safeName(
      n.fm.company || "Onbekend"
    )}]] | ${cell(n.fm.location)} | ${cell(n.fm.salary || "—")} | ${n.fm.posted || "—"} | ${
      e?.closed ? "**delisted**" : "open"
    } | [[${dir}/CV\\|CV]] · [[${dir}/Cover Letter\\|letter]] |`;
  });

  return `---
tags: ["index"]
updated: ${today()}
---

# To Apply

Every job note whose \`status:\` is \`apply\` — **${marked.length}** ${
    marked.length === 1 ? "vacancy" : "vacancies"
  }.

Mark one by opening it and changing \`status: new\` to \`status: apply\`. The field
survives every rescrape, so the mark sticks even as the listing is refreshed.

${
  marked.length
    ? `| Job | Company | Location | Salary | Posted | Listing | Application |
|---|---|---|---|---|---|---|
${rows.join("\n")}`
    : "_Nothing marked yet._"
}

## Writing the applications

\`\`\`bash
cd scraper && npm run apply          # gathers each marked vacancy into ${APPLICATIONS_DIR}/
\`\`\`

That writes a \`Brief.md\` per vacancy — the advert, the salary, your own notes on
it — and leaves \`CV.md\` and \`Cover Letter.md\` empty. Then, in Claude Code from
the project root:

\`\`\`
/apply
\`\`\`

which reads your [[README|Profile]] notes and writes both, one subagent per
vacancy. Drafts you have already edited are left alone.

A vacancy that turns out not to be worth it: set its status back to
\`interested\`, or to \`rejected\`. The folder under ${APPLICATIONS_DIR}/ stays
either way — nothing there is ever deleted for you.
`;
}

/* One vacancy's mark, set from outside Obsidian (the job browser). The same
   preservation rules as a full build: the note is rewritten from the store with
   the given status, applied date and notes, and any field not given keeps what
   the note already said. In "marked" mode a change that leaves the note
   untouched — status back to `new`, notes emptied — removes the note again, so
   un-marking really does take the job back out of the vault. */
export function writeJobMark(cfg, entry, change = {}) {
  const jobsDir = join(cfg.vaultPath, "Jobs");
  mkdirSync(jobsDir, { recursive: true });
  const { existing, from } = findExisting(jobsDir, entry);
  const base = existing || { status: undefined, applied: undefined, fit: undefined, notes: "" };
  if (base.applied === "null") base.applied = undefined;
  const next = {
    status: change.status ?? base.status,
    applied: change.applied !== undefined ? change.applied || undefined : base.applied,
    fit: base.fit,
    notes: change.notes !== undefined ? String(change.notes).trimEnd() : base.notes,
  };
  if (next.status === "applied" && (!next.applied || next.applied === "null")) next.applied = today();
  const path = join(jobsDir, entry.file);
  if (from) rmSync(join(jobsDir, from));
  if (noteMode(cfg) === "marked" && untouched(next)) {
    rmSync(path, { force: true });
    return { ...next, note: null };
  }
  writeFileSync(path, jobNote(entry, next, loadFit(cfg.vaultPath)));
  return { ...next, status: next.status || (entry.closed ? "closed" : "new"), note: path };
}

/* The shortlist note, rebuilt on its own so a mark shows up in Obsidian without
   waiting for the next full build. */
export function writeToApply(cfg, entries) {
  const indexDir = join(cfg.vaultPath, "Indexes");
  mkdirSync(indexDir, { recursive: true });
  const marked = markedJobs(cfg.vaultPath, DEFAULT_MARKS).marked;
  writeFileSync(join(indexDir, "To Apply.md"), toApplyNote(marked, entries));
  return marked.length;
}

const OBSIDIAN_CONFIG = {
  "app.json": { attachmentFolderPath: "Attachments", alwaysUpdateLinks: true, newLinkFormat: "shortest", useMarkdownLinks: false },
  "appearance.json": { accentColor: "" },
  "core-plugins.json": {
    "file-explorer": true, search: true, "global-search": true, graph: true, backlink: true,
    "outgoing-link": true, tag: true, properties: true, "page-preview": true, "note-composer": true,
    "command-palette": true, "editor-status": true, bookmarks: true, outline: true, "word-count": true,
    bases: true,
  },
  // The control panel needs all three: Buttons draws the buttons, Shell
  // commands runs them, Meta Bind draws the input fields. Listing them here
  // only switches them on — they still have to be installed from the plugin
  // hub, and Obsidian ignores the ones that are not.
  "community-plugins.json": ["buttons", "obsidian-shellcommands", "obsidian-meta-bind-plugin"],
};

/* Generated notes carry their key in the file name. The first pattern is the
   current "(source-id)" form; the second is the bare Indeed jobkey used before
   the scraper handled more than one board. Files matching neither are the
   user's own and are never touched. */
const GENERATED = [
  new RegExp(`\\((?:${sourceIds().join("|")})-[^()]+\\)\\.md$`),
  /\([0-9a-f]{16}\)\.md$/,
];

export function buildVault(cfg, store, log = console.log) {
  const jobs = Object.values(store.jobs);
  const entries = clusterJobs(jobs, { enabled: cfg.dedupeAcrossSources !== false }).map(toEntry);
  const vault = cfg.vaultPath;
  const jobsDir = join(vault, "Jobs");
  const companiesDir = join(vault, "Companies");
  const indexDir = join(vault, "Indexes");
  for (const dir of [vault, jobsDir, companiesDir, indexDir, join(vault, ".obsidian")]) {
    mkdirSync(dir, { recursive: true });
  }
  // The hand-written half of the vault. Templates are laid down once; an
  // existing note is never touched, so this is safe on every build.
  const scaffolded = scaffoldProfile(vault);
  // Written once and then left alone: the panel's properties are the scraper's
  // settings, and the ones in the note may be newer than the ones on disk.
  writePanelIfMissing(vault);
  for (const [name, body] of Object.entries(OBSIDIAN_CONFIG)) {
    const path = join(vault, ".obsidian", name);
    try {
      readFileSync(path);
    } catch {
      writeFileSync(path, JSON.stringify(body, null, 2));
    }
  }

  // Every board sweep adds notes for vacancies that will never be read, and
  // nothing has ever taken one away again. Notes older than this, for jobs that
  // are gone and were never marked, are dropped below.
  const pruneBefore =
    cfg.pruneClosedAfterDays == null || !(cfg.pruneClosedAfterDays >= 0)
      ? null
      : new Date(Date.now() - cfg.pruneClosedAfterDays * 86400000).toISOString().slice(0, 10);

  const mode = noteMode(cfg);
  const ratings = loadFit(vault);
  const wanted = new Set();
  const dropped = new Set();
  const retained = [];
  const live = [];
  let unnoted = 0;
  let written = 0;
  let carried = 0;
  let pruned = 0;
  for (const entry of entries) {
    const path = join(jobsDir, entry.file);
    const { existing, from } = findExisting(jobsDir, entry);
    // Left out of `wanted`, so the sweep below deletes whatever is on disk. It
    // is counted here rather than there — a pruned note is not a stale one.
    if (prunable(entry, existing, pruneBefore)) {
      dropped.add(entry.file);
      pruned++;
      continue;
    }
    // Still a live listing — the dashboard counts it and the browser shows it —
    // but in "marked" mode nobody has touched it, so it gets no note.
    live.push(entry);
    if (mode === "marked" && untouched(existing)) {
      dropped.add(entry.file);
      unnoted++;
      continue;
    }
    if (from) carried++;
    wanted.add(entry.file);
    retained.push(entry);
    writeFileSync(path, jobNote(entry, existing, ratings));
    written++;
  }

  let removed = 0;
  for (const file of readdirSync(jobsDir)) {
    if (wanted.has(file)) continue;
    if (!GENERATED.some((re) => re.test(file))) continue;
    rmSync(join(jobsDir, file));
    if (!dropped.has(file)) removed++;
  }

  const byCompany = new Map();
  for (const entry of retained) {
    const key = safeName(entry.primary.company);
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(entry);
  }
  for (const [company, companyEntries] of byCompany) {
    const path = join(companiesDir, `${company}.md`);
    writeFileSync(path, companyNote(companyEntries[0].primary.company, companyEntries, readExisting(path)));
  }

  // An employer with no job notes left has a note listing nothing and linking
  // nowhere. Only a generated one is removed — the tag is written by
  // companyNote, and `## Notes` is the half of the file that is the user's.
  let stubs = 0;
  for (const file of readdirSync(companiesDir)) {
    if (!file.endsWith(".md") || byCompany.has(file.slice(0, -3))) continue;
    const path = join(companiesDir, file);
    if (!/^tags: \["company"\]$/m.test(readFileSync(path, "utf8"))) continue;
    if (!untouched(readExisting(path))) continue;
    rmSync(path);
    stubs++;
  }

  const open = retained
    .filter((e) => !e.closed)
    .sort((a, b) => (b.primary.postedAt || "").localeCompare(a.primary.postedAt || ""));
  const bySource = Object.entries(
    jobs.reduce((acc, j) => ((acc[j.source || "unknown"] = (acc[j.source || "unknown"] || 0) + 1), acc), {})
  ).sort((a, b) => b[1] - a[1]);
  const lastRun = store.runs.at(-1);
  // Read back what you have marked in Obsidian: the status lives in the notes,
  // not in the store, and the ones just rewritten above carry it forward.
  const marked = markedJobs(vault, DEFAULT_MARKS).marked;
  const meta = {
    scrapedAt: lastRun?.date?.slice(0, 16).replace("T", " ") || today(),
    lastSources: lastRun?.sources || [],
    bySource,
    marked: marked.length,
  };

  // The counts are about every live listing, the links only about the ones
  // that have a note — a company link must never point at a removed note.
  meta.mode = mode;
  meta.notes = retained.filter((e) => !e.closed).length;
  meta.hasCompanyNote = (company) => byCompany.has(safeName(company));
  writeFileSync(join(vault, "Dashboard.md"), dashboard(live, cfg, meta));
  writeFileSync(join(indexDir, "To Apply.md"), toApplyNote(marked, retained));
  // Everything else under Indexes/ is a Base: one query per view, written once,
  // instead of a Markdown table per vacancy rewritten on every run. The old
  // tables are cleared out of a vault built before this.
  const bases = writeBasesIfMissing(vault);
  const staleIndexes = removeLegacyIndexes(vault);

  log(
    `Vault written to ${vault}: ${written} job notes (${jobs.length} postings, ${live.length} live vacancies, ${
      retained.filter((e) => e.members.length > 1).length
    } merged across boards), ${byCompany.size} company notes` +
      (mode === "marked" && unnoted ? `, ${unnoted} unmarked vacancies left to the browser (npm run browse)` : "") +
      (carried ? `, ${carried} notes carried across a rename` : "") +
      (removed ? `, ${removed} stale notes removed` : "") +
      (pruned
        ? `, ${pruned} untouched note${pruned === 1 ? "" : "s"} pruned (delisted over ${
            cfg.pruneClosedAfterDays
          } days)`
        : "") +
      (stubs ? `, ${stubs} empty company note${stubs === 1 ? "" : "s"} removed` : "") +
      (scaffolded.length ? `, ${PROFILE_DIR}/ scaffolded (${scaffolded.length} notes — fill them in)` : "") +
      (bases.length ? `, ${bases.join(" + ")} written` : "") +
      (staleIndexes ? `, ${staleIndexes} superseded index note${staleIndexes === 1 ? "" : "s"} removed` : "") +
      (marked.length ? `, ${marked.length} marked for application` : "")
  );
  return {
    jobNotes: written,
    companyNotes: byCompany.size,
    merged: retained.filter((e) => e.members.length > 1).length,
    pruned,
  };
}
