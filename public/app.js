const elements = Object.fromEntries([
  'welcomeView', 'roomView', 'createForm', 'joinForm', 'createName', 'joinName', 'roomCode', 'joinHint',
  'homeButton', 'shareButton', 'connectionPill', 'activeRoomCode', 'roomCodeChip', 'totalNumber',
  'scoreButtonWrap', 'scoreButton', 'undoButton', 'yourScore', 'peopleCount', 'leaderName', 'leaderboard',
  'activityList', 'resetButton', 'resetDialog', 'confirmResetButton', 'toast'
].map((id) => [id, document.getElementById(id)]));

const state = {
  code: null,
  credentials: null,
  room: null,
  events: null,
  toastTimer: null,
  pendingScores: 0
};

const storageKey = (code) => `deine-mutter-counter:${code}`;

function savedSession(code) {
  try {
    return JSON.parse(localStorage.getItem(storageKey(code))) || null;
  } catch {
    return null;
  }
}

function saveSession(code, session) {
  localStorage.setItem(storageKey(code), JSON.stringify(session));
  localStorage.setItem('deine-mutter-counter:last-name', session.name);
}

function lastName() {
  return localStorage.getItem('deine-mutter-counter:last-name') || '';
}

function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 6);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* A network proxy may return a blank body. */ }
  if (!response.ok) throw new Error(payload.error || 'Die Verbindung hat gerade nicht geklappt.');
  return payload;
}

function setFormBusy(form, busy) {
  for (const control of form.elements) control.disabled = busy;
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  state.toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 2600);
}

function setConnection(mode) {
  const label = mode === 'online' ? 'Live verbunden' : mode === 'offline' ? 'Verbindung weg' : 'Verbinde …';
  elements.connectionPill.className = `connection-pill ${mode}`;
  elements.connectionPill.querySelector('b').textContent = label;
  elements.connectionPill.title = label;
}

function enterRoom(result, name) {
  state.code = result.room.code;
  state.credentials = result.credentials;
  state.room = null;
  saveSession(state.code, { ...result.credentials, name });
  history.replaceState(null, '', `${location.pathname}?room=${state.code}`);
  elements.welcomeView.classList.add('hidden');
  elements.roomView.classList.remove('hidden');
  elements.activeRoomCode.textContent = state.code;
  updateRoom(result.room);
  connectEvents();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function leaveRoom() {
  state.events?.close();
  state.events = null;
  state.code = null;
  state.credentials = null;
  state.room = null;
  history.replaceState(null, '', location.pathname);
  elements.roomView.classList.add('hidden');
  elements.welcomeView.classList.remove('hidden');
  elements.joinHint.textContent = 'Erstelle einen neuen Raum oder tritt deinen Freunden bei.';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function connectEvents() {
  state.events?.close();
  setConnection('connecting');
  const events = new EventSource(`/api/rooms/${state.code}/events`);
  state.events = events;
  events.addEventListener('room', (event) => {
    try { updateRoom(JSON.parse(event.data)); } catch { /* Ignore malformed event. */ }
  });
  events.onopen = () => setConnection('online');
  events.onerror = () => setConnection('offline');
}

function currentParticipant() {
  return state.room?.participants.find((participant) => participant.id === state.credentials?.participantId);
}

function participantById(id) {
  return state.room?.participants.find((participant) => participant.id === id);
}

function updateRoom(room) {
  if (state.room && room.version < state.room.version) return;
  const oldTotal = state.room?.total;
  state.room = room;
  renderRoom();
  if (oldTotal !== undefined && room.total !== oldTotal) {
    elements.totalNumber.classList.remove('bump');
    requestAnimationFrame(() => elements.totalNumber.classList.add('bump'));
  }
}

function renderRoom() {
  const me = currentParticipant();
  const sorted = [...state.room.participants].sort((a, b) => b.count - a.count || a.joinedAt.localeCompare(b.joinedAt));
  elements.totalNumber.textContent = state.room.total.toLocaleString('de-DE');
  elements.yourScore.textContent = (me?.count || 0).toLocaleString('de-DE');
  elements.peopleCount.textContent = state.room.participants.length.toLocaleString('de-DE');
  elements.leaderName.textContent = sorted[0]?.count > 0 ? sorted[0].name : 'Noch offen';
  elements.undoButton.disabled = !me || me.count === 0;
  elements.resetButton.classList.toggle('hidden', !me?.isOwner);
  renderLeaderboard(sorted);
  renderActivity();
}

function renderLeaderboard(sorted) {
  elements.leaderboard.replaceChildren();
  sorted.forEach((participant, index) => {
    const row = document.createElement('li');
    row.className = `leader-row${participant.id === state.credentials.participantId ? ' is-you' : ''}`;

    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = index < 3 ? ['🥇', '🥈', '🥉'][index] : `#${index + 1}`;

    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.style.background = participant.color;
    avatar.textContent = participant.name.slice(0, 1).toUpperCase();

    const person = document.createElement('div');
    person.className = 'leader-person';
    const name = document.createElement('strong');
    name.textContent = participant.name;
    const note = document.createElement('span');
    const labels = [];
    if (participant.id === state.credentials.participantId) labels.push('Du');
    if (participant.isOwner) labels.push('Raumchef');
    note.textContent = labels.join(' · ') || 'Mitforscher';
    person.append(name, note);

    const score = document.createElement('strong');
    score.className = 'leader-score';
    score.textContent = participant.count.toLocaleString('de-DE');
    score.setAttribute('aria-label', `${participant.count} Punkte`);

    row.append(rank, avatar, person, score);
    elements.leaderboard.append(row);
  });
}

function formatTime(iso) {
  return new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function renderActivity() {
  elements.activityList.replaceChildren();
  const events = state.room.history.slice(0, 8);
  if (!events.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = 'Hier ist es verdächtig ruhig …';
    elements.activityList.append(empty);
    return;
  }

  for (const event of events) {
    const participant = participantById(event.participantId);
    const item = document.createElement('li');
    item.className = 'activity-item';
    const dot = document.createElement('span');
    dot.className = 'activity-dot';
    if (participant?.color) dot.style.background = participant.color;
    const copy = document.createElement('span');
    copy.className = 'activity-copy';
    const strong = document.createElement('strong');
    strong.textContent = participant?.name || 'Jemand';
    const suffix = document.createTextNode(
      event.type === 'join' ? ' ist dem Raum beigetreten.' :
      event.type === 'reset' ? ' hat alle Zähler zurückgesetzt.' :
      event.delta === -1 ? ' hat einen Punkt zurückgenommen.' : ' meldet: „Deine Mutter!“'
    );
    copy.append(strong, suffix);
    const time = document.createElement('time');
    time.className = 'activity-time';
    time.dateTime = event.at;
    time.textContent = formatTime(event.at);
    item.append(dot, copy, time);
    elements.activityList.append(item);
  }
}

function spawnBurst() {
  const colors = ['#ff3d81', '#ff6b35', '#f5c842', '#8b5cf6', '#12b8a6'];
  for (let index = 0; index < 12; index += 1) {
    const particle = document.createElement('span');
    particle.className = 'burst-particle';
    const angle = (Math.PI * 2 * index) / 12 + Math.random() * .35;
    const distance = 60 + Math.random() * 65;
    particle.style.setProperty('--particle-x', `${Math.cos(angle) * distance}px`);
    particle.style.setProperty('--particle-y', `${Math.sin(angle) * distance}px`);
    particle.style.setProperty('--particle-r', `${Math.random() * 360}deg`);
    particle.style.setProperty('--particle-color', colors[index % colors.length]);
    elements.scoreButtonWrap.append(particle);
    particle.addEventListener('animationend', () => particle.remove());
  }
}

async function changeScore(delta) {
  if (!state.code || !state.credentials) return;
  if (delta === 1) {
    elements.scoreButton.classList.add('pressed');
    setTimeout(() => elements.scoreButton.classList.remove('pressed'), 120);
    spawnBurst();
    navigator.vibrate?.(20);
  }
  state.pendingScores += 1;
  try {
    const result = await api(`/api/rooms/${state.code}/score`, {
      method: 'POST',
      body: JSON.stringify({ ...state.credentials, delta })
    });
    updateRoom(result.room);
  } catch (error) {
    showToast(error.message);
  } finally {
    state.pendingScores -= 1;
  }
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage);
  } catch {
    const temporary = document.createElement('textarea');
    temporary.value = text;
    temporary.style.position = 'fixed';
    temporary.style.opacity = '0';
    document.body.append(temporary);
    temporary.select();
    document.execCommand('copy');
    temporary.remove();
    showToast(successMessage);
  }
}

elements.createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = elements.createName.value.trim();
  setFormBusy(elements.createForm, true);
  try {
    const result = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) });
    enterRoom(result, name);
  } catch (error) {
    showToast(error.message);
  } finally {
    setFormBusy(elements.createForm, false);
  }
});

