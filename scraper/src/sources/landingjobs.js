/* Landing.jobs — Lisbon-based European tech board with a public v1 API.
   Unlike the other remote boards this one carries on-site roles too, so the
   listing's own country codes decide eligibility rather than a remote flag. */
import { baseJob, htmlToText, jitter, makeKey, sleep } from "./util.js";
import { getJson } from "./lib/http.js";
import { makeRegionFilter } from "./lib/region.js";

export const id = "landingjobs";
export const label = "Landing.jobs";
export const kind = "http";
export const supportsQueries = false;
export const geoFiltered = false;
export const blurb = "Public v1 API; European tech roles and projects, EU-wide.";

export const defaults = { apiUrl: "https://landing.jobs/api/v1/jobs", landingLimit: 50, delayMs: [700, 1400] };

/* The API carries no company field at all; the public job URL is
   /at/<company-slug>/<job-slug>, so the employer has to come from there. */
export function companyFrom(url) {
  const slug = (String(url || "").match(/\/at\/([^/]+)\//) || [])[1];
  if (!slug) return "Onbekend";
  return slug
    .split("-")
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

function salary(raw) {
  const low = Number(raw.gross_salary_low) || 0;
  const high = Number(raw.gross_salary_high) || 0;
  if (!low && !high) return "";
  const cur = raw.currency_code === "EUR" ? "€" : raw.currency_code === "USD" ? "$" : `${raw.currency_code || ""} `;
  const num = (n) => cur + n.toLocaleString("nl-NL");
  return (low && high && low !== high ? `${num(low)} - ${num(high)}` : num(high || low)) + " per jaar";
}

/* Two-letter country codes, so the shared region filter (which matches names)
   needs the country spelled out. Only the ones this board actually uses. */
const COUNTRY = {
  NL: "Netherlands", BE: "Belgium", DE: "Germany", FR: "France", ES: "Spain",
  PT: "Portugal", IT: "Italy", IE: "Ireland", GB: "United Kingdom", UK: "United Kingdom",
  PL: "Poland", SE: "Sweden", DK: "Denmark", NO: "Norway", FI: "Finland",
  AT: "Austria", CH: "Switzerland", CZ: "Czech Republic", RO: "Romania", GR: "Greece",
  US: "United States", CA: "Canada", BR: "Brazil", AU: "Australia",
};

function places(raw) {
  const out = (raw.locations || []).map((l) => {
    const country = COUNTRY[String(l.country_code || "").toUpperCase()] || l.country_code || "";
    return [l.city, country].filter(Boolean).join(", ");
  });
  if (raw.remote) out.push("Remote");
  return [...new Set(out.filter(Boolean))];
}

export function normalizeJob(raw, cfg, query) {
  const regions = places(raw);
  const first = (raw.locations || [])[0] || {};
  const body = [raw.role_description, raw.main_requirements, raw.nice_to_have, raw.perks].filter(Boolean).join("<br/><br/>");
  return baseJob({
    source: id,
    sourceId: String(raw.id),
    jobkey: makeKey(id, raw.id),
    title: (raw.title || "").trim(),
    company: companyFrom(raw.url),
    location: regions.join(" · "),
    city: first.city || "",
    salary: salary(raw),
    jobTypes: [raw.type].filter(Boolean),
    categories: (raw.tags || []).filter(Boolean),
    remote: !!raw.remote,
    remoteLabels: raw.remote ? ["Remote"] : [],
    regions,
    description: htmlToText(body),
    summary: htmlToText(raw.role_description || body).slice(0, 700),
    url: raw.url,
    postedAt: raw.published_at ? raw.published_at.slice(0, 10) : null,
    expiresAt: raw.expires_at ? raw.expires_at.slice(0, 10) : null,
    query,
  });
}

export async function scrape(cfg, { log = console.log, onPage } = {}) {
  const eligible = makeRegionFilter(cfg);
  const stats = { pages: 0, jobs: 0, blockedQueries: [] };
  log(`\nAll listings — ${cfg.apiUrl} (this board has no search parameter)`);

  const seen = new Set();
  let dropped = 0;
  for (let page = 1; page <= cfg.maxPagesPerQuery; page++) {
    const url = new URL(cfg.apiUrl);
    url.searchParams.set("limit", String(cfg.landingLimit));
    url.searchParams.set("page", String(page));

    const res = await getJson(url.toString(), { log });
    stats.pages++;
    if (!res.ok) {
      log(`  request failed (http ${res.status})`);
      stats.blockedQueries.push("(all jobs)");
      break;
    }

    const items = Array.isArray(res.data) ? res.data : res.data?.jobs || [];
    if (!items.length) break;
    // The API ignores an out-of-range page rather than erroring, so stop when
    // a page repeats what the previous one already gave us.
    const fresh = items.filter((r) => r?.id && !seen.has(r.id));
    if (!fresh.length) break;

    const batch = [];
    for (const raw of fresh) {
      seen.add(raw.id);
      const job = normalizeJob(raw, cfg, "");
      if (!eligible(job.regions)) {
        dropped++;
        continue;
      }
      batch.push(job);
    }
    stats.jobs += batch.length;
    const tally = (await onPage?.(batch)) || {};
    log(`  page ${page}: ${items.length} listings, ${batch.length} kept, ${dropped} out of region so far` + (tally.total ? ` — ${tally.total} stored` : ""));

    if (items.length < cfg.landingLimit) break;
    await sleep(jitter(cfg.delayMs));
  }
  return stats;
}
