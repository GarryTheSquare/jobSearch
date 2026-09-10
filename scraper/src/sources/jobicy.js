/* Jobicy — public API with a documented Netherlands region endpoint. */
import { baseJob, htmlToText, jitter, makeKey, sleep } from "./util.js";
import { getJson } from "./lib/http.js";
import { makeRegionFilter, splitRegions } from "./lib/region.js";

export const id = "jobicy";
export const label = "Jobicy";
export const kind = "http";
export const supportsQueries = true;
export const geoFiltered = false;
export const blurb = "Public API with a Netherlands region filter and a Contract job type.";

export const defaults = {
  apiUrl: "https://jobicy.com/api/v2/remote-jobs",
  // The board's own region slugs. "anywhere" carries the worldwide listings,
  // which are the ones actually open to a Dutch freelancer.
  regions: ["netherlands", "europe", "anywhere"],
  jobicyCount: 50,
  delayMs: [800, 1600],
};

export function normalizeJob(raw, cfg, query) {
  const regions = splitRegions(raw.jobGeo);
  return baseJob({
    source: id,
    sourceId: String(raw.id),
    jobkey: makeKey(id, raw.id),
    title: (raw.jobTitle || "").trim(),
    company: (raw.companyName || "").trim() || "Onbekend",
    location: regions.join(", "),
    salary: raw.annualSalaryMin || raw.annualSalaryMax
      ? `${raw.salaryCurrency || ""}${raw.annualSalaryMin || ""}${raw.annualSalaryMax ? ` - ${raw.annualSalaryMax}` : ""} per jaar`.trim()
      : "",
    jobTypes: raw.jobType || [],
    categories: [...(raw.jobIndustry || []), raw.jobLevel].filter(Boolean),
    remote: true,
    remoteLabels: regions,
    regions,
    description: htmlToText(raw.jobDescription),
    summary: htmlToText(raw.jobExcerpt || raw.jobDescription).slice(0, 700),
    url: raw.url,
    postedAt: raw.pubDate ? raw.pubDate.slice(0, 10) : null,
    query,
  });
}

export async function scrape(cfg, { log = console.log, onPage } = {}) {
  const eligible = makeRegionFilter(cfg);
  const stats = { pages: 0, jobs: 0, blockedQueries: [] };
  const seen = new Set();

  for (const query of cfg.queries) {
    for (const region of cfg.regions) {
      const url = new URL(cfg.apiUrl);
      url.searchParams.set("count", String(cfg.jobicyCount));
      if (region) url.searchParams.set("geo", region);
      if (query) url.searchParams.set("tag", query);
      log(`\nQuery ${query || "(all jobs)"} · region ${region}`);

      const res = await getJson(url.toString(), { log });
      stats.pages++;
      if (!res.ok) {
        log(`  request failed (http ${res.status})`);
        stats.blockedQueries.push(`${query || "(all jobs)"} / ${region}`);
        continue;
      }

      const items = res.data?.jobs || [];
      const batch = [];
      let dropped = 0;
      for (const raw of items) {
        if (!raw?.id || seen.has(raw.id)) continue;
        seen.add(raw.id);
        const job = normalizeJob(raw, cfg, query);
        if (!eligible(job.regions)) {
          dropped++;
          continue;
        }
        batch.push(job);
      }
      stats.jobs += batch.length;
      const tally = (await onPage?.(batch)) || {};
      log(`  ${items.length} listings, ${batch.length} kept, ${dropped} out of region` + (tally.total ? ` — ${tally.total} stored` : ""));
      await sleep(jitter(cfg.delayMs));
    }
  }
  return stats;
}
