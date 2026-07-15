const elements = Object.fromEntries([
  'welcomeView', 'roomView', 'createForm', 'joinForm', 'createName', 'joinName', 'roomCode', 'joinHint',
  'homeButton', 'shareButton', 'connectionPill', 'activeRoomCode', 'roomCodeChip', 'totalNumber',
  'undoButton', 'creditCount', 'peopleCount', 'leaderName', 'awardGrid', 'leaderboard', 'activityList',
  'resetButton', 'resetDialog', 'confirmResetButton', 'toast'
].map((id) => [id, document.getElementById(id)]));

const state = {
  code: null,
  credentials: null,
  room: null,
  events: null,
  toastTimer: null,
  pendingCredits: 0
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
  const oldOwnScore = currentParticipant()?.count;
  state.room = room;
  renderRoom();
  const newOwnScore = currentParticipant()?.count;
  if (oldOwnScore !== undefined && newOwnScore !== oldOwnScore) {
    elements.totalNumber.classList.remove('bump');
    requestAnimationFrame(() => elements.totalNumber.classList.add('bump'));
  }
}

function formatScore(score) {
  const number = Number(score) || 0;
  return number > 0 ? `+${number.toLocaleString('de-DE')}` : number.toLocaleString('de-DE');
}

function renderRoom() {
  const me = currentParticipant();
  const sorted = [...state.room.participants].sort((a, b) => a.count - b.count || a.joinedAt.localeCompare(b.joinedAt));
  elements.totalNumber.textContent = formatScore(me?.count);
  elements.creditCount.textContent = (state.room.creditCount || 0).toLocaleString('de-DE');
  elements.peopleCount.textContent = state.room.participants.length.toLocaleString('de-DE');
  elements.leaderName.textContent = sorted[0]?.name || 'Noch offen';
  elements.undoButton.disabled = !state.room.history.some(
    (event) => event.type === 'credit' && event.awardedByParticipantId === state.credentials.participantId
  );
  elements.resetButton.classList.toggle('hidden', !me?.isOwner);
  renderAwardGrid();
  renderLeaderboard(sorted);
  renderActivity();
}

function renderAwardGrid() {
  elements.awardGrid.replaceChildren();
  const others = state.room.participants
    .filter((participant) => participant.id !== state.credentials.participantId)
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));

  if (!others.length) {
    const empty = document.createElement('p');
    empty.className = 'award-empty';
    empty.textContent = 'Noch niemand da. Teile den Raum-Link – eigene Credits sind gesperrt.';
    elements.awardGrid.append(empty);
    return;
  }

  for (const participant of others) {
    const card = document.createElement('article');
    card.className = 'award-card';
    const identity = document.createElement('div');
    identity.className = 'award-identity';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.style.background = participant.color;
    avatar.textContent = participant.name.slice(0, 1).toUpperCase();
    const copy = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = participant.name;
    const score = document.createElement('span');
    score.textContent = `Stand: ${formatScore(participant.count)}`;
    copy.append(name, score);
    identity.append(avatar, copy);

    const actions = document.createElement('div');
    actions.className = 'award-actions';
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'award-button award-plus';
    plus.dataset.target = participant.id;
    plus.dataset.delta = '1';
    plus.textContent = '+1 Witz gemacht';
    plus.setAttribute('aria-label', `${participant.name} plus einen Punkt geben: Witz gemacht`);
    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'award-button award-minus';
    minus.dataset.target = participant.id;
    minus.dataset.delta = '-1';
    minus.textContent = '−1 Witz abbekommen';
    minus.setAttribute('aria-label', `${participant.name} minus einen Punkt geben: Witz abbekommen`);
    actions.append(plus, minus);
    card.append(identity, actions);
    elements.awardGrid.append(card);
  }
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
    if (index === 0) labels.push('Führt');
    if (participant.id === state.credentials.participantId) labels.push('Du');
    if (participant.isOwner) labels.push('Raumchef');
    note.textContent = labels.join(' · ') || 'Mitforscher';
    person.append(name, note);

    const score = document.createElement('strong');
    score.className = 'leader-score';
    score.textContent = formatScore(participant.count);
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
    if (event.type === 'credit') {
      const awardedBy = participantById(event.awardedByParticipantId);
      const actor = document.createElement('strong');
      actor.textContent = awardedBy?.name || 'Jemand';
      const target = document.createElement('strong');
      target.textContent = participant?.name || 'jemandem';
      const reason = event.delta === 1 ? '+1 für einen gemachten Witz.' : '−1 für einen abbekommenen Witz.';
      copy.append(actor, document.createTextNode(' gab '), target, document.createTextNode(` ${reason}`));
    } else {
      const strong = document.createElement('strong');
      strong.textContent = participant?.name || 'Jemand';
      const suffix = document.createTextNode(
        event.type === 'join' ? ' ist dem Raum beigetreten.' :
        event.type === 'reset' ? ' hat alle Konten zurückgesetzt.' :
        event.delta === -1 ? ' bekam −1.' : ' bekam +1.'
      );
      copy.append(strong, suffix);
    }
    const time = document.createElement('time');
    time.className = 'activity-time';
    time.dateTime = event.at;
    time.textContent = formatTime(event.at);
    item.append(dot, copy, time);
    elements.activityList.append(item);
  }
}

async function awardCredit(targetParticipantId, delta, button) {
  if (!state.code || !state.credentials || targetParticipantId === state.credentials.participantId) return;
  button.disabled = true;
  state.pendingCredits += 1;
  try {
    const result = await api(`/api/rooms/${state.code}/credit`, {
      method: 'POST',
      body: JSON.stringify({ ...state.credentials, targetParticipantId, delta })
    });
    updateRoom(result.room);
    const target = participantById(targetParticipantId);
    showToast(`${target?.name || 'Credit'}: ${delta === 1 ? '+1 Witz gemacht' : '−1 Witz abbekommen'}`);
    navigator.vibrate?.(20);
  } catch (error) {
    showToast(error.message);
  } finally {
    state.pendingCredits -= 1;
    if (button.isConnected) button.disabled = false;
  }
}

async function undoLastCredit() {
  elements.undoButton.disabled = true;
  try {
    const result = await api(`/api/rooms/${state.code}/undo`, {
      method: 'POST',
      body: JSON.stringify(state.credentials)
    });
    updateRoom(result.room);
    showToast('Deine letzte Credit-Vergabe wurde zurückgenommen.');
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.undoButton.disabled = !state.room?.history.some(
      (event) => event.type === 'credit' && event.awardedByParticipantId === state.credentials?.participantId
    );
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
elements.awardGrid.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-target][data-delta]');
  if (!button) return;
  awardCredit(button.dataset.target, Number(button.dataset.delta), button);
});
elements.undoButton.addEventListener('click', undoLastCredit);
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
