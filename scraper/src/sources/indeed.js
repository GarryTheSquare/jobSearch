/* Indeed NL — a Tier-3 source: hostile to plain HTTP (403 on every request), so
   it needs a real Chromium. The job data itself comes from the JSON blob Indeed
   embeds in the search page, not from the rendered cards. */
import { chromium } from "playwright";
import { baseJob, htmlToText, jitter, makeKey, sleep } from "./util.js";

export const id = "indeed";
export const label = "Indeed NL";
export const kind = "browser";
export const supportsQueries = true;
export const blurb = "Chromium via Playwright; ~1000 results per query, rate-limited.";

/* Keys whose global value is meaningless or wrong for this source. Indeed is
   the source the top-level config was written for, so it overrides nothing. */
export const defaults = {};

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

const BLOCK_TITLES = [/blocked/i, /security check/i, /even geduld/i, /just a moment/i, /verify you are human/i];

export function searchUrl(cfg, query, start) {
  const p = new URLSearchParams();
  p.set("q", query || "");
  p.set("l", cfg.location);
  p.set("radius", String(cfg.radius));
  if (cfg.sort) p.set("sort", cfg.sort);
  if (cfg.jobType) p.set("jt", cfg.jobType);
  if (cfg.maxAgeDays) p.set("fromage", String(cfg.maxAgeDays));
  if (start) p.set("start", String(start));
  return `https://${cfg.host}/jobs?${p.toString()}`;
}

/* Pulls the job list out of the JSON blob Indeed embeds in the search page.
   Falls back to the rendered cards if the blob moved or is missing. */
const EXTRACT = () => {
  const model =
    window.mosaic?.providerData?.["mosaic-provider-jobcards"]?.metaData?.mosaicProviderJobCardsModel;
  if (model?.results?.length) {
    return { source: "mosaic", total: model.totalJobCount ?? null, results: model.results };
  }
  const cards = Array.from(document.querySelectorAll(".job_seen_beacon, [data-jk]"));
  const results = cards
    .map((card) => {
      const jk = card.getAttribute("data-jk") || card.querySelector("[data-jk]")?.getAttribute("data-jk");
      if (!jk) return null;
      const text = (sel) => card.querySelector(sel)?.textContent?.trim() || "";
      return {
        jobkey: jk,
        title: text("h2.jobTitle span[title], h2.jobTitle span, .jobTitle"),
        company: text('[data-testid="company-name"], .companyName'),
        formattedLocation: text('[data-testid="text-location"], .companyLocation'),
        snippet: card.querySelector('[data-testid="jobsnippet_footer"], .job-snippet')?.innerHTML || "",
        salarySnippetText: text('[data-testid="attribute_snippet_testid"], .salary-snippet-container'),
        formattedRelativeTime: text('[data-testid="myJobsStateDate"], .date'),
      };
    })
    .filter(Boolean);
  return { source: "dom", total: null, results };
};

function isBlocked(title) {
  return BLOCK_TITLES.some((re) => re.test(title || ""));
}

async function openBrowser(cfg) {
  const context = await chromium.launchPersistentContext(cfg.profileDir, {
    headless: cfg.headless,
    channel: "chromium",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--lang=nl-NL",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--mute-audio",
    ],
    userAgent: USER_AGENT,
    locale: "nl-NL",
    timezoneId: "Europe/Amsterdam",
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8" },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  // The job data comes from an inline JSON blob, so images, fonts and media are
  // pure overhead — dropping them keeps Chromium small on a low-memory host.
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image" || type === "font" || type === "media") return route.abort();
    return route.continue();
  });
  return context;
}

async function dismissConsent(page) {
  for (const sel of ["#onetrust-accept-btn-handler", "button:has-text('Alles accepteren')", "button:has-text('Accepteren')"]) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1000);
      return true;
    }
  }
  return false;
}

/* Loads one search page, waiting out (and retrying past) Indeed's bot checks. */
async function fetchPage(page, url, cfg, log) {
  const attempts = 4;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => {
      log(`  navigation failed: ${e.message}`);
      return null;
    });
    const status = resp ? resp.status() : 0;
    // Challenge pages sometimes resolve themselves once the JS runs.
    const gotResults = await page
      .waitForFunction(
        () =>
          !!window.mosaic?.providerData?.["mosaic-provider-jobcards"]?.metaData?.mosaicProviderJobCardsModel
            ?.results?.length || !!document.querySelector(".job_seen_beacon"),
        null,
        { timeout: 25000 }
      )
      .then(() => true)
      .catch(() => false);

    await dismissConsent(page);
    const title = await page.title().catch(() => "");

    if (gotResults) return { ok: true, status, ...(await page.evaluate(EXTRACT)) };

    if (isBlocked(title) || status === 403 || status === 429) {
      const backoff = 60000 * attempt;
      log(`  blocked (http ${status}, "${title}") — attempt ${attempt}/${attempts}, backing off ${backoff / 1000}s`);
      if (attempt < attempts) await sleep(backoff);
      continue;
    }
    // Loaded fine but genuinely empty (past the last page of results).
    return { ok: true, status, source: "empty", total: null, results: [] };
  }
  return { ok: false, blocked: true, results: [] };
}

