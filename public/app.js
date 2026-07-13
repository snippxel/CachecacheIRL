const socket = io();
const SESSION_KEY = 'traque_session';

function saveSession(code, sessionId, name) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ code, sessionId, name })); } catch (e) {}
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
}

let state = {
  code: null,
  playerId: null,
  isHost: false,
  myRole: null,
  myToken: null,
  players: [],
  zone: null,
  status: 'lobby',
  watchId: null,
  map: null,
  markers: {},
  zoneCircle: null,
  nextZoneCircle: null,
  myMarker: null,
  timerInterval: null,
  nextRevealAt: null
};

// Tentative de reconnexion automatique si on a deja une session en cours
// (ex : la page vient d'etre rafraichie pendant une partie)
socket.on('connect', () => {
  const saved = loadSession();
  if (!saved) return;
  socket.emit('rejoin_room', { code: saved.code, sessionId: saved.sessionId }, (res) => {
    if (!res.ok) { clearSession(); return; }
    state.code = res.code;
    state.playerId = res.playerId;
    state.isHost = res.isHost;
    if (res.status === 'lobby') enterLobby();
    // si la partie est en cours, l'ecran "screen-game" s'ouvrira automatiquement
    // via l'evenement 'game_view' que le serveur va renvoyer juste apres.
  });
});

// ---------- Navigation ----------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById(btn.dataset.close).classList.add('hidden');
    stopScanner();
  });
});

// ---------- Accueil ----------
document.getElementById('btn-create').addEventListener('click', () => {
  const name = document.getElementById('input-name').value.trim();
  if (!name) return showHomeError('Entre ton nom d\'abord.');
  socket.emit('create_room', { name }, (res) => {
    if (!res.ok) return showHomeError(res.error);
    state.code = res.code;
    state.playerId = res.playerId;
    state.isHost = true;
    saveSession(res.code, res.sessionId, name);
    enterLobby();
  });
});

document.getElementById('btn-join').addEventListener('click', () => {
  const name = document.getElementById('input-name').value.trim();
  const code = document.getElementById('input-code').value.trim().toUpperCase();
  if (!name) return showHomeError('Entre ton nom d\'abord.');
  if (!code) return showHomeError('Entre un code de partie.');
  socket.emit('join_room', { code, name }, (res) => {
    if (!res.ok) return showHomeError(res.error);
    state.code = res.code;
    state.playerId = res.playerId;
    state.isHost = false;
    saveSession(res.code, res.sessionId, name);
    enterLobby();
  });
});

function showHomeError(msg) {
  document.getElementById('home-error').textContent = msg;
}

// ---------- Lobby ----------
function enterLobby() {
  document.getElementById('lobby-code').textContent = state.code;
  document.getElementById('host-controls').classList.toggle('hidden', !state.isHost);
  document.getElementById('guest-waiting').classList.toggle('hidden', state.isHost);
  showScreen('screen-lobby');
}

socket.on('room_update', (room) => {
  state.players = room.players;
  state.status = room.status;
  renderLobby(room);
});

function renderLobby(room) {
  const list = document.getElementById('lobby-players');
  list.innerHTML = '';
  room.players.forEach(p => {
    const li = document.createElement('li');
    const roleTag = p.role === 'hunter' ? '<span class="tag tag-hunter">Chasseur</span>'
      : p.role === 'hidden' ? '<span class="tag tag-hidden">Caché</span>'
      : '<span class="tag tag-none">—</span>';
    const hostTag = p.id === room.hostId ? '<span class="tag tag-host">Hôte</span>' : '';
    li.innerHTML = `<span>${escapeHtml(p.name)}</span><span style="display:flex;gap:6px;">${hostTag}${roleTag}</span>`;
    list.appendChild(li);
  });
  if (state.isHost) buildManualPanel(room);
}

function buildManualPanel(room) {
  const panel = document.getElementById('manual-roles-panel');
  panel.innerHTML = '';
  room.players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'manual-row';
    row.innerHTML = `
      <span>${escapeHtml(p.name)}</span>
      <select data-id="${p.id}">
        <option value="">—</option>
        <option value="hunter" ${p.role === 'hunter' ? 'selected' : ''}>Chasseur</option>
        <option value="hidden" ${p.role === 'hidden' ? 'selected' : ''}>Caché</option>
      </select>`;
    panel.appendChild(row);
  });
}

document.getElementById('btn-random-roles').addEventListener('click', () => {
  socket.emit('set_roles', { code: state.code, mode: 'random' }, () => {});
});

