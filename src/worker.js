/**
 * ============================================================================
 * CIP - STRIKE COCKPIT - CLOUDFLARE WORKER (API + static assets)
 * ============================================================================
 * Architecture:
 *
 *      Browser (public/index.html - the existing application, unchanged UI)
 *          |
 *          |  GET  /api/bootstrap   one efficient startup request
 *          |  POST /api/sync        fine-grained mutations (only changed records)
 *          |  GET  /api/export      D1-backed JSON backup (backup-file format)
 *          |  POST /api/import      deterministic full import from a backup file
 *          |  GET  /api/health      lightweight status/verification probe
 *          v
 *      this Worker (validation, transactions, response formatting)
 *          |
 *          |  env.DB  (Cloudflare D1 binding - parameterized SQL only)
 *          v
 *      Cloudflare D1  (authoritative persistent database)
 *
 * The browser never receives database credentials and never talks to D1
 * directly. Every SQL statement is a prepared statement with bound
 * parameters - no string concatenation of values ever reaches SQL.
 *
 * The Worker stays thin on purpose: all domain logic (phase machine,
 * analytics, validation semantics, terminology) lives in the existing
 * frontend. Server-side validation here is STRUCTURAL (shapes, sizes,
 * types, coercions identical to the app's own sanitize layer); semantic
 * validation stays in the application exactly as it is today.
 *
 * AUTHENTICATION: intentionally not implemented in code. Deploy behind
 * Cloudflare Access (dashboard: Zero Trust > Access > Applications) to
 * protect this Worker; Access authenticates users before requests reach
 * this code, so no auth logic is needed here. Without Access, the API is
 * reachable by anyone who knows the URL (single-user tool - see the
 * deployment notes).
 *
 * Static assets: every non-/api/ request is forwarded to the Workers
 * Static Assets binding, which serves public/index.html.
 * ============================================================================
 */

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const MAX_SYNC_BODY_BYTES = 20 * 1024 * 1024;   // 20 MB
const MAX_IMPORT_BODY_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_OPS_PER_REQUEST = 40;                 // keep each D1 transaction safely bounded; the client chunks larger syncs

/* ==========================================================================
   FIELD MAPS: application JSON shape <-> D1 columns.
   Every prospect field of sanitizeProspect() is a real column; unknown or
   future fields round-trip through extra_json so nothing is ever lost.
   ========================================================================== */

const PROSPECT_FIELDS = [
  ["website", "website", "str"],
  ["domain", "domain", "str"],
  ["company.name", "company_name", "str"],
  ["company.niche", "company_niche", "str"],
  ["company.source", "company_source", "str"],
  ["company.adUrl", "company_ad_url", "str"],
  ["company.adDiscoveryDate", "company_ad_discovery_date", "str"],
  ["company.adLaunchDate", "company_ad_launch_date", "str"],
  ["contact.name", "contact_name", "str"],
  ["contact.role", "contact_role", "str"],
  ["contact.email", "contact_email", "str"],
  ["contact.linkedin", "contact_linkedin", "str"],
  ["contact.phone", "contact_phone", "str"],
  ["testing.status", "testing_status", "str"],
  ["testing.qualification", "testing_qualification", "str"],
  ["testing.testedAt", "testing_tested_at", "str"],
  ["testing.note", "testing_note", "str"],
  ["strike.adSource", "strike_ad_source", "str"],
  ["strike.activeAd", "strike_active_ad", "str"],
  ["strike.adAge", "strike_ad_age", "str"],
  ["strike.visibleLeak", "strike_visible_leak", "str"],
  ["strike.leak1", "strike_leak1", "str"],
  ["strike.leak2", "strike_leak2", "str"],
  ["strike.loomUrl", "strike_loom_url", "str"],
  ["strike.videoStatus", "strike_video_status", "str"],
  ["strike.xrayStartedAt", "strike_xray_started_at", "strOrNull"],
  ["outreach.status", "outreach_status", "str"],
  ["outreach.firstOutreachDate", "outreach_first_date", "str"],
  ["outreach.lastOutreachDate", "outreach_last_date", "str"],
  ["outreach.nextFollowUpDate", "outreach_next_fu_date", "str"],
  ["outreach.touches", "outreach_touches", "num"],
  ["outreach.channels", "outreach_channels", "jsonArr"],
  ["commercial.dealValue", "commercial_deal_value", "num"],
  ["commercial.wonDate", "commercial_won_date", "str"],
  ["economics.directCost", "economics_direct_cost", "num"],
  ["economics.researchMinutes", "economics_research_minutes", "num"],
  ["economics.auditMinutes", "economics_audit_minutes", "num"],
  ["economics.xrayMinutes", "economics_xray_minutes", "num"],
  ["economics.followupMinutes", "economics_followup_minutes", "num"],
  ["notes", "notes", "str"],
  ["createdAt", "created_at", "str"],
  ["updatedAt", "updated_at", "str"],
];
const PROSPECT_TOP_KEYS = ["id", "website", "domain", "company", "contact", "testing",
  "strike", "outreach", "commercial", "economics", "notes", "createdAt", "updatedAt"];
