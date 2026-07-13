const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Reglages par defaut (surchargeables par l'hote au lancement) ----
const DEFAULT_REVEAL_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_ZONE_GRACE_MS = 10 * 1000;

// ---- Etat en memoire ----
const rooms = {};

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function makeToken() {
  return crypto.randomBytes(8).toString('hex');
}

function makeSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

// distance en metres entre deux points GPS (haversine)
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const DISCONNECT_GRACE_MS = 90 * 1000; // temps laisse a un joueur pour revenir apres un refresh/coupure

// Vue "lobby" : liste simple, pas de position
function lobbySnapshot(room, code) {
  return {
    code,
    status: room.status,
    hostId: room.hostId,
    players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, role: p.role }))
  };
}

// Vue personnalisee pendant la partie : chaque joueur ne voit pas la meme chose,
// et ne recoit son PROPRE token QR que pour lui-meme (jamais celui des autres).
function gameViewFor(room, code, viewerId) {
  const viewer = room.players[viewerId];
  const isHunter = viewer && viewer.role === 'hunter';

  const players = Object.values(room.players).map(p => {
    const base = { id: p.id, name: p.name, role: p.role };
    if (p.id === viewerId) {
      // on se voit soi-meme en temps reel + on recoit son propre token pour afficher son QR
      return { ...base, lat: p.lat, lng: p.lng, accuracy: p.accuracy, live: true, myToken: p.token };
    }
    if (p.role === 'hunter') {
      // un chasseur n'est JAMAIS visible pour un cache. Seuls les autres chasseurs le voient.
      if (isHunter) return { ...base, lat: p.lat, lng: p.lng, live: true };
      return { ...base, lat: null, lng: null, live: false };
    }
    // p est cache (et n'est pas le viewer)
    if (isHunter) {
      // un chasseur ne voit la position d'un cache que via la derniere revelation (5 min)
      if (p.lastReveal) return { ...base, lat: p.lastReveal.lat, lng: p.lastReveal.lng, live: false, revealedAt: p.lastReveal.time };
      return { ...base, lat: null, lng: null, live: false };
    }
    // les caches se voient entre eux en temps reel (utile pour se regrouper / s'eviter)
    return { ...base, lat: p.lat, lng: p.lng, live: true };
  });

  return {
    code,
    status: room.status,
    hostId: room.hostId,
    zone: room.zone,
    nextRevealAt: room.nextRevealAt,
    revealIntervalMs: room.revealIntervalMs,
    myRole: viewer ? viewer.role : null,
    players
  };
}

function broadcastLobby(room, code) {
  io.to(code).emit('room_update', lobbySnapshot(room, code));
}

function broadcastToHunters(room, code, event, payload) {
  Object.values(room.players).forEach(p => {
    if (p.role === 'hunter') io.to(p.id).emit(event, payload);
  });
}

// index du palier actuel (0 = zone de depart, jusqu'a zone.phases = zone finale)
function currentPhaseIndex(zone, now) {
  const idx = Math.floor((now - zone.startTime) / zone.phaseDurationMs);
  return Math.min(zone.phases, Math.max(0, idx));
}

function currentSafeRadius(zone, now) {
  return zone.radii[currentPhaseIndex(zone, now)];
}

// Verifie en continu si des caches sont hors-zone ; gere l'alerte, le delai de
// grace configurable, et la conversion automatique en chasseur si le delai expire.
function checkZoneBounds(room, code) {
  if (room.status !== 'playing' || !room.zone) return;
  const now = Date.now();
  const zone = room.zone;

  const phaseIdx = currentPhaseIndex(zone, now);
  if (phaseIdx > zone.lastPhaseIndex) {
    zone.lastPhaseIndex = phaseIdx;
    io.to(code).emit('zone_shrink');
  }

  const safeRadius = currentSafeRadius(zone, now);

  Object.values(room.players).forEach(p => {
    if (p.role !== 'hidden' || p.lat == null) return;
    const dist = distanceMeters(p.lat, p.lng, zone.centerLat, zone.centerLng);

    if (dist > safeRadius) {
      if (!p.outOfZoneSince) {
        p.outOfZoneSince = now;
        io.to(p.id).emit('zone_warning', { deadline: now + room.zoneGraceMs });
        broadcastToHunters(room, code, 'zone_exit_ping', { name: p.name, lat: p.lat, lng: p.lng });
      } else if (now - p.outOfZoneSince >= room.zoneGraceMs) {
        p.role = 'hunter';
        p.outOfZoneSince = null;
        p.lastReveal = null;
        io.to(code).emit('zone_capture', { name: p.name });
        broadcastGameViews(room, code);
        checkWinCondition(room, code);
      }
    } else if (p.outOfZoneSince) {
      p.outOfZoneSince = null;
      io.to(p.id).emit('zone_safe');
    }
  });
}

