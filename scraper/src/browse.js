#!/usr/bin/env node
/* `npm run browse` — the job browser.

   The vault used to hold a note per vacancy, and at fifteen thousand of them
   Obsidian spends its time indexing files nobody opens. This serves the store
   itself as one searchable list instead: everything is in memory, filtering
   happens in the page, and nothing is written until you mark a job.

   A mark goes where it always went — `status:` in the job's note — so
   `npm run apply`, the To Apply shortlist, the Bases views and `/apply` all
   work exactly as before. In the default `jobNotes: "marked"` mode a note is
   written the moment you mark a job and removed again if you un-mark it, which
   keeps Jobs/ down to the vacancies you actually care about.

   Hiding a vacancy is the one thing that does not touch the vault: a dismissed
   job is not your work, and writing a note per dismissal would rebuild the
   problem this exists to solve. Those keys live in <vault>/.browse/hidden.json,
   a dot-folder Obsidian does not index.

   Only listens on 127.0.0.1. Writes require a custom header, which a page on
   another origin cannot send without a CORS preflight this server never
   answers, and the Host header is checked against DNS rebinding. */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { loadConfig } from "./config.js";
import { loadStore } from "./store.js";
import { describeSources, labelFor } from "./sources/index.js";
import { jobEntries, writeJobMark, writeToApply, findExisting, noteMode, loadFit, FIT_FILE } from "./vault.js";
import { PROFILE_DIR } from "./profile.js";
import { salaryFigures } from "./salary.js";
import { readJobNotes, prepareApplications, applicationDirName, KNOWN_STATUSES, DEFAULT_MARKS, APPLICATIONS_DIR } from "./apply.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "browse-ui.html");
const DEFAULT_PORT = 4173;

const HELP = `Usage: npm run browse -- [options]

Serves every stored vacancy as one searchable list at http://localhost:${DEFAULT_PORT},
where you can read them and mark the ones to apply for.

  --port <n>      Port to listen on (default: config browsePort, else ${DEFAULT_PORT})
  --open          Open the page in your browser once it is up
  --allow-host <name>  Also accept requests for this host name (repeatable) —
                  for a reverse proxy in front; adds to config browseHosts
  --vault <path>  Vault location (default: config vaultPath)
  -h, --help
`;

function parseArgs(argv) {
  const opts = { overrides: {} };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--port": opts.port = Number(argv[++i]); break;
      case "--open": opts.open = true; break;
      case "--allow-host": (opts.overrides.browseHosts ||= []).push(argv[++i]); break;
      case "--vault": opts.overrides.vaultPath = argv[++i]; break;
      case "-h":
      case "--help": opts.help = true; break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(1);
    }
  }
  return opts;
}

/* ---------- state ---------- */

const uniq = (arr) => [...new Set((arr || []).filter(Boolean))];