document.getElementById('btn-manual-roles').addEventListener('click', () => {
  const panel = document.getElementById('manual-roles-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    panel.querySelectorAll('select').forEach(sel => {
      sel.addEventListener('change', () => {
        const assignments = {};
        panel.querySelectorAll('select').forEach(s => { if (s.value) assignments[s.dataset.id] = s.value; });
        socket.emit('set_roles', { code: state.code, mode: 'manual', assignments }, () => {});
      });
    });
  }
});

document.getElementById('btn-start-game').addEventListener('click', () => {
  const radiusStart = parseInt(document.getElementById('cfg-radius-start').value, 10) || 400;
  const radiusEnd = parseInt(document.getElementById('cfg-radius-end').value, 10) || 40;
  const duration = parseInt(document.getElementById('cfg-duration').value, 10) || 20;
  const steps = parseInt(document.getElementById('cfg-steps').value, 10) || 4;

  navigator.geolocation.getCurrentPosition((pos) => {
    socket.emit('start_game', {
      code: state.code,
      zone: {
        centerLat: pos.coords.latitude,
        centerLng: pos.coords.longitude,
        startRadius: radiusStart,
        endRadius: radiusEnd
      },
      durationMinutes: duration,
      steps
    }, (res) => {
      if (!res.ok) alert(res.error);
    });
  }, () => alert('Active la géolocalisation pour définir le centre de la zone.'), { enableHighAccuracy: true });
});

// ---------- Jeu ----------
socket.on('game_started', () => {
  state.status = 'playing';
});

let gameEntered = false;

socket.on('game_view', (view) => {
  state.players = view.players;
  state.zone = view.zone;
  state.status = view.status;
  state.myRole = view.myRole;
  state.nextRevealAt = view.nextRevealAt;

  const me = view.players.find(p => p.id === state.playerId);
  if (me && me.myToken) state.myToken = me.myToken;

  if (!gameEntered) {
    gameEntered = true;
    enterGame();
  }
  renderGamePlayers();
  updateRoleUI();
});

function updateRoleUI() {
  const badge = document.getElementById('role-badge');
  badge.textContent = state.myRole === 'hunter' ? 'CHASSEUR' : 'CACHÉ';
  badge.className = 'role-badge ' + (state.myRole === 'hunter' ? 'role-hunter' : 'role-hidden');

  document.getElementById('btn-my-qr').classList.toggle('hidden', state.myRole !== 'hidden');
  document.getElementById('btn-scan').classList.toggle('hidden', state.myRole !== 'hunter');

  document.getElementById('reveal-timer').classList.remove('hidden');
}

function enterGame() {
  showScreen('screen-game');
  initMap();
  startGeolocation();
  startTimer();
}

function initMap() {
  if (state.map) { state.map.remove(); state.map = null; }
  state.map = L.map('map', { zoomControl: false, attributionControl: false })
    .setView([state.zone.centerLat, state.zone.centerLng], 16);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 20
  }).addTo(state.map);

  state.zoneCircle = L.circle([state.zone.centerLat, state.zone.centerLng], {
    radius: state.zone.startRadius,
    color: '#FF9F1C', weight: 2, dashArray: '6 6', fillOpacity: 0.05
  }).addTo(state.map);

  state.nextZoneCircle = L.circle([state.zone.centerLat, state.zone.centerLng], {
    radius: state.zone.startRadius,
    color: '#E63946', weight: 2, dashArray: '3 8', fillOpacity: 0
  }).addTo(state.map);

  setTimeout(() => state.map.invalidateSize(), 200);
  updateZoneRadius();
  renderGamePlayers();
}

function currentPhaseIndex(zone, now) {
  const idx = Math.floor((now - zone.startTime) / zone.phaseDurationMs);
  return Math.min(zone.phases, Math.max(0, idx));
}

function currentZoneRadius() {
  const z = state.zone;
  if (!z.radii) return z.startRadius;
  return z.radii[currentPhaseIndex(z, Date.now())];
}

function nextZoneRadius() {
  const z = state.zone;
  if (!z.radii) return null;
  const idx = currentPhaseIndex(z, Date.now());
  return idx < z.phases ? z.radii[idx + 1] : null;
}

function updateZoneRadius() {
  if (!state.zoneCircle) return;
  state.zoneCircle.setRadius(currentZoneRadius());
  const next = nextZoneRadius();
  if (next != null) {
    state.nextZoneCircle.setRadius(next);
    state.nextZoneCircle.setStyle({ opacity: 1 });
  } else {
    state.nextZoneCircle.setStyle({ opacity: 0 });
  }
}

