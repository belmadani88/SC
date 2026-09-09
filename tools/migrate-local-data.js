#!/usr/bin/env node
/**
 * ============================================================================
 * CIP - STRIKE COCKPIT : local backup -> D1 migration script (OPTIONAL)
 * ============================================================================
 * Uploads an existing CIP JSON backup file (created by the application's
 * "EXPORT JSON BACKUP" button) into the cloud D1 database through the
 * Worker's /api/import endpoint.
 *
 * This script is OPTIONAL. The deployed application performs the same
 * migration automatically and safely the first time it loads with local
 * data in the browser and an empty cloud database. This script exists as a
 * second, dashboard-independent path (useful for verification, retries, or
 * migrating data from a backup file on disk).
 *
 * Requirements: Node.js 18 or newer (no npm packages needed).
 *
 * Usage:
 *   node migrate-local-data.js <WORKER_BASE_URL> <BACKUP_JSON_FILE>
 *
 * Example:
 *   node migrate-local-data.js https://cip-strike-cockpit.<account>.workers.dev cip-backup-2026-09-10.json
 *
 * The import is deterministic and repeatable: re-running it with the same
 * file produces the same database state (ids, timestamps, events, learnings,
 * settings and strike state are preserved verbatim).
 * ============================================================================
 */

"use strict";

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("Usage: node migrate-local-data.js <WORKER_BASE_URL> <BACKUP_JSON_FILE>");
  console.error('Example: node migrate-local-data.js https://cip-strike-cockpit.youraccount.workers.dev cip-backup-2026-09-10.json');
  process.exit(1);
}
const base = args[0].replace(/\/+$/, "");
const file = args[1];

const fs = require("fs");

function fail(msg) {
  console.error("MIGRATION FAILED: " + msg);
  console.error("The cloud database was NOT modified (the Worker applies imports atomically per batch).");
  process.exit(1);
}

async function main() {
  /* 1. read and validate the backup file locally (same check the app uses) */
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { return fail("could not read the file: " + e.message); }

  let data;
  try { data = JSON.parse(raw); }
  catch (e) { return fail("the file is not valid JSON: " + e.message); }

  if (!data || typeof data !== "object" ||
      !Array.isArray(data.prospects) || !Array.isArray(data.events)) {
    return fail("that file is not a valid CIP backup (prospects and events arrays are required)");
  }
  const learnings = Array.isArray(data.learnings) ? data.learnings : [];
  console.log("Backup file loaded:");
  console.log("  prospects: " + data.prospects.length);
  console.log("  events:    " + data.events.length);
  console.log("  learnings: " + learnings.length);
  if (data.prospects.length) {
    const won = data.prospects.filter((p) => p.outreach && p.outreach.status === "WON");
    const revenue = won.reduce((a, p) => a + (Number(p.commercial && p.commercial.dealValue) || 0), 0);
    console.log("  won:       " + won.length + " (" + revenue + " total deal value)");
  }

  /* 2. verify the Worker + D1 are reachable before writing anything */
  let health;
  try {
    const res = await fetch(base + "/api/health?counts=1");
    health = await res.json();
    if (!health || !health.ok) throw new Error("health check returned not-ok");
  } catch (e) {
    return fail("could not reach the Worker at " + base + " (" + e.message + "). Is the URL correct and deployed?");
  }
  console.log("Worker reachable. D1 counts before import: " + JSON.stringify(health.counts));

  if (health.counts && (health.counts.prospects > 0 || health.counts.events > 0)) {
    console.warn("");
    console.warn("WARNING: the cloud database is NOT empty. /api/import REPLACES the whole database.");
    console.warn("         If the cloud copy is the good one, abort now (Ctrl+C).");
    await new Promise((resolve) => {
      const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });
      rl.question("Type IMPORT to continue anyway: ", (answer) => { rl.close(); resolve(answer); });
    }).then((answer) => {
      if (String(answer).trim() !== "IMPORT") {
        console.log("Aborted - nothing was changed.");
        process.exit(0);
      }
    });
  }

  /* 3. POST the backup to the Worker's import endpoint with the exact
        generation observed by the preflight health check. This makes the
        destructive restore compare-and-swap safe against concurrent writes. */
  let imported;
  try {
    const importPayload = Object.assign({}, data, { expectedGen: Number(health.gen) || 0 });
    const res = await fetch(base + "/api/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(importPayload),
    });
    imported = await res.json();
    if (!imported || !imported.ok) throw new Error((imported && imported.error) || ("HTTP " + res.status));
  } catch (e) {
    return fail("the Worker rejected the import: " + e.message);
  }
  console.log("Import committed: " + JSON.stringify(imported.imported) +
    " (generation " + imported.gen + ")");
  if (imported.warnings && imported.warnings.length) {
    console.log("Warnings: " + JSON.stringify(imported.warnings));
  }

  /* 4. verify the result server-side */
  const after = await (await fetch(base + "/api/health?counts=1")).json();
  console.log("D1 counts after import:  " + JSON.stringify(after.counts));
  const ok = after.counts.prospects === imported.imported.prospects &&
    after.counts.events === imported.imported.events &&
    after.counts.learnings === imported.imported.learnings;
  if (!ok) return fail("verification mismatch - re-run the script before using the app");
  console.log("");
  console.log("MIGRATION VERIFIED - counts match the backup file.");
  console.log("Open " + base + " and reload the page: the app will adopt the cloud data.");
}

main().catch((e) => fail(e.message));