function createState(cfg) {
  const hiddenFile = join(cfg.vaultPath, ".browse", "hidden.json");
  const geo = new Map(describeSources().map((s) => [s.id, s.geoFiltered ? "local" : "remote"]));
  const fitFile = join(cfg.vaultPath, PROFILE_DIR, FIT_FILE);
  const state = { cfg, mtime: 0, store: null, entries: [], byKey: new Map(), marks: new Map(), hidden: {}, list: null, haystack: null, ratings: {}, fitMtime: -1 };

  /* Fit ratings (0–100) from Profile/fit.json, re-read when the file changes —
     rating a batch of new vacancies shows up on the next refresh of the page. */
  state.loadFit = () => {
    let mtime = 0;
    try {
      mtime = statSync(fitFile).mtimeMs;
    } catch {}
    if (mtime === state.fitMtime) return;
    state.fitMtime = mtime;
    state.ratings = mtime ? loadFit(cfg.vaultPath) : {};
  };
  /* A fit typed into the job's note wins, as it does when the vault is built. */
  const fitNumber = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? undefined : Math.round(Number(v)));
  state.fitOf = (e) => {
    const typed = state.marks.get(String(e.anchor.jobkey))?.fit;
    if (typed !== undefined) return typed;
    for (const key of [e.anchor.jobkey, ...e.members.map((m) => m.jobkey)]) {
      const n = fitNumber(state.ratings[key]);
      if (n !== undefined) return n;
    }
    return null;
  };

  state.loadHidden = () => {
    try {
      state.hidden = JSON.parse(readFileSync(hiddenFile, "utf8")) || {};
    } catch {
      state.hidden = {};
    }
  };
  state.saveHidden = () => {
    mkdirSync(dirname(hiddenFile), { recursive: true });
    writeFileSync(hiddenFile, JSON.stringify(state.hidden, null, 1));
  };

  /* Status lives in the notes, and in "marked" mode there are only a handful. A
     note edited in Obsidian is picked up the next time the list is fetched. */
  state.loadMarks = () => {
    state.marks = new Map();
    for (const n of readJobNotes(cfg.vaultPath)) {
      if (!n.fm.jobkey) continue;
      state.marks.set(String(n.fm.jobkey), { status: n.fm.status || "new", notes: !!n.notes.trim(), fit: fitNumber(n.fm.fit) });
    }
  };

  /* The store is rewritten by every scrape, so it is reloaded whenever the file
     on disk is newer than the copy in memory. */
  state.refresh = () => {
    let mtime = 0;
    try {
      mtime = statSync(cfg.dataFile).mtimeMs;
    } catch {}
    if (state.store && mtime === state.mtime) return false;
    const t = Date.now();
    state.store = loadStore(cfg.dataFile);
    state.mtime = mtime;
    state.entries = jobEntries(cfg, state.store);
    state.byKey = new Map(state.entries.map((e) => [String(e.anchor.jobkey), e]));
    state.haystack = null;
    state.list = null;
    console.log(`Loaded ${state.entries.length} vacancies (${Object.keys(state.store.jobs).length} postings) in ${Date.now() - t} ms`);
    return true;
  };

  /* The parts of every vacancy the list needs, and no more — the advert text
     alone is most of the store and is fetched one job at a time. */
  state.rows = () => {
    if (!state.list) {
      state.list = state.entries.map((e) => {
        const m = e.members;
        const j = e.primary;
        const sources = uniq(m.map((x) => x.source));
        const paid = m.find((x) => x.salary);
        const pay = paid ? salaryFigures(paid.salary, paid.hoursMax || paid.hoursMin ? paid : j) : null;
        return {
          k: String(e.anchor.jobkey),
          t: j.title || "",
          c: j.company || "",
          l: j.location || "",
          s: paid?.salary || "",
          sy: pay?.yearly || "",
          sh: pay?.hourly || "",
          p: m.map((x) => x.postedAt).filter(Boolean).sort()[0] || "",
          f: m.map((x) => x.firstSeen).filter(Boolean).sort()[0] || "",
          ls: m.map((x) => x.lastSeen).filter(Boolean).sort().at(-1) || "",
          r: m.some((x) => x.remote),
          src: sources,
          g: sources.some((s) => geo.get(s) === "local") ? "local" : "remote",
          x: e.closed,
          cat: uniq(m.flatMap((x) => x.categories || [])).slice(0, 6),
          ty: uniq(m.flatMap((x) => x.jobTypes || [])),
        };
      });
    }
    return state.list.map((row, i) => {
      const mark = state.marks.get(row.k);
      return { ...row, st: mark?.status || (row.x ? "closed" : "new"), n: mark?.notes || false, h: !!state.hidden[row.k], fit: state.fitOf(state.entries[i]) };
    });
  };

  /* Full-text search over the advert text, done here because the text is not
     sent to the page. Every word must appear somewhere in the vacancy. */
  state.search = (q) => {
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    if (!state.haystack) {
      state.haystack = state.entries.map((e) => [
        String(e.anchor.jobkey),
        e.members
          .map((x) => [x.title, x.company, x.location, x.description || x.summary, (x.categories || []).join(" ")].join(" "))
          .join(" ")
          .toLowerCase(),
      ]);
    }
    return state.haystack.filter(([, text]) => words.every((w) => text.includes(w))).map(([k]) => k);
  };

  state.detail = (key) => {
    const e = state.byKey.get(key);
    if (!e) return null;
    const m = e.members;
    const j = e.primary;
    const { existing } = findExisting(join(cfg.vaultPath, "Jobs"), e);
    const description = m.map((x) => x.description || x.summary || "").sort((a, b) => b.length - a.length)[0] || "";
    const hours = j.hoursMin || j.hoursMax ? (j.hoursMin && j.hoursMax && j.hoursMin !== j.hoursMax ? `${j.hoursMin}–${j.hoursMax} uur` : `${j.hoursMax || j.hoursMin} uur`) : "";
    const rated = m.find((x) => x.companyRating);
    const paid = m.find((x) => x.salary);
    const pay = paid ? salaryFigures(paid.salary, paid.hoursMax || paid.hoursMin ? paid : j) : null;
    const appDir = applicationDirName({ fm: { company: j.company, title: j.title, jobkey: e.anchor.jobkey } });
    return {
      k: key,
      title: j.title,
      company: j.company,
      location: j.location,
      closed: e.closed,
      status: existing?.status || (e.closed ? "closed" : "new"),
      applied: existing?.applied && existing.applied !== "null" ? existing.applied : "",
      notes: existing?.notes || "",
      hasNote: !!existing,
      hidden: !!state.hidden[key],
      description,
      application: existsSync(join(cfg.vaultPath, APPLICATIONS_DIR, appDir)) ? `${APPLICATIONS_DIR}/${appDir}` : "",
      fit: state.fitOf(e),
      facts: [
        ["Fit", state.fitOf(e) == null ? "" : `${state.fitOf(e)} / 100`],
        ["Salary", paid?.salary],
        ["Yearly", pay ? `${pay.yearly} (${pay.yearlyBasis})` : ""],
        ["Hourly", pay ? `${pay.hourly} (${pay.hourlyBasis})` : ""],
        ["Hours", hours],
        ["Type", uniq(m.flatMap((x) => x.jobTypes)).join(", ")],
        ["Field", uniq(m.flatMap((x) => x.categories)).slice(0, 12).join(", ")],
        ["Education", uniq(m.flatMap((x) => x.education)).join(", ")],
        ["Remote", m.some((x) => x.remote) ? uniq(m.flatMap((x) => x.remoteLabels)).slice(0, 6).join(", ") || "yes" : ""],
        ["Open to", uniq(m.flatMap((x) => x.regions)).slice(0, 12).join(", ")],
        ["Posted", m.map((x) => x.postedAt).filter(Boolean).sort()[0] || j.postedRelative],
        ["Closes", m.map((x) => x.expiresAt).filter(Boolean).sort()[0]],
        ["Rating", rated ? `${rated.companyRating} ★ (${rated.companyReviews} reviews)` : ""],
        ["Benefits", uniq(m.flatMap((x) => x.benefits)).join(", ")],
        ["First seen", m.map((x) => x.firstSeen).filter(Boolean).sort()[0]],
        ["Last seen", m.map((x) => x.lastSeen).filter(Boolean).sort().at(-1)],
      ].filter(([, v]) => v),
      links: m
        .slice()
        .sort((a, b) => a.source.localeCompare(b.source))
        .map((x) => ({ board: labelFor(x.source), url: x.url, applyUrl: x.applyUrl || "", closed: !!x.closed })),
    };
  };

  state.loadHidden();
  state.loadMarks();
  state.loadFit();
  state.refresh();
  return state;
}

