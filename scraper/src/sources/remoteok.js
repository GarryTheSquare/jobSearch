/* RemoteOK — public JSON dump of the board. The first element is a legal
   notice rather than a job, which is why entries without an id are skipped. */
import { baseJob, htmlToText, makeKey } from "./util.js";
import { getJson } from "./lib/http.js";
import { makeRegionFilter, splitRegions } from "./lib/region.js";

export const id = "remoteok";
export const label = "RemoteOK";
export const kind = "http";
export const supportsQueries = false;
export const geoFiltered = false;
export const blurb = "Public JSON dump of the whole board. Region often unstated.";

export const defaults = { apiUrl: "https://remoteok.com/api", delayMs: [500, 1000] };

function salary(raw) {
  const min = Number(raw.salary_min) || 0;
  const max = Number(raw.salary_max) || 0;
  if (!min && !max) return "";
  const num = (n) => "$" + n.toLocaleString("en-US");
  return (min && max && min !== max ? `${num(min)} - ${num(max)}` : num(max || min)) + " per jaar";
}

export function normalizeJob(raw, cfg, query) {
  const regions = splitRegions(raw.location);
  return baseJob({
    source: id,
    sourceId: String(raw.id),
    jobkey: makeKey(id, raw.id),
    title: (raw.position || "").trim(),
    company: (raw.company || "").trim() || "Onbekend",
    location: regions.join(", "),
    salary: salary(raw),
    categories: (raw.tags || []).filter(Boolean),
    remote: true,
    remoteLabels: regions,
    regions,
    description: htmlToText(raw.description),
    summary: htmlToText(raw.description).slice(0, 700),
    url: raw.url || raw.apply_url,
    applyUrl: raw.apply_url || "",
    postedAt: raw.date ? raw.date.slice(0, 10) : null,
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

  const items = (Array.isArray(res.data) ? res.data : []).filter((x) => x && x.id && x.position);
  const batch = [];
  let dropped = 0;
  for (const raw of items) {
    const job = normalizeJob(raw, cfg, "");
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