const NESTED_KNOWN = {
  company: ["name", "niche", "source", "adUrl", "adDiscoveryDate", "adLaunchDate"],
  contact: ["name", "role", "email", "linkedin", "phone"],
  testing: ["status", "qualification", "testedAt", "note"],
  strike: ["adSource", "activeAd", "adAge", "visibleLeak", "leak1", "leak2", "loomUrl", "videoStatus", "xrayStartedAt"],
  outreach: ["status", "firstOutreachDate", "lastOutreachDate", "nextFollowUpDate", "touches", "channels"],
  commercial: ["dealValue", "wonDate"],
  economics: ["directCost", "researchMinutes", "auditMinutes", "xrayMinutes", "followupMinutes"],
};

/* The app's own sanitize keeps exactly these event/learning fields; extras
   would be dropped by the app itself on load, so these tables are exact. */
const EVENT_FIELDS = [
  ["prospectId", "prospect_id", "strOrNull"],
  ["type", "type", "str"],
  ["subtype", "subtype", "str"],
  ["timestamp", "timestamp", "str"],
  ["value", "value", "numOrNull"],
  ["note", "note", "str"],
  ["channel", "channel", "str"],
  ["refId", "ref_id", "strOrNull"],
];
const LEARNING_FIELDS = [
  ["text", "text", "str"],
  ["createdAt", "created_at", "str"],
];
const SETTINGS_FIELDS = [
  ["strikeGoal", "strike_goal", "int"],
  ["fu1", "fu1", "int"],
  ["fu2", "fu2", "int"],
  ["fu3", "fu3", "int"],
  ["currency", "currency", "str"],
  ["globalToolCost", "global_tool_cost", "num"],
  ["globalOutreachCost", "global_outreach_cost", "num"],
  ["globalOtherCost", "global_other_cost", "num"],
  ["hourlyCost", "hourly_cost", "num"],
];
const SETTINGS_KNOWN = SETTINGS_FIELDS.map((f) => f[0]);
const METADATA_FIELDS = [
  ["createdAt", "created_at", "str"],
  ["lastBackup", "last_backup", "strOrNull"],
  ["lastBackupEvents", "last_backup_events", "int"],
  ["version", "version", "int"],
  ["onboardingComplete", "onboarding_complete", "boolInt"],
];
const METADATA_KNOWN = METADATA_FIELDS.map((f) => f[0]);

/* ==========================================================================
   VALUE CONVERSION (mirrors the application's own coercion semantics)
   ========================================================================== */

function getPath(obj, path) {
  const parts = path.split(".");
  let o = obj;
  for (const p of parts) {
    if (o === null || o === undefined || typeof o !== "object") return undefined;
    o = o[p];
  }
  return o;
}
function setPath(obj, path, v) {
  const parts = path.split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (o[k] === null || o[k] === undefined || typeof o[k] !== "object") o[k] = {};
    o = o[k];
  }
  o[parts[parts.length - 1]] = v;
}
function conv(v, kind) {
  switch (kind) {
    case "str": return v === null || v === undefined ? "" : String(v);
    case "strOrNull": return v === null || v === undefined ? null : String(v);
    case "num": return Number(v) || 0;
    case "numOrNull": return v === null || v === undefined ? null : (Number(v) || 0);
    case "int": return Math.floor(Number(v) || 0);
    case "boolInt": return v ? 1 : 0;
    case "jsonArr": return JSON.stringify(Array.isArray(v) ? v : []);
    default: return v;
  }
}
function safeParse(text, fallback) {
  try { const v = JSON.parse(text); return v === null || v === undefined ? fallback : v; }
  catch (e) { return fallback; }
}
function isPlainObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

/* -------- prospect: object -> ordered bind array -------- */

function prospectExtras(p) {
  const extras = {};
  if (!isPlainObj(p)) return extras;
  for (const k of Object.keys(p)) {
    if (PROSPECT_TOP_KEYS.indexOf(k) < 0) extras[k] = p[k];
  }
  for (const group of Object.keys(NESTED_KNOWN)) {
    const src = p[group];
    if (isPlainObj(src)) {
      const left = {};
      for (const k of Object.keys(src)) {
        if (NESTED_KNOWN[group].indexOf(k) < 0) left[k] = src[k];
      }
      if (Object.keys(left).length) extras[group] = left;
    }
  }
  return extras;
}
function prospectToRow(p, gen) {
  const row = [String((p && p.id) || "")];
  for (const [path, , kind] of PROSPECT_FIELDS) row.push(conv(getPath(p, path), kind));
  row.push(JSON.stringify(prospectExtras(p)));
  row.push(gen);
  return row;
}

