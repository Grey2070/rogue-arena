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

// ── Persistance ELO + Pseudos ────────────────────────────────────
const fs = require('fs');
// ══ Registre des pseudos persistants ════════════════════════
// pseudoRegistry: pseudo.toLowerCase() → { pseudo, sessionId, ip, lastSeen }
const pseudoRegistry = new Map();
const PSEUDO_FILE = './pseudo_data.json';

function loadPseudoData() {
  try {
    if (fs.existsSync(PSEUDO_FILE)) {
      const data = JSON.parse(fs.readFileSync(PSEUDO_FILE, 'utf8'));
      Object.entries(data).forEach(([k,v]) => pseudoRegistry.set(k, v));
      log(`Pseudos chargés: ${pseudoRegistry.size}`);
    }
  } catch(e) { log('Pseudo load:', e.message); }
}

function savePseudoData() {
  try {
    fs.writeFileSync(PSEUDO_FILE,
      JSON.stringify(Object.fromEntries(pseudoRegistry)));
  } catch(e) {}
}

// Un joueur peut utiliser un pseudo si :
// 1. Le pseudo n'est jamais enregistré
// 2. C'est son sessionId (même navigateur/appareil)
// 3. C'est son IP (même réseau, navigateur différent)
function canUsePseudo(pseudo, sessionId, ip) {
  const key = pseudo.toLowerCase();

  // Tier 1: Check ACTIVE connections only
  // If an active player (different ws) uses this pseudo with a different sessionId → block
  for (const [, pd] of players.entries()) {
    if (pd.pseudo?.toLowerCase() === key) {
      if (pd.sessionId === sessionId) return true;  // same session = same player
      if (ip && ip !== '0.0.0.0' && pd._ip === ip) return true; // same IP
      return false; // Actively used by someone else
    }
  }

  // Tier 2: No active player using it — check persistent registry
  const entry = pseudoRegistry.get(key);
  if (!entry) return true;
  if (entry.sessionId === sessionId) return true;
  if (ip && ip !== '0.0.0.0' && entry.ip === ip) return true;

  // Not in active use and registry entry doesn't match → allow
  // (player may have changed device/network; don't permanently block)
  return true;
}

function registerPseudo(pseudo, sessionId, ip) {
  const key = pseudo.toLowerCase();
  pseudoRegistry.set(key, { pseudo, sessionId, ip, lastSeen: Date.now() });
  savePseudoData();
}

// Quand un joueur se connecte, mettre à jour son entrée si c'est le sien
function refreshPseudoEntry(pseudo, sessionId, ip) {
  if (!pseudo) return;
  const key = pseudo.toLowerCase();
  const entry = pseudoRegistry.get(key);
  if (!entry || entry.sessionId === sessionId || (ip && entry.ip === ip)) {
    pseudoRegistry.set(key, { pseudo, sessionId, ip, lastSeen: Date.now() });
    savePseudoData();
  }
}



const ELO_FILE = './elo_data.json';

function loadEloData() {
  try {
    if (fs.existsSync(ELO_FILE)) {
      const data = JSON.parse(fs.readFileSync(ELO_FILE, 'utf8'));
      if (data['1v1']) Object.entries(data['1v1']).forEach(([k,v]) => eloMap['1v1'].set(k,v));
      if (data['2v2']) Object.entries(data['2v2']).forEach(([k,v]) => eloMap['2v2'].set(k,v));
      log(`ELO data loaded: ${eloMap['1v1'].size} joueurs 1v1, ${eloMap['2v2'].size} joueurs 2v2`);
    }
  } catch(e) { log('ELO load error:', e.message); }
}

function saveEloData() {
  try {
    const data = {
      '1v1': Object.fromEntries(eloMap['1v1']),
      '2v2': Object.fromEntries(eloMap['2v2'])
    };
    fs.writeFileSync(ELO_FILE, JSON.stringify(data));
  } catch(e) { log('ELO save error:', e.message); }
}

// ── État global ─────────────────────────────────────────────────
const queues  = { '1v1': [], '2v2': [] }; // files matchmaking
const rooms   = new Map();                // roomId → Room
const players = new Map();               // ws → Player
const eloMap  = { '1v1': new Map(), '2v2': new Map() }; // pseudo → elo
const CHAT_HISTORY = [];                 // last 50 messages
const MAX_CHAT = 50;

