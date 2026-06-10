const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

// ── Constants ──────────────────────────────────────────────────────
const TICK_RATE   = 60;
const WORLD_W     = 1100;
const WORLD_H     = 500;
const GROUND_Y    = 400;      // y of the ground surface
const PLAYER_X    = 120;      // fixed x for all players
const PLAYER_W    = 44;
const PLAYER_H    = 54;
const GRAVITY     = 0.7;
const JUMP_FORCE  = 16;
const SPEED_START = 5.5;
const SPEED_MAX   = 20;
const SPEED_INC   = 0.0009;

const COLORS = [
  '#FF6B6B','#4ECDC4','#FFD93D','#6BCB77',
  '#FF9671','#845EC2','#4FC3F7','#FF6FD8',
  '#A8E6CF','#FFB347',
];

// ── Rooms ──────────────────────────────────────────────────────────
const rooms = {};   // code -> room

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length:5}, () => chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while (rooms[code]);
  return code;
}

function makeRoom(hostSocket) {
  const code = makeCode();
  rooms[code] = {
    code,
    hostId:    hostSocket.id,
    phase:     'lobby',   // lobby | countdown | playing | roundover
    players:   {},
    obstacles: [],
    speed:     SPEED_START,
    score:     0,
    tick:      0,
    nextObs:   90,
    countdown: 0,
    winner:    null,
    obsId:     0,
    _endPending: false,
  };
  return rooms[code];
}

function deleteRoom(code) {
  delete rooms[code];
}

// ── Obstacle helpers ───────────────────────────────────────────────
function spawnObs(room) {
  const r = Math.random();
  let w, h;
  if      (r < 0.45) { w = 28+Math.random()*8;  h = 44+Math.random()*28; }  // tall
  else if (r < 0.75) { w = 52+Math.random()*16; h = 26+Math.random()*14; }  // wide low
  else               { w = 22+Math.random()*6;  h = 68+Math.random()*18; }  // spike

  room.obstacles.push({ id: room.obsId++, x: WORLD_W + 30, w: Math.round(w), h: Math.round(h) });

  // occasional double obstacle
  if (Math.random() < 0.28 && room.speed > 7) {
    const e = spawnExtra();
    room.obstacles.push({ id: room.obsId++, x: WORLD_W + 30 + w + 16 + Math.random()*22, ...e });
  }
}
function spawnExtra() {
  return { w: Math.round(24+Math.random()*12), h: Math.round(36+Math.random()*24) };
}

// ── Phase helper (always use this to change phase) ─────────────────
function setPhase(room, phase) {
  room.phase = phase;
  io.to(room.code).emit('phaseChange', phase);
}

// ── Game logic ─────────────────────────────────────────────────────
function startCountdown(room) {
  setPhase(room, 'countdown');
  room.countdown = 3;

  // reset players
  Object.values(room.players).forEach(p => {
    p.jumpH = 0; p.jumpV = 0; p.grounded = true; p.alive = true;
    p.deadVX = 0; p.deadVY = 0; p.deadY = 0;
  });
  room.obstacles = [];
  room.speed  = SPEED_START;
  room.score  = 0;
  room.tick   = 0;
  room.nextObs = 90;
  room.winner      = null;
  room._endPending = false;

  const iv = setInterval(() => {
    room.countdown--;
    if (room.countdown <= 0) {
      clearInterval(iv);
      setPhase(room, 'playing');
    }
  }, 1000);
}

function endRound(room) {
  const alive = Object.values(room.players).filter(p => p.alive);
  room.winner = alive.length === 1 ? alive[0].name
              : alive.length  > 1 ? 'Everyone survived!'
              : 'Nobody survived';
  setPhase(room, 'roundover');
  setTimeout(() => {
    if (!rooms[room.code]) return;
    room.obstacles = [];
    Object.values(room.players).forEach(p => { p.alive = true; });
    // keep room.winner so lobby can show "last round" banner
    setPhase(room, 'lobby');
  }, 6000);
}

