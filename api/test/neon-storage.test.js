import test from 'node:test';
import assert from 'node:assert/strict';

test('db-neon module exports expected interface', async () => {
  const neonDb = await import('../db-neon.js');
  assert.equal(typeof neonDb.ensureSchema, 'function');
  assert.equal(typeof neonDb.loadDb, 'function');
  assert.equal(typeof neonDb.saveDb, 'function');
  assert.equal(typeof neonDb.readStateStrict, 'function');
  assert.equal(typeof neonDb.readStateRev, 'function');
  assert.equal(typeof neonDb.saveStateAtomic, 'function');
  assert.equal(typeof neonDb.putChallenge, 'function');
  assert.equal(typeof neonDb.takeChallenge, 'function');
  assert.equal(typeof neonDb.putPairing, 'function');
  assert.equal(typeof neonDb.takePairing, 'function');
  assert.equal(typeof neonDb.dropPairingsForUser, 'function');
  assert.equal(typeof neonDb.getOrInitSecret, 'function');
  assert.equal(typeof neonDb.getOrInitVapid, 'function');
});

test('server.js exports handleRequest and initServer for Vercel', async () => {
  const serverModule = await import('../server.js');
  assert.equal(typeof serverModule.handleRequest, 'function');
  assert.equal(typeof serverModule.initServer, 'function');
});