function formatSalary(raw) {
  if (raw.salarySnippetText) return raw.salarySnippetText;
  const s = raw.salarySnippet;
  if (s?.text) return s.text.replace(/\s+/g, " ").trim();
  const ex = raw.extractedSalary;
  if (ex && (ex.min || ex.max)) {
    const cur = s?.currency === "EUR" ? "€" : s?.currency ? s.currency + " " : "";
    const unit = { HOURLY: "per uur", DAILY: "per dag", WEEKLY: "per week", MONTHLY: "per maand", YEARLY: "per jaar" }[ex.type] || "";
    const num = (n) => cur + Math.round(n).toLocaleString("nl-NL");
    const range = ex.min && ex.max && ex.min !== ex.max ? `${num(ex.min)} - ${num(ex.max)}` : num(ex.max || ex.min);
    return `${range} ${unit}`.trim();
  }
  return "";
}

function taxo(raw, name) {
  const group = (raw.taxonomyAttributes || []).find((g) => g.label === name);
  return (group?.attributes || []).map((a) => a.label);
}

export function normalizeJob(raw, cfg, query) {
  const jobTypes = raw.jobTypes?.length ? raw.jobTypes : taxo(raw, "job-types");
  const remoteLabels = taxo(raw, "remote");
  const posted = raw.pubDate || raw.createDate || null;
  return baseJob({
    source: id,
    sourceId: raw.jobkey,
    jobkey: makeKey(id, raw.jobkey),
    title: (raw.displayTitle || raw.title || "").trim(),
    company: (raw.company || "").trim() || "Onbekend",
    location: (raw.formattedLocation || "").trim(),
    city: raw.jobLocationCity || "",
    postal: raw.jobLocationPostal || "",
    province: raw.jobLocationState || "",
    salary: formatSalary(raw),
    jobTypes,
    shifts: taxo(raw, "shifts"),
    benefits: taxo(raw, "benefits"),
    remote: remoteLabels.length > 0 || !!raw.remoteLocation,
    remoteLabels,
    summary: htmlToText(raw.snippet),
    url: `https://${cfg.host}/viewjob?jk=${raw.jobkey}`,
    postedAt: posted ? new Date(posted).toISOString().slice(0, 10) : null,
    postedRelative: raw.formattedRelativeTime || "",
    companyRating: raw.companyRating ?? null,
    companyReviews: raw.companyReviewCount ?? null,
    easyApply: !!raw.indeedApplyable,
    urgentlyHiring: !!raw.urgentlyHiring,
    query,
  });
}

export async function scrape(cfg, { log = console.log, onPage } = {}) {
  let context = await openBrowser(cfg);
  let page = await context.newPage();
  const include = cfg.locationInclude ? new RegExp(cfg.locationInclude, "i") : null;
  const exclude = cfg.locationExclude ? new RegExp(cfg.locationExclude, "i") : null;
  const stats = { pages: 0, jobs: 0, blockedQueries: [] };
  let sinceRecycle = 0;

  /* Chromium creeps upwards over a long run; a fresh context every so often
     hands the memory back. The profile directory keeps the cookies. */
  const recycle = async () => {
    await context.close().catch(() => {});
    context = await openBrowser(cfg);
    page = await context.newPage();
    sinceRecycle = 0;
  };

  try {
    for (const query of cfg.queries) {
      const queryLabel = query || "(alle vacatures)";
      log(`\nQuery ${queryLabel} — ${cfg.location}, ${cfg.radius} km`);
      let emptyStreak = 0;
      // Per query, so an overlapping second query is not mistaken for the end.
      const queryKeys = new Set();

      const firstPage = cfg.startPage || 0;
      for (let pageNo = firstPage; pageNo < firstPage + cfg.maxPagesPerQuery; pageNo++) {
        if (sinceRecycle >= cfg.recycleEvery) {
          log("  recycling the browser");
          await recycle();
        }

        const start = pageNo * cfg.pageSize;
        const res = await fetchPage(page, searchUrl(cfg, query, start), cfg, log);
        stats.pages++;
        sinceRecycle++;

        if (!res.ok) {
          log(`  giving up on this query after repeated blocks (page ${pageNo + 1})`);
          stats.blockedQueries.push(queryLabel);
          break;
        }

        const before = queryKeys.size;
        const batch = [];
        for (const raw of res.results) {
          if (!raw?.jobkey) continue;
          queryKeys.add(raw.jobkey);
          const job = normalizeJob(raw, cfg, query);
          if (include && !include.test(job.location)) continue;
          if (exclude && exclude.test(job.location)) continue;
          batch.push(job);
        }
        const added = queryKeys.size - before;
        stats.jobs += batch.length;

        // Hand the page over immediately: a crash or an OOM kill then costs one
        // page, not the whole run.
        const tally = (await onPage?.(batch)) || {};
        log(
          `  page ${pageNo + 1} (start=${start}): ${res.results.length} cards, ${added} new` +
            (tally.total ? ` — ${tally.total} stored` : "")
        );

        if (res.results.length === 0) {
          emptyStreak++;
          if (emptyStreak >= 2) break;
        } else {
          emptyStreak = 0;
        }
        // Indeed keeps serving the last page once you run past the end.
        if (res.results.length > 0 && added === 0 && pageNo > firstPage) {
          log("  no new jobs on this page — end of results for this query");
          break;
        }
        await sleep(jitter(cfg.delayMs));
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  return stats;
}