function renderGamePlayers() {
  if (!state.map) return;
  const activeIds = new Set();
  state.players.forEach(p => {
    if (p.id === state.playerId) return;
    if (p.lat == null || p.lng == null) return;
    activeIds.add(p.id);
    const color = p.role === 'hunter' ? '#E63946' : '#2EC4B6';
    const stale = !p.live ? ' stale' : '';
    if (state.markers[p.id]) {
      state.markers[p.id].setLatLng([p.lat, p.lng]);
    } else {
      const icon = L.divIcon({
        className: '',
        html: `<div class="player-marker${stale}" style="background:${color}"></div>
               <div class="marker-label">${escapeHtml(p.name)}${!p.live ? ' (signal)' : ''}</div>`,
        iconSize: [18, 18], iconAnchor: [9, 9]
      });
      state.markers[p.id] = L.marker([p.lat, p.lng], { icon }).addTo(state.map);
    }
  });
  Object.keys(state.markers).forEach(id => {
    if (!activeIds.has(id)) { state.map.removeLayer(state.markers[id]); delete state.markers[id]; }
  });
}

function roughDistanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const MAX_ACCEPTABLE_ACCURACY_M = 30;
const MIN_SEND_INTERVAL_MS = 1500;
const MIN_MOVE_METERS = 2;

function startGeolocation() {
  if (state.watchId) navigator.geolocation.clearWatch(state.watchId);
  let lastSentAt = 0;
  let lastLat = null, lastLng = null;

  state.watchId = navigator.geolocation.watchPosition((pos) => {
    const { latitude, longitude, accuracy } = pos.coords;

    renderMyOwnMarker(latitude, longitude);
    updateMyMarkerAccuracy(latitude, longitude, accuracy);

    if (accuracy != null && accuracy > MAX_ACCEPTABLE_ACCURACY_M) {
      updateAccuracyBadge(accuracy, true);
      return;
    }
    updateAccuracyBadge(accuracy, false);

    const now = Date.now();
    const moved = lastLat == null || roughDistanceMeters(lastLat, lastLng, latitude, longitude) > MIN_MOVE_METERS;
    if (now - lastSentAt < MIN_SEND_INTERVAL_MS && !moved) return;

    lastSentAt = now; lastLat = latitude; lastLng = longitude;
    socket.emit('update_position', { code: state.code, lat: latitude, lng: longitude, accuracy });
  }, (err) => console.warn('Géoloc erreur', err), { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 });
}

function renderMyOwnMarker(lat, lng) {
  if (!state.map) return;
  const icon = L.divIcon({
    className: '',
    html: `<div class="player-marker me" style="background:#FF9F1C"></div><div class="marker-label">Toi</div>`,
    iconSize: [18, 18], iconAnchor: [9, 9]
  });
  if (state.myMarker) {
    state.myMarker.setLatLng([lat, lng]);
  } else {
    state.myMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(state.map);
  }
}

function updateAccuracyBadge(accuracy, rejected) {
  const el = document.getElementById('accuracy-badge');
  if (!el) return;
  el.classList.remove('hidden');
  const val = accuracy ? Math.round(accuracy) : '?';
  el.textContent = rejected ? `Signal GPS faible (±${val}m, ignoré)` : `Précision GPS ≈ ${val}m`;
  el.classList.toggle('accuracy-bad', rejected);
}

let myAccuracyCircle = null;
function updateMyMarkerAccuracy(lat, lng, accuracy) {
  if (!state.map || accuracy == null) return;
  if (!myAccuracyCircle) {
    myAccuracyCircle = L.circle([lat, lng], { radius: accuracy, color: '#FF9F1C', weight: 1, fillOpacity: 0.08, dashArray: '3 5' }).addTo(state.map);
  } else {
    myAccuracyCircle.setLatLng([lat, lng]);
    myAccuracyCircle.setRadius(accuracy);
  }
}

