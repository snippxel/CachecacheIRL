const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Reglages ----
const REVEAL_INTERVAL_MS = 5 * 60 * 1000; // position des cachés révélée toutes les 5 min aux chasseurs

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
    if (!isHunter) {
      // un cache ne voit JAMAIS personne d'autre : ni les chasseurs, ni les autres caches
      return { ...base, lat: null, lng: null, live: false };
    }
    if (p.role === 'hunter') {
      // les coequipiers chasseurs se voient entre eux en temps reel
      return { ...base, lat: p.lat, lng: p.lng, live: true };
    }
    if (p.lastReveal) {
      // cache : uniquement visible pour les chasseurs, via la derniere revelation (5 min)
      return { ...base, lat: p.lastReveal.lat, lng: p.lastReveal.lng, live: false, revealedAt: p.lastReveal.time };
    }
    return { ...base, lat: null, lng: null, live: false };
  });

  return {
    code,
    status: room.status,
    hostId: room.hostId,
    zone: room.zone,
    nextRevealAt: room.nextRevealAt,
    revealIntervalMs: REVEAL_INTERVAL_MS,
    myRole: viewer ? viewer.role : null,
    players
  };
}

function broadcastLobby(room, code) {
  io.to(code).emit('room_update', lobbySnapshot(room, code));
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
    io.to(code).emit('game_over', { winner: 'hunters', reason: 'Tous les cachés ont été attrapés' });
  }
}

io.on('connection', (socket) => {
  let currentCode = null;

  socket.on('create_room', ({ name }, cb) => {
    const code = makeCode();
    rooms[code] = {
      hostId: socket.id,
      status: 'lobby',
      zone: null,
      revealTimer: null,
      broadcastTimer: null,
      dirty: false,
      nextRevealAt: null,
      players: {
        [socket.id]: { id: socket.id, name: name || 'Hôte', role: null, lat: null, lng: null, lastReveal: null, token: makeToken(), lastUpdate: null }
      },
      createdAt: Date.now()
    };
    currentCode = code;
    socket.join(code);
    cb({ ok: true, code, playerId: socket.id });
    broadcastLobby(rooms[code], code);
  });

  socket.on('join_room', ({ code, name }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: 'Partie introuvable' });
    if (room.status !== 'lobby') return cb({ ok: false, error: 'La partie a déjà commencé' });
    room.players[socket.id] = { id: socket.id, name: name || 'Joueur', role: null, lat: null, lng: null, lastReveal: null, token: makeToken(), lastUpdate: null };
    currentCode = code;
    socket.join(code);
    cb({ ok: true, code, playerId: socket.id });
    broadcastLobby(room, code);
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
  socket.on('start_game', ({ code, zone, durationMinutes }, cb) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return cb && cb({ ok: false, error: 'Non autorisé : seul l’hôte peut lancer la partie' });
    const missingRole = Object.values(room.players).some(p => !p.role);
    if (missingRole) return cb && cb({ ok: false, error: 'Tous les joueurs doivent avoir un rôle' });

    room.status = 'playing';
    room.zone = {
      centerLat: zone.centerLat,
      centerLng: zone.centerLng,
      startRadius: zone.startRadius,
      endRadius: zone.endRadius,
      startTime: Date.now(),
      durationMs: durationMinutes * 60 * 1000
    };
    room.nextRevealAt = Date.now() + REVEAL_INTERVAL_MS;

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
    }, 2000);

    room.revealTimer = setInterval(() => {
      Object.values(room.players).forEach(p => {
        if (p.role === 'hidden' && p.lat != null) {
          p.lastReveal = { lat: p.lat, lng: p.lng, time: Date.now() };
        }
      });
      room.nextRevealAt = Date.now() + REVEAL_INTERVAL_MS;
      io.to(code).emit('reveal_ping');
      broadcastGameViews(room, code);
    }, REVEAL_INTERVAL_MS);

    setTimeout(() => {
      const r = rooms[code];
      if (r && r.status === 'playing') {
        r.status = 'ended';
        if (r.revealTimer) clearInterval(r.revealTimer);
        if (r.broadcastTimer) clearInterval(r.broadcastTimer);
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
    delete room.players[socket.id];
    if (Object.keys(room.players).length === 0) {
      if (room.revealTimer) clearInterval(room.revealTimer);
      if (room.broadcastTimer) clearInterval(room.broadcastTimer);
      delete rooms[code];
      return;
    }
    if (room.hostId === socket.id) room.hostId = Object.keys(room.players)[0];
    if (room.status === 'lobby') broadcastLobby(room, code);
    else broadcastGameViews(room, code);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur Cache-Cache IRL sur le port ${PORT}`));