/* ---------- http ---------- */

function send(req, res, status, body, type = "application/json; charset=utf-8") {
  let data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const headers = { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (/\bgzip\b/.test(req.headers["accept-encoding"] || "") && data.length > 2048) {
    data = gzipSync(data);
    headers["Content-Encoding"] = "gzip";
  }
  res.writeHead(status, headers);
  res.end(data);
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw new Error("request too large");
  }
  return raw ? JSON.parse(raw) : {};
}

function handler(state, port) {
  const cfg = state.cfg;
  /* Behind a reverse proxy (Caddy, say) the browser's Host header is the
     proxy's name, not ours; `browseHosts` lists the names it may arrive under.
     A bare name matches any port. The page uses relative URLs, so it works
     mounted under a sub-path as well as at the root. */
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, ...(cfg.browseHosts || [])].map((h) => String(h).toLowerCase()));
  const allowed = (host = "") => {
    host = host.toLowerCase();
    return hosts.has(host) || hosts.has(host.replace(/:\d+$/, ""));
  };

  return async (req, res) => {
    try {
      if (!allowed(req.headers.host)) return send(req, res, 403, { error: "unexpected host" });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const route = `${req.method} ${url.pathname}`;

      if (req.method === "POST" && req.headers["x-jobs-browser"] !== "1") return send(req, res, 403, { error: "missing header" });

      switch (route) {
        case "GET /":
          return send(req, res, 200, readFileSync(PAGE), "text/html; charset=utf-8");

        case "GET /api/jobs": {
          state.refresh();
          state.loadMarks();
          state.loadHidden();
          state.loadFit();
          const lastRun = state.store.runs.at(-1);
          return send(req, res, 200, {
            meta: {
              mode: noteMode(cfg),
              vault: cfg.vaultPath,
              lastRun: lastRun?.date || "",
              statuses: KNOWN_STATUSES,
              marks: DEFAULT_MARKS,
              boards: describeSources().map((s) => ({ id: s.id, label: s.label, geo: s.geoFiltered ? "local" : "remote" })),
            },
            jobs: state.rows(),
          });
        }

        case "GET /api/job": {
          const d = state.detail(url.searchParams.get("k") || "");
          return d ? send(req, res, 200, d) : send(req, res, 404, { error: "no such vacancy — rescraped since?" });
        }

        case "GET /api/search":
          return send(req, res, 200, { keys: state.search(url.searchParams.get("q") || "") });

        case "POST /api/mark": {
          const body = await readJson(req);
          const entry = state.byKey.get(String(body.k));
          if (!entry) return send(req, res, 404, { error: "no such vacancy" });
          if (body.status !== undefined && !KNOWN_STATUSES.includes(body.status)) return send(req, res, 400, { error: `unknown status ${body.status}` });
          const result = writeJobMark(cfg, entry, { status: body.status, notes: body.notes, applied: body.applied });
          state.loadMarks();
          const marked = writeToApply(cfg, state.entries);
          console.log(`${result.status.padEnd(10)} ${entry.primary.company} — ${entry.primary.title}${result.note ? "" : " (note removed)"}`);
          return send(req, res, 200, { status: result.status, applied: result.applied || "", notes: result.notes, hasNote: !!result.note, marked });
        }

        case "POST /api/hide": {
          const body = await readJson(req);
          const key = String(body.k);
          if (!state.byKey.has(key)) return send(req, res, 404, { error: "no such vacancy" });
          if (body.hidden) state.hidden[key] = new Date().toISOString().slice(0, 10);
          else delete state.hidden[key];
          state.saveHidden();
          return send(req, res, 200, { hidden: !!body.hidden });
        }

        /* The deterministic half of `npm run apply`: a folder and a brief per
           marked vacancy. The CV and letter are still `/apply`'s job. */
        case "POST /api/prepare": {
          state.refresh();
          const { queue, root } = prepareApplications(cfg, state.store, { marks: DEFAULT_MARKS });
          return send(req, res, 200, {
            root,
            prepared: queue.length,
            pending: queue.filter((q) => !q.written).length,
          });
        }

        default:
          return send(req, res, 404, { error: "not found" });
      }
    } catch (err) {
      console.error(err);
      return send(req, res, 500, { error: String(err.message || err) });
    }
  };
}

function openInBrowser(url) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {}
}

export function startBrowser({ port, open = false, overrides = {} } = {}) {
  const extra = overrides.browseHosts || [];
  const cfg = loadConfig({ ...overrides, browseHosts: undefined });
  cfg.browseHosts = [...(cfg.browseHosts || []), ...extra];
  port = port || cfg.browsePort || DEFAULT_PORT;
  const state = createState(cfg);
  const server = createServer(handler(state, port));
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      // Most likely the browser is already running — say so and point at it.
      console.log(`Port ${port} is in use — the job browser is probably already running at http://localhost:${port}`);
      if (open) openInBrowser(`http://localhost:${port}`);
      process.exit(0);
    }
    throw err;
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}`;
    console.log(`Job browser on ${url} — ${state.entries.length} vacancies, notes in ${noteMode(cfg)} mode. Ctrl-C to stop.`);
    if (open) openInBrowser(url);
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) console.log(HELP);
  else startBrowser(opts);
}
