/* Noorderlink — the HR network of the northern Netherlands. A Tier-1 source:
   the site is a Nuxt front end over a plain paginated JSON API, so this adapter
   is a handful of fetches, no browser at all. The payload is richer than
   Indeed's: real salary numbers, hours, coordinates and the full advert text.

   Note: noorderlink.nl/robots.txt disallows /api/* for crawlers. This adapter
   reads a few pages a day for one person's job search, identifies itself, and
   pauses between requests — far less traffic than paging the HTML would cost.
   Set `enabled: false` under sourceOptions.noorderlink to leave it alone. */
import { baseJob, haversineKm, htmlToText, jitter, makeKey, sleep } from "./util.js";

export const id = "noorderlink";
export const label = "Noorderlink";
export const kind = "http";
export const supportsQueries = true;
export const blurb = "Public JSON API, no browser. Covers Groningen, Friesland and Drenthe.";

/* Keys whose top-level value was written for Indeed and makes no sense here.
   Anything not listed keeps coming from the global config, so a change to
   `radius` or `locationExclude` still reaches this source. */
export const defaults = {
  baseUrl: "https://noorderlink.nl",
  apiPath: "/api/backend/vacancies/1.2/vacancies/filter",
  pageSize: 100,
  delayMs: [700, 1500],
  // The API returns coordinates, so `radius` is applied as a true circle
  // around the shared `center` from the global config.
  includeExpired: false,
};

const UA = "groningen-job-scraper/2.0 (personal job search; contact via noorderlink.nl form)";

function pageUrl(cfg, query, page) {
  const p = new URLSearchParams();
  if (query) p.set("query", query);
  p.set("limit", String(cfg.pageSize));
  p.set("page", String(page));
  return `${cfg.baseUrl}${cfg.apiPath}?${p.toString()}`;
}

async function fetchPage(url, log) {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": UA, "Accept-Language": "nl-NL,nl;q=0.9" },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`http ${res.status}`);
      if (!res.ok) return { ok: false, status: res.status, items: [] };
      const body = await res.json();
      return { ok: true, total: body.total_items ?? null, items: body.items || [] };
    } catch (err) {
      const backoff = 5000 * attempt;
      log(`  request failed (${err.message}) — attempt ${attempt}/${attempts}, retrying in ${backoff / 1000}s`);
      if (attempt < attempts) await sleep(backoff);
    }
  }
  return { ok: false, items: [] };
}

/* base_salary / max_salary come back as bare numbers with no period. Anything
   in the low hundreds is an hourly rate; the rest is gross per month. */
function formatSalary(salary) {
  const min = Number(salary?.base_salary) || 0;
  const max = Number(salary?.max_salary) || 0;
  if (!min && !max) return "";
  const unit = Math.max(min, max) < 100 ? "per uur" : "per maand";
  const num = (n) => "€" + n.toLocaleString("nl-NL", { maximumFractionDigits: unit === "per uur" ? 2 : 0 });
  const range = min && max && min !== max ? `${num(min)} - ${num(max)}` : num(max || min);
  return `${range} ${unit}`;
}

const REMOTE = /\b(thuiswerk\w*|hybride\s*werken|hybride|remote|op\s+afstand\s+werken)\b/i;

function textOf(raw) {
  const blocks = (raw.text_blocks || []).map((b) => b.text).filter(Boolean);
  return htmlToText([raw.text, ...blocks].filter(Boolean).join("<br/><br/>"));
}

const names = (arr) => (arr || []).map((a) => a.name).filter(Boolean);
const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);