function broadcastGameViews(room, code) {
  Object.keys(room.players).forEach(pid => {
    io.to(pid).emit('game_view', gameViewFor(room, code, pid));
  });
}

function checkWinCondition(room, code) {
  if (room.status !== 'playing') return;
  const hidden = Object.values(room.players).filter(p => p.role === 'hidden');
  if (hidden.length === 0) {
    room.status = 'ended';
    if (room.revealTimer) clearInterval(room.revealTimer);
    if (room.broadcastTimer) clearInterval(room.broadcastTimer);
    if (room.zoneCheckTimer) clearInterval(room.zoneCheckTimer);
    io.to(code).emit('game_over', { winner: 'hunters', reason: 'Tous les cachés ont été attrapés' });
  }
}

io.on('connection', (socket) => {
  let currentCode = null;

  socket.on('create_room', ({ name }, cb) => {
    const code = makeCode();
    const sessionId = makeSessionId();
    rooms[code] = {
      hostId: socket.id,
      status: 'lobby',
      zone: null,
      revealTimer: null,
      broadcastTimer: null,
      dirty: false,
      nextRevealAt: null,
      players: {
        [socket.id]: { id: socket.id, name: name || 'Hôte', role: null, lat: null, lng: null, lastReveal: null, token: makeToken(), sessionId, connected: true, disconnectTimer: null, outOfZoneSince: null, lastUpdate: null }
      },
      createdAt: Date.now()
    };
    currentCode = code;
    socket.join(code);
    cb({ ok: true, code, playerId: socket.id, sessionId });
    broadcastLobby(rooms[code], code);
  });

  socket.on('join_room', ({ code, name }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: 'Partie introuvable' });
    if (room.status !== 'lobby') return cb({ ok: false, error: 'La partie a déjà commencé' });
    const sessionId = makeSessionId();
    room.players[socket.id] = { id: socket.id, name: name || 'Joueur', role: null, lat: null, lng: null, lastReveal: null, token: makeToken(), sessionId, connected: true, disconnectTimer: null, outOfZoneSince: null, lastUpdate: null };
    currentCode = code;
    socket.join(code);
    cb({ ok: true, code, playerId: socket.id, sessionId });
    broadcastLobby(room, code);
  });

  // Reconnexion apres un refresh / une coupure reseau : on retrouve le joueur
  // via son sessionId (stocke cote client) et on reprend sa place exactement
  // ou il en etait (role, position, token QR, jeu en cours ou lobby).
  socket.on('rejoin_room', ({ code, sessionId }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: 'Partie introuvable' });
    const oldId = Object.keys(room.players).find(id => room.players[id].sessionId === sessionId);
    if (!oldId) return cb({ ok: false, error: 'Session introuvable' });

    const player = room.players[oldId];
    if (player.disconnectTimer) { clearTimeout(player.disconnectTimer); player.disconnectTimer = null; }
    delete room.players[oldId];
    player.id = socket.id;
    player.connected = true;
    room.players[socket.id] = player;
    if (room.hostId === oldId) room.hostId = socket.id;

    currentCode = code;
    socket.join(code);
    cb({ ok: true, code, playerId: socket.id, sessionId, status: room.status, isHost: room.hostId === socket.id });

    if (room.status === 'lobby') broadcastLobby(room, code);
    else broadcastGameViews(room, code);
  });

  // Seul l'hote peut assigner les roles
  socket.on('set_roles', ({ code, mode, assignments }, cb) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return cb && cb({ ok: false, error: 'Non autorisé : seul l’hôte peut faire ça' });
    const ids = Object.keys(room.players);
    if (mode === 'random') {
      const shuffled = [...ids].sort(() => Math.random() - 0.5);
      const hunterCount = Math.max(1, Math.round(shuffled.length * 0.25));
      shuffled.forEach((id, i) => { room.players[id].role = i < hunterCount ? 'hunter' : 'hidden'; });
    } else if (mode === 'manual' && assignments) {
      Object.entries(assignments).forEach(([id, role]) => { if (room.players[id]) room.players[id].role = role; });
    }
    broadcastLobby(room, code);
    cb && cb({ ok: true });
  });

  // Seul l'hote peut lancer la partie
  socket.on('start_game', ({ code, zone, durationMinutes, steps, revealIntervalMinutes, zoneGraceSeconds }, cb) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return cb && cb({ ok: false, error: 'Non autorisé : seul l’hôte peut lancer la partie' });
    const missingRole = Object.values(room.players).some(p => !p.role);
    if (missingRole) return cb && cb({ ok: false, error: 'Tous les joueurs doivent avoir un rôle' });

    room.revealIntervalMs = revealIntervalMinutes ? Math.max(30 * 1000, revealIntervalMinutes * 60 * 1000) : DEFAULT_REVEAL_INTERVAL_MS;
    room.zoneGraceMs = zoneGraceSeconds ? Math.max(3, Math.min(120, zoneGraceSeconds)) * 1000 : DEFAULT_ZONE_GRACE_MS;

    const phases = Math.max(1, Math.min(10, parseInt(steps, 10) || 4));
    const durationMs = durationMinutes * 60 * 1000;
    const radii = [];
    for (let i = 0; i <= phases; i++) {
      radii.push(zone.startRadius + (zone.endRadius - zone.startRadius) * (i / phases));
    }

    room.status = 'playing';
    room.zone = {
      centerLat: zone.centerLat,
      centerLng: zone.centerLng,
      startRadius: zone.startRadius,
      endRadius: zone.endRadius,
      startTime: Date.now(),
      durationMs,
      phases,
      radii,
      phaseDurationMs: durationMs / phases,
      lastPhaseIndex: 0
    };
    room.nextRevealAt = Date.now() + room.revealIntervalMs;

    io.to(code).emit('game_started');
    broadcastGameViews(room, code);
    cb && cb({ ok: true });

    // on ne diffuse l'etat qu'a intervalle regulier (pas a chaque update GPS individuel)
    // pour eviter de saturer le reseau et faire ramer les telephones
    room.broadcastTimer = setInterval(() => {
      if (room.dirty) {
        broadcastGameViews(room, code);
        room.dirty = false;
      }
    }, 1500);

    // verification des limites de zone (alerte + delai de grace + conversion)
    room.zoneCheckTimer = setInterval(() => checkZoneBounds(room, code), 1000);

    room.revealTimer = setInterval(() => {
      Object.values(room.players).forEach(p => {
        if (p.role === 'hidden' && p.lat != null) {
          p.lastReveal = { lat: p.lat, lng: p.lng, time: Date.now() };
        }
      });
      room.nextRevealAt = Date.now() + room.revealIntervalMs;
      io.to(code).emit('reveal_ping');
      broadcastGameViews(room, code);
    }, room.revealIntervalMs);

    setTimeout(() => {
      const r = rooms[code];
      if (r && r.status === 'playing') {
        r.status = 'ended';
        if (r.revealTimer) clearInterval(r.revealTimer);
        if (r.broadcastTimer) clearInterval(r.broadcastTimer);
        if (r.zoneCheckTimer) clearInterval(r.zoneCheckTimer);
        io.to(code).emit('game_over', { winner: 'hidden', reason: 'Le temps est écoulé, des joueurs cachés ont survécu' });
      }
    }, room.zone.durationMs);
  });

  socket.on('update_position', ({ code, lat, lng, accuracy }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    player.lat = lat;
    player.lng = lng;
    player.accuracy = accuracy;
    player.lastUpdate = Date.now();
    if (room.status === 'playing') room.dirty = true;
  });

  // Elimination par QR : le chasseur scanne le code affiche par le cache.
  // La proximite physique est garantie par le fait qu'il faut scanner l'ecran du telephone d'en face.
  socket.on('scan_result', ({ code, targetToken }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: 'Partie introuvable' });
    const scanner = room.players[socket.id];
    if (!scanner || scanner.role !== 'hunter') {
      return cb && cb({ ok: false, error: 'Seul un chasseur peut éliminer' });
    }
    const target = Object.values(room.players).find(p => p.token === targetToken);
    if (!target) return cb && cb({ ok: false, error: 'QR code invalide' });
    if (target.role === 'hunter') return cb && cb({ ok: false, error: 'Ce joueur est déjà chasseur' });

    target.role = 'hunter';
    target.lastReveal = null;
    target.outOfZoneSince = null;
    broadcastGameViews(room, code);
    io.to(code).emit('capture', { name: target.name });
    cb && cb({ ok: true, name: target.name });
    checkWinCondition(room, code);
  });

  socket.on('leave_room', ({ code }) => handleLeave(code, socket));
  socket.on('disconnect', () => { if (currentCode) handleLeave(currentCode, socket); });

  function handleLeave(code, socket) {
    const room = rooms[code];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;

    // on ne supprime pas tout de suite : on laisse une fenetre pour un refresh/reconnexion
    player.connected = false;
    player.disconnectTimer = setTimeout(() => {
      const r = rooms[code];
      if (!r) return;
      delete r.players[socket.id];
      if (Object.keys(r.players).length === 0) {
        if (r.revealTimer) clearInterval(r.revealTimer);
        if (r.broadcastTimer) clearInterval(r.broadcastTimer);
        if (r.zoneCheckTimer) clearInterval(r.zoneCheckTimer);
        delete rooms[code];
        return;
      }
      if (r.hostId === socket.id) r.hostId = Object.keys(r.players)[0];
      if (r.status === 'lobby') broadcastLobby(r, code);
      else broadcastGameViews(r, code);
    }, DISCONNECT_GRACE_MS);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur Cache-Cache IRL sur le port ${PORT}`));