function getElo(mode, pseudo) { return eloMap[mode]?.get(pseudo) || 1000; }
function setElo(mode, pseudo, val) {
  if (!eloMap[mode]) return;
  eloMap[mode].set(pseudo, Math.max(0, val));
  broadcastLeaderboard(mode);
  saveEloData(); // Persist immediately
}
function broadcastLeaderboard(mode) {
  const entries = [...(eloMap[mode]?.entries()||[])];
  entries.sort((a,b) => b[1]-a[1]);
  const top100 = entries.slice(0,100).map(([pseudo,elo])=>({pseudo,elo}));
  wss.clients.forEach(ws => {
    if (ws.readyState === 1)
      ws.send(JSON.stringify({type:'leaderboard', mode, players: top100}));
  });
}

// ── Structure Room ───────────────────────────────────────────────
class Room {
  constructor(id, mode) {
    this.id = id;
    this.mode = mode;           // '1v1' | '2v2'
    this.slots = mode === '1v1' ? 2 : 4;
    this.players = [];          // [{ws, pseudo, team, isBot}]
    this.state = 'waiting';     // waiting | pick_ban | playing | finished
    this.gameState = null;
    this.currentTurn = null;
    this.botTimer = null;
    this.created = Date.now();
    this.actionLog = [];        // Last 200 game actions for catch-up on reconnect
    this._hadRealOpponent = false; // ELO: was there a real opponent at game start?
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
      const slot = this.players.length;
      this.players.push({
        ws: null,
        pseudo: `IA_${i + 1}`,
        team: (slot === 0 || slot === 2) ? 'player' : 'enemy',
        isBot: true,
        sessionId: uid(),
        slot
      });
    }
    log(`Room ${this.id}: ${needed} bot(s) ajouté(s)`);
  }

  humanCount() { return this.players.filter(p => !p.isBot).length; }
}

// ── Matchmaking ──────────────────────────────────────────────────
function isPseudoInUse(pseudo) {
  // Check if pseudo is used by any connected player
  for (const [ws, pd] of players.entries()) {
    if (pd.pseudo && pd.pseudo.toLowerCase() === pseudo.toLowerCase()) return true;
  }
  return false;
}

// Force a match for all players currently in the queue (with bots filling empty slots)
// Idempotent: first call wins, subsequent calls are no-ops (players already removed)
function forceMatchWithBots(mode) {
  const queue = queues[mode];
  if (queue.length === 0) return; // nobody left

  // Take ALL remaining players in the queue
  const allInQueue = queue.splice(0);
  allInQueue.forEach(p => clearTimeout(p.botTimerRef));
  if (queues._2v2MatchTimer) { clearTimeout(queues._2v2MatchTimer); queues._2v2MatchTimer = null; }

  const room = new Room(uid(), mode);

  if (mode === '1v1') {
    // Only 1 player should be here (other would have been matched already)
    const p = allInQueue[0];
    room.players.push({ws:p.ws, pseudo:p.pseudo, sessionId:p.sessionId,
      team:'player', isBot:false, slot:0, _ip:p._ip||'0.0.0.0'});
  } else {
    // 2v2: assign slots with balance
    const slotOrder = [0, 1, 2, 3];
    const usedSlots = new Set();
    // Honor preferences first
    allInQueue.forEach(p => {
      if (p._slotPref !== undefined && !usedSlots.has(p._slotPref)) {
        usedSlots.add(p._slotPref);
        p._assignedSlot = p._slotPref;
      }
    });
    // Balance remaining
    allInQueue.forEach(p => {
      if (p._assignedSlot === undefined) {
        const teamCounts = {player:0, enemy:0};
        allInQueue.forEach(q => {
          if (q._assignedSlot !== undefined) {
            if (q._assignedSlot===0||q._assignedSlot===2) teamCounts.player++;
            else teamCounts.enemy++;
          }
        });
        const prefer = teamCounts.player > teamCounts.enemy ? 'enemy' : 'player';
        let slot = slotOrder.find(s => !usedSlots.has(s) &&
          ((prefer==='player'&&(s===0||s===2))||(prefer==='enemy'&&(s===1||s===3))));
        if (slot === undefined) slot = slotOrder.find(s => !usedSlots.has(s));
        usedSlots.add(slot);
        p._assignedSlot = slot;
      }
    });
    allInQueue.forEach(p => {
      const slot = p._assignedSlot ?? allInQueue.indexOf(p);
      const team = (slot===0||slot===2)?'player':'enemy';
      room.players.push({ws:p.ws, pseudo:p.pseudo, sessionId:p.sessionId,
        team, isBot:false, slot, _ip:p._ip||'0.0.0.0'});
    });
  }

  room.fillWithBots();
  rooms.set(room.id, room);
  log(`forceMatch ${mode}: room ${room.id} — ${room.players.map(p=>p.pseudo+'['+p.slot+']').join(' ')}`);
  startRoom(room);
}