function updateRoom(room) {
  room.tick++;
  room.score++;
  room.speed = Math.min(SPEED_MAX, SPEED_START + room.tick * SPEED_INC);

  // move obstacles
  for (const o of room.obstacles) o.x -= room.speed;
  room.obstacles = room.obstacles.filter(o => o.x + o.w > -30);

  // spawn
  room.nextObs--;
  if (room.nextObs <= 0) {
    const gap = Math.max(38, 85 - room.speed * 3.5);
    room.nextObs = Math.floor(gap + Math.random() * 35);
    spawnObs(room);
  }

  const players = Object.values(room.players);

  for (const p of players) {
    if (!p.alive) {
      // dead players: fly off screen
      p.deadVY += GRAVITY * 0.9;
      p.deadY  += p.deadVY;
      continue;
    }
    // vertical physics
    p.jumpV -= GRAVITY;
    p.jumpH += p.jumpV;
    if (p.jumpH <= 0) { p.jumpH = 0; p.jumpV = 0; p.grounded = true; }
    else p.grounded = false;

    // collision
    for (const o of room.obstacles) {
      const hit = o.x < PLAYER_X + PLAYER_W - 6
               && o.x + o.w > PLAYER_X + 6
               && p.jumpH < o.h;
      if (hit) {
        p.alive  = false;
        p.deadVY = -8;
        p.deadVX =  4 + Math.random() * 3;
        p.deadY  = 0;
        break;
      }
    }
  }

  // win check
  const alive = players.filter(p => p.alive);
  if (!room._endPending) {
    const total = players.length;
    if (total >= 2 && alive.length <= 1) {
      room._endPending = true;
      setTimeout(() => { if (rooms[room.code]) endRound(room); }, 1200);
    } else if (total === 1 && alive.length === 0) {
      room._endPending = true;
      setTimeout(() => { if (rooms[room.code]) endRound(room); }, 800);
    }
  }
}

// ── Global game loop ───────────────────────────────────────────────
setInterval(() => {
  for (const room of Object.values(rooms)) {
    if (room.phase === 'playing') updateRoom(room);

    // broadcast
    const snap = {
      code:      room.code,
      phase:     room.phase,
      hostId:    room.hostId,
      countdown: room.countdown,
      score:     room.score,
      speed:     Math.round(room.speed * 10) / 10,
      winner:    room.winner,
      obstacles: room.obstacles.map(o => ({
        id: o.id, x: Math.round(o.x), w: o.w, h: o.h,
      })),
      players: Object.values(room.players).map(p => ({
        id:       p.id,
        name:     p.name,
        color:    p.color,
        jumpH:    Math.round(p.jumpH * 10) / 10,
        grounded: p.grounded,
        alive:    p.alive,
        deadVX:   p.deadVX,
        deadVY:   Math.round(p.deadVY * 10) / 10,
        deadY:    Math.round(p.deadY  * 10) / 10,
        isHost:   p.id === room.hostId,
      })),
    };
    io.to(room.code).emit('gs', snap);
  }
}, 1000 / TICK_RATE);

// ── Socket events ──────────────────────────────────────────────────
let colorIdx = 0;

io.on('connection', socket => {
  let currentRoom = null;   // ref to room player is in

  function joinRoom(room, name) {
    currentRoom = room;
    socket.join(room.code);
    room.players[socket.id] = {
      id:       socket.id,
      name:     name || `Player ${Object.keys(room.players).length + 1}`,
      color:    COLORS[colorIdx++ % COLORS.length],
      jumpH:    0, jumpV: 0, grounded: true, alive: true,
      deadVX: 0, deadVY: 0, deadY: 0,
    };
    socket.emit('joined', { code: room.code, playerId: socket.id, phase: room.phase });
    console.log(`${room.players[socket.id].name} → room ${room.code}  (${Object.keys(room.players).length} players)`);
  }

  // Create lobby
  socket.on('createLobby', ({ name } = {}) => {
    const room = makeRoom(socket);
    joinRoom(room, name);
  });

  // Join lobby by code
  socket.on('joinLobby', ({ code, name } = {}) => {
    const room = rooms[code?.toUpperCase().trim()];
    if (!room) { socket.emit('joinError', 'Room not found. Check the code!'); return; }
    if (room.phase !== 'lobby') { socket.emit('joinError', 'That game already started!'); return; }
    joinRoom(room, name);
  });

  // Set name
  socket.on('setName', name => {
    if (!currentRoom) return;
    const p = currentRoom.players[socket.id];
    if (p && typeof name === 'string') p.name = name.trim().slice(0, 16) || p.name;
  });

  // Jump
  socket.on('jump', () => {
    if (!currentRoom) return;
    const p = currentRoom.players[socket.id];
    if (p && p.alive && p.grounded && currentRoom.phase === 'playing') {
      p.jumpV    = JUMP_FORCE;
      p.grounded = false;
    }
  });

  // Start game (host only)
  socket.on('startGame', () => {
    if (!currentRoom) return;
    if (socket.id === currentRoom.hostId && currentRoom.phase === 'lobby') {
      startCountdown(currentRoom);
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (!currentRoom) return;
    delete currentRoom.players[socket.id];

    // reassign host if needed
    if (currentRoom.hostId === socket.id) {
      const ids = Object.keys(currentRoom.players);
      currentRoom.hostId = ids[0] || null;
      if (currentRoom.hostId) currentRoom.players[currentRoom.hostId].isHost = true;
    }

    // empty room → delete
    if (Object.keys(currentRoom.players).length === 0) {
      console.log(`Room ${currentRoom.code} empty — deleted`);
      deleteRoom(currentRoom.code);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () =>
  console.log(`🎮  JUMP! → http://localhost:${PORT}`)
);
