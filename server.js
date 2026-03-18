const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ── ROOM STORAGE ──
// rooms[code] = { code, game, host, players, state, quizData }
const rooms = {};

function makeCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function cleanRooms() {
  const now = Date.now();
  for (const code in rooms) {
    if (now - rooms[code].createdAt > 1000 * 60 * 60 * 6) { // 6h TTL
      delete rooms[code];
    }
  }
}
setInterval(cleanRooms, 1000 * 60 * 30);

// ── HTTP ENDPOINTS ──
app.get('/health', (_, res) => res.json({ ok: true, rooms: Object.keys(rooms).length }));

// ── SOCKET.IO ──
io.on('connection', (socket) => {
  console.log('connect', socket.id);

  // ════ CREATE ROOM ════
  socket.on('create_room', ({ game, playerName, quizData }) => {
    let code;
    do { code = makeCode(); } while (rooms[code]);

    rooms[code] = {
      code, game,
      host: socket.id,
      players: [{ id: socket.id, name: playerName, ready: false }],
      state: 'lobby',   // lobby | playing | ended
      quizData: quizData || null,
      gameState: null,
      createdAt: Date.now()
    };

    socket.join(code);
    socket.emit('room_created', { code, room: sanitizeRoom(rooms[code]) });
    console.log(`Room ${code} created for ${game} by ${playerName}`);
  });

  // ════ JOIN ROOM ════
  socket.on('join_room', ({ code, playerName }) => {
    const room = rooms[code];
    if (!room) { socket.emit('error', { msg: 'Raum nicht gefunden!' }); return; }
    if (room.state !== 'lobby') { socket.emit('error', { msg: 'Spiel läuft bereits!' }); return; }
    if (room.players.length >= 10) { socket.emit('error', { msg: 'Raum voll!' }); return; }

    // Prevent duplicate names
    const nameExists = room.players.some(p => p.name === playerName);
    const finalName = nameExists ? playerName + '_' + Math.floor(Math.random()*99) : playerName;

    room.players.push({ id: socket.id, name: finalName, ready: false });
    socket.join(code);

    socket.emit('room_joined', { code, room: sanitizeRoom(room), yourName: finalName });
    io.to(code).emit('player_joined', { room: sanitizeRoom(room), newPlayer: finalName });
    console.log(`${finalName} joined ${code}`);
  });

  // ════ PLAYER READY ════
  socket.on('player_ready', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.ready = true;
    io.to(code).emit('room_update', { room: sanitizeRoom(room) });
  });

  // ════ START GAME (host only) ════
  socket.on('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.state = 'playing';
    io.to(code).emit('game_started', { room: sanitizeRoom(room), quizData: room.quizData });
    console.log(`Game started in ${code}`);
  });

  // ════ GENERIC GAME ACTION ════
  // Each game sends actions, server broadcasts to all in room
  // Actions are game-specific — server just relays them
  socket.on('game_action', ({ code, action, payload }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    // Store latest game state for late joiners
    if (action === 'state_sync') {
      room.gameState = payload;
    }

    io.to(code).emit('game_action', {
      action,
      payload,
      from: player.name,
      fromId: socket.id
    });
  });

  // ════ HOST SYNC (push full state to all) ════
  socket.on('host_sync', ({ code, gameState }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.gameState = gameState;
    socket.to(code).emit('host_sync', { gameState });
  });

  // ════ CHAT / REACTION ════
  socket.on('reaction', ({ code, emoji }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    io.to(code).emit('reaction', { name: player.name, emoji });
  });

  // ════ END GAME ════
  socket.on('end_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.state = 'ended';
    io.to(code).emit('game_ended', { room: sanitizeRoom(room) });
  });

  // ════ DISCONNECT ════
  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx === -1) continue;

      const name = room.players[idx].name;
      room.players.splice(idx, 1);

      if (room.host === socket.id) {
        // Host left — promote next player or close room
        if (room.players.length > 0) {
          room.host = room.players[0].id;
          io.to(code).emit('host_changed', { newHost: room.players[0].name });
        } else {
          delete rooms[code];
          break;
        }
      }

      io.to(code).emit('player_left', { name, room: sanitizeRoom(room) });
      console.log(`${name} left ${code}`);
      break;
    }
    console.log('disconnect', socket.id);
  });
});

function sanitizeRoom(room) {
  return {
    code: room.code,
    game: room.game,
    state: room.state,
    players: room.players.map(p => ({ name: p.name, ready: p.ready, isHost: p.id === room.host })),
    hostName: room.players.find(p => p.id === room.host)?.name || ''
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Quiz server running on port ${PORT}`));