function joinQueue(ws, pseudo, sessionId, mode, preferredTeam='player') {
  const queue = queues[mode];
  if (!queue) return send(ws, { type: 'error', msg: 'Mode invalide' });

  // Vérifier si déjà en file
  if (queue.find(p => p.sessionId === sessionId)) {
    return send(ws, { type: 'queue_already' });
  }

  const playerIp = ws._ip || '0.0.0.0';
  if (!canUsePseudo(pseudo, sessionId, playerIp)) {
    send(ws, { type: 'pseudo_taken', pseudo });
    return;
  }
  registerPseudo(pseudo, sessionId, playerIp);
  const player = { ws, pseudo, sessionId, mode, preferredTeam, joinedAt: Date.now(), _ip: playerIp };
  queue.push(player);
  players.set(ws, { ...player, room: null });
  log(`Queue ${mode}: +${pseudo} (${queue.length}/${mode === '1v1' ? 2 : 4})`);

  const required = mode === '1v1' ? 2 : 4;
  // First player starts the 60s clock; others sync to remaining time
  const queueStart = queue[0]?.joinedAt || Date.now();
  queue.forEach((p, idx) => {
    const elapsed = Math.floor((Date.now() - queueStart) / 1000);
    const remaining = Math.max(0, 60 - elapsed);
    send(p.ws, { type: 'queue_joined', mode, position: idx + 1,
      required, timeout: remaining,
      queuePlayers: queue.map((q, qi) => ({
        pseudo: q.pseudo,
        slot: q._slotPref ?? qi,
        team: q._slotPref !== undefined ? ((q._slotPref===0||q._slotPref===2)?'player':'enemy') : (qi<2?'player':'enemy')
      })) });
  });

  // Timer 60s → forcer le lancement avec bots pour TOUS les joueurs restants
  player.botTimer = setTimeout(() => {
    if (queue.indexOf(player) === -1) return; // already matched
    forceMatchWithBots(mode);
  }, MATCHMAKING_TIMEOUT);

  player.botTimerRef = player.botTimer;
  tryMatch(mode);
}

function tryMatch(mode) {
  const queue = queues[mode];
  const minRequired = 2; // Both modes need at least 2 players
  if (queue.length < minRequired) return;
  if (mode === '1v1' && queue.length < 2) return;

  // For 2v2: wait a short window for more players (unless 4 already present)
  if (mode === '2v2' && queue.length < 4) {
    // Schedule a delayed match if not enough players yet
    if (!queues._2v2MatchTimer) {
      queues._2v2MatchTimer = setTimeout(() => {
        queues._2v2MatchTimer = null;
        if (queues['2v2'].length >= 2) forceMatchWithBots('2v2');
      }, 30000); // Wait 30s for more players, then force with bots
    }
    return; // Don't match immediately with only 2 players
  }
  if (mode === '2v2') delete queues._2v2MatchTimer;

  // For 2v2: take up to 4, fill rest with bots
  const takeCount = mode === '2v2' ? Math.min(queue.length, 4) : 2;
  const matched = queue.splice(0, takeCount);
  matched.forEach(p => clearTimeout(p.botTimerRef));

  const room = new Room(uid(), mode);

  if (mode === '1v1') {
    // slot 0 = player team, slot 1 = enemy team
    matched.forEach((p, i) => {
      const slot = i;
      const team = i === 0 ? 'player' : 'enemy';
      room.players.push({ws:p.ws, pseudo:p.pseudo, sessionId:p.sessionId,
        team, isBot:false, slot, _ip:p._ip||'0.0.0.0'});
    });
  } else {
    // 2v2: smart team-balanced slot assignment
    const assigned = new Map();
    const usedSlots = new Set();

    // 1. Honor preferences first
    matched.forEach(p => {
      if (p._slotPref !== undefined && !usedSlots.has(p._slotPref)) {
        assigned.set(p.ws, p._slotPref);
        usedSlots.add(p._slotPref);
      }
    });

    // 2. Fill remaining with team balance
    const allSlots = [0, 1, 2, 3];
    matched.forEach(p => {
      if (!assigned.has(p.ws)) {
        const teamCounts = { player: 0, enemy: 0 };
        assigned.forEach(slot => {
          if (slot === 0 || slot === 2) teamCounts.player++;
          else teamCounts.enemy++;
        });
        const preferredTeam = teamCounts.player > teamCounts.enemy ? 'enemy' : 'player';
        let freeSlot = allSlots.find(s =>
          !usedSlots.has(s) &&
          ((preferredTeam === 'player' && (s === 0 || s === 2)) ||
           (preferredTeam === 'enemy'  && (s === 1 || s === 3)))
        );
        if (freeSlot === undefined) freeSlot = allSlots.find(s => !usedSlots.has(s));
        assigned.set(p.ws, freeSlot);
        usedSlots.add(freeSlot);
      }
    });

    matched.forEach(p => {
      const slot = assigned.get(p.ws) ?? matched.indexOf(p);
      const team = (slot === 0 || slot === 2) ? 'player' : 'enemy';
      room.players.push({ws:p.ws, pseudo:p.pseudo, sessionId:p.sessionId,
        team, isBot:false, slot, _ip:p._ip||'0.0.0.0'});
    });
    // Fill remaining slots with bots
    room.fillWithBots();
  }

  rooms.set(room.id, room);
  log(`Match ${mode}: ${room.players.map(p=>p.pseudo).join(' vs ')} (slots: ${room.players.map(p=>p.slot).join(',')})`);
  startRoom(room); // startRoom handles match_found + pd.room update
}


