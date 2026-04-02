// ═══════════════════════════════════════════════════════════════
// ROGUE ARENA — SERVEUR MULTIJOUEUR
// Node.js + ws (WebSocket)
// Démarrage : node server.js
// Déploiement : Railway / Render / Fly.io
// ═══════════════════════════════════════════════════════════════

const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const MATCHMAKING_TIMEOUT = 60_000; // 60s avant IA

// ── Utilitaires ─────────────────────────────────────────────────
const uid = () => crypto.randomBytes(6).toString('hex');
const log = (...a) => console.log(`[${new Date().toISOString().slice(11,19)}]`, ...a);

// ── État global ─────────────────────────────────────────────────
const queues = { '1v1': [], '2v2': [] };  // files matchmaking
const rooms  = new Map();                  // roomId → Room
const players = new Map();                 // ws → Player

// ── Structure Room ───────────────────────────────────────────────
class Room {
  constructor(id, mode) {
    this.id = id;
    this.mode = mode;           // '1v1' | '2v2'
    this.slots = mode === '1v1' ? 2 : 4;
    this.players = [];          // [{ws, pseudo, team, isBot}]
    this.state = 'waiting';     // waiting | pick_ban | playing | finished
    this.gameState = null;      // snapshot de l'état de jeu côté serveur
    this.currentTurn = null;    // playerId dont c'est le tour
    this.botTimer = null;
    this.created = Date.now();
  }

  broadcast(msg, excludeWs = null) {
    const str = JSON.stringify(msg);
    this.players.forEach(p => {
      if (p.ws !== excludeWs && !p.isBot && p.ws.readyState === WebSocket.OPEN)
        p.ws.send(str);
    });
  }

  broadcastAll(msg) { this.broadcast(msg, null); }

  isFull() { return this.players.length >= this.slots; }

  fillWithBots() {
    const needed = this.slots - this.players.length;
    for (let i = 0; i < needed; i++) {
      this.players.push({
        ws: null, pseudo: `IA_${i+1}`, team: this.players.length <= 1 ? 'enemy' : 'enemy',
        isBot: true, sessionId: uid(), slot: this.players.length
      });
    }
    log(`Room ${this.id}: ${needed} bot(s) ajouté(s)`);
  }

  humanCount() { return this.players.filter(p => !p.isBot).length; }
}

// ── Matchmaking ──────────────────────────────────────────────────
function joinQueue(ws, pseudo, sessionId, mode, preferredTeam='player') {
  const queue = queues[mode];
  if (!queue) return send(ws, { type: 'error', msg: 'Mode invalide' });

  // Vérifier si déjà en file
  if (queue.find(p => p.sessionId === sessionId)) {
    return send(ws, { type: 'queue_already' });
  }

  const player = { ws, pseudo, sessionId, mode, preferredTeam, joinedAt: Date.now() };
  queue.push(player);
  players.set(ws, { ...player, room: null });
  log(`Queue ${mode}: +${pseudo} (${queue.length}/${mode === '1v1' ? 2 : 4})`);

  // Notifier TOUS les joueurs en file de la mise à jour
  const required = mode === '1v1' ? 2 : 4;
  queue.forEach((p, idx) => {
    const playerList = queue.map(q => ({ pseudo: q.pseudo, slot: idx }));
    send(p.ws, { type: 'queue_joined', mode, position: idx + 1,
      required, timeout: 60, queuePlayers: queue.map(q => ({ pseudo: q.pseudo })) });
  });

  // Timer 60s → remplir avec bots
  player.botTimer = setTimeout(() => {
    const idx = queue.indexOf(player);
    if (idx === -1) return; // déjà matché
    queue.splice(idx, 1);
    // Créer room avec ce joueur + bots
    const room = new Room(uid(), mode);
    room.players.push({ ws, pseudo, sessionId, team: 'player', isBot: false, slot: 0 });
    room.fillWithBots();
    rooms.set(room.id, room);
    players.get(ws).room = room.id;
    log(`Room ${room.id}: créée avec bots (timeout 60s)`);
    startRoom(room);
  }, MATCHMAKING_TIMEOUT);

  player.botTimerRef = player.botTimer;
  tryMatch(mode);
}

