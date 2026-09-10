/* Himalayas — cursor-paginated public API with the best per-job country
   eligibility metadata of any board on the list. */
import { baseJob, htmlToText, jitter, makeKey, sleep } from "./util.js";
import { getJson } from "./lib/http.js";
import { makeRegionFilter } from "./lib/region.js";

export const id = "himalayas";
export const label = "Himalayas";
export const kind = "http";
export const supportsQueries = false;
export const geoFiltered = false;
export const blurb = "Public cursor-paginated API; explicit per-job country eligibility.";

/* The API caps a page at 20 whatever `limit` asks for, and the board is very
   large (100k+ listings) with only a fifth of them open to this region, so the
   page budget rather than the page size is what decides the yield. */
export const defaults = {
  apiUrl: "https://himalayas.app/jobs/api",
  himalayasLimit: 20,
  maxPagesPerQuery: 40,
  delayMs: [600, 1200],
};

const day = (epoch) => (epoch ? new Date(epoch * 1000).toISOString().slice(0, 10) : null);

function salary(raw) {
  if (!raw.minSalary && !raw.maxSalary) return "";
  const cur = raw.currency === "EUR" ? "€" : raw.currency === "USD" ? "$" : `${raw.currency || ""} `;
  const per = { annual: "per jaar", monthly: "per maand", hourly: "per uur", weekly: "per week", daily: "per dag" }[raw.salaryPeriod] || "";
  const num = (n) => cur + Number(n).toLocaleString("nl-NL");
  const range = raw.minSalary && raw.maxSalary && raw.minSalary !== raw.maxSalary
    ? `${num(raw.minSalary)} - ${num(raw.maxSalary)}`
    : num(raw.maxSalary || raw.minSalary);
  return `${range} ${per}`.trim();
}

/* The API has no stable numeric id, but the job URL is unique and permanent. */
const idOf = (raw) => (raw.guid || raw.applicationLink || "").split("/").filter(Boolean).slice(-2).join("-");

export function normalizeJob(raw, cfg, query) {
  const regions = raw.locationRestrictions || [];
  return baseJob({
    source: id,
    sourceId: idOf(raw),
    jobkey: makeKey(id, idOf(raw)),
    title: (raw.title || "").trim(),
    company: (raw.companyName || "").trim() || "Onbekend",
    location: regions.join(", "),
    salary: salary(raw),
    jobTypes: [raw.employmentType].filter(Boolean),
    categories: [...(raw.parentCategories || []), ...(raw.seniority || [])].filter(Boolean),
    remote: true,
    remoteLabels: regions,
    regions,
    description: htmlToText(raw.description),
    summary: htmlToText(raw.excerpt || raw.description).slice(0, 700),
    url: raw.guid || raw.applicationLink,
    applyUrl: raw.applicationLink || "",
    postedAt: day(raw.pubDate),
    expiresAt: day(raw.expiryDate),
    query,
  });
}

export async function scrape(cfg, { log = console.log, onPage } = {}) {
  const eligible = makeRegionFilter(cfg);
  const stats = { pages: 0, jobs: 0, blockedQueries: [] };
  log(`\nAll listings — ${cfg.apiUrl} (this board has no search parameter)`);

  let cursor = null;
  let dropped = 0;
  for (let page = 1; page <= cfg.maxPagesPerQuery; page++) {
    const url = new URL(cfg.apiUrl);
    url.searchParams.set("limit", String(cfg.himalayasLimit));
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await getJson(url.toString(), { log });
    stats.pages++;
    if (!res.ok) {
      log(`  request failed (http ${res.status})`);
      stats.blockedQueries.push("(all jobs)");
      break;
    }

    const items = res.data?.jobs || [];
    if (!items.length) break;

    const batch = [];
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
    log(
      `  page ${page}: ${items.length} listings, ${batch.length} open to this region, ${dropped} not so far` +
        (tally.total ? ` — ${tally.total} stored` : "") +
        (res.data?.totalCount ? ` (${res.data.totalCount} on the board)` : "")
    );

    cursor = res.data?.nextCursor || null;
    if (!cursor) break;
    await sleep(jitter(cfg.delayMs));
  }
  return stats;
}
