/* DailyRemote — no API, but every listing page embeds schema.org JobPosting
   blocks with full applicantLocationRequirements, which is exactly the
   eligibility data the other boards make you guess at. */
import { baseJob, htmlToText, jitter, makeKey, sleep } from "./util.js";
import { getText } from "./lib/http.js";
import { jobPostings, locationNames, EMPLOYMENT } from "./lib/jsonld.js";
import { makeRegionFilter, splitRegions } from "./lib/region.js";

export const id = "dailyremote";
export const label = "DailyRemote";
export const kind = "http";
export const supportsQueries = true;
export const geoFiltered = false;
export const blurb = "JSON-LD on each listing page; explicit applicant-location requirements.";

export const defaults = {
  baseUrl: "https://dailyremote.com",
  listPath: "/remote-jobs",
  // Ten postings per page, so the page cap has to be generous to be useful.
  maxPagesPerQuery: 25,
  delayMs: [1200, 2200],
};

/* The identifier's value is the board's own slug; the URL is the fallback. */
function idOf(posting) {
  const v = posting.identifier?.value;
  if (v) return String(v);
  return String(posting.url || "").split("/").filter(Boolean).pop() || "";
}

/* Some listings hide the employer behind the board's paid tier and put a
   placeholder in the JSON-LD instead. Left as-is it would look like one giant
   employer and would wrongly cluster unrelated jobs, so it becomes unknown. */
const PAYWALLED = /unlock with premium|premium (?:only|member)|hidden/i;

export function normalizeJob(posting, cfg, query) {
  const regions = splitRegions(locationNames(posting));
  const org = posting.hiringOrganization;
  const sourceId = idOf(posting);
  const description = htmlToText(posting.description);
  return baseJob({
    source: id,
    sourceId,
    jobkey: makeKey(id, sourceId),
    title: (posting.title || "").trim(),
    company: (() => {
      const n = (typeof org === "string" ? org : org?.name)?.trim() || "";
      return !n || PAYWALLED.test(n) ? "Onbekend" : n;
    })(),
    location: regions.slice(0, 6).join(", ") + (regions.length > 6 ? ` +${regions.length - 6}` : ""),
    jobTypes: splitRegions(posting.employmentType).map((t) => EMPLOYMENT[t] || t),
    remote: posting.jobLocationType === "TELECOMMUTE" || true,
    remoteLabels: regions.slice(0, 6),
    regions,
    description,
    summary: description.slice(0, 700),
    url: posting.url || "",
    postedAt: posting.datePosted ? String(posting.datePosted).slice(0, 10) : null,
    expiresAt: posting.validThrough ? String(posting.validThrough).slice(0, 10) : null,
    query,
  });
}

export async function scrape(cfg, { log = console.log, onPage } = {}) {
  const eligible = makeRegionFilter(cfg);
  const stats = { pages: 0, jobs: 0, blockedQueries: [] };

  for (const query of cfg.queries) {
    log(`\nQuery ${query || "(all jobs)"} — ${cfg.baseUrl}${cfg.listPath}`);
    const seen = new Set();
    let dropped = 0;

    for (let page = 1; page <= cfg.maxPagesPerQuery; page++) {
      const url = new URL(cfg.baseUrl + cfg.listPath);
      if (query) url.searchParams.set("search", query);
      if (page > 1) url.searchParams.set("page", String(page));

      const res = await getText(url.toString(), { log });
      stats.pages++;
      if (!res.ok) {
        log(`  request failed (http ${res.status})`);
        stats.blockedQueries.push(query || "(all jobs)");
        break;
      }

      const postings = jobPostings(res.text);
      if (!postings.length) break;

      const batch = [];
      let fresh = 0;
      for (const posting of postings) {
        const job = normalizeJob(posting, cfg, query);
        if (!job.sourceId || seen.has(job.sourceId)) continue;
        seen.add(job.sourceId);
        fresh++;
        if (!eligible(job.regions)) {
          dropped++;
          continue;
        }
        batch.push(job);
      }
      stats.jobs += batch.length;
      const tally = (await onPage?.(batch)) || {};
      log(
        `  page ${page}: ${postings.length} postings, ${batch.length} open to this region, ${dropped} not so far` +
          (tally.total ? ` — ${tally.total} stored` : "")
      );

      // Past the last page the site re-serves the previous one.
      if (!fresh) {
        log("  no new postings on this page — end of results");
        break;
      }
      await sleep(jitter(cfg.delayMs));
    }
  }
  return stats;
}