function tryMatch(mode) {
  const queue = queues[mode];
  const required = mode === '1v1' ? 2 : 4;
  if (queue.length < required) return;

  const matched = queue.splice(0, required);
  matched.forEach(p => clearTimeout(p.botTimerRef));

  const room = new Room(uid(), mode);
  matched.forEach((p, i) => {
    // Respecter preferredTeam si possible
    let team;
    if (mode === '1v1') {
      team = i === 0 ? 'player' : 'enemy';
    } else {
      // Tenter de respecter l'équipe préférée
      const teamACnt = room.players.filter(p=>p.team==='player').length;
      const teamBCnt = room.players.filter(p=>p.team==='enemy').length;
      if (p.preferredTeam==='enemy' && teamBCnt < 2) team='enemy';
      else if (p.preferredTeam==='player' && teamACnt < 2) team='player';
      else team = teamACnt <= teamBCnt ? 'player' : 'enemy';
    }
    room.players.push({ ws: p.ws, pseudo: p.pseudo, sessionId: p.sessionId,
      team, isBot: false, slot: i });
    const pd = players.get(p.ws);
    if (pd) pd.room = room.id;
  });

  rooms.set(room.id, room);
  log(`Room ${room.id}: match ${mode} — ${matched.map(p=>p.pseudo).join(' vs ')}`);
  startRoom(room);
}

function startRoom(room) {
  room.state = 'pick_ban';
  const playerList = room.players.map(p => ({
    pseudo: p.pseudo, team: p.team, slot: p.slot, isBot: p.isBot
  }));
  room.broadcastAll({ type: 'match_found', roomId: room.id, mode: room.mode, players: playerList });
}

// ── Gestion des actions de jeu ───────────────────────────────────
function handleGameAction(ws, msg) {
  const pd = players.get(ws);
  if (!pd || !pd.room) return;
  const room = rooms.get(pd.room);
  if (!room) return;

  const sender = room.players.find(p => p.ws === ws);
  if (!sender) return;

  switch(msg.type) {
    case 'launch_now':
      // Host lance la partie maintenant
      if (room.players[0]?.ws === ws && room.state === 'pick_ban') {
        room.players.filter(p=>!p.alive&&!p.isBot).forEach(p=>{
          if(!room.players.some(x=>x.id===p.id)) return;
        });
        // Remplir avec bots et démarrer
        if (!room.isFull()) room.fillWithBots();
        startRoom(room);
        log(`Room ${room.id}: lancée par le host`);
      }
      break;
    case 'pb_action':      // Pick/ban choice
      room.broadcast({ type: 'pb_action', pseudo: sender.pseudo,
        slot: sender.slot, heroId: msg.heroId, action: msg.action }, ws);
      break;

    case 'game_action':    // Move, skill, end_turn
      // Broadcast à tous les autres joueurs
      room.broadcast({
        type: 'game_action',
        pseudo: sender.pseudo,
        slot: sender.slot,
        action: msg.action,  // {type:'move'|'skill'|'end_turn', ...}
      }, ws);
      break;

    case 'game_state_sync': // État complet (envoyé par le joueur host)
      room.gameState = msg.state;
      room.broadcast({ type: 'game_state_sync', state: msg.state }, ws);
      break;

    case 'chat': break; // chat désactivé

    case 'game_over':
      room.state = 'finished';
      room.broadcastAll({ type: 'game_over', winner: msg.winner });
      log(`Room ${room.id}: partie terminée (${msg.winner})`);
      setTimeout(() => rooms.delete(room.id), 30000);
      break;
  }
}

// ── Utilitaire send ──────────────────────────────────────────────
function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(msg));
}

// ── Déconnexion ──────────────────────────────────────────────────
function onDisconnect(ws) {
  const pd = players.get(ws);
  if (!pd) return;

  // Retirer de la file
  ['1v1','2v2'].forEach(mode => {
    const idx = queues[mode].findIndex(p => p.ws === ws);
    if (idx >= 0) {
      clearTimeout(queues[mode][idx].botTimerRef);
      queues[mode].splice(idx, 1);
    }
  });

  // Notifier la room
  if (pd.room) {
    const room = rooms.get(pd.room);
    if (room && room.state !== 'finished') {
      const p = room.players.find(x => x.ws === ws);
      if (p) {
        p.isBot = true; p.ws = null; // remplacer par bot
        room.broadcast({ type: 'player_disconnected', pseudo: pd.pseudo,
          slot: p.slot, replacedByBot: true });
        log(`Room ${room.id}: ${pd.pseudo} déconnecté → remplacé par IA`);
      }
    }
  }

  players.delete(ws);
  log(`Déconnexion: ${pd.pseudo}`);
}