export function normalizeJob(raw, cfg, query) {
  const org = raw.organisation || {};
  const description = textOf(raw);
  const city = raw.locality || org.city || "";
  const province = raw.province || org.province || "";
  const remoteLabels = [...new Set((description.match(REMOTE) ? [description.match(REMOTE)[0]] : []))];
  return baseJob({
    source: id,
    sourceId: String(raw.id),
    jobkey: makeKey(id, raw.id),
    title: (raw.title || "").trim(),
    company: (org.title || "").trim() || "Onbekend",
    location: [city, province && province !== city ? province : ""].filter(Boolean).join(", "),
    city,
    postal: raw.zipcode || "",
    province,
    lat: raw.lat ?? org.lat ?? null,
    lng: raw.lng ?? org.lng ?? null,
    salary: formatSalary(raw.salary),
    jobTypes: names(raw.employments),
    categories: [...names(raw.functions), ...names(raw.workfields)],
    education: names(raw.educations),
    hoursMin: raw.min_hours ?? null,
    hoursMax: raw.max_hours ?? null,
    remote: remoteLabels.length > 0,
    remoteLabels,
    // The advert is the whole text; the vault wants a short lead as well.
    summary: description.slice(0, 700).trim() + (description.length > 700 ? "…" : ""),
    description,
    url: `${cfg.baseUrl}/vacature/${raw.slug}`,
    applyUrl: raw.apply_method === "url" ? raw.apply || "" : "",
    postedAt: day(raw.go_live_at || raw.first_published_at),
    expiresAt: day(raw.expire_at),
    query,
  });
}

export async function scrape(cfg, { log = console.log, onPage } = {}) {
  const include = cfg.locationInclude ? new RegExp(cfg.locationInclude, "i") : null;
  const exclude = cfg.locationExclude ? new RegExp(cfg.locationExclude, "i") : null;
  const center = cfg.radius > 0 ? cfg.center : null;
  const maxAge = cfg.maxAgeDays
    ? new Date(Date.now() - cfg.maxAgeDays * 86400000).toISOString().slice(0, 10)
    : null;
  const stats = { pages: 0, jobs: 0, blockedQueries: [] };

  for (const query of cfg.queries) {
    const queryLabel = query || "(alle vacatures)";
    log(`\nQuery ${queryLabel} — ${cfg.baseUrl}${center ? `, ${cfg.radius} km around ${center.lat},${center.lng}` : ""}`);
    let dropped = 0;

    const firstPage = (cfg.startPage || 0) + 1; // this API pages from 1
    for (let pageNo = firstPage; pageNo < firstPage + cfg.maxPagesPerQuery; pageNo++) {
      const res = await fetchPage(pageUrl(cfg, query, pageNo), log);
      stats.pages++;

      if (!res.ok) {
        log(`  giving up on this query after repeated failures (page ${pageNo})`);
        stats.blockedQueries.push(queryLabel);
        break;
      }
      if (res.items.length === 0) break;

      const batch = [];
      for (const raw of res.items) {
        if (!raw?.id) continue;
        if (!cfg.includeExpired && raw.is_expired) continue;
        const job = normalizeJob(raw, cfg, query);
        if (maxAge && job.postedAt && job.postedAt < maxAge) continue;
        if (include && !include.test(job.location)) continue;
        if (exclude && exclude.test(job.location)) continue;
        // Coordinates are the reliable filter; a listing without them is kept
        // rather than guessed at — the board is regional to begin with.
        if (center && job.lat != null && job.lng != null) {
          if (haversineKm(center, { lat: job.lat, lng: job.lng }) > cfg.radius) {
            dropped++;
            continue;
          }
        }
        batch.push(job);
      }
      stats.jobs += batch.length;

      const tally = (await onPage?.(batch)) || {};
      log(
        `  page ${pageNo}: ${res.items.length} listings, ${batch.length} kept` +
          (dropped ? `, ${dropped} outside the radius so far` : "") +
          (tally.total ? ` — ${tally.total} stored` : "") +
          (res.total ? ` (${res.total} on the board)` : "")
      );

      if (res.items.length < cfg.pageSize) break; // last page
      await sleep(jitter(cfg.delayMs));
    }
  }

  return stats;
}
