#!/usr/bin/env node
/* The back end of the Obsidian control panel — see src/panel.js for the notes
   themselves.

   A button in Profile/Scraper.md fires a Shell command, and every one of those
   commands is this script. It folds the note's properties into config.json and
   starts the scraper *detached*, so Obsidian is never held hostage by a run
   that takes half an hour; the output streams into Profile/Scraper Log.md,
   which the panel embeds, and the vault is rebuilt when the queue empties.

   Usage (from the vault folder, which is where Obsidian runs it):

     node ../scraper/src/vault-ui.js <command>

     pull                    config.json  → the panel note
     push                    the panel note → config.json
     run [--only local|remote]  save, then scrape in the background
     vault                   rebuild the vault from the stored jobs
     stop                    stop the run that is going
     status                  refresh the log note's numbers
     apply                   gather the vacancies marked `status: apply`
     run-worker              internal: the background run itself
*/

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { ROOT, loadConfig } from "./config.js";
import { describeSources, labelFor } from "./sources/index.js";
import { loadStore } from "./store.js";
import {
  ALL_JOBS, PANEL_FILE, LOG_FILE, configToPanel, panelToConfig, readConfigFile, enabledSources,
  writeConfigFile, readPanel, writePanel, renderLogNote, writeLogNote, existingLog,
} from "./panel.js";

const SELF = fileURLToPath(import.meta.url);
const CLI = join(ROOT, "src", "cli.js");
const APPLY_CLI = join(ROOT, "src", "apply-cli.js");
const PID_FILE = join(ROOT, "data", "run.pid");
const JOB_FILE = join(ROOT, "data", "run.json");
const CRASH_LOG = join(ROOT, "data", "run-crash.log");
const MAX_LOG_LINES = 400;

/* ---------- commands ---------- */