function startTimer() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = setInterval(() => {
    const z = state.zone;
    const remaining = Math.max(0, z.startTime + z.durationMs - Date.now());
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    document.getElementById('timer').textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    updateZoneRadius();

    if (state.nextRevealAt) {
      const rem = Math.max(0, state.nextRevealAt - Date.now());
      const rm = Math.floor(rem / 60000);
      const rs = Math.floor((rem % 60000) / 1000);
      document.getElementById('reveal-countdown').textContent = `${String(rm).padStart(2, '0')}:${String(rs).padStart(2, '0')}`;
    }

    if (state.zone && state.zone.phaseDurationMs) {
      const idx = currentPhaseIndex(state.zone, Date.now());
      const zoneTimerEl = document.getElementById('zone-timer');
      if (idx < state.zone.phases) {
        const nextChangeAt = state.zone.startTime + (idx + 1) * state.zone.phaseDurationMs;
        const zrem = Math.max(0, nextChangeAt - Date.now());
        const zm = Math.floor(zrem / 60000);
        const zs = Math.floor((zrem % 60000) / 1000);
        document.getElementById('zone-countdown').textContent = `${String(zm).padStart(2, '0')}:${String(zs).padStart(2, '0')}`;
        zoneTimerEl.classList.remove('hidden');
      } else {
        zoneTimerEl.classList.add('hidden');
      }
    }
  }, 1000);
}

document.getElementById('btn-my-qr').addEventListener('click', () => {
  if (!state.myToken) return;
  const wrap = document.getElementById('qr-canvas-wrap');
  wrap.innerHTML = '';
  new QRCode(wrap, { text: state.myToken, width: 220, height: 220 });
  document.getElementById('modal-qr').classList.remove('hidden');
});

let html5QrCode = null;

document.getElementById('btn-scan').addEventListener('click', () => {
  document.getElementById('modal-scan').classList.remove('hidden');
  html5QrCode = new Html5Qrcode('qr-reader');
  html5QrCode.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: 220 },
    (decodedText) => {
      socket.emit('scan_result', { code: state.code, targetToken: decodedText }, (res) => {
        showToast(res.ok ? `${res.name} rejoint les chasseurs !` : res.error);
        document.getElementById('modal-scan').classList.add('hidden');
        stopScanner();
      });
    },
    () => {}
  ).catch(() => showToast("Impossible d'accéder à la caméra"));
});

function stopScanner() {
  if (html5QrCode) {
    html5QrCode.stop().then(() => html5QrCode.clear()).catch(() => {});
    html5QrCode = null;
  }
}

socket.on('capture', ({ name }) => showToast(`${name} rejoint les chasseurs !`));

let audioCtx = null;
document.addEventListener('pointerdown', () => {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  } else if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}, { once: false });

function playAlarmBeep() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(880, now);
  gain.gain.setValueAtTime(0.2, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.35);
}

let zoneWarningInterval = null;

socket.on('zone_warning', ({ deadline }) => {
  const overlay = document.getElementById('zone-warning-overlay');
  const countdownEl = document.getElementById('zone-warning-countdown');
  overlay.classList.remove('hidden');
  playAlarmBeep();
  if (zoneWarningInterval) clearInterval(zoneWarningInterval);
  zoneWarningInterval = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    countdownEl.textContent = remaining;
    if (remaining <= 0 || remaining % 2 === 0) playAlarmBeep();
    if (Date.now() >= deadline) {
      clearInterval(zoneWarningInterval);
      zoneWarningInterval = null;
    }
  }, 1000);
});

socket.on('zone_safe', () => {
  document.getElementById('zone-warning-overlay').classList.add('hidden');
  if (zoneWarningInterval) { clearInterval(zoneWarningInterval); zoneWarningInterval = null; }
});

socket.on('zone_shrink', () => showToast('La zone vient de rétrécir !'));

socket.on('zone_capture', ({ name }) => showToast(`${name} est resté hors zone trop longtemps et rejoint les chasseurs !`));

socket.on('zone_exit_ping', ({ name, lat, lng }) => {
  showToast(`${name} est sorti de la zone !`);
  if (!state.map) return;
  const icon = L.divIcon({
    className: '',
    html: `<div class="hunter-ping-marker"></div><div class="marker-label">${escapeHtml(name)}</div>`,
    iconSize: [22, 22], iconAnchor: [11, 11]
  });
  const marker = L.marker([lat, lng], { icon }).addTo(state.map);
  setTimeout(() => state.map.removeLayer(marker), 6000);
});

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 2600);
}

socket.on('game_over', ({ winner, reason }) => {
  if (state.watchId) navigator.geolocation.clearWatch(state.watchId);
  if (state.timerInterval) clearInterval(state.timerInterval);
  document.getElementById('zone-warning-overlay').classList.add('hidden');
  if (zoneWarningInterval) { clearInterval(zoneWarningInterval); zoneWarningInterval = null; }
  document.getElementById('over-title').textContent = winner === 'hunters' ? 'Les chasseurs gagnent' : 'Les cachés gagnent';
  document.getElementById('over-reason').textContent = reason;
  showScreen('screen-over');
});

document.getElementById('btn-back-home').addEventListener('click', () => {
  clearSession();
  location.reload();
});

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
