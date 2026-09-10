import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* Top-level keys are the *global* defaults, shared by every source. Anything a
   particular board needs done differently lives in its own module defaults or
   under `sourceOptions.<id>` — see src/sources/index.js for the precedence. */
const DEFAULTS = {
  sources: ["indeed"],
  sourceOptions: {},
  host: "nl.indeed.com",
  location: "9711 Groningen",
  radius: 25,
  // The coordinates behind `location`, for the sources that return real
  // coordinates and can therefore filter on true distance rather than on
  // matching place names. Default is the 9711 Groningen postcode.
  center: { lat: 53.2194, lng: 6.5665 },
  queries: [""],
  sort: "date",
  maxAgeDays: null,
  jobType: "",
  pageSize: 15,
  maxPagesPerQuery: 80,
  startPage: 0,
  delayMs: [7000, 14000],
  recycleEvery: 20,
  headless: true,
  vaultPath: "../JobVault",
  dataFile: "data/jobs.json",
  locationInclude: null,
  locationExclude: null,
  staleAfterDays: 45,
  dedupeAcrossSources: true,
  // Remote boards are worldwide; these decide what counts as reachable from
  // here. null for regionInclude disables the filter entirely. See
  // src/sources/lib/region.js for the defaults and the matching rule.
  regionInclude: undefined,
  regionExclude: null,
  keepUnknownRegion: true,
};

export function loadConfig(overrides = {}) {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(readFileSync(resolve(ROOT, "config.json"), "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const cfg = { ...DEFAULTS, ...fileCfg, ...overrides };
  cfg.vaultPath = resolve(ROOT, cfg.vaultPath);
  cfg.dataFile = resolve(ROOT, cfg.dataFile);
  cfg.profileDir = resolve(ROOT, ".browser-profile");
  if (!Array.isArray(cfg.queries) || cfg.queries.length === 0) cfg.queries = [""];
  if (!Array.isArray(cfg.sources) || cfg.sources.length === 0) cfg.sources = ["indeed"];
  if (!cfg.sourceOptions || typeof cfg.sourceOptions !== "object") cfg.sourceOptions = {};
  // `undefined` means "use the shared default"; `null` means "no filter".
  if (cfg.regionInclude === undefined) delete cfg.regionInclude;
  return cfg;
}