const COMMANDS = {
  pull: () => {
    const vault = loadConfig().vaultPath;
    writePanel(vault, configToPanel(readConfigFile()));
    refreshStatus();
    return `Loaded config.json into ${PANEL_FILE}`;
  },

  push: () => {
    save();
    return `Saved ${PANEL_FILE} into config.json`;
  },

  run: (args) => {
    const config = save();
    const only = flag(args, "--only");
    if (only && only !== "local" && only !== "remote") throw new Error(`--only takes "local" or "remote"`);
    const sources = pick(config.sources, only);
    if (!sources.length) throw new Error(`no ${only ? only + " " : ""}boards are ticked`);
    const queries = config.queries?.length ? config.queries : [""];
    start({ mode: "scrape", sources, queries });
    return `Scraping ${sources.length} board(s) × ${queries.length} quer${queries.length === 1 ? "y" : "ies"} — watch ${LOG_FILE}`;
  },

  vault: () => {
    start({ mode: "vault" });
    return `Rebuilding the vault — watch ${LOG_FILE}`;
  },

  stop: () => {
    const pid = runningPid();
    if (!pid) return "Nothing is running.";
    process.kill(pid, "SIGTERM");
    return "Stopping — everything scraped so far is already saved.";
  },

  status: () => {
    refreshStatus();
    return `Refreshed ${LOG_FILE}`;
  },

  apply: () => {
    const result = spawnSync(process.execPath, [APPLY_CLI], { cwd: ROOT, encoding: "utf8" });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (result.status !== 0) throw new Error(output || `apply exited with code ${result.status}`);
    return output.split("\n").slice(-12).join("\n");
  },

  "run-worker": () => worker(),
};

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const help = !command || command === "-h" || command === "--help";
  if (help || !COMMANDS[command]) {
    if (!help) console.error(`Unknown command: ${command}\n`);
    console.log(readFileSync(SELF, "utf8").match(/Usage[\s\S]*?\n\*\//)[0].replace(/\n\*\/$/, ""));
    process.exit(help ? 0 : 1);
  }
  const message = await COMMANDS[command](args);
  if (message) console.log(message);
}

/* ---------- helpers ---------- */

const flag = (args, name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

function save() {
  const config = panelToConfig(readPanel(loadConfig().vaultPath).front, readConfigFile());
  writeConfigFile(config);
  return config;
}

/* Boards, in registry order, narrowed to one geography if asked. */
function pick(sources, only) {
  const wanted = new Set(sources || []);
  return describeSources()
    .filter((s) => wanted.has(s.id))
    .filter((s) => (only === "local" ? s.geoFiltered : only === "remote" ? !s.geoFiltered : true))
    .map((s) => s.id);
}

function runningPid() {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    process.kill(pid, 0); // liveness check only — signal 0 is not delivered
    return pid;
  } catch {
    return null;
  }
}

/* Starts the worker in its own process group, so closing Obsidian, or the
   shell the button ran in, does not take the run down with it. */
function start(job) {
  const pid = runningPid();
  if (pid) throw new Error(`a run is already going (pid ${pid}) — press Stop first`);
  mkdirSync(dirname(JOB_FILE), { recursive: true });
  writeFileSync(JOB_FILE, JSON.stringify(job));
  const crash = openSync(CRASH_LOG, "a"); // only ever holds a stack trace
  const child = spawn(process.execPath, [SELF, "run-worker"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", crash, crash],
  });
  writeFileSync(PID_FILE, String(child.pid));
  child.unref();
}

/* ---------- the log note ---------- */

function stats(cfg) {
  const store = loadStore(cfg.dataFile);
  const jobs = Object.values(store.jobs);
  const last = store.runs.at(-1);
  return [
    ["Open vacancies", String(jobs.filter((job) => !job.closed).length)],
    ["Stored in total", String(jobs.length)],
    ["Companies", String(new Set(jobs.map((job) => job.company)).size)],
    ["Last completed run", last?.date ? `${last.date.slice(0, 16).replace("T", " ")}${last.sources?.length ? " — " + last.sources.map(labelFor).join(", ") : ""}` : "never"],
    ["Boards ticked", enabledSources(readConfigFile()).map(labelFor).join(", ") || "none"],
    ["Queries", (cfg.queries || []).map((q) => (q === "" ? ALL_JOBS : q)).join(", ")],
  ];
}

function refreshStatus() {
  const cfg = loadConfig();
  const pid = runningPid();
  writeLogNote(
    cfg.vaultPath,
    renderLogNote({
      state: pid ? "running" : "idle",
      headline: pid ? `**running** (pid ${pid})` : "idle",
      rows: stats(cfg),
      log: existingLog(cfg.vaultPath),
    }),
  );
}

/* ---------- the background run ---------- */

async function worker() {
  const job = JSON.parse(readFileSync(JOB_FILE, "utf8"));
  const cfg = loadConfig();
  const vault = cfg.vaultPath;
  const boards = new Map(describeSources().map((s) => [s.id, s]));
  const lines = [];
  let current = null;
  let phase = job.mode === "vault" ? "vault" : "starting";
  let cancelled = false;
  let child = null;
  let lastWrite = 0;

  // A board that ignores search terms is run once, not once per query — the
  // extra passes would fetch the same listings again.
  const queue =
    job.mode === "vault"
      ? []
      : job.sources.flatMap((source) =>
          (boards.get(source)?.supportsQueries === false ? [""] : job.queries).map((query) => ({ source, query })),
        );

  // What the log note says at the top, per stage of the run.
  const HEADLINES = {
    starting: () => "**starting**",
    scraping: () => `**running** — ${labelFor(current.source)} · ${current.query || ALL_JOBS}`,
    vault: () => "**building the vault**",
    done: () => "idle — the run finished",
    stopped: () => "**stopped** — everything scraped before it is saved",
  };

  const write = (force = false) => {
    if (!force && Date.now() - lastWrite < 1000) return;
    lastWrite = Date.now();
    writeLogNote(
      vault,
      renderLogNote({
        state: phase === "done" ? "idle" : phase === "stopped" ? "stopped" : "running",
        headline: HEADLINES[phase](),
        rows: [...(queue.length ? [["Still to run", `${queue.length} more`]] : []), ...stats(loadConfig())],
        log: lines.join("\n"),
      }),
    );
  };

  const log = (line) => {
    lines.push(line);
    while (lines.length > MAX_LOG_LINES) lines.shift();
    write();
  };

  const stop = () => {
    if (cancelled) return;
    cancelled = true;
    phase = "stopped";
    queue.length = 0;
    log("— stopped; everything scraped so far is already saved —");
    child?.kill("SIGTERM");
    write(true);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const runCommand = (args, label) =>
    new Promise((resolve) => {
      log(`\n$ node src/cli.js ${args.join(" ")}`);
      child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT });
      let buffer = "";
      const onData = (chunk) => {
        buffer += chunk.toString();
        const parts = buffer.split("\n");
        buffer = parts.pop();
        for (const part of parts) if (part.trim()) log(part);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("close", (code, signal) => {
        if (buffer.trim()) log(buffer);
        child = null;
        if (signal) log(`✗ ${label} stopped mid-page`);
        else log(code === 0 ? `✓ ${label} finished` : `✗ ${label} exited with code ${code}`);
        resolve(code);
      });
    });

  try {
    write(true);
    while (queue.length && !cancelled) {
      current = queue.shift();
      phase = "scraping";
      write(true);
      const args = ["--scrape-only", "--source", current.source, "--query", current.query];
      await runCommand(args, `${labelFor(current.source)} · ${current.query || ALL_JOBS}`);
      current = null;
    }
    if (!cancelled) {
      log("\nRebuilding the vault…");
      phase = "vault";
      write(true);
      await runCommand(["--vault-only"], "vault build");
    }
  } catch (err) {
    log(`✗ ${err.message}`);
  } finally {
    current = null;
    if (!cancelled) phase = "done";
    write(true);
    try {
      unlinkSync(PID_FILE);
    } catch {}
  }
}

/* Kept last so every helper above it is initialised before a command runs. */
main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
