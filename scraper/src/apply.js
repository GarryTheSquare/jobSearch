/* The application queue.

   You mark a vacancy by setting `status: apply` in its note — the one field the
   vault generator always preserves, so the mark survives every rescrape. This
   module finds those notes, gathers everything known about each vacancy into a
   single Brief.md, and hands the list to whoever writes the CV.

   The status lives in the note rather than in data/jobs.json on purpose: the
   store is the scraper's, the note is yours, and Obsidian is where you are when
   you decide to apply. */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { labelFor } from "./sources/index.js";
import { fileKey } from "./sources/util.js";
import { safeName } from "./vault.js";

/* Which `status:` values mean "write me an application". `apply` is the marker;
   `interested` is included so a shortlist can be drafted in one go if you'd
   rather triage in bulk. */
export const DEFAULT_MARKS = ["apply"];
export const KNOWN_STATUSES = ["new", "interested", "apply", "applied", "interview", "offer", "rejected", "closed"];

const CV_FILE = "CV.md";
const LETTER_FILE = "Cover Letter.md";
const BRIEF_FILE = "Brief.md";
export const APPLICATIONS_DIR = "Applications";

/* Enough YAML for the frontmatter this vault writes and nothing more: quoted
   scalars, flow sequences of quoted scalars, booleans, nulls, bare words. */
function parseValue(raw) {
  const v = raw.trim();
  if (v === "" ) return "";
  if (v === "null" || v === "~") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.startsWith("[")) {
    const inner = v.slice(1, v.lastIndexOf("]"));
    return [...inner.matchAll(/"((?:[^"\\]|\\.)*)"|([^,\s][^,]*)/g)]
      .map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2].trim()))
      .filter((s) => s !== "");
  }
  if (v.startsWith('"') && v.endsWith('"') && v.length > 1) return v.slice(1, -1).replace(/\\(.)/g, "$1");
  return v;
}

export function parseNote(raw) {
  if (!raw.startsWith("---\n")) return { fm: {}, body: raw };
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return { fm: {}, body: raw };
  const fm = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (m) fm[m[1]] = parseValue(m[2]);
  }
  return { fm, body: raw.slice(end + 4).replace(/^\n/, "") };
}

/* Whatever you typed under `## Notes` in the job note. It is the only place
   you can tell the CV writer something about this vacancy in particular, so it
   goes into the brief verbatim. */
function userNotes(body) {
  const idx = body.indexOf("## Notes");
  if (idx === -1) return "";
  return body.slice(idx + "## Notes".length).replace(/^\n+/, "").trimEnd();
}

export function readJobNotes(vaultPath) {
  const dir = join(vaultPath, "Jobs");
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return names.map((name) => {
    const path = join(dir, name);
    const { fm, body } = parseNote(readFileSync(path, "utf8"));
    return { file: name, path, fm, notes: userNotes(body) };
  });
}

/* The vacancies you have marked, newest posting first. Unknown statuses are
   reported rather than silently ignored — a typo in `status:` otherwise looks
   exactly like a job you never marked. */
export function markedJobs(vaultPath, marks = DEFAULT_MARKS) {
  const wanted = new Set(marks);
  const notes = readJobNotes(vaultPath);
  const unknown = notes.filter((n) => n.fm.status && !KNOWN_STATUSES.includes(n.fm.status));
  const marked = notes
    .filter((n) => wanted.has(n.fm.status))
    .sort((a, b) => String(b.fm.posted || "").localeCompare(String(a.fm.posted || "")));
  return { marked, unknown, total: notes.length };
}

export function applicationDirName(note) {
  const company = safeName(note.fm.company || "Onbekend", 40);
  const title = safeName(note.fm.title || "Vacature", 60);
  return `${company} - ${title} (${fileKey(note.fm.jobkey || "unknown")})`;
}

/* Search results are abridged — a board's listing page rarely carries the whole
   advert. A note may also stand for the same vacancy on several boards, and its
   frontmatter only names the anchor's key, so the postings behind it are found
   by `source_urls` as well. The longest description of the lot wins. */
function storePostings(note, store) {
  const urls = new Set([note.fm.url, ...(Array.isArray(note.fm.source_urls) ? note.fm.source_urls : [])].filter(Boolean));
  return Object.values(store?.jobs || {}).filter((j) => j.jobkey === note.fm.jobkey || urls.has(j.url));
}

function fullDescription(note, store) {
  return storePostings(note, store)
    .map((j) => j.description || j.summary || "")
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] || "";
}

/* Boards that state benefits or a shift pattern separately from the advert text
   — Indeed and Noorderlink both do — say things a letter can answer directly. */
function extras(note, store) {
  const postings = storePostings(note, store);
  const uniq = (key) => [...new Set(postings.flatMap((j) => j[key] || []).filter(Boolean))];
  return { benefits: uniq("benefits"), shifts: uniq("shifts"), applyUrl: postings.map((j) => j.applyUrl).find(Boolean) || "" };
}

const bullet = (label, value) => (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length) ? null : `- **${label}**: ${Array.isArray(value) ? value.join(", ") : value}`);

