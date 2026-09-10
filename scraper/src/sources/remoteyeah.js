/* RemoteYeah — RSS feed with company and location as their own elements. */
import { baseJob, htmlToText, makeKey, slugFromUrl } from "./util.js";
import { getText } from "./lib/http.js";
import { feedDate, linkOf, parseFeed, tag, tags } from "./lib/feed.js";
import { makeRegionFilter, splitRegions } from "./lib/region.js";

export const id = "remoteyeah";
export const label = "RemoteYeah";
export const kind = "http";
export const supportsQueries = false;
export const geoFiltered = false;
export const blurb = "RSS feed of ~300 recent listings, with company and location fields.";

export const defaults = { feedUrl: "https://remoteyeah.com/rss.xml", delayMs: [800, 1500] };

const idOf = (link) => slugFromUrl(link);

/* The description is a bullet list whose first items repeat the structured
   fields ("Locations: United States (Remote)"), which is the only place some
   items state a region at all. */
function regionFrom(item, description) {
  const explicit = tag(item, "location");
  if (explicit) return splitRegions(explicit);
  const m = description.match(/Locations?:\s*(.+)/i);
  return m ? splitRegions(m[1].split("\n")[0]) : [];
}

export function normalizeItem(item, cfg) {
  const link = linkOf(item);
  const sourceId = idOf(link);
  const description = htmlToText(tag(item, "description"));
  const regions = regionFrom(item, description);
  const title = tag(item, "title").replace(/^\s*Remote\s+/i, "").replace(/\s+at\s+.+$/i, "").trim();
  return baseJob({
    source: id,
    sourceId,
    jobkey: makeKey(id, sourceId),
    title: title || tag(item, "title"),
    company: tag(item, "company") || "Onbekend",
    location: regions.join(", "),
    categories: [...tags(item, "category"), ...splitRegions(tag(item, "tags"))],
    remote: true,
    remoteLabels: regions,
    regions,
    description,
    summary: description.slice(0, 700),
    url: link,
    postedAt: feedDate(tag(item, "pubDate")),
  });
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

  const items = parseFeed(res.text);
  const batch = [];
  let dropped = 0;
  const seen = new Set();
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
  log(`  ${items.length} items, ${batch.length} open to this region, ${dropped} not` + (tally.total ? ` — ${tally.total} stored` : ""));
  return stats;
}
