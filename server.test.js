import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCounterServer } from '../server.js';

async function startApp(dataFile) {
  const app = createCounterServer({ dataFile });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  return { ...app, url: `http://127.0.0.1:${port}` };
}

async function request(url, path, options = {}) {
  const response = await fetch(`${url}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json();
  return { response, body };
}

test('Andere vergeben Credits, Selbstvergabe ist gesperrt und Vergaben lassen sich zurücknehmen', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dm-counter-'));
  const app = await startApp(join(directory, 'rooms.json'));
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const created = await request(app.url, '/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: 'Alex' })
  });
  assert.equal(created.response.status, 201);
  assert.match(created.body.room.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(created.body.room.total, 0);
  assert.equal(created.body.room.participants[0].isOwner, true);
  assert.ok(!('tokenHash' in created.body.room.participants[0]));

  const code = created.body.room.code;
  const joined = await request(app.url, `/api/rooms/${code}/join`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Sam' })
  });
  assert.equal(joined.response.status, 200);
  assert.equal(joined.body.room.participants.length, 2);

  const samId = joined.body.credentials.participantId;
  const awarded = await request(app.url, `/api/rooms/${code}/credit`, {
    method: 'POST',
    body: JSON.stringify({ ...created.body.credentials, targetParticipantId: samId, delta: 1 })
  });
  assert.equal(awarded.response.status, 200);
  assert.equal(awarded.body.room.total, 1);
  assert.equal(awarded.body.room.creditCount, 1);
  assert.equal(awarded.body.room.participants.find((person) => person.name === 'Sam').count, 1);
  assert.equal(awarded.body.room.history[0].awardedByParticipantId, created.body.credentials.participantId);

  const deniedSelfCredit = await request(app.url, `/api/rooms/${code}/credit`, {
    method: 'POST',
    body: JSON.stringify({ ...joined.body.credentials, targetParticipantId: samId, delta: 1 })
  });
  assert.equal(deniedSelfCredit.response.status, 403);
  assert.equal(deniedSelfCredit.body.code, 'self_credit_forbidden');

  await request(app.url, `/api/rooms/${code}/credit`, {
    method: 'POST',
    body: JSON.stringify({ ...created.body.credentials, targetParticipantId: samId, delta: -1 })
  });
  const undone = await request(app.url, `/api/rooms/${code}/undo`, {
    method: 'POST',
    body: JSON.stringify(created.body.credentials)
  });
  assert.equal(undone.response.status, 200);
  assert.equal(undone.body.room.creditCount, 1);
  assert.equal(undone.body.room.participants.find((person) => person.name === 'Sam').count, 1);

  const deniedReset = await request(app.url, `/api/rooms/${code}/reset`, {
    method: 'POST',
    body: JSON.stringify(joined.body.credentials)
  });
  assert.equal(deniedReset.response.status, 403);

  const reset = await request(app.url, `/api/rooms/${code}/reset`, {
    method: 'POST',
    body: JSON.stringify(created.body.credentials)
  });
  assert.equal(reset.response.status, 200);
  assert.equal(reset.body.room.total, 0);
  assert.equal(reset.body.room.creditCount, 0);

  const undoAfterReset = await request(app.url, `/api/rooms/${code}/undo`, {
    method: 'POST',
    body: JSON.stringify(created.body.credentials)
  });
  assert.equal(undoAfterReset.response.status, 409);
  assert.equal(undoAfterReset.body.code, 'nothing_to_undo');
});

test('Offene Geräte erhalten neue Zählerstände als Live-Ereignis', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dm-counter-live-'));
  const app = await startApp(join(directory, 'rooms.json'));
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const created = await request(app.url, '/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: 'Lea' })
  });
  const code = created.body.room.code;
  const joined = await request(app.url, `/api/rooms/${code}/join`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Noah' })
  });
  const stream = await fetch(`${app.url}/api/rooms/${code}/events`, { signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  const initial = decoder.decode((await reader.read()).value);
  assert.match(initial, /event: room/);
  assert.match(initial, /"total":0/);

  await request(app.url, `/api/rooms/${code}/credit`, {
    method: 'POST',
    body: JSON.stringify({
      ...created.body.credentials,
      targetParticipantId: joined.body.credentials.participantId,
      delta: 1
    })
  });
  const update = await Promise.race([
    reader.read(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Live-Ereignis kam nicht an.')), 1_000))
  ]);
  assert.match(decoder.decode(update.value), /"total":1/);
  assert.match(decoder.decode(update.value), /"creditCount":1/);
  await reader.cancel();
});

test('Räume überleben einen Serverneustart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dm-counter-persist-'));
  const dataFile = join(directory, 'rooms.json');
  t.after(() => rm(directory, { recursive: true, force: true }));

  const first = await startApp(dataFile);
  const created = await request(first.url, '/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: 'Mika' })
  });
  const code = created.body.room.code;
  await first.close();

  const second = await startApp(dataFile);
  const loaded = await request(second.url, `/api/rooms/${code}`);
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.body.room.participants[0].name, 'Mika');
  await second.close();
});

test('Ungültige Eingaben werden verständlich abgelehnt', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dm-counter-validation-'));
  const app = await startApp(join(directory, 'rooms.json'));
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const noName = await request(app.url, '/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: '   ' })
  });
  assert.equal(noName.response.status, 400);
  assert.equal(noName.body.code, 'invalid_name');

  const missing = await request(app.url, '/api/rooms/ABC234');
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.code, 'room_not_found');
});