/* -------- prospect: row -> application object -------- */

function rowToProspect(r) {
  const extra = isPlainObj(safeParse(r.extra_json, {})) ? safeParse(r.extra_json, {}) : {};
  const p = { id: r.id };
  for (const k of Object.keys(extra)) {
    if (PROSPECT_TOP_KEYS.indexOf(k) < 0) p[k] = extra[k];
  }
  for (const [path, col, kind] of PROSPECT_FIELDS) {
    let v = r[col];
    if (kind === "jsonArr") v = Array.isArray(safeParse(v, [])) ? safeParse(v, []) : [];
    else if (kind === "num") v = Number(v) || 0;
    setPath(p, path, v);
  }
  /* future/unknown nested fields ride along inside the group objects */
  for (const group of Object.keys(NESTED_KNOWN)) {
    const ex = isPlainObj(extra[group]) ? extra[group] : null;
    if (ex) {
      const cur = getPath(p, group) || {};
      for (const k of Object.keys(ex)) {
        if (!(k in cur)) cur[k] = ex[k];
      }
    }
  }
  return p;
}
function rowToEvent(r) {
  return {
    id: r.id,
    prospectId: r.prospect_id === null || r.prospect_id === undefined ? null : String(r.prospect_id),
    type: r.type || "",
    subtype: r.subtype || "",
    timestamp: r.timestamp || "",
    value: r.value === null || r.value === undefined ? null : Number(r.value),
    note: r.note || "",
    channel: r.channel || "",
    refId: r.ref_id === null || r.ref_id === undefined ? null : String(r.ref_id),
  };
}
function rowToLearning(r) {
  return { id: r.id, text: r.text || "", createdAt: r.created_at || "" };
}
function rowToSettings(r) {
  const base = { strikeGoal: 5, fu1: 3, fu2: 4, fu3: 7, currency: "USD",
    globalToolCost: 0, globalOutreachCost: 0, globalOtherCost: 0, hourlyCost: 0 };
  if (!r) return base;
  const extra = isPlainObj(safeParse(r.extra_json, {})) ? safeParse(r.extra_json, {}) : {};
  const out = {};
  for (const k of Object.keys(extra)) {
    if (SETTINGS_KNOWN.indexOf(k) < 0) out[k] = extra[k];
  }
  for (const [path, col, kind] of SETTINGS_FIELDS) {
    let v = r[col];
    if (kind === "num") v = Number(v) || 0;
    else if (kind === "int") v = Math.floor(Number(v) || 0);
    else v = v === null || v === undefined ? "" : String(v);
    out[path] = v;
  }
  return out;
}
function rowToStrike(r) {
  if (!r) return { date: "", locked: false, ids: [], goal: 0 };
  const ids = safeParse(r.ids_json, []);
  return { date: r.date || "", locked: !!r.locked, ids: Array.isArray(ids) ? ids : [], goal: Number(r.goal) || 0 };
}
function rowToMetadata(r) {
  const base = { createdAt: "", lastBackup: null, lastBackupEvents: 0, version: 2, onboardingComplete: false };
  if (!r) return base;
  const extra = isPlainObj(safeParse(r.extra_json, {})) ? safeParse(r.extra_json, {}) : {};
  const out = {};
  for (const k of Object.keys(extra)) {
    if (METADATA_KNOWN.indexOf(k) < 0) out[k] = extra[k];
  }
  for (const [path, col, kind] of METADATA_FIELDS) {
    let v = r[col];
    if (kind === "int") v = Math.floor(Number(v) || 0);
    else if (kind === "boolInt") v = !!v;
    else if (kind === "strOrNull") v = v === null || v === undefined ? null : String(v);
    else v = v === null || v === undefined ? "" : String(v);
    out[path] = v;
  }
  return out;
}

/* ==========================================================================
   SQL BUILDERS (column names are code constants; values always bound)
   ========================================================================== */

