import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as neonDb from '../db-neon.js';
import { initServer, handleRequest } from '../server.js';

test('Neon end-to-end verification', async (t) => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be defined');

  await t.test('1. ensureSchema creates and verifies Neon tables', async () => {
    await neonDb.ensureSchema();
    const tables = await neonDb.sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name IN ('opengym_meta', 'opengym_db', 'opengym_state', 'opengym_challenges', 'opengym_pairings')
      ORDER BY table_name;
    `;
    const names = tables.map(r => r.table_name);
    assert.ok(names.includes('opengym_meta'), 'opengym_meta exists');
    assert.ok(names.includes('opengym_db'), 'opengym_db exists');
    assert.ok(names.includes('opengym_state'), 'opengym_state exists');
    assert.ok(names.includes('opengym_challenges'), 'opengym_challenges exists');
    assert.ok(names.includes('opengym_pairings'), 'opengym_pairings exists');
  });

  await t.test('2. Secret and VAPID key lifecycle in opengym_meta', async () => {
    const secret = await neonDb.getOrInitSecret();
    assert.ok(typeof secret === 'string' && secret.length >= 32, 'Valid secret string');
    const secret2 = await neonDb.getOrInitSecret();
    assert.equal(secret, secret2, 'Secret is idempotent and persisted');

    const vapid = await neonDb.getOrInitVapid('http://localhost:8080', false);
    assert.ok(vapid.publicKey && vapid.privateKey, 'VAPID keys generated');
    const vapid2 = await neonDb.getOrInitVapid('http://localhost:8080', false);
    assert.equal(vapid.publicKey, vapid2.publicKey, 'VAPID public key persisted');
  });

  await t.test('3. DB schema data store in opengym_db', async () => {
    const db = await neonDb.loadDb();
    assert.ok(Array.isArray(db.users), 'db.users is an array');
    assert.ok(Array.isArray(db.creds), 'db.creds is an array');

    const testUser = { id: 'test-user-' + Date.now(), name: 'Neon Tester' };
    db.users.push(testUser);
    await neonDb.saveDb(db);

    const reloaded = await neonDb.loadDb();
    assert.ok(reloaded.users.some(u => u.id === testUser.id), 'Test user saved and reloaded');

    // Clean up
    reloaded.users = reloaded.users.filter(u => u.id !== testUser.id);
    await neonDb.saveDb(reloaded);
  });

  await t.test('4. Atomic state updates and optimistic concurrency in opengym_state', async () => {
    const testUid = 'e2e-uid-' + Date.now();
    const testState = { workouts: [{ id: 'w1', name: 'Bench Press' }], _rev: 1, _wid: 'wid-1' };

    // Initial insert with rev 0 -> 1
    const res1 = await neonDb.saveStateAtomic(testUid, testState, 1, 'wid-1', 0);
    assert.equal(res1.ok, true, 'Initial state inserted');

    // Read state
    const fetched = await neonDb.readStateStrict(testUid);
    assert.deepEqual(fetched, testState, 'State fetched accurately');

    // Read rev
    const revInfo = await neonDb.readStateRev(testUid);
    assert.equal(revInfo._rev, 1);
    assert.equal(revInfo._wid, 'wid-1');

    // Update with correct curRev 1 -> 2
    const testState2 = { ...testState, _rev: 2, _wid: 'wid-2' };
    const res2 = await neonDb.saveStateAtomic(testUid, testState2, 2, 'wid-2', 1);
    assert.equal(res2.ok, true, 'State revision bumped');

    // Conflict test: attempt update with stale curRev 1
    const resConflict = await neonDb.saveStateAtomic(testUid, { ...testState, _rev: 3 }, 3, 'wid-3', 1);
    assert.equal(resConflict.conflict, true, 'Optimistic lock detected conflict');
    assert.equal(resConflict.rev, 2, 'Reported latest rev on conflict');

    // Clean up
    await neonDb.deleteState(testUid);
    const afterDelete = await neonDb.readStateStrict(testUid);
    assert.equal(afterDelete, null, 'State cleaned up');
  });

  await t.test('5. Challenges and Pairings in Neon', async () => {
    const challengeData = { challenge: 'abc-123', uid: 'user-xyz' };
    const cid = await neonDb.putChallenge(challengeData);
    assert.ok(typeof cid === 'string' && cid.length > 0, 'Challenge stored');

    const retrievedChallenge = await neonDb.takeChallenge(cid);
    assert.deepEqual(retrievedChallenge, challengeData, 'Challenge retrieved');

    // Single-use verification
    const doubleTake = await neonDb.takeChallenge(cid);
    assert.equal(doubleTake, null, 'Challenge is single-use');

    // Pairings
    const pairCode = 'PAIR99';
    const pairUid = 'uid-pair-test';
    await neonDb.putPairing(pairCode, pairUid);

    const taken = await neonDb.takePairing(pairCode);
    assert.equal(taken?.uid, pairUid, 'Pairing code matched');
  });

  await t.test('6. Server initialization and live HTTP requests', async () => {
    await initServer();

    // Spin up an ephemeral http server using handleRequest
    const server = http.createServer((req, res) => {
      handleRequest(req, res);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Test GET /api/health
      const healthRes = await fetch(`${baseUrl}/api/health`);
      assert.equal(healthRes.status, 200, '/api/health status 200');
      const healthJson = await healthRes.json();
      assert.equal(healthJson.ok, true, 'healthJson.ok === true');

      // Test POST /api/login/options
      const loginOptsRes = await fetch(`${baseUrl}/api/login/options`, { method: 'POST' });
      assert.equal(loginOptsRes.status, 200, '/api/login/options status 200');
      const loginOptsJson = await loginOptsRes.json();
      assert.ok(loginOptsJson.cid, 'cid present in response');
      assert.ok(loginOptsJson.options?.challenge, 'challenge present in options');

      // Test GET /api/data without cookie -> 401 Unauthorized
      const dataRes = await fetch(`${baseUrl}/api/data`);
      assert.equal(dataRes.status, 401, '/api/data returns 401 when unauthorized');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