function brief(note, store, vaultPath) {
  const fm = note.fm;
  const sources = Array.isArray(fm.sources) ? fm.sources : [];
  const urls = Array.isArray(fm.source_urls) ? fm.source_urls : [fm.url].filter(Boolean);
  const description = fullDescription(note, store);
  const { benefits, shifts, applyUrl } = extras(note, store);
  const lines = [
    "---",
    'tags: ["application", "application/brief"]',
    `company: ${JSON.stringify(String(fm.company ?? ""))}`,
    `title: ${JSON.stringify(String(fm.title ?? ""))}`,
    `jobkey: ${fm.jobkey ?? ""}`,
    `job_note: ${JSON.stringify(note.file.replace(/\.md$/, ""))}`,
    `url: ${fm.url ?? ""}`,
    `prepared: ${new Date().toISOString().slice(0, 10)}`,
    "---",
    "",
    `# Brief — ${fm.title} at ${fm.company}`,
    "",
    "Generated from the vacancy. Everything below is the job side of the",
    "application; your side is in [[README|Profile]]. This file is rewritten by",
    "`npm run apply`, so keep your own remarks in the job note under `## Notes`",
    "— they are copied in below.",
    "",
    `Job note: [[${note.file.replace(/\.md$/, "")}]]`,
    "",
    "## The vacancy",
    "",
    [
      bullet("Company", fm.company),
      bullet("Title", fm.title),
      bullet("Location", fm.location),
      bullet("Salary", fm.salary),
      bullet("Hours", fm.hours),
      bullet("Type", fm.job_types),
      bullet("Field", fm.categories),
      bullet("Education asked", fm.education),
      bullet("Remote", fm.remote === true ? "yes" : fm.remote === false ? "no" : fm.remote),
      bullet("Open to", fm.regions),
      bullet("Posted", fm.posted),
      bullet("Closes", fm.expires),
      bullet("Found on", sources.map(labelFor)),
      bullet("Easy apply", fm.easy_apply === true ? "yes" : null),
      bullet("Benefits named", benefits),
      bullet("Shifts", shifts),
      bullet("Apply direct", applyUrl),
    ]
      .filter(Boolean)
      .join("\n"),
    "",
    "## Where to read it in full",
    "",
    ...(urls.length ? urls.map((u, i) => `- [${labelFor(sources[i] || sources[0] || "")||"listing"}](${u})`) : ["- _No URL stored._"]),
    "",
    "The advert text below is what the board handed the scraper, which is often",
    "an abridged version. Fetch the URL above before writing if you can — the",
    "requirements list is the part most often truncated.",
    "",
    "## Advert text as stored",
    "",
    description || "_The board gave no description beyond the fields above._",
    "",
    "## Your notes on this vacancy",
    "",
    note.notes || "_None — add them under `## Notes` in the job note._",
    "",
  ];
  return lines.join("\n");
}

const stub = (kind, note) => `---
tags: ["application", "application/${kind}"]
company: ${JSON.stringify(String(note.fm.company ?? ""))}
title: ${JSON.stringify(String(note.fm.title ?? ""))}
jobkey: ${note.fm.jobkey ?? ""}
status: not written yet
---

# ${kind === "cv" ? "CV" : "Cover letter"} — ${note.fm.title} at ${note.fm.company}

_Not written yet. Run \`/apply\` in Claude Code from the project root, or delete
this file and write it yourself._
`;

/* Creates a folder per marked vacancy and fills it with the brief. The CV and
   the letter are left as stubs for the writer; an existing one is never
   overwritten without `force`, because by then you have probably edited it. */
export function prepareApplications(cfg, store, { marks = DEFAULT_MARKS, force = false } = {}) {
  const vaultPath = cfg.vaultPath;
  const { marked, unknown, total } = markedJobs(vaultPath, marks);
  const root = join(vaultPath, APPLICATIONS_DIR);
  if (marked.length) mkdirSync(root, { recursive: true });

  const queue = marked.map((note) => {
    const dirName = applicationDirName(note);
    const dir = join(root, dirName);
    mkdirSync(dir, { recursive: true });
    const briefPath = join(dir, BRIEF_FILE);
    writeFileSync(briefPath, brief(note, store, vaultPath));

    const cv = join(dir, CV_FILE);
    const letter = join(dir, LETTER_FILE);
    const hadCv = existsSync(cv) && !readFileSync(cv, "utf8").includes("status: not written yet");
    const hadLetter = existsSync(letter) && !readFileSync(letter, "utf8").includes("status: not written yet");
    if (!existsSync(cv) || (force && !hadCv)) writeFileSync(cv, stub("cv", note));
    if (!existsSync(letter) || (force && !hadLetter)) writeFileSync(letter, stub("letter", note));

    return {
      company: note.fm.company,
      title: note.fm.title,
      jobkey: note.fm.jobkey,
      status: note.fm.status,
      url: note.fm.url,
      posted: note.fm.posted,
      location: note.fm.location,
      salary: note.fm.salary,
      remote: note.fm.remote,
      jobNote: note.path,
      dir,
      brief: briefPath,
      cv,
      letter,
      // A job whose CV and letter are both real is done; the writer skips it
      // unless you asked for a rewrite.
      written: hadCv && hadLetter,
    };
  });

  return { queue, unknown, total, root };
}
