import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT_DIR, 'public');
const DEFAULT_DATA_FILE = join(ROOT_DIR, 'data', 'rooms.json');
const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COLORS = ['#ff6b35', '#ff3d81', '#8b5cf6', '#12b8a6', '#f4b942', '#3b82f6', '#ef4444', '#22c55e'];

class ApiError extends Error {
  constructor(status, message, code = 'request_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function tokensMatch(token, expectedHash) {
  if (!token || !expectedHash) return false;
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function cleanName(value) {
  if (typeof value !== 'string') throw new ApiError(400, 'Bitte gib einen Namen ein.', 'invalid_name');
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > 24) {
    throw new ApiError(400, 'Der Name muss zwischen 1 und 24 Zeichen lang sein.', 'invalid_name');
  }
  return name;
}

function cleanCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!ROOM_CODE_PATTERN.test(code)) {
    throw new ApiError(400, 'Der Raumcode besteht aus 6 Zeichen.', 'invalid_room_code');
  }
  return code;
}

function newToken() {
  return randomBytes(24).toString('base64url');
}

function makeRoomCode(existingRooms) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = '';
    for (let index = 0; index < 6; index += 1) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!existingRooms[code]) return code;
  }
  throw new ApiError(503, 'Gerade konnte kein Raum erstellt werden. Versuch es noch einmal.', 'code_generation_failed');
}

function publicRoom(room) {
  const participants = Object.values(room.participants).map((participant) => ({
    id: participant.id,
    name: participant.name,
    count: Number(participant.count) || 0,
    color: participant.color,
    joinedAt: participant.joinedAt,
    lastActiveAt: participant.lastActiveAt,
    isOwner: participant.id === room.ownerParticipantId
  }));

  return {
    code: room.code,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    version: room.version,
    total: participants.reduce((sum, participant) => sum + participant.count, 0),
    creditCount: Number.isInteger(room.creditCount)
      ? room.creditCount
      : room.history.filter((event) => event.type === 'credit').length,
    participants,
    history: room.history.slice(-100).reverse()
  };
}

class RoomStore {
  constructor(dataFile) {
    this.dataFile = dataFile;
    this.rooms = {};
    this.writeQueue = Promise.resolve();
  }

  async load() {
    await mkdir(dirname(this.dataFile), { recursive: true });
    try {
      const payload = JSON.parse(await readFile(this.dataFile, 'utf8'));
      if (payload && payload.version === 1 && payload.rooms && typeof payload.rooms === 'object') {
        this.rooms = payload.rooms;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('Gespeicherte Räume konnten nicht geladen werden; es wird leer gestartet.', error.message);
      }
    }
  }

