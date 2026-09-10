/* Hoofdkraan — Dutch ZZP marketplace. Its assignment feed is public RSS.
   These are opdrachten rather than vacancies: you invoice, no employment
   contract, which is the point of having it on the list. */
import { baseJob, htmlToText, makeKey } from "./util.js";
import { getText } from "./lib/http.js";
import { feedDate, linkOf, parseFeed, tag } from "./lib/feed.js";

export const id = "hoofdkraan";
export const label = "Hoofdkraan";
export const kind = "http";
export const supportsQueries = false;
export const geoFiltered = false;
export const blurb = "Dutch ZZP assignment marketplace; public RSS of open opdrachten.";

export const defaults = { feedUrl: "https://www.hoofdkraan.nl/opdrachten/rss", delayMs: [800, 1500] };

const idOf = (link) => (String(link).match(/\/(\d+)\/?$/) || [])[1] || String(link).split("/").filter(Boolean).pop() || "";

/* Titles routinely carry the budget: "… budget E50-350". */
function budget(title) {
  const m = title.match(/budget\s*[€E]\s*([\d.,]+)\s*(?:-\s*([\d.,]+))?/i);
  if (!m) return "";
  return m[2] ? `€${m[1]} - €${m[2]}` : `€${m[1]}`;
}

export function normalizeItem(item, cfg) {
  const link = linkOf(item);
  const sourceId = idOf(link);
  const title = tag(item, "title");
  const description = htmlToText(tag(item, "description"));
  return baseJob({
    source: id,
    sourceId,
    jobkey: makeKey(id, sourceId),
    title: title.replace(/\s*budget\s*[€E].*$/i, "").trim() || title,
    // The feed names no client — these are assignments posted by individuals
    // and small businesses, and the board keeps the poster anonymous.
    company: "Hoofdkraan (opdrachtgever niet vermeld)",
    location: "Nederland",
    salary: budget(title),
    jobTypes: ["Opdracht (ZZP)"],
    description,
    summary: description.slice(0, 700),
    url: link,
    postedAt: feedDate(tag(item, "pubDate")),
  });
}

export async function scrape(cfg, { log = console.log, onPage } = {}) {
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
  const seen = new Set();
  const batch = [];
  for (const item of items) {
    const job = normalizeItem(item, cfg);
    if (!job.sourceId || seen.has(job.sourceId)) continue;
    seen.add(job.sourceId);
    batch.push(job);
  }
  stats.jobs += batch.length;
  const tally = (await onPage?.(batch)) || {};
  log(`  ${items.length} items, ${batch.length} assignments` + (tally.total ? ` — ${tally.total} stored` : ""));
  return stats;
}
