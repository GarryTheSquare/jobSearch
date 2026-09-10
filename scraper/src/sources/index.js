/* The source registry. Adding a board means dropping a module in this folder
   and listing it here; nothing else in the pipeline is source-aware.

   A source module exports:
     id, label, kind ("http" | "browser"), supportsQueries, geoFiltered, blurb
     defaults   — config keys whose global value is wrong for this source
     scrape(cfg, { log, onPage })  — yields normalized jobs a page at a time

   `geoFiltered: false` marks a board of remote work, where "25 km around
   Groningen" is meaningless. Those adapters filter on stated candidate
   eligibility instead — see lib/region.js.
*/
import * as indeed from "./indeed.js";
import * as noorderlink from "./noorderlink.js";
import * as striive from "./striive.js";
import * as hoofdkraan from "./hoofdkraan.js";
import * as landingjobs from "./landingjobs.js";
import * as himalayas from "./himalayas.js";
import * as remotive from "./remotive.js";
import * as jobicy from "./jobicy.js";
import * as remoteok from "./remoteok.js";
import * as workingnomads from "./workingnomads.js";
import * as weworkremotely from "./weworkremotely.js";
import * as remoteyeah from "./remoteyeah.js";
import * as fourdayweek from "./fourdayweek.js";
import * as dailyremote from "./dailyremote.js";

/* Local boards first, then the Dutch ZZP marketplaces, then the remote boards —
   the order runs cheap-and-relevant before broad-and-slow. */
export const SOURCES = [
  indeed,
  noorderlink,
  striive,
  hoofdkraan,
  landingjobs,
  himalayas,
  remotive,
  jobicy,
  remoteok,
  workingnomads,
  weworkremotely,
  remoteyeah,
  fourdayweek,
  dailyremote,
];
export const byId = new Map(SOURCES.map((s) => [s.id, s]));

export const sourceIds = () => SOURCES.map((s) => s.id);

export function describeSources() {
  return SOURCES.map((s) => ({
    id: s.id,
    label: s.label,
    kind: s.kind,
    supportsQueries: s.supportsQueries !== false,
    geoFiltered: s.geoFiltered !== false,
    blurb: s.blurb || "",
    defaultEnabled: s.defaults?.enabled !== false,
  }));
}

export function labelFor(sourceId) {
  return byId.get(sourceId)?.label || sourceId;
}

/* Config precedence, lowest to highest:
     global config  <  the source's own defaults  <  sourceOptions[id]  <  CLI flags
   A source declares a default precisely because the global value is meaningless
   for it (Indeed's 7-second delay on a JSON API, say), so its defaults win over
   the globals. Per-source options are the escape hatch in the config file, and
   anything typed on the command line wins outright — `--max-pages 3` has to
   mean three pages on every board, whatever their defaults say. */
export function configFor(cfg, sourceId, overrides = {}) {
  const mod = byId.get(sourceId);
  if (!mod) throw new Error(`Unknown source: ${sourceId}`);
  const merged = { ...cfg, ...(mod.defaults || {}), ...(cfg.sourceOptions?.[sourceId] || {}), ...overrides };
  // A board that ignores search terms should not be run once per query.
  if (mod.supportsQueries === false) merged.queries = [""];
  return merged;
}

/* Resolves the sources to run: an explicit list if given, else the enabled set
   from the config. Unknown names are a hard error — a typo should not silently
   scrape nothing. A source asked for by name runs even if it is off by
   default; only the config-driven set honours `enabled: false`. */
export function resolveSources(cfg, requested) {
  if (requested?.length) {
    const unknown = requested.filter((name) => !byId.has(name));
    if (unknown.length) {
      throw new Error(`Unknown source(s): ${unknown.join(", ")}. Known: ${sourceIds().join(", ")}`);
    }
    return requested.map((name) => byId.get(name));
  }
  const wanted = cfg.sources.filter((name) => byId.has(name));
  const unknown = cfg.sources.filter((name) => !byId.has(name));
  if (unknown.length) throw new Error(`Unknown source(s) in config: ${unknown.join(", ")}`);
  return wanted
    .map((name) => byId.get(name))
    .filter((mod) => (cfg.sourceOptions?.[mod.id]?.enabled ?? mod.defaults?.enabled ?? true) !== false);
}