// ── Serveur HTTP + WebSocket ──────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Rogue Arena Server\n');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  log(`Connexion depuis ${ip}`);

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      switch(msg.type) {
        case 'join_queue':
          joinQueue(ws, msg.pseudo?.slice(0,20)||'Joueur', msg.sessionId||uid(), msg.mode||'1v1', msg.preferredTeam||'player');
          break;
        case 'create_session': {
          // Créer un lobby privé avec code à 4 chiffres
          const code = Math.floor(1000 + Math.random() * 9000).toString();
          const room = new Room(code, msg.mode || '1v1');
          room.state = 'waiting';
          room.isPrivate = true;
          room.players.push({ ws, pseudo: msg.pseudo?.slice(0,20)||'Joueur',
            sessionId: msg.sessionId||uid(), team: 'player', isBot: false, slot: 0 });
          rooms.set(code, room);
          players.set(ws, { pseudo: msg.pseudo, sessionId: msg.sessionId, room: code });
          log(`Session privée créée: ${code} par ${msg.pseudo}`);
          send(ws, { type: 'session_created', code, mode: room.mode,
            players: room.players.map(p=>({ pseudo:p.pseudo, slot:p.slot, isBot:p.isBot })) });
          break;
        }
        case 'join_session': {
          const code = msg.code?.trim();
          const room = rooms.get(code);
          if (!room) { send(ws, { type: 'session_error', msg: 'Code introuvable' }); break; }
          if (room.state !== 'waiting') { send(ws, { type: 'session_error', msg: 'Session déjà lancée' }); break; }
          const maxSlots = room.mode === '1v1' ? 2 : 4;
          const humanCount = room.players.filter(p=>!p.isBot).length;
          if (humanCount >= maxSlots) { send(ws, { type: 'session_error', msg: 'Session complète' }); break; }
          const slot = room.players.length;
          const team = room.mode === '1v1' ? 'enemy' : (slot < 2 ? 'player' : 'enemy');
          room.players.push({ ws, pseudo: msg.pseudo?.slice(0,20)||'Joueur',
            sessionId: msg.sessionId||uid(), team, isBot: false, slot });
          players.set(ws, { pseudo: msg.pseudo, sessionId: msg.sessionId, room: code });
          log(`Session ${code}: +${msg.pseudo} (${room.players.length}/${maxSlots})`);
          // Notifier tous les joueurs de la room
          const playerList = room.players.map(p=>({ pseudo:p.pseudo, slot:p.slot, team:p.team, isBot:p.isBot }));
          room.broadcastAll({ type: 'session_updated', code, mode: room.mode, players: playerList });
          send(ws, { type: 'session_joined', code, mode: room.mode, players: playerList });
          break;
        }
        case 'session_launch': {
          // Le chef de groupe lance la session
          const room2 = rooms.get(msg.code);
          if (!room2) break;
          if (room2.players[0]?.ws !== ws) break; // seul le chef peut lancer
          // Remplir avec bots si nécessaire
          if (!room2.isFull()) room2.fillWithBots();
          room2.state = 'pick_ban';
          startRoom(room2);
          log(`Session ${msg.code}: lancée par ${room2.players[0].pseudo}`);
          break;
        }
        case 'leave_queue':
          ['1v1','2v2'].forEach(mode => {
            const idx = queues[mode].findIndex(p => p.ws === ws);
            if (idx >= 0) { clearTimeout(queues[mode][idx].botTimerRef); queues[mode].splice(idx, 1); }
          });
          send(ws, { type: 'queue_left' });
          break;
        case 'ping':
          send(ws, { type: 'pong', ts: Date.now() });
          break;
        case 'launch_now':
          handleGameAction(ws, msg);
          break;
        default:
          handleGameAction(ws, msg);
      }
    } catch(e) { log('Parse error:', e.message); }
  });

  ws.on('close', () => onDisconnect(ws));
  ws.on('error', () => onDisconnect(ws));

  // Keepalive ping
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// Heartbeat pour détecter les connexions mortes
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => {
  log(`Rogue Arena Server démarré sur le port ${PORT}`);
  log(`Connecte-toi sur ws://localhost:${PORT}`);
});

// ── Stats console ────────────────────────────────────────────────
setInterval(() => {
  const roomCount = rooms.size;
  const playerCount = players.size;
  const q1 = queues['1v1'].length;
  const q2 = queues['2v2'].length;
  if (playerCount > 0 || roomCount > 0)
    log(`Stats: ${playerCount} connectés, ${roomCount} rooms, file: ${q1}×1v1 ${q2}×2v2`);
}, 60000);
