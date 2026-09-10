#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { configFor, describeSources, resolveSources, sourceIds } from "./sources/index.js";
import { loadStore, saveStore, upsertJobs, finalizeRun, countBySource } from "./store.js";
import { buildVault } from "./vault.js";

function parseArgs(argv) {
  const opts = { overrides: {}, sources: [] };
  const queries = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--vault-only": opts.vaultOnly = true; break;
      case "--scrape-only": opts.scrapeOnly = true; break;
      case "--headful": opts.overrides.headless = false; break;
      case "--max-pages": opts.overrides.maxPagesPerQuery = Number(next()); break;
      case "--start-page": opts.overrides.startPage = Number(next()); break;
      case "--radius": opts.overrides.radius = Number(next()); break;
      case "--location": opts.overrides.location = next(); break;
      case "--sort": opts.overrides.sort = next(); break;
      case "--job-type": opts.overrides.jobType = next(); break;
      case "--max-age": opts.overrides.maxAgeDays = Number(next()); break;
      case "--query": queries.push(next()); break;
      case "--vault": opts.overrides.vaultPath = next(); break;
      case "--source": opts.sources.push(next()); break;
      case "--sources": opts.sources.push(...next().split(",").map((s) => s.trim()).filter(Boolean)); break;
      case "--list-sources": opts.listSources = true; break;
      case "-h":
      case "--help": opts.help = true; break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }
  if (queries.length) opts.overrides.queries = queries;
  return opts;
}

const HELP = `Usage: npm run scrape -- [options]

  --vault-only        Rebuild the Obsidian vault from data/jobs.json, no scraping
  --scrape-only       Scrape and store, skip vault generation
  --source <id>       Scrape this source only (repeatable) — default: config "sources"
  --sources a,b       Same, comma-separated
  --list-sources      Show the available job boards and exit
  --query <text>      Search term (repeatable; default: empty = every job)
  --location <place>  Override search location (default: 9711 Groningen)
  --radius <km>       Override search radius (default: 25)
  --max-pages <n>     Cap pages per query
  --start-page <n>    Resume from page n (0-based) — for splitting a long run
  --max-age <days>    Only jobs posted within N days
  --sort <date|relevance>          (Indeed)
  --job-type <type>   fulltime | parttime | contract | temporary | internship  (Indeed)
  --vault <path>      Where to write the Obsidian vault
  --headful           Run the browser visibly (needs a display)

Known sources: ${sourceIds().join(", ")}
`;

async function main() {
  const { help, listSources, vaultOnly, scrapeOnly, overrides, sources } = parseArgs(process.argv.slice(2));
  if (help) return console.log(HELP);
  if (listSources) {
    for (const s of describeSources()) {
      console.log(`${s.id.padEnd(14)} ${s.kind.padEnd(8)} ${s.label} — ${s.blurb}`);
    }
    return;
  }

  const cfg = loadConfig(overrides);
  const store = loadStore(cfg.dataFile);
  const ran = [];

  if (!vaultOnly) {
    const modules = resolveSources(cfg, sources);
    if (!modules.length) throw new Error("No sources enabled — check `sources` in config.json");
    const tally = { scraped: 0, added: 0, updated: 0 };
    const blocked = [];
    let pages = 0;

    for (const mod of modules) {
      // `overrides` are the CLI flags; they outrank a source's own defaults.
      const sourceCfg = configFor(cfg, mod.id, overrides);
      console.log(
        `\n=== ${mod.label} (${mod.id}) — ${sourceCfg.queries.length} quer${sourceCfg.queries.length === 1 ? "y" : "ies"} ===`
      );
      const stats = await mod.scrape(sourceCfg, {
        onPage(jobs) {
          const { added, updated } = upsertJobs(store, jobs);
          tally.scraped += jobs.length;
          tally.added += added;
          tally.updated += updated;
          saveStore(cfg.dataFile, store); // checkpoint every page
          return { total: Object.keys(store.jobs).length };
        },
      });
      ran.push(mod.id);
      pages += stats.pages;
      blocked.push(...stats.blockedQueries.map((q) => `${mod.id}: ${q}`));
    }

    const result = finalizeRun(store, tally, { staleAfterDays: cfg.staleAfterDays, sources: ran });
    saveStore(cfg.dataFile, store);
    console.log(
      `\n${pages} pages fetched from ${ran.join(", ")} — ${result.scraped} jobs this run: ${result.added} new, ${result.updated} updated, ${result.closed} newly closed (${result.total} in the store)`
    );
    console.log(
      "Store by source: " +
        Object.entries(countBySource(store)).map(([s, n]) => `${s} ${n}`).join(", ")
    );
    if (blocked.length) {
      console.log(`Cut short: ${blocked.join(", ")} — rerun later to fill the gaps.`);
    }
  }

  if (!scrapeOnly) buildVault(cfg, store);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