elements.joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = elements.joinName.value.trim();
  const code = normalizeCode(elements.roomCode.value);
  setFormBusy(elements.joinForm, true);
  try {
    const previous = savedSession(code);
    const result = await api(`/api/rooms/${code}/join`, {
      method: 'POST',
      body: JSON.stringify({ name, credentials: previous ? { participantId: previous.participantId, token: previous.token } : null })
    });
    enterRoom(result, name);
  } catch (error) {
    showToast(error.message);
  } finally {
    setFormBusy(elements.joinForm, false);
  }
});

elements.roomCode.addEventListener('input', () => { elements.roomCode.value = normalizeCode(elements.roomCode.value); });
elements.scoreButton.addEventListener('click', () => changeScore(1));
elements.undoButton.addEventListener('click', () => changeScore(-1));
elements.homeButton.addEventListener('click', leaveRoom);
elements.roomCodeChip.addEventListener('click', () => copyText(state.code, 'Raumcode kopiert!'));

elements.shareButton.addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?room=${state.code}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Deine Mutter Counter', text: `Komm in unseren Raum ${state.code}!`, url });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  await copyText(url, 'Einladungslink kopiert!');
});

elements.resetButton.addEventListener('click', () => elements.resetDialog.showModal());
elements.confirmResetButton.addEventListener('click', async (event) => {
  event.preventDefault();
  elements.confirmResetButton.disabled = true;
  try {
    const result = await api(`/api/rooms/${state.code}/reset`, {
      method: 'POST',
      body: JSON.stringify(state.credentials)
    });
    updateRoom(result.room);
    elements.resetDialog.close();
    showToast('Alles wieder auf null. Frischer Start!');
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.confirmResetButton.disabled = false;
  }
});

async function restoreFromUrl() {
  const code = normalizeCode(new URLSearchParams(location.search).get('room'));
  const previous = code && savedSession(code);
  elements.createName.value = lastName();
  elements.joinName.value = previous?.name || lastName();
  if (!code) return;
  elements.roomCode.value = code;
  elements.joinHint.textContent = `Du wurdest in Raum ${code} eingeladen.`;
  if (!previous?.participantId || !previous?.token || !previous?.name) return;

  try {
    const result = await api(`/api/rooms/${code}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: previous.name, credentials: { participantId: previous.participantId, token: previous.token } })
    });
    enterRoom(result, previous.name);
  } catch (error) {
    elements.joinHint.textContent = error.message;
  }
}

restoreFromUrl();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
