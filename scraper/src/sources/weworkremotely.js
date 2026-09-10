/* We Work Remotely — the site blocks automated fetching of its HTML, but its
   RSS feeds are public and carry the region on each item. */
import { baseJob, htmlToText, jitter, makeKey, sleep, slugFromUrl } from "./util.js";
import { getText } from "./lib/http.js";
import { feedDate, linkOf, parseFeed, tag, tags } from "./lib/feed.js";
import { makeRegionFilter, splitRegions } from "./lib/region.js";

export const id = "weworkremotely";
export const label = "We Work Remotely";
export const kind = "http";
export const supportsQueries = false;
export const geoFiltered = false;
export const blurb = "Public RSS feeds (HTML is bot-blocked); each item states its region.";

export const defaults = {
  feeds: ["https://weworkremotely.com/remote-europe-jobs.rss", "https://weworkremotely.com/remote-jobs.rss"],
  delayMs: [1000, 2000],
};

/* Titles come through as "Company: Position". */
function splitTitle(raw) {
  const idx = raw.indexOf(":");
  if (idx === -1) return { company: "Onbekend", title: raw.trim() };
  return { company: raw.slice(0, idx).trim() || "Onbekend", title: raw.slice(idx + 1).trim() };
}

const idOf = (link) => (String(link).match(/\/remote-jobs\/([^/?#]+)/) || [])[1] || slugFromUrl(link);

export function normalizeItem(item, cfg) {
  const link = linkOf(item);
  const { company, title } = splitTitle(tag(item, "title"));
  const regions = splitRegions(tag(item, "region"));
  const sourceId = idOf(link);
  const description = htmlToText(tag(item, "description"));
  return baseJob({
    source: id,
    sourceId,
    jobkey: makeKey(id, sourceId),
    title,
    company,
    location: regions.join(", "),
    jobTypes: [tag(item, "programming_type")].filter(Boolean),
    categories: tags(item, "category"),
    remote: true,
    remoteLabels: regions,
    regions,
    description,
    summary: description.slice(0, 700),
    url: link,
    postedAt: feedDate(tag(item, "pubDate")),
    expiresAt: feedDate(tag(item, "expires_at")),
  });
}

export async function scrape(cfg, { log = console.log, onPage } = {}) {
  const eligible = makeRegionFilter(cfg);
  const stats = { pages: 0, jobs: 0, blockedQueries: [] };
  const seen = new Set();

  for (const feed of cfg.feeds) {
    log(`\nFeed ${feed}`);
    const res = await getText(feed, { log });
    stats.pages++;
    if (!res.ok) {
      log(`  request failed (http ${res.status})`);
      stats.blockedQueries.push(feed);
      continue;
    }

    const items = parseFeed(res.text);
    const batch = [];
    let dropped = 0;
    for (const item of items) {
      const job = normalizeItem(item, cfg);
      if (!job.sourceId || seen.has(job.sourceId)) continue;
      seen.add(job.sourceId);
      if (!eligible(job.regions)) {
        dropped++;
        continue;
      }
      batch.push(job);
    }
    stats.jobs += batch.length;
    const tally = (await onPage?.(batch)) || {};
    log(`  ${items.length} items, ${batch.length} kept, ${dropped} out of region` + (tally.total ? ` — ${tally.total} stored` : ""));
    await sleep(jitter(cfg.delayMs));
  }
  return stats;
}
