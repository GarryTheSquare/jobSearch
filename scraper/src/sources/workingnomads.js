/* Working Nomads — one public endpoint returning the current board. */
import { baseJob, htmlToText, makeKey } from "./util.js";
import { getJson } from "./lib/http.js";
import { makeRegionFilter, splitRegions } from "./lib/region.js";

export const id = "workingnomads";
export const label = "Working Nomads";
export const kind = "http";
export const supportsQueries = false;
export const geoFiltered = false;
export const blurb = "Public endpoint, whole board in one request.";

export const defaults = { apiUrl: "https://www.workingnomads.com/api/exposed_jobs/", delayMs: [500, 1000] };

/* No id field; the job URL ends in the board's own numeric id. */
const idOf = (raw) => (String(raw.url || "").match(/\/(\d+)\/?$/) || [])[1] || "";

export function normalizeJob(raw, cfg, query) {
  const regions = splitRegions(raw.location);
  return baseJob({
    source: id,
    sourceId: idOf(raw),
    jobkey: makeKey(id, idOf(raw)),
    title: (raw.title || "").trim(),
    company: (raw.company_name || "").trim() || "Onbekend",
    location: regions.join(", "),
    categories: [raw.category_name, ...String(raw.tags || "").split(",")].map((s) => String(s).trim()).filter(Boolean),
    remote: true,
    remoteLabels: regions,
    regions,
    description: htmlToText(raw.description),
    summary: htmlToText(raw.description).slice(0, 700),
    url: raw.url,
    postedAt: raw.pub_date ? new Date(raw.pub_date).toISOString().slice(0, 10) : null,
    query,
  });
}

export async function scrape(cfg, { log = console.log, onPage } = {}) {
  const eligible = makeRegionFilter(cfg);
  const stats = { pages: 0, jobs: 0, blockedQueries: [] };
  log(`\nAll listings — ${cfg.apiUrl} (this board has no search parameter)`);

  const res = await getJson(cfg.apiUrl, { log });
  stats.pages++;
  if (!res.ok) {
    log(`  request failed (http ${res.status})`);
    stats.blockedQueries.push("(all jobs)");
    return stats;
  }

  const items = Array.isArray(res.data) ? res.data : res.data?.jobs || [];
  const batch = [];
  let dropped = 0;
  for (const raw of items) {
    const job = normalizeJob(raw, cfg, "");
    if (!job.sourceId) continue;
    if (!eligible(job.regions)) {
      dropped++;
      continue;
    }
    batch.push(job);
  }
  stats.jobs += batch.length;
  const tally = (await onPage?.(batch)) || {};
  log(`  ${items.length} listings, ${batch.length} open to this region, ${dropped} not` + (tally.total ? ` — ${tally.total} stored` : ""));
  return stats;
}