function startRoom(room) {
  room.state   = 'pick_ban';
  room.pbStep  = 0;
  room.pbBans  = {};
  room.pbPicks = {};
  room.pbTimer = null;

  // Update pd.room for ALL players (human + bot slots)
  room.players.forEach(p => {
    if (p.ws) {
      const pd = players.get(p.ws);
      if (pd) { pd.room = room.id; }
      else players.set(p.ws, {pseudo:p.pseudo, sessionId:p.sessionId||'', room:room.id, _ip:p._ip||'0.0.0.0'});
    }
  });

  const playerList = room.players.map(p => ({
    pseudo: p.pseudo, team: p.team, slot: p.slot, isBot: p.isBot
  }));

  // Send match_found individually so each client knows their slot
  room.players.filter(p => p.ws && !p.isBot).forEach(p => {
    send(p.ws, { type: 'match_found', roomId: room.id, mode: room.mode, players: playerList });
  });

  log(`Room ${room.id} (${room.mode}): PB starts in 3s — ${room.players.map(p=>p.pseudo+'['+p.slot+']').join(' ')}`);
  // PB starts after client countdown (3s)
  setTimeout(() => startPBStep(room), 3000);
}

// PB sequence: ban1(player), ban2(enemy), pick1(player), pick2(enemy)
const PB_STEPS = [
  { team: 'player', type: 'ban',  slot: 0 },
  { team: 'enemy',  type: 'ban',  slot: 1 },
  { team: 'player', type: 'pick', slot: 0 },
  { team: 'enemy',  type: 'pick', slot: 1 },
];
const PB_STEPS_2V2 = [
  { team: 'player', type: 'ban',  slot: 0 },  // Joueur 1 ban
  { team: 'enemy',  type: 'ban',  slot: 1 },  // Joueur 2 ban
  { team: 'player', type: 'ban',  slot: 2 },  // Joueur 3 ban (allié)
  { team: 'enemy',  type: 'ban',  slot: 3 },  // Joueur 4 ban (ennemi)
  { team: 'player', type: 'pick', slot: 0 },  // Joueur 1 pick
  { team: 'enemy',  type: 'pick', slot: 1 },  // Joueur 2 pick
  { team: 'player', type: 'pick', slot: 2 },  // Joueur 3 pick
  { team: 'enemy',  type: 'pick', slot: 3 },  // Joueur 4 pick
];

