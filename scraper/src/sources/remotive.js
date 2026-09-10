/* Remotive — public, documented JSON API returning the whole board at once. */
import { baseJob, htmlToText, makeKey } from "./util.js";
import { getJson } from "./lib/http.js";
import { makeRegionFilter, splitRegions } from "./lib/region.js";

export const id = "remotive";
export const label = "Remotive";
export const kind = "http";
export const supportsQueries = true;
export const geoFiltered = false;
export const blurb = "Public API, whole board in one request. Per-job candidate location.";

export const defaults = { apiUrl: "https://remotive.com/api/remote-jobs", delayMs: [500, 1200] };

const TYPES = { full_time: "Full-time", part_time: "Part-time", contract: "Contract", freelance: "Freelance", internship: "Internship", other: "Other" };

export function normalizeJob(raw, cfg, query) {
  const regions = splitRegions(raw.candidate_required_location);
  return baseJob({
    source: id,
    sourceId: String(raw.id),
    jobkey: makeKey(id, raw.id),
    title: (raw.title || "").trim(),
    company: (raw.company_name || "").trim() || "Onbekend",
    location: regions.join(", "),
    salary: (raw.salary || "").trim(),
    jobTypes: [TYPES[raw.job_type] || raw.job_type].filter(Boolean),
    categories: [raw.category, ...(raw.tags || [])].filter(Boolean),
    remote: true,
    remoteLabels: regions,
    regions,
    description: htmlToText(raw.description),
    summary: htmlToText(raw.description).slice(0, 700),
    url: raw.url,
    postedAt: raw.publication_date ? raw.publication_date.slice(0, 10) : null,
    query,
  });
}

export async function scrape(cfg, { log = console.log, onPage } = {}) {
  const eligible = makeRegionFilter(cfg);
  const stats = { pages: 0, jobs: 0, blockedQueries: [] };

  for (const query of cfg.queries) {
    const url = new URL(cfg.apiUrl);
    if (query) url.searchParams.set("search", query);
    if (cfg.remotiveLimit) url.searchParams.set("limit", String(cfg.remotiveLimit));
    log(`\nQuery ${query || "(all jobs)"} — ${url}`);

    const res = await getJson(url.toString(), { log });
    stats.pages++;
    if (!res.ok) {
      log(`  request failed (http ${res.status})`);
      stats.blockedQueries.push(query || "(all jobs)");
      continue;
    }

    const items = res.data?.jobs || [];
    const batch = [];
    let dropped = 0;
    for (const raw of items) {
      if (!raw?.id) continue;
      const job = normalizeJob(raw, cfg, query);
      if (!eligible(job.regions)) {
        dropped++;
        continue;
      }
      batch.push(job);
    }
    stats.jobs += batch.length;
    const tally = (await onPage?.(batch)) || {};
    log(
      `  ${items.length} listings, ${batch.length} open to this region, ${dropped} not` +
        (tally.total ? ` — ${tally.total} stored` : "")
    );
  }
  return stats;
}
