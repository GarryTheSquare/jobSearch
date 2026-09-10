/* 4 Day Week — RSS feed of the board. The feed is title-and-link only, so the
   listing page is fetched for the JSON-LD behind each item; that is one request
   per job, which is why the feed is capped rather than followed wholesale. */
import { baseJob, htmlToText, jitter, makeKey, sleep, slugFromUrl } from "./util.js";
import { getText } from "./lib/http.js";
import { feedDate, linkOf, parseFeed, tag } from "./lib/feed.js";
import { jobPostings, locationNames, EMPLOYMENT } from "./lib/jsonld.js";
import { makeRegionFilter, splitRegions } from "./lib/region.js";

export const id = "fourdayweek";
export const label = "4 Day Week";
export const kind = "http";
export const supportsQueries = false;
export const geoFiltered = false;
export const blurb = "RSS feed plus per-job JSON-LD. Rebuilt daily, so listings stay fresh.";

export const defaults = {
  feedUrl: "https://4dayweek.io/feed",
  // One HTTP request per listing, so keep the per-run appetite modest.
  detailLimit: 50,
  fetchDetail: true,
  delayMs: [900, 1800],
};

const idOf = (link) => slugFromUrl(link);

function fromPosting(posting) {
  const regions = splitRegions(locationNames(posting));
  const org = posting.hiringOrganization;
  const salary = posting.baseSalary?.value;
  const amount = salary?.minValue || salary?.maxValue || salary?.value;
  const currency = posting.baseSalary?.currency || "";
  return {
    company: (typeof org === "string" ? org : org?.name) || "",
    regions,
    jobTypes: splitRegions(posting.employmentType).map((t) => EMPLOYMENT[t] || t),
    description: htmlToText(posting.description),
    postedAt: posting.datePosted ? String(posting.datePosted).slice(0, 10) : null,
    expiresAt: posting.validThrough ? String(posting.validThrough).slice(0, 10) : null,
    salary: amount
      ? `${currency === "EUR" ? "€" : currency === "USD" ? "$" : currency + " "}${Number(salary.minValue || amount).toLocaleString("nl-NL")}` +
        (salary.maxValue && salary.maxValue !== salary.minValue ? ` - ${Number(salary.maxValue).toLocaleString("nl-NL")}` : "")
      : "",
  };
}

export async function scrape(cfg, { log = console.log, onPage } = {}) {
  const eligible = makeRegionFilter(cfg);
  const stats = { pages: 0, jobs: 0, blockedQueries: [] };
  log(`\nFeed ${cfg.feedUrl}`);

  const res = await getText(cfg.feedUrl, { log });
  stats.pages++;
  if (!res.ok) {
    log(`  request failed (http ${res.status})`);
    stats.blockedQueries.push(cfg.feedUrl);
    return stats;
  }

  const items = parseFeed(res.text).slice(0, cfg.detailLimit);
  log(`  ${items.length} items in the feed${cfg.fetchDetail ? "; fetching each listing for its JSON-LD" : ""}`);

  const batch = [];
  let dropped = 0;
  for (const item of items) {
    const link = linkOf(item);
    const sourceId = idOf(link);
    if (!sourceId) continue;
    const rawTitle = tag(item, "title");
    // "Position at Company" — the author element repeats the company.
    const company = tag(item, "author") || rawTitle.split(/\s+at\s+/i).slice(1).join(" at ") || "Onbekend";
    const title = rawTitle.replace(new RegExp(`\\s+at\\s+${company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "").trim();

    let detail = {};
    if (cfg.fetchDetail) {
      const page = await getText(link, { log, attempts: 2 });
      if (page.ok) {
        const posting = jobPostings(page.text)[0];
        if (posting) detail = fromPosting(posting);
      }
      await sleep(jitter(cfg.delayMs));
    }

    const job = baseJob({
      source: id,
      sourceId,
      jobkey: makeKey(id, sourceId),
      title: title || rawTitle,
      company: detail.company || company,
      location: (detail.regions || []).join(", "),
      salary: detail.salary || "",
      jobTypes: detail.jobTypes || [],
      remote: true,
      remoteLabels: detail.regions || [],
      regions: detail.regions || [],
      description: detail.description || "",
      summary: (detail.description || "").slice(0, 700),
      url: link,
      postedAt: detail.postedAt || feedDate(tag(item, "pubDate")),
      expiresAt: detail.expiresAt || null,
    });

    if (!eligible(job.regions)) {
      dropped++;
      continue;
    }
    batch.push(job);
  }

  stats.jobs += batch.length;
  const tally = (await onPage?.(batch)) || {};
  log(`  ${batch.length} open to this region, ${dropped} not` + (tally.total ? ` — ${tally.total} stored` : ""));
  return stats;
}