function upsertSql(table, cols) {
  const ph = cols.map(() => "?").join(", ");
  const sets = cols.slice(1).map((c) => `${c}=excluded.${c}`).join(", ");
  /* The first generation predicate prevents an insert when the request's
     compare-and-swap failed. The second predicate guards an existing row
     against a newer row version. Both are evaluated inside the same atomic
     D1 batch as the generation claim. */
  return `INSERT INTO ${table} (${cols.join(", ")}) ` +
    `SELECT ${ph} WHERE (SELECT gen FROM sync_state WHERE id=1)=? ` +
    `ON CONFLICT(id) DO UPDATE SET ${sets} ` +
    `WHERE ${table}.sync_gen <= ? AND (SELECT gen FROM sync_state WHERE id=1)=?`;
}
const PROSPECT_COLS = ["id", ...PROSPECT_FIELDS.map((f) => f[1]), "extra_json", "sync_gen"];
const EVENT_COLS = ["id", ...EVENT_FIELDS.map((f) => f[1]), "sync_gen"];
const LEARNING_COLS = ["id", ...LEARNING_FIELDS.map((f) => f[1]), "sync_gen"];
const SETTINGS_COLS = ["id", ...SETTINGS_FIELDS.map((f) => f[1]), "extra_json", "updated_at", "sync_gen"];
const STRIKE_COLS = ["id", "date", "locked", "goal", "ids_json", "updated_at", "sync_gen"];
const METADATA_COLS = ["id", ...METADATA_FIELDS.map((f) => f[1]), "extra_json", "updated_at", "sync_gen"];

const UPSERT_PROSPECT = upsertSql("prospects", PROSPECT_COLS);
const UPSERT_EVENT = upsertSql("events", EVENT_COLS);
const UPSERT_LEARNING = upsertSql("learnings", LEARNING_COLS);
const UPSERT_SETTINGS = upsertSql("settings", SETTINGS_COLS);
const UPSERT_STRIKE = upsertSql("strike", STRIKE_COLS);
const UPSERT_METADATA = upsertSql("app_metadata", METADATA_COLS);

function settingsRow(settings, gen, now) {
  const extra = {};
  if (isPlainObj(settings)) {
    for (const k of Object.keys(settings)) {
      if (SETTINGS_KNOWN.indexOf(k) < 0) extra[k] = settings[k];
    }
  }
  const row = [1];
  for (const [path, , kind] of SETTINGS_FIELDS) row.push(conv(getPath(settings, path), kind));
  row.push(JSON.stringify(extra), now, gen);
  return row;
}
function strikeRow(strike, gen, now) {
  const s = isPlainObj(strike) ? strike : {};
  const ids = Array.isArray(s.ids) ? s.ids : [];
  return [1, conv(s.date, "str"), s.locked ? 1 : 0, Math.floor(Number(s.goal) || 0),
    JSON.stringify(ids), now, gen];
}
function metadataRow(metadata, gen, now) {
  const extra = {};
  if (isPlainObj(metadata)) {
    for (const k of Object.keys(metadata)) {
      if (METADATA_KNOWN.indexOf(k) < 0) extra[k] = metadata[k];
    }
  }
  const row = [1];
  for (const [path, , kind] of METADATA_FIELDS) row.push(conv(getPath(metadata, path), kind));
  row.push(JSON.stringify(extra), now, gen);
  return row;
}

/* ==========================================================================
   HELPERS
   ========================================================================== */

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: JSON_HEADERS });
}
function jsonErr(message, status) {
  return json({ ok: false, error: String(message) }, status || 400);
}
function nowIso() { return new Date().toISOString(); }

async function readJsonBody(request, maxBytes) {
  const lenHeader = Number(request.headers.get("content-length") || 0);
  if (lenHeader > maxBytes) throw new Error(`request body too large (${lenHeader} bytes)`);
  const text = await request.text();
  if (text.length > maxBytes) throw new Error("request body too large");
  if (!text) return null;
  return JSON.parse(text);
}
function validId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 128;
}
/* D1 batch is the atomic unit. Never fall back to separately committed
   chunks, because doing so would turn a failed sync/import into a partial write.
   Per-statement results remain aligned with the input statements. */
async function runBatch(db, stmts) {
  return await db.batch(stmts);
}
async function currentGen(db) {
  const row = await db.prepare("SELECT gen FROM sync_state WHERE id=1").first();
  return row ? (Math.floor(Number(row.gen)) || 0) : 0;
}

/* ==========================================================================
   API: GET /api/bootstrap  (one efficient request; returns the full
   application-shaped state, sanitized client-side by the existing app)
   ========================================================================== */

async function readSnapshot(db) {
  /* Generation and all application state are captured in one D1 batch so the
     caller never receives a generation from one moment paired with state
     from another moment. */
  const [gR, pR, eR, lR, sR, kR, mR] = await db.batch([
    db.prepare("SELECT gen FROM sync_state WHERE id=1"),
    db.prepare("SELECT * FROM prospects ORDER BY created_at, id"),
    db.prepare("SELECT * FROM events ORDER BY timestamp, id"),
    db.prepare("SELECT * FROM learnings ORDER BY created_at DESC, id"),
    db.prepare("SELECT * FROM settings WHERE id=1"),
    db.prepare("SELECT * FROM strike WHERE id=1"),
    db.prepare("SELECT * FROM app_metadata WHERE id=1"),
  ]);
  const state = {
    prospects: (pR.results || []).map(rowToProspect),
    events: (eR.results || []).map(rowToEvent),
    learnings: (lR.results || []).map(rowToLearning),
    settings: rowToSettings(sR.results && sR.results[0]),
    strike: rowToStrike(kR.results && kR.results[0]),
    metadata: rowToMetadata(mR.results && mR.results[0]),
  };
  const gen = gR.results && gR.results[0] ? (Math.floor(Number(gR.results[0].gen)) || 0) : 0;
  return { gen, state };
}