function startPBStep(room) {
  if (room.state !== 'pick_ban') return;
  const steps = room.mode === '2v2' ? PB_STEPS_2V2 : PB_STEPS;
  if (room.pbStep >= steps.length) {
    // All picks done — start game
    room.state = 'playing';
    // picks[slot] = heroId
    const picks = room.pbPicks;  // {0: heroId, 1: heroId, ...}
    const bans  = room.pbBans;
    const mapSeed = Math.floor(Math.random() * 2147483647);
    // Mark that this game had real opponents (for ELO on disconnect)
    room._hadRealOpponent = hasRealOpponent(room);
    room.broadcastAll({
      type: 'game_start',
      picks,
      bans,
      mapSeed,
      roomId: room.id,
      mode: room.mode,
      players: room.players.map(p=>({ pseudo:p.pseudo, team:p.team, slot:p.slot, isBot:p.isBot }))
    });
    log(`Room ${room.id}: game started picks=${JSON.stringify(room.pbPicks)}`);
    return;
  }
  const step = steps[room.pbStep];
  // Send as objects keyed by slot for correct client mapping
  const banned = room.pbBans;
  const picked = room.pbPicks;
  const curSlot = step.slot ?? (step.team === 'player' ? 0 : 1);
  // Find pseudo of player whose turn it is
  const turnPlayer = getPlayerBySlot(room, curSlot);
  const turnPseudo = turnPlayer
    ? (turnPlayer.isBot ? `IA (${step.type==='ban'?'Ban':'Pick'})` : turnPlayer.pseudo)
    : step.team;
  room.broadcastAll({
    type: 'pb_turn',
    step: room.pbStep,
    team: step.team,
    stepType: step.type,
    slot: curSlot,
    pseudo: turnPseudo,
    bans: banned, picks: picked,
    timeLeft: 15,
    total: steps.length
  });
  // Auto-pick for bots or AFK
  const currentPlayer = getPlayerBySlot(room, curSlot);
  if (!currentPlayer || currentPlayer.isBot) {
    setTimeout(() => autoPickBot(room, step), 1000);
  } else {
    // Human: auto-pick after 15s AFK
    if (room.pbTimer) clearTimeout(room.pbTimer);
    room.pbTimer = setTimeout(() => autoPickBot(room, step), 15000);
  }
}

function getPlayerBySlot(room, slot) {
  return room.players.find(p => p.slot === slot);
}

function autoPickBot(room, step) {
  if (!room || room.state !== 'pick_ban') return;
  const steps = room.mode === '2v2' ? PB_STEPS_2V2 : PB_STEPS;
  const currentStep = steps[room.pbStep];
  if (!currentStep || currentStep.team !== step.team || currentStep.type !== step.type) return;
  // Send as objects keyed by slot for correct client mapping
  const banned = room.pbBans;
  const picked = room.pbPicks;
  const used = [
    ...Object.values(banned),
    ...Object.values(picked)
  ].filter(Boolean);
  const allHeroes = ['pyro','cryo','rogue','paladin','archer','necro','storm','shaman',
    'shadow','berserker','adventurer','smuggler','dragonmaster','runesmith','enchanter',
    'ninja','samurai','dryad','monk','alchemist','golem','ondelame'];
  const avail = allHeroes.filter(h => !used.includes(h));
  const pick  = avail[Math.floor(Math.random() * avail.length)];
  const slot = step.slot ?? (step.team === 'player' ? 0 : 1);
  applyPBChoice(room, slot, step.type, pick);
}

function applyPBChoice(room, slot, type, heroId) {
  if (room.state !== 'pick_ban') return;
  if (type === 'ban')  room.pbBans[slot]  = heroId;
  else                 room.pbPicks[slot] = heroId;
  const steps = room.mode === '2v2' ? PB_STEPS_2V2 : PB_STEPS;
  const curStep = steps[room.pbStep];
  room.broadcastAll({ type: 'pb_choice',
    team: curStep.team, slot, stepType: type, heroId,
    bans:  room.pbBans,    // object keyed by slot: {0:'ninja', 1:'shaman', ...}
    picks: room.pbPicks    // object keyed by slot: {0:'ninja', 1:'shaman', ...}
  });
  room.pbStep++;
  if (room.pbTimer) { clearTimeout(room.pbTimer); room.pbTimer = null; }
  setTimeout(() => startPBStep(room), 500);
}

// ── Gestion des actions de jeu ───────────────────────────────────
function hasRealOpponent(room) {
  const teams = { player: 0, enemy: 0 };
  room.players.forEach(p => { if (!p.isBot) teams[p.team]++; });
  return teams.player > 0 && teams.enemy > 0;
}

