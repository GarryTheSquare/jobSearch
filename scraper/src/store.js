import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { makeKey } from "./sources/util.js";

const today = () => new Date().toISOString().slice(0, 10);

/* Jobs used to be keyed by Indeed's bare jobkey, from back when Indeed was the
   only source. Rekey those to "indeed:<jobkey>" on load so an existing store
   keeps working — and keeps its first-seen dates and closed flags. */
export function migrateStore(store) {
  let migrated = 0;
  for (const [key, job] of Object.entries(store.jobs)) {
    if (job.source) continue;
    const sourceId = job.sourceId || job.jobkey || key;
    const next = { ...job, source: "indeed", sourceId, jobkey: makeKey("indeed", sourceId) };
    delete store.jobs[key];
    store.jobs[next.jobkey] = next;
    migrated++;
  }
  return migrated;
}

export function loadStore(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const store = { jobs: data.jobs || {}, runs: data.runs || [] };
    migrateStore(store);
    return store;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return { jobs: {}, runs: [] };
  }
}

export function saveStore(file, store) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 2) + "\n");
}

/* Folds a batch of scraped jobs into the store. Called once per result page so a
   crash or a kill costs at most one page, never the whole run. */
export function upsertJobs(store, scraped) {
  const now = today();
  let added = 0;
  let updated = 0;
  for (const job of scraped) {
    const existing = store.jobs[job.jobkey];
    // A job can surface under several queries; remember all of them. Records
    // written before `queries` existed carry a single `query` instead.
    const previous = existing?.queries || (existing && existing.query !== undefined ? [existing.query] : []);
    const queries = [...new Set([...previous, job.query ?? ""])];
    if (existing) {
      store.jobs[job.jobkey] = { ...existing, ...job, queries, firstSeen: existing.firstSeen, lastSeen: now, closed: false };
      updated++;
    } else {
      store.jobs[job.jobkey] = { ...job, queries, firstSeen: now, lastSeen: now, closed: false };
      added++;
    }
  }
  return { added, updated };
}

export function countBySource(store) {
  const counts = {};
  for (const job of Object.values(store.jobs)) {
    const key = job.source || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/* Ends a run: jobs that have not shown up for a while are marked closed rather
   than deleted, so the vault keeps your history. Only the sources that actually
   ran are aged — otherwise scraping one board would slowly close another's. */
export function finalizeRun(store, tally, { staleAfterDays = 45, sources = null } = {}) {
  const cutoff = new Date(Date.now() - staleAfterDays * 86400000).toISOString().slice(0, 10);
  const ran = sources?.length ? new Set(sources) : null;
  let closed = 0;
  for (const job of Object.values(store.jobs)) {
    if (ran && !ran.has(job.source)) continue;
    if (job.lastSeen < cutoff && !job.closed) {
      job.closed = true;
      closed++;
    }
  }
  store.runs.push({ date: new Date().toISOString(), sources: sources || [], ...tally, closed });
  if (store.runs.length > 200) store.runs = store.runs.slice(-200);
  return { ...tally, closed, total: Object.keys(store.jobs).length };
}