async function apiBootstrap(env) {
  if (!env.DB) return jsonErr("D1 binding 'DB' is not configured for this Worker", 500);
  const snapshot = await readSnapshot(env.DB);
  return json({
    ok: true,
    gen: snapshot.gen,
    syncedAt: nowIso(),
    counts: {
      prospects: snapshot.state.prospects.length,
      events: snapshot.state.events.length,
      learnings: snapshot.state.learnings.length,
    },
    state: snapshot.state,
  });
}

/* ==========================================================================
   API: POST /api/sync  (fine-grained mutations, one transactional batch)
   Body: { baseGen: <last generation the client synced>, ops: {
            prospects: { upserts: [...], deletes: [id...] },
            events:    { upserts: [...], deletes: [id...] },
            learnings: { upserts: [...], deletes: [id...] },
            settings?  {...}, strike? {...}, metadata? {...} } }
   Guarded upserts are skipped and reported as conflicts when the stored row
   is newer than the client's base generation (prevents lost updates).
   ========================================================================== */

function pickOpsArrays(container) {
  const c = isPlainObj(container) ? container : {};
  return {
    upserts: Array.isArray(c.upserts) ? c.upserts : [],
    deletes: Array.isArray(c.deletes) ? c.deletes : [],
  };
}

async function apiSync(request, env) {
  if (!env.DB) return jsonErr("D1 binding 'DB' is not configured for this Worker", 500);
  const body = await readJsonBody(request, MAX_SYNC_BODY_BYTES);
  if (!isPlainObj(body) || !isPlainObj(body.ops)) return jsonErr("invalid sync body");
  const ops = body.ops;
  const prospects = pickOpsArrays(ops.prospects);
  const events = pickOpsArrays(ops.events);
  const learnings = pickOpsArrays(ops.learnings);
  const total = prospects.upserts.length + prospects.deletes.length +
    events.upserts.length + events.deletes.length +
    learnings.upserts.length + learnings.deletes.length;
  if (total > MAX_OPS_PER_REQUEST) return jsonErr("too many operations in one sync", 413);

  for (const p of prospects.upserts) {
    if (!isPlainObj(p) || !validId(p.id)) return jsonErr("invalid prospect record (id missing or invalid)");
  }
  for (const e of events.upserts) {
    if (!isPlainObj(e) || !validId(e.id)) return jsonErr("invalid event record (id missing or invalid)");
  }
  for (const l of learnings.upserts) {
    if (!isPlainObj(l) || !validId(l.id)) return jsonErr("invalid learning record (id missing or invalid)");
  }

  const baseGen = Math.max(0, Math.floor(Number(body.baseGen) || 0));
  /* Claim exactly the next generation atomically. If another request has
     committed first, the compare-and-swap changes zero rows and every data
     statement below is additionally gated on the claimed generation, so the
     request becomes a clean conflict with no partial writes. */
  const newGen = baseGen + 1;
  const now = nowIso();

  const stmts = [];
  const opIndex = []; /* aligned with stmts; used to map results -> ops */
  const warnings = [];

  stmts.push(env.DB.prepare("UPDATE sync_state SET gen=?, updated_at=? WHERE id=1 AND gen=?").bind(newGen, now, baseGen));
  opIndex.push(null);

  /* Duplicate-domain protection remains enforced by the application's
     existing findDup() logic. Do not perform one D1 read per prospect here:
     that N+1 diagnostic would consume the per-invocation D1 read budget during
     a first-run migration. The schema intentionally keeps domain non-unique
     for backup/import compatibility. */
  for (const p of prospects.upserts) {
    stmts.push(env.DB.prepare(UPSERT_PROSPECT).bind(...prospectToRow(p, newGen), newGen, baseGen, newGen));
    opIndex.push({ kind: "prospects", id: p.id });
  }
  for (const e of events.upserts) {
    const row = [String(e.id)];
    for (const [path, , kind] of EVENT_FIELDS) row.push(conv(getPath(e, path), kind));
    row.push(newGen);
    stmts.push(env.DB.prepare(UPSERT_EVENT).bind(...row, newGen, baseGen, newGen));
    opIndex.push({ kind: "events", id: e.id });
  }
  for (const l of learnings.upserts) {
    const row = [String(l.id)];
    for (const [path, , kind] of LEARNING_FIELDS) row.push(conv(getPath(l, path), kind));
    row.push(newGen);
    stmts.push(env.DB.prepare(UPSERT_LEARNING).bind(...row, newGen, baseGen, newGen));
    opIndex.push({ kind: "learnings", id: l.id });
  }
  if (ops.settings !== undefined) {
    stmts.push(env.DB.prepare(UPSERT_SETTINGS).bind(...settingsRow(ops.settings, newGen, now), newGen, baseGen, newGen));
    opIndex.push({ kind: "settings", id: "settings" });
  }
  if (ops.strike !== undefined) {
    stmts.push(env.DB.prepare(UPSERT_STRIKE).bind(...strikeRow(ops.strike, newGen, now), newGen, baseGen, newGen));
    opIndex.push({ kind: "strike", id: "strike" });
  }
  if (ops.metadata !== undefined) {
    stmts.push(env.DB.prepare(UPSERT_METADATA).bind(...metadataRow(ops.metadata, newGen, now), newGen, baseGen, newGen));
    opIndex.push({ kind: "metadata", id: "metadata" });
  }
  /* deletes last: a record removed locally must disappear after all
     upserts in the same batch have been applied */
  for (const id of prospects.deletes) {
    if (!validId(id)) continue;
    stmts.push(env.DB.prepare("DELETE FROM prospects WHERE id=? AND sync_gen<=? AND (SELECT gen FROM sync_state WHERE id=1)=?").bind(String(id), baseGen, newGen));
    opIndex.push({ kind: "delete", table: "prospects", id: String(id) });
  }
  for (const id of events.deletes) {
    if (!validId(id)) continue;
    stmts.push(env.DB.prepare("DELETE FROM events WHERE id=? AND sync_gen<=? AND (SELECT gen FROM sync_state WHERE id=1)=?").bind(String(id), baseGen, newGen));
    opIndex.push({ kind: "delete", table: "events", id: String(id) });
  }
  for (const id of learnings.deletes) {
    if (!validId(id)) continue;
    stmts.push(env.DB.prepare("DELETE FROM learnings WHERE id=? AND sync_gen<=? AND (SELECT gen FROM sync_state WHERE id=1)=?").bind(String(id), baseGen, newGen));
    opIndex.push({ kind: "delete", table: "learnings", id: String(id) });
  }

  const results = await runBatch(env.DB, stmts);

  const generationClaimed = Math.floor(Number(results[0] && results[0].meta && results[0].meta.changes) || 0) > 0;
  if (!generationClaimed) {
    return json({
      ok: true,
      gen: baseGen,
      applied: { prospects: 0, events: 0, learnings: 0, deletes: 0 },
      conflicts: [{ table: "sync_state", id: "1", reason: "stale_generation" }],
      warnings: warnings,
    });
  }

  /* conflicts = guarded upserts/deletes that changed 0 rows. For deletes,
     a zero-row result is conservatively treated as a conflict: the row may
     already be absent or may have a newer server version. A false-positive
     conflict only causes a safe re-bootstrap; it can never delete newer data. */
  const conflicts = [];
  let appliedProspects = 0, appliedEvents = 0, appliedLearnings = 0, appliedDeletes = 0;
  for (let i = 0; i < results.length; i++) {
    const oi = opIndex[i];
    if (!oi) continue;
    const changes = Math.floor(Number(results[i] && results[i].meta && results[i].meta.changes) || 0);
    if (oi.kind === "delete") {
      if (changes > 0) appliedDeletes += changes;
      else conflicts.push({ table: oi.table, id: oi.id, reason: "stale_or_missing" });
      continue;
    }
    if (changes === 0) {
      conflicts.push({ table: oi.kind, id: oi.id, reason: "stale_version" });
      continue;
    }
    if (oi.kind === "prospects") appliedProspects++;
    else if (oi.kind === "events") appliedEvents++;
    else if (oi.kind === "learnings") appliedLearnings++;
  }

  return json({
    ok: true,
    gen: newGen,
    applied: {
      prospects: appliedProspects,
      events: appliedEvents,
      learnings: appliedLearnings,
      deletes: appliedDeletes,
    },
    conflicts: conflicts,
    warnings: warnings,
  });
}