  async persist() {
    const snapshot = JSON.stringify({ version: 1, rooms: this.rooms }, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      const temporaryFile = `${this.dataFile}.${process.pid}.tmp`;
      await writeFile(temporaryFile, snapshot, 'utf8');
      await rename(temporaryFile, this.dataFile);
    });
    return this.writeQueue;
  }

  find(codeValue) {
    const code = cleanCode(codeValue);
    const room = this.rooms[code];
    if (!room) throw new ApiError(404, 'Diesen Raum gibt es nicht (mehr).', 'room_not_found');
    return room;
  }

  authenticate(room, participantId, token) {
    const participant = room.participants[participantId];
    if (!participant || !tokensMatch(token, participant.tokenHash)) {
      throw new ApiError(401, 'Deine Teilnahme konnte nicht bestätigt werden.', 'invalid_credentials');
    }
    return participant;
  }

  createParticipant(room, name) {
    const token = newToken();
    const id = randomUUID();
    const now = new Date().toISOString();
    const participant = {
      id,
      name,
      count: 0,
      color: COLORS[Object.keys(room.participants).length % COLORS.length],
      joinedAt: now,
      lastActiveAt: now,
      tokenHash: hashToken(token)
    };
    room.participants[id] = participant;
    return { participant, token };
  }

  async create(nameValue) {
    const name = cleanName(nameValue);
    const code = makeRoomCode(this.rooms);
    const now = new Date().toISOString();
    const room = {
      code,
      createdAt: now,
      updatedAt: now,
      version: 1,
      ownerParticipantId: null,
      creditCount: 0,
      participants: {},
      history: []
    };
    const { participant, token } = this.createParticipant(room, name);
    room.ownerParticipantId = participant.id;
    room.history.push({ id: randomUUID(), type: 'join', participantId: participant.id, at: now });
    this.rooms[code] = room;
    await this.persist();
    return {
      room: publicRoom(room),
      credentials: { participantId: participant.id, token }
    };
  }

  async join(codeValue, nameValue, suppliedCredentials = {}) {
    const room = this.find(codeValue);
    const name = cleanName(nameValue);
    const existing = room.participants[suppliedCredentials?.participantId];
    const now = new Date().toISOString();

    if (existing && tokensMatch(suppliedCredentials.token, existing.tokenHash)) {
      existing.name = name;
      existing.lastActiveAt = now;
      room.updatedAt = now;
      room.version += 1;
      await this.persist();
      return {
        room: publicRoom(room),
        credentials: { participantId: existing.id, token: suppliedCredentials.token }
      };
    }

    if (Object.keys(room.participants).length >= 40) {
      throw new ApiError(409, 'Dieser Raum ist schon voll.', 'room_full');
    }

    const { participant, token } = this.createParticipant(room, name);
    room.updatedAt = now;
    room.version += 1;
    room.history.push({ id: randomUUID(), type: 'join', participantId: participant.id, at: now });
    room.history = room.history.slice(-100);
    await this.persist();
    return {
      room: publicRoom(room),
      credentials: { participantId: participant.id, token }
    };
  }

  async awardCredit(codeValue, participantId, token, targetParticipantId, deltaValue) {
    const room = this.find(codeValue);
    const awardedBy = this.authenticate(room, participantId, token);
    const target = room.participants[targetParticipantId];
    if (!target) throw new ApiError(404, 'Diese Person ist nicht mehr im Raum.', 'participant_not_found');
    if (awardedBy.id === target.id) {
      throw new ApiError(403, 'Du kannst dir selbst keine Credits geben.', 'self_credit_forbidden');
    }
    const delta = Number(deltaValue);
    if (delta !== 1 && delta !== -1) {
      throw new ApiError(400, 'Erlaubt sind nur +1 und -1.', 'invalid_delta');
    }

    const now = new Date().toISOString();
    target.count = (Number(target.count) || 0) + delta;
    target.lastActiveAt = now;
    awardedBy.lastActiveAt = now;
    room.updatedAt = now;
    room.version += 1;
    room.creditCount = (Number(room.creditCount) || 0) + 1;
    room.history.push({
      id: randomUUID(),
      type: 'credit',
      participantId: target.id,
      awardedByParticipantId: awardedBy.id,
      delta,
      at: now
    });
    room.history = room.history.slice(-100);
    await this.persist();
    return publicRoom(room);
  }

  async undoLastCredit(codeValue, participantId, token) {
    const room = this.find(codeValue);
    const awardedBy = this.authenticate(room, participantId, token);
    let historyIndex = -1;
    for (let index = room.history.length - 1; index >= 0; index -= 1) {
      const event = room.history[index];
      if (event.type === 'credit' && event.awardedByParticipantId === awardedBy.id) {
        historyIndex = index;
        break;
      }
    }
    if (historyIndex === -1) {
      throw new ApiError(409, 'Du hast noch keine Vergabe, die du zurücknehmen kannst.', 'nothing_to_undo');
    }

    const event = room.history[historyIndex];
    const target = room.participants[event.participantId];
    if (target) target.count = (Number(target.count) || 0) - event.delta;
    room.history.splice(historyIndex, 1);
    room.creditCount = Math.max(0, (Number(room.creditCount) || 0) - 1);
    room.updatedAt = new Date().toISOString();
    room.version += 1;
    await this.persist();
    return publicRoom(room);
  }

  async reset(codeValue, participantId, token) {
    const room = this.find(codeValue);
    const participant = this.authenticate(room, participantId, token);
    if (participant.id !== room.ownerParticipantId) {
      throw new ApiError(403, 'Nur der Raumersteller darf alle Zähler zurücksetzen.', 'owner_required');
    }

    const now = new Date().toISOString();
    for (const item of Object.values(room.participants)) item.count = 0;
    room.creditCount = 0;
    room.updatedAt = now;
    room.version += 1;
    room.history = [{ id: randomUUID(), type: 'reset', participantId: participant.id, at: now }];
    await this.persist();
    return publicRoom(room);
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 12_000) throw new ApiError(413, 'Die Anfrage ist zu groß.', 'payload_too_large');
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new ApiError(400, 'Die Anfrage enthält kein gültiges JSON.', 'invalid_json');
  }
}

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