function handleGameAction(ws, msg) {
  const pd = players.get(ws);
  if (!pd || !pd.room) return;
  const room = rooms.get(pd.room);
  if (!room) return;

  const sender = room.players.find(p => p.ws === ws);
  if (!sender) return;

  switch(msg.type) {
    case 'launch_now': {
      const pd2 = players.get(ws);
      let launchRoom = pd2?.room ? rooms.get(pd2.room) : null;

      if (!launchRoom) {
        // Find in queue and create room immediately
        for (const mode2 of ['1v1','2v2']) {
          const qi = queues[mode2].findIndex(p => p.ws === ws);
          if (qi < 0) continue;
          const qp = queues[mode2].splice(qi, 1)[0];
          clearTimeout(qp.botTimerRef);
          const nr = new Room(uid(), mode2);
          if (mode2 === '1v1') {
            nr.players.push({ws, pseudo:qp.pseudo, sessionId:qp.sessionId,
              team:'player', isBot:false, slot:0, _ip:ws._ip||'0.0.0.0'});
            nr.players.push({ws:null, pseudo:'IA_1', team:'enemy',
              isBot:true, sessionId:uid(), slot:1});
          } else {
            nr.players.push({ws, pseudo:qp.pseudo, sessionId:qp.sessionId,
              team:'player', isBot:false, slot:0, _ip:ws._ip||'0.0.0.0'});
            nr.players.push({ws:null, pseudo:'IA_ally', team:'player',
              isBot:true, sessionId:uid(), slot:2});
            nr.players.push({ws:null, pseudo:'IA_enemy1', team:'enemy',
              isBot:true, sessionId:uid(), slot:1});
            nr.players.push({ws:null, pseudo:'IA_enemy2', team:'enemy',
              isBot:true, sessionId:uid(), slot:3});
          }
          rooms.set(nr.id, nr);
          if (pd2) pd2.room = nr.id;
          else players.set(ws, {pseudo:qp.pseudo,sessionId:qp.sessionId,room:nr.id,_ip:ws._ip||'0.0.0.0'});
          // Send match_found so client knows the room
          startRoom(nr); // startRoom sets state=pick_ban and updates pd.room
          // Send match_found then pb_turn with delay
          const nrPlayers = nr.players.map(p=>({pseudo:p.pseudo,team:p.team,slot:p.slot,isBot:p.isBot}));
          send(ws, {type:'match_found', roomId:nr.id, mode:mode2, players:nrPlayers});
          // pb_turn will be sent by startRoom → startPBStep (already queued)
          log(`Room ${nr.id}: lancée depuis la file par ${qp.pseudo}`);
          launchRoom = nr;
          break;
        }
      }

      if (launchRoom) {
        if (launchRoom.state === 'waiting') {
          // Not started yet: fill bots and start
          if (!launchRoom.isFull()) launchRoom.fillWithBots();
          startRoom(launchRoom);
          log(`Room ${launchRoom.id}: lancée manuellement`);
        } else if (launchRoom.state === 'pick_ban') {
          // Already in PB: re-notify player and re-send current PB turn
          const lrPlayers = launchRoom.players.map(p=>({pseudo:p.pseudo,team:p.team,slot:p.slot,isBot:p.isBot}));
          send(ws, {type:'match_found', roomId:launchRoom.id, mode:launchRoom.mode, players:lrPlayers});
          setTimeout(() => startPBStep(launchRoom), 500);
          log(`Room ${launchRoom.id}: PB re-notifié à ${pd2?.pseudo}`);
        }
        // If playing/finished: nothing to do
      }
      break;
    }
    case 'slot_preference': {
      // Player expresses preference for a slot before match starts
      const prefSlot = msg.slot;
      const pd_pref = players.get(ws);
      if (pd_pref) {
        pd_pref._slotPref = prefSlot;
        pd_pref._teamPref = (prefSlot===0||prefSlot===2) ? 'player' : 'enemy';
      }
      // If in queue, update the display slot
      ['1v1','2v2'].forEach(m2 => {
        const qi = queues[m2].findIndex(p => p.ws === ws);
        if (qi >= 0) queues[m2][qi]._slotPref = prefSlot;
      });
      break;
    }
    case 'slot_choice': {
      // Player chose their slot/team for 2v2
      const newSlot = msg.slot;
      if (newSlot === undefined || newSlot === null) break;
      // Check slot not taken by someone else
      const alreadyTaken = room.players.find(p => p.slot === newSlot && p.ws !== ws && !p.isBot);
      if (alreadyTaken) { send(ws, {type:'slot_error', msg:'Slot déjà pris'}); break; }
      // Update this player's slot and team
      const sp2 = room.players.find(p => p.ws === ws);
      if (sp2) {
        sp2.slot = newSlot;
        sp2.team = (newSlot === 0 || newSlot === 2) ? 'player' : 'enemy';
      }
      // Broadcast updated player list to all
      room.broadcastAll({ type: 'slot_updated',
        players: room.players.map(p=>({pseudo:p.pseudo,team:p.team,slot:p.slot,isBot:p.isBot})) });
      break;
    }
    case 'pb_action': {
      // Validate it's this player's turn
      const steps2 = room.mode === '2v2' ? PB_STEPS_2V2 : PB_STEPS;
      const curStep = steps2[room.pbStep];
      if (!curStep || !msg.heroId) break;
      // Validate by SLOT (not team) — slot determines whose turn it is
      const senderIsCorrect = (curStep.slot !== undefined)
        ? sender.slot === curStep.slot
        : sender.team === curStep.team;
      if (!senderIsCorrect) { send(ws, { type:'pb_error', msg:'Pas ton tour!' }); break; }
      // Check hero not already taken (use all slot values)
      const allBanned = Object.values(room.pbBans).filter(Boolean);
      const allPicked = Object.values(room.pbPicks).filter(Boolean);
      if ([...allBanned,...allPicked].includes(msg.heroId)) {
        send(ws, { type:'pb_error', msg:'Héros déjà pris' }); break;
      }
      applyPBChoice(room, sender.slot, curStep.type, msg.heroId);
      break;
    }

    case 'game_action': {
      // Log action for catch-up (keep last 200)
      if (msg.action) {
        room.actionLog.push({ ...msg.action, ts: Date.now(), senderSlot: sender.slot });
        if (room.actionLog.length > 200) room.actionLog.shift();
      }
      const isEndTurn = msg.action?.type === 'end_turn';
      if (isEndTurn) {
        room.broadcastAll({
          type: 'game_action',
          pseudo: sender.pseudo,
          slot: sender.slot,
          action: msg.action,
        });
      } else {
        room.broadcast({
          type: 'game_action',
          pseudo: sender.pseudo,
          slot: sender.slot,
          action: msg.action,
        }, ws);
      }
      // Reset turn timeout when player acts
      if (msg.action?.type === 'end_turn') {
        if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
        room.turnStartedAt = Date.now();
        room.turnDuration  = 30; // seconds
        // Broadcast turn start with sync timestamp
        room._serverTurnIdx = (room._serverTurnIdx || 0) + 1;
        room.broadcastAll({ type: 'turn_sync', timeLeft: room.turnDuration, ts: Date.now(), turnIdx: room._serverTurnIdx });
        // Timeout if player AFK
        room.turnTimer = setTimeout(() => {
          if (room.state !== 'playing') return;
          log(`Room ${room.id}: turn timeout`);
          room.broadcastAll({ type: 'turn_timeout' });
        }, room.turnDuration * 1000 + 2000); // +2s buffer
      }
      break;
    }

    case 'game_state_sync': // État complet (envoyé par le joueur host)
      room.gameState = msg.state;
      room.broadcast({ type: 'game_state_sync', state: msg.state }, ws);
      break;

    case 'chat': break; // chat in-game désactivé

    case 'skin_choice': {
      // Relay skin choice to all players in room
      if (room) {
        room.broadcastAll({
          type: 'skin_choice',
          slot: msg.slot,
          skin: msg.skin
        });
      }
      break;
    }

    case 'request_sync': {
      // Client requests full action log to recover from freeze
      if (!room || room.state !== 'playing') break;
      const since = msg.since || 0; // timestamp of last action client received
      const missed = room.actionLog.filter(a => a.ts > since);
      send(ws, {
        type: 'sync_catch_up',
        actions: missed,
        turnIdx: room._serverTurnIdx || 0,
        ts: Date.now()
      });
      log(`Sync: sent ${missed.length} missed actions to ${sender.pseudo}`);
      break;
    }

    case 'game_over':
      // Deduplicate + only update ELO if there's a real opponent
      if (room._eloUpdated) { break; }
      if (!room._hadRealOpponent && !hasRealOpponent(room)) {
        log(`Room ${room.id}: no real opponent (disconnected) — ELO skipped`);
        room.state = 'finished';
        room.broadcastAll({ type: 'game_over', winner: msg.winner });
        room.actionLog = []; // Free memory
      setTimeout(() => rooms.delete(room.id), 30000);
        break;
      }
      room._eloUpdated = true;
      room.state = 'finished';
      room.broadcastAll({ type: 'game_over', winner: msg.winner });
      log(`Room ${room.id}: game over → winner: ${msg.winner}`);
      // Update ELO for all human players exactly once
      room.players.filter(p => !p.isBot && p.pseudo).forEach(p => {
        const won = p.team === msg.winner;
        const cur = getElo(room.mode, p.pseudo);
        const delta = won ? 25 : -20;
        log(`ELO ${room.mode}: ${p.pseudo} ${cur} → ${cur+delta} (${won?'+25':'-20'})`);
        setElo(room.mode, p.pseudo, cur + delta);
      });
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

  // Keep pseudo registered (tied to sessionId+IP) even after disconnect
  if (pd.pseudo && pd.sessionId) {
    refreshPseudoEntry(pd.pseudo, pd.sessionId, pd._ip || '0.0.0.0');
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
  ws._ip = ip; // Store IP on socket for pseudo checks
  setTimeout(() => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({type:'chat_history', messages: CHAT_HISTORY}));
      ['1v1','2v2'].forEach(mode => {
        const entries = [...(eloMap[mode]?.entries()||[])];
        entries.sort((a,b) => b[1]-a[1]);
        ws.send(JSON.stringify({type:'leaderboard', mode, players: entries.slice(0,100).map(([pseudo,elo])=>({pseudo,elo}))}));
      });
    }
  }, 200);

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      switch(msg.type) {
        case 'join_queue':
          joinQueue(ws, msg.pseudo?.slice(0,20)||'Joueur', msg.sessionId||uid(), msg.mode||'1v1', msg.preferredTeam||'player');
          break;
        case 'create_session': {
          // Créer un lobby privé avec code à 4 chiffres
          const code = (msg.code && /^[0-9]{4}$/.test(msg.code)) ? msg.code : Math.floor(1000 + Math.random() * 9000).toString();
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
        case 'global_chat': {
          const chatMsg2 = String(msg.text||'').slice(0,120).trim();
          const chatPseudo = (msg.pseudo?.slice(0,20)||players.get(ws)?.pseudo||'').trim();
          if (!chatMsg2 || chatPseudo.length < 2) break;
          // Register/refresh pseudo for this connection
          const chatSid = players.get(ws)?.sessionId || msg.sessionId || '';
          const chatIp  = ws._ip || '0.0.0.0';
          if (canUsePseudo(chatPseudo, chatSid, chatIp)) {
            refreshPseudoEntry(chatPseudo, chatSid, chatIp);
            const pd = players.get(ws);
            if (pd) pd.pseudo = chatPseudo;
            else players.set(ws, {pseudo:chatPseudo, sessionId:chatSid, room:null, _ip:chatIp});
          }
          const entry2 = { pseudo: chatPseudo, text: chatMsg2, ts: Date.now() };
          CHAT_HISTORY.push(entry2);
          while (CHAT_HISTORY.length > MAX_CHAT) CHAT_HISTORY.shift();
          const chatBcast = JSON.stringify({type:'global_chat', ...entry2});
          wss.clients.forEach(w2 => { if (w2.readyState === WebSocket.OPEN) w2.send(chatBcast); });
          // Register player if not known
          if (!players.has(ws)) players.set(ws, {pseudo:chatPseudo, sessionId:uid(), room:null});
          else if (players.get(ws)) players.get(ws).pseudo = chatPseudo;
          break;
        }
        case 'set_pseudo': {
          const newPseudo = String(msg.pseudo||'').slice(0,20).trim();
          if (!newPseudo) break;
          // Check if taken by another connection
          const pd3 = players.get(ws);
          const sid3 = msg.sessionId || pd3?.sessionId || '';
          const ip3  = ws._ip || '0.0.0.0';
          if (!canUsePseudo(newPseudo, sid3, ip3)) {
            send(ws, {type:'pseudo_taken', pseudo: newPseudo});
          } else {
            registerPseudo(newPseudo, sid3, ip3);
            if (pd3) { pd3.pseudo = newPseudo; pd3.sessionId = sid3; pd3._ip = ip3; }
            else players.set(ws, {pseudo:newPseudo, sessionId:sid3, room:null, _ip:ip3});
            send(ws, {type:'pseudo_ok', pseudo: newPseudo});
          }
          break;
        }
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
  loadEloData();
  loadPseudoData();
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