/* ==========================================================================
   API: GET /api/export  (D1-backed backup in the application's backup-file
   format; ?download=1 makes the browser save it as a .json file)
   ========================================================================== */

async function apiExport(env, url) {
  if (!env.DB) return jsonErr("D1 binding 'DB' is not configured for this Worker", 500);
  const snapshot = await readSnapshot(env.DB);
  const state = snapshot.state;
  const gen = snapshot.gen;
  if (url.searchParams.get("download") === "1") {
    const day = nowIso().slice(0, 10);
    return new Response(JSON.stringify(state, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="cip-d1-export-${day}.json"`,
        "cache-control": "no-store",
      },
    });
  }
  return json({
    ok: true,
    gen: gen,
    generatedAt: nowIso(),
    counts: {
      prospects: state.prospects.length,
      events: state.events.length,
      learnings: state.learnings.length,
    },
    state: state,
  });
}

/* ==========================================================================
   API: POST /api/import  (deterministic full import from a CIP backup file)
   - body.expectedGen must be the caller's last observed cloud generation
   - preserves ids, timestamps, events, learnings, settings, strike state,
     commercial/economic values and unknown fields (extra_json)
   - full replace, idempotent and safely repeatable (re-running the same
     import produces the same database state)
   - duplicate ids inside one file are deduplicated deterministically
     (last occurrence wins) and reported in the response
   - bumps the sync generation so already-open clients detect the change,
     re-bootstrap and adopt the imported state
   ========================================================================== */

function dedupeById(records, warnings, warnType) {
  const map = new Map();
  let dupes = 0;
  for (const r of records) {
    if (!isPlainObj(r) || !validId(r.id)) continue;
    if (map.has(r.id)) dupes++;
    map.set(r.id, r);
  }
  if (dupes) warnings.push({ type: warnType, count: dupes });
  return [...map.values()];
}

async function apiImport(request, env) {
  if (!env.DB) return jsonErr("D1 binding 'DB' is not configured for this Worker", 500);
  const body = await readJsonBody(request, MAX_IMPORT_BODY_BYTES);
  /* same structural check the application's restore flow performs */
  if (!isPlainObj(body) || !Array.isArray(body.prospects) || !Array.isArray(body.events)) {
    return jsonErr("that file is not a valid CIP backup (prospects and events arrays are required)");
  }
  const warnings = [];
  const prospects = dedupeById(body.prospects, warnings, "duplicate_prospect_ids");
  const events = dedupeById(body.events, warnings, "duplicate_event_ids");
  const learnings = dedupeById(Array.isArray(body.learnings) ? body.learnings : [], warnings, "duplicate_learning_ids");

  /* report fields the application itself would drop, so nothing is lost silently */
  let unknownEventFields = 0;
  const eventKnown = ["id", ...EVENT_FIELDS.map((f) => f[0])];
  for (const e of events) {
    for (const k of Object.keys(e)) {
      if (eventKnown.indexOf(k) < 0) { unknownEventFields++; break; }
    }
  }
  if (unknownEventFields) warnings.push({ type: "event_unknown_fields_dropped", count: unknownEventFields });

  const expectedGen = Math.max(0, Math.floor(Number(body.expectedGen) || 0));
  const newGen = expectedGen + 1;
  const now = nowIso();

  const stmts = [];
  /* Import is a destructive full replacement. Claim the exact generation
     atomically before deleting anything, so a stale restore can never erase
     newer synchronized data. The whole replacement remains one transaction. */
  stmts.push(env.DB.prepare("UPDATE sync_state SET gen=?, updated_at=? WHERE id=1 AND gen=?").bind(newGen, now, expectedGen));
  /* full replace: clear the record tables, then insert the backup verbatim */
  stmts.push(env.DB.prepare("DELETE FROM events WHERE (SELECT gen FROM sync_state WHERE id=1)=?").bind(newGen));
  stmts.push(env.DB.prepare("DELETE FROM learnings WHERE (SELECT gen FROM sync_state WHERE id=1)=?").bind(newGen));
  stmts.push(env.DB.prepare("DELETE FROM prospects WHERE (SELECT gen FROM sync_state WHERE id=1)=?").bind(newGen));
  for (const p of prospects) {
    stmts.push(env.DB.prepare(
      `INSERT INTO prospects (${PROSPECT_COLS.join(", ")}) SELECT ${PROSPECT_COLS.map(() => "?").join(", ")} WHERE (SELECT gen FROM sync_state WHERE id=1)=?`
    ).bind(...prospectToRow(p, newGen), newGen));
  }
  for (const e of events) {
    const row = [String(e.id)];
    for (const [path, , kind] of EVENT_FIELDS) row.push(conv(getPath(e, path), kind));
    row.push(newGen);
    stmts.push(env.DB.prepare(
      `INSERT INTO events (${EVENT_COLS.join(", ")}) SELECT ${EVENT_COLS.map(() => "?").join(", ")} WHERE (SELECT gen FROM sync_state WHERE id=1)=?`
    ).bind(...row, newGen));
  }
  for (const l of learnings) {
    const row = [String(l.id)];
    for (const [path, , kind] of LEARNING_FIELDS) row.push(conv(getPath(l, path), kind));
    row.push(newGen);
    stmts.push(env.DB.prepare(
      `INSERT INTO learnings (${LEARNING_COLS.join(", ")}) SELECT ${LEARNING_COLS.map(() => "?").join(", ")} WHERE (SELECT gen FROM sync_state WHERE id=1)=?`
    ).bind(...row, newGen));
  }
  /* singleton rows are authoritative for the imported backup, but every write
     below is still gated on the claimed generation so a stale import becomes
     a complete no-op. */
  stmts.push(env.DB.prepare(
    `INSERT INTO settings (${SETTINGS_COLS.join(", ")}) SELECT ${SETTINGS_COLS.map(() => "?").join(", ")} ` +
    `WHERE (SELECT gen FROM sync_state WHERE id=1)=? ON CONFLICT(id) DO UPDATE SET ${SETTINGS_COLS.slice(1).map((c) => `${c}=excluded.${c}`).join(", ")}`
  ).bind(...settingsRow(body.settings, newGen, now), newGen));
  stmts.push(env.DB.prepare(
    `INSERT INTO strike (${STRIKE_COLS.join(", ")}) SELECT ${STRIKE_COLS.map(() => "?").join(", ")} ` +
    `WHERE (SELECT gen FROM sync_state WHERE id=1)=? ON CONFLICT(id) DO UPDATE SET ${STRIKE_COLS.slice(1).map((c) => `${c}=excluded.${c}`).join(", ")}`
  ).bind(...strikeRow(body.strike, newGen, now), newGen));
  stmts.push(env.DB.prepare(
    `INSERT INTO app_metadata (${METADATA_COLS.join(", ")}) SELECT ${METADATA_COLS.map(() => "?").join(", ")} ` +
    `WHERE (SELECT gen FROM sync_state WHERE id=1)=? ON CONFLICT(id) DO UPDATE SET ${METADATA_COLS.slice(1).map((c) => `${c}=excluded.${c}`).join(", ")}`
  ).bind(...metadataRow(body.metadata, newGen, now), newGen));

  const results = await runBatch(env.DB, stmts);
  const generationClaimed = Math.floor(Number(results[0] && results[0].meta && results[0].meta.changes) || 0) > 0;
  if (!generationClaimed) {
    return json({
      ok: false,
      error: "import rejected because the cloud database changed after this backup was read; refresh/bootstrap and retry with the current generation",
      reason: "stale_generation",
    }, 409);
  }

  return json({
    ok: true,
    imported: { prospects: prospects.length, events: events.length, learnings: learnings.length },
    gen: newGen,
    warnings: warnings,
  });
}

/* ==========================================================================
   API: GET /api/health  (lightweight verification probe; ?counts=1 adds
   table counts for the post-migration verification checklist)
   ========================================================================== */

async function apiHealth(env, url) {
  if (!env.DB) return jsonErr("D1 binding 'DB' is not configured for this Worker", 500);
  const gen = await currentGen(env.DB);
  let counts = null;
  if (url.searchParams.get("counts") === "1") {
    const [p, e, l, s, k, m] = await env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) AS n FROM prospects"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM events"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM learnings"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM settings"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM strike"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM app_metadata"),
    ]);
    counts = {
      prospects: p.results[0].n, events: e.results[0].n, learnings: l.results[0].n,
      settings: s.results[0].n, strike: k.results[0].n, app_metadata: m.results[0].n,
    };
  }
  return json({ ok: true, db: "ok", gen: gen, counts: counts, serverTime: nowIso() });
}

/* ==========================================================================
   ROUTER
   ========================================================================== */

function sameOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (!origin) return true; /* non-browser clients (curl, migration script) */
  try { return new URL(origin).origin === url.origin; }
  catch (e) { return false; }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    try {
      if (url.pathname === "/api/" || url.pathname === "/api/health") {
        if (method !== "GET" && method !== "HEAD") return jsonErr("method not allowed", 405);
        return await apiHealth(env, url);
      }
      if (url.pathname === "/api/bootstrap") {
        if (method !== "GET") return jsonErr("method not allowed", 405);
        return await apiBootstrap(env);
      }
      if (url.pathname === "/api/sync") {
        if (method !== "POST") return jsonErr("method not allowed", 405);
        if (!sameOrigin(request, url)) return jsonErr("cross-origin request rejected", 403);
        return await apiSync(request, env);
      }
      if (url.pathname === "/api/export") {
        if (method !== "GET") return jsonErr("method not allowed", 405);
        return await apiExport(env, url);
      }
      if (url.pathname === "/api/import") {
        if (method !== "POST") return jsonErr("method not allowed", 405);
        if (!sameOrigin(request, url)) return jsonErr("cross-origin request rejected", 403);
        return await apiImport(request, env);
      }
      if (url.pathname.indexOf("/api/") === 0) {
        return jsonErr("not found", 404);
      }
      /* everything else -> static assets (serves public/index.html) */
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return jsonErr("static assets binding 'ASSETS' is not configured", 500);
    } catch (err) {
      return jsonErr((err && err.message) || "internal error", 500);
    }
  },
};