async function serveStatic(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const safeRelativePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = resolve(PUBLIC_DIR, safeRelativePath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${sep}`)) return false;

  try {
    const details = await stat(filePath);
    if (!details.isFile()) return false;
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(filePath)] || 'application/octet-stream',
      'Content-Length': details.size,
      'Cache-Control': pathname === '/' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(filePath).pipe(response);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return false;
    throw error;
  }
}

function writeRoomEvent(response, room) {
  response.write(`event: room\ndata: ${JSON.stringify(room)}\n\n`);
}

export function createCounterServer(options = {}) {
  const store = new RoomStore(options.dataFile || process.env.DATA_FILE || DEFAULT_DATA_FILE);
  const clients = new Map();
  const ready = store.load();

  function broadcast(code) {
    const room = publicRoom(store.find(code));
    for (const response of clients.get(code) || []) {
      if (!response.destroyed) writeRoomEvent(response, room);
    }
  }

  const server = createServer(async (request, response) => {
    try {
      await ready;
      const url = new URL(request.url, 'http://localhost');
      const { pathname } = url;

      if (pathname === '/health' && request.method === 'GET') {
        return sendJson(response, 200, { ok: true });
      }

      if (pathname === '/api/rooms' && request.method === 'POST') {
        const body = await readJson(request);
        const result = await store.create(body.name);
        return sendJson(response, 201, result);
      }

      const match = pathname.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})(?:\/(join|credit|undo|reset|events))?$/);
      if (match) {
        const [, code, action] = match;

        if (!action && request.method === 'GET') {
          return sendJson(response, 200, { room: publicRoom(store.find(code)) });
        }

        if (action === 'join' && request.method === 'POST') {
          const body = await readJson(request);
          const result = await store.join(code, body.name, body.credentials);
          broadcast(code);
          return sendJson(response, 200, result);
        }

        if (action === 'credit' && request.method === 'POST') {
          const body = await readJson(request);
          const room = await store.awardCredit(
            code,
            body.participantId,
            body.token,
            body.targetParticipantId,
            body.delta
          );
          broadcast(code);
          return sendJson(response, 200, { room });
        }

        if (action === 'undo' && request.method === 'POST') {
          const body = await readJson(request);
          const room = await store.undoLastCredit(code, body.participantId, body.token);
          broadcast(code);
          return sendJson(response, 200, { room });
        }

        if (action === 'reset' && request.method === 'POST') {
          const body = await readJson(request);
          const room = await store.reset(code, body.participantId, body.token);
          broadcast(code);
          return sendJson(response, 200, { room });
        }

        if (action === 'events' && request.method === 'GET') {
          const room = publicRoom(store.find(code));
          response.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
          });
          response.write('retry: 2000\n\n');
          writeRoomEvent(response, room);
          if (!clients.has(code)) clients.set(code, new Set());
          clients.get(code).add(response);
          request.on('close', () => {
            clients.get(code)?.delete(response);
            if (clients.get(code)?.size === 0) clients.delete(code);
          });
          return;
        }
      }

      if (pathname.startsWith('/api/')) throw new ApiError(404, 'API-Endpunkt nicht gefunden.', 'not_found');
      if (await serveStatic(request, response, pathname)) return;
      throw new ApiError(404, 'Seite nicht gefunden.', 'not_found');
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status = error instanceof ApiError ? error.status : 500;
      if (status === 500) console.error(error);
      sendJson(response, status, {
        error: error instanceof ApiError ? error.message : 'Auf dem Server ist etwas schiefgegangen.',
        code: error instanceof ApiError ? error.code : 'internal_error'
      });
    }
  });

  const heartbeat = setInterval(() => {
    for (const roomClients of clients.values()) {
      for (const response of roomClients) {
        if (!response.destroyed) response.write(': ping\n\n');
      }
    }
  }, 20_000);
  heartbeat.unref();

  return {
    server,
    store,
    async close() {
      clearInterval(heartbeat);
      for (const roomClients of clients.values()) {
        for (const response of roomClients) response.end();
      }
      if (!server.listening) return;
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const app = createCounterServer();
  app.server.listen(port, host, () => {
    console.log(`Deine-Mutter-Counter läuft auf http://${host}:${port}`);
  });
}
