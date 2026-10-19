import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

if (!process.env.DATABASE_URL) {
  for (const f of ['.env.local', '.env', path.resolve(process.cwd(), '.env.local'), path.resolve(process.cwd(), '.env'), path.resolve(import.meta.dirname, '..', '.env.local'), path.resolve(import.meta.dirname, '..', '.env')]) {
    try {
      if (fs.existsSync(f)) {
        process.loadEnvFile(f);
        if (process.env.DATABASE_URL) break;
      }
    } catch {}
  }
}

const databaseUrl = process.env.DATABASE_URL;
export let sql = databaseUrl ? neon(databaseUrl) : null;

let schemaInitialized = false;
let initPromise = null;

export async function ensureSchema() {
  if (!sql && process.env.DATABASE_URL) {
    sql = neon(process.env.DATABASE_URL);
  }
  if (!sql) return;
  if (schemaInitialized) return;
  if (!initPromise) {
    initPromise = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS opengym_meta (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS opengym_db (
          id INT PRIMARY KEY DEFAULT 1,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS opengym_state (
          uid TEXT PRIMARY KEY,
          state JSONB NOT NULL,
          rev INT NOT NULL DEFAULT 0,
          wid TEXT,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS opengym_challenges (
          cid TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          exp BIGINT NOT NULL
        );
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS opengym_pairings (
          code TEXT PRIMARY KEY,
          uid TEXT NOT NULL,
          exp BIGINT NOT NULL
        );
      `;
      schemaInitialized = true;
    })().catch(err => {
      initPromise = null;
      console.error('ensureSchema error:', err);
      throw err;
    });
  }
  return initPromise;
}

export async function getOrInitSecret() {
  if (!sql) return null;
  await ensureSchema();
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET.trim();
  const rows = await sql`SELECT value FROM opengym_meta WHERE key = 'session_secret'`;
  if (rows.length > 0) return rows[0].value;
  const gen = crypto.randomBytes(32).toString('hex');
  await sql`
    INSERT INTO opengym_meta (key, value)
    VALUES ('session_secret', to_jsonb(${gen}::text))
    ON CONFLICT (key) DO NOTHING
  `;
  const res = await sql`SELECT value FROM opengym_meta WHERE key = 'session_secret'`;
  return res[0].value;
}

export async function getOrInitVapid(origin, secure) {
  if (!sql) return null;
  await ensureSchema();
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY.trim(),
      privateKey: process.env.VAPID_PRIVATE_KEY.trim()
    };
  }
  const rows = await sql`SELECT value FROM opengym_meta WHERE key = 'vapid_keys'`;
  if (rows.length > 0) return rows[0].value;
  const gen = webpush.generateVAPIDKeys();
  await sql`
    INSERT INTO opengym_meta (key, value)
    VALUES ('vapid_keys', ${JSON.stringify(gen)}::jsonb)
    ON CONFLICT (key) DO NOTHING
  `;
  const res = await sql`SELECT value FROM opengym_meta WHERE key = 'vapid_keys'`;
  return res[0].value;
}

export async function loadDb() {
  if (!sql) return null;
  await ensureSchema();
  const rows = await sql`SELECT data FROM opengym_db WHERE id = 1`;
  if (rows.length === 0) {
    const init = { users: [], creds: [], subs: [], invites: [], deviceLinks: [] };
    await sql`
      INSERT INTO opengym_db (id, data)
      VALUES (1, ${JSON.stringify(init)}::jsonb)
      ON CONFLICT (id) DO NOTHING
    `;
    return init;
  }
  const d = rows[0].data;
  d.users = d.users || [];
  d.creds = d.creds || [];
  d.subs = d.subs || [];
  d.invites = d.invites || [];
  d.deviceLinks = d.deviceLinks || [];
  return d;
}

export async function saveDb(db) {
  if (!sql) return;
  await ensureSchema();
  const text = JSON.stringify(db);
  await sql`
    INSERT INTO opengym_db (id, data, updated_at)
    VALUES (1, ${text}::jsonb, NOW())
    ON CONFLICT (id) DO UPDATE
    SET data = EXCLUDED.data, updated_at = NOW()
  `;
}

export async function readStateStrict(uid) {
  if (!sql) return null;
  await ensureSchema();
  try {
    const rows = await sql`SELECT state FROM opengym_state WHERE uid = ${uid}`;
    return rows.length > 0 ? rows[0].state : null;
  } catch (err) {
    console.error('readStateStrict error', uid, err);
    return null;
  }
}

export async function readStateRev(uid) {
  if (!sql) return null;
  await ensureSchema();
  const rows = await sql`SELECT rev, wid FROM opengym_state WHERE uid = ${uid}`;
  return rows.length > 0 ? { _rev: rows[0].rev, _wid: rows[0].wid } : null;
}

export async function deleteState(uid) {
  if (!sql) return;
  await ensureSchema();
  await sql`DELETE FROM opengym_state WHERE uid = ${uid}`;
}

export async function saveStateAtomic(uid, state, nextRev, nextWid, curRev = -1) {
  if (!sql) return { ok: false };
  await ensureSchema();
  const stateJson = JSON.stringify(state);

  // Unconditional overwrite (import / backup restore)
  if (curRev === -1) {
    await sql`
      INSERT INTO opengym_state (uid, state, rev, wid, updated_at)
      VALUES (${uid}, ${stateJson}::jsonb, ${nextRev}, ${nextWid}, NOW())
      ON CONFLICT (uid) DO UPDATE
      SET state = EXCLUDED.state, rev = EXCLUDED.rev, wid = EXCLUDED.wid, updated_at = NOW()
    `;
    return { ok: true, rev: nextRev };
  }

  // Initial state creation
  if (curRev === 0) {
    const res = await sql`
      INSERT INTO opengym_state (uid, state, rev, wid, updated_at)
      VALUES (${uid}, ${stateJson}::jsonb, ${nextRev}, ${nextWid}, NOW())
      ON CONFLICT (uid) DO NOTHING
      RETURNING rev;
    `;
    if (res.length > 0) return { ok: true, rev: nextRev };
    const latest = await sql`SELECT state, rev FROM opengym_state WHERE uid = ${uid}`;
    return { conflict: true, rev: latest[0]?.rev, state: latest[0]?.state };
  }

  // Normal revision bump with optimistic concurrency
  const res = await sql`
    UPDATE opengym_state
    SET state = ${stateJson}::jsonb,
        rev = ${nextRev},
        wid = ${nextWid},
        updated_at = NOW()
    WHERE uid = ${uid} AND rev = ${curRev}
    RETURNING rev;
  `;
  if (res.length > 0) return { ok: true, rev: nextRev };

  // Conflict occurred
  const latest = await sql`SELECT state, rev FROM opengym_state WHERE uid = ${uid}`;
  return { conflict: true, rev: latest[0]?.rev, state: latest[0]?.state };
}

export async function putChallenge(data) {
  if (!sql) return null;
  await ensureSchema();
  const cid = crypto.randomBytes(16).toString('base64url');
  const exp = Date.now() + 5 * 60000;
  await sql`
    INSERT INTO opengym_challenges (cid, data, exp)
    VALUES (${cid}, ${JSON.stringify(data)}::jsonb, ${exp})
  `;
  sql`DELETE FROM opengym_challenges WHERE exp < ${Date.now()}`.catch(() => {});
  return cid;
}

export async function takeChallenge(cid) {
  if (!sql) return null;
  await ensureSchema();
  const now = Date.now();
  const rows = await sql`
    DELETE FROM opengym_challenges
    WHERE cid = ${cid} AND exp >= ${now}
    RETURNING data;
  `;
  return rows.length > 0 ? rows[0].data : null;
}

export async function putPairing(code, uid) {
  if (!sql) return;
  await ensureSchema();
  const exp = Date.now() + 5 * 60000;
  await sql`
    INSERT INTO opengym_pairings (code, uid, exp)
    VALUES (${code}, ${uid}, ${exp})
    ON CONFLICT (code) DO UPDATE SET uid = EXCLUDED.uid, exp = EXCLUDED.exp
  `;
  sql`DELETE FROM opengym_pairings WHERE exp < ${Date.now()}`.catch(() => {});
}

export async function takePairing(code) {
  if (!sql) return null;
  await ensureSchema();
  const now = Date.now();
  const rows = await sql`
    DELETE FROM opengym_pairings
    WHERE code = ${code} AND exp >= ${now}
    RETURNING uid;
  `;
  return rows.length > 0 ? { uid: rows[0].uid } : null;
}

export async function dropPairingsForUser(uid) {
  if (!sql) return;
  await ensureSchema();
  await sql`DELETE FROM opengym_pairings WHERE uid = ${uid}`;
}
