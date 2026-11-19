/* One-time interactive Indeed sign-in.
 *
 * Indeed serves page 1 of a search to anyone and puts every page after it behind
 * an account ("Maak een account aan of log in om de volgende pagina's met
 * vacatures te bekijken"). Without a session the scraper collects 15 vacancies
 * out of ~8000 and, because the wall answers HTTP 200, used to report that as a
 * clean sweep.
 *
 * This opens the adapter's own persistent profile in a visible window so you can
 * log in by hand. The cookies land in `profileDir`, which the headless scrape
 * reuses on every later run — so this is a thing you do once, and again whenever
 * the session lapses.
 *
 * Run it on the machine that does the Indeed scraping, in a desktop session:
 *
 *   npm run indeed-login
 *
 * It verifies page 2 before it exits, so a green finish means the scrape will
 * actually paginate — not just that a login form was filled in.
 */
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.js";
import { openBrowser, searchUrl } from "./sources/indeed.js";

const VERIFY_START = 15;

async function main() {
  const cfg = loadConfig({});
  console.log(`Opening Indeed in ${cfg.profileDir}`);
  console.log("Log in in the browser window, then come back here and press Enter.\n");

  const context = await openBrowser({ ...cfg, headless: false });
  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto(`https://${cfg.host}/account/login`, { waitUntil: "domcontentloaded", timeout: 60000 });

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("Press Enter once you are signed in… ");
    rl.close();

    // The real test is not "is there a session cookie" but "does page 2 return
    // jobs", which is the thing the wall takes away.
    const url = searchUrl(cfg, cfg.queries[0] || "", VERIFY_START);
    console.log(`\nChecking pagination: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    const results = await page
      .waitForFunction(
        () =>
          window.mosaic?.providerData?.["mosaic-provider-jobcards"]?.metaData?.mosaicProviderJobCardsModel
            ?.results?.length || null,
        null,
        { timeout: 25000 }
      )
      .then((h) => h.jsonValue())
      .catch(() => 0);

    const title = await page.title().catch(() => "");
    if (results) {
      console.log(`\nWorking — page 2 returned ${results} vacancies. The scrape will paginate from now on.`);
    } else {
      console.log(`\nStill walled: page 2 gave no results (title "${title}").`);
      console.log("Either the sign-in did not complete, or Indeed wants another step. Nothing was saved to cookies.");
      process.exitCode = 1;
    }
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
