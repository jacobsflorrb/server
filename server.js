/* ============================================================
 * 四国争霸 - 联机服务器 v2.2
 * ============================================================ */

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const MAP_SIZE = 10;
const ACTION_TIME = 20;
const RECRUIT_TIME = 10;
const CITY_COST = 10;
const START_FOOD = 5;
const BROADCAST_INTERVAL = 150;

const TROOP_SPEED = { infantry: 10000, cavalry: 5000, lightCav: 2500 };
const TROOP_POWER = { infantry: 1, cavalry: 1, lightCav: 1 };
const TROOP_ORDER = ['infantry', 'cavalry', 'lightCav'];
const TROOP_COST = { infantry: 1, cavalry: 2, lightCav: 3 };

function initMap() {
  const map = [];
  for (let y = 0; y < MAP_SIZE; y++) {
    map[y] = [];
    for (let x = 0; x < MAP_SIZE; x++) {
      map[y][x] = {
        x, y, owner: null, type: 'empty',
        troops: { infantry: 0, cavalry: 0, lightCav: 0 },
      };
    }
  }
  return map;
}

function totalPower(t) {
  return t.infantry * TROOP_POWER.infantry
       + t.cavalry * TROOP_POWER.cavalry
       + t.lightCav * TROOP_POWER.lightCav;
}
function totalTroops(t) {
  return t.infantry + t.cavalry + t.lightCav;
}
function getQuadrant(x, y) {
  if (x < 5 && y < 5) return 0;
  if (x >= 5 && y < 5) return 1;
  if (x < 5 && y >= 5) return 2;
  return 3;
}
function inBounds(x, y) {
  return x >= 0 && x < MAP_SIZE && y >= 0 && y < MAP_SIZE;
}
function getMarchDuration(troops, distance) {
  let slowest = 0;
  if (troops.infantry > 0) slowest = Math.max(slowest, TROOP_SPEED.infantry);
  if (troops.cavalry > 0)  slowest = Math.max(slowest, TROOP_SPEED.cavalry);
  if (troops.lightCav > 0) slowest = Math.max(slowest, TROOP_SPEED.lightCav);
  if (slowest === 0) slowest = TROOP_SPEED.infantry;
  return slowest * distance;
}

class Room {
  constructor(id) {
    this.id = id;
    this.clients = [];
    this.quadrants = null;
    this.state = this.initState();
    this.lastTick = Date.now();
    this.lastBroadcast = 0;
    this.timer = setInterval(() => this.tick(), 50);
  }

  initState() {
    return {
      map: initMap(),
      players: [0, 1, 2, 3].map(i => ({
        id: i, food: START_FOOD, capital: null, alive: true,
      })),
      phase: 'waiting',
      timeLeft: 0,
      turn: 1,
      marching: [],
      gameOver: false,
      marchingIdCounter: 0,
    };
  }

  isFull() { return this.clients.length >= 4; }

  addClient(ws) {
    const playerId = this.clients.length;
    this.clients.push({ ws, playerId });
    ws.send(JSON.stringify({ type: 'joined', playerId, roomId: this.id }));
    this.broadcastRoomState();
    if (this.isFull()) this.startGame();
  }

  removeClient(ws) {
    this.clients = this.clients.filter(c => c.ws !== ws);
  }

  broadcastRoomState() {
    this.broadcast({
      type: 'roomState',
      roomId: this.id,
      count: this.clients.length,
    });
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
    }
  }

  sendTo(playerId, msg) {
    const c = this.clients.find(c => c.playerId === playerId);
    if (c && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }

  startGame() {
    const quads = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
    this.quadrants = quads;
    this.state.phase = 'select';
    this.broadcast({ type: 'gameStart', quadrants: quads });
    this.broadcastState();
    console.log(`[房间 ${this.id}] 开局，象限分配：`, quads);
  }

  tick() {
    if (this.state.gameOver) return;

    const now = Date.now();
    const dt = now - this.lastTick;
    this.lastTick = now;

    if (this.state.phase === 'action') {
      for (const m of this.state.marching) {
        m.elapsed = Math.min(m.elapsed + dt, m.duration);
      }
      const arrived = this.state.marching.filter(m => m.elapsed >= m.duration);
      for (const m of arrived) {
        this.state.marching = this.state.marching.filter(x => x.id !== m.id);
        this.onMarchArrive(m);
      }
    }

    if (this.state.phase === 'action' || this.state.phase === 'recruit') {
      this.state.timeLeft -= dt / 1000;
      if (this.state.timeLeft <= 0) this.nextPhase();
    }

    if (now - this.lastBroadcast >= BROADCAST_INTERVAL) {
      this.lastBroadcast = now;
      this.broadcastState();
    }
  }

  nextPhase() {
    if (this.state.phase === 'action') {
      this.settle();
      this.state.phase = 'recruit';
      this.state.timeLeft = RECRUIT_TIME;
      console.log(`[房间 ${this.id}] → 征兵阶段`);
    } else if (this.state.phase === 'recruit') {
      this.state.turn++;
      this.state.phase = 'action';
      this.state.timeLeft = ACTION_TIME;
      console.log(`[房间 ${this.id}] → 第 ${this.state.turn} 回合行动阶段`);
    }
    this.broadcastState();
  }

  settle() {
    for (const p of this.state.players) {
      if (!p.alive) continue;
      let count = 0;
      for (let y = 0; y < MAP_SIZE; y++)
        for (let x = 0; x < MAP_SIZE; x++)
          if (this.state.map[y][x].owner === p.id) count++;
      p.food += count;
    }
  }

  handleSelectCapital(playerId, x, y) {
    if (this.state.phase !== 'select') {
      this.sendTo(playerId, { type: 'hint', message: '现在不是选都城阶段' });
      return;
    }
    if (this.state.players[playerId].capital) {
      this.sendTo(playerId, { type: 'hint', message: '你已经选过都城了' });
      return;
    }
    if (!inBounds(x, y)) return;
    const cell = this.state.map[y][x];
    if (cell.owner !== null) {
      this.sendTo(playerId, { type: 'hint', message: '这个格子不能选' });
      return;
    }
    if (getQuadrant(x, y) !== this.quadrants[playerId]) {
      this.sendTo(playerId, { type: 'hint', message: '只能选你的象限' });
      return;
    }

    cell.owner = playerId;
    cell.type = 'capital';
    this.state.players[playerId].capital = { x, y };

    const cnt = this.state.players.filter(p => p.capital).length;
    console.log(`[房间 ${this.id}] P${playerId} 选了 (${x},${y})，${cnt}/4`);
    this.sendTo(playerId, { type: 'hint', message: `都城已选定 (${x},${y})` });

    if (this.state.players.every(p => p.capital)) {
      console.log(`[房间 ${this.id}] 4 人选完，进入征兵阶段`);
      this.state.phase = 'recruit';
      this.state.timeLeft = RECRUIT_TIME;
    }

    this.broadcastState();
  }

  handleMove(playerId, from, to, troops) {
    if (this.state.phase !== 'action') return;
    if (this.state.gameOver) return;
    if (!this.state.players[playerId].alive) return;
    if (!from || !to || !inBounds(from.x, from.y) || !inBounds(to.x, to.y)) return;
    if (!troops) return;

    const fromCell = this.state.map[from.y][from.x];
    if (!fromCell || fromCell.owner !== playerId) return;

    const fi = Math.max(0, Math.floor(troops.infantry || 0));
    const fc = Math.max(0, Math.floor(troops.cavalry || 0));
    const fl = Math.max(0, Math.floor(troops.lightCav || 0));

    if (fi > fromCell.troops.infantry) return;
    if (fc > fromCell.troops.cavalry) return;
    if (fl > fromCell.troops.lightCav) return;
    if (fi + fc + fl === 0) return;

    fromCell.troops.infantry -= fi;
    fromCell.troops.cavalry  -= fc;
    fromCell.troops.lightCav -= fl;

    const distance = Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
    const duration = getMarchDuration({ infantry: fi, cavalry: fc, lightCav: fl }, distance);

    this.state.marching.push({
      id: this.state.marchingIdCounter++,
      owner: playerId,
      from: { x: from.x, y: from.y },
      to: { x: to.x, y: to.y },
      troops: { infantry: fi, cavalry: fc, lightCav: fl },
      elapsed: 0,
      duration,
      distance,
    });

    this.broadcastState();
  }

  handleRecruit(playerId, x, y, type) {
    if (this.state.phase !== 'recruit') return;
    if (!TROOP_COST[type]) return;
    if (!inBounds(x, y)) return;
    const cell = this.state.map[y][x];
    if (!cell || cell.owner !== playerId) return;
    if (cell.type !== 'capital' && cell.type !== 'city') return;
    const p = this.state.players[playerId];
    if (p.food < TROOP_COST[type]) return;
    p.food -= TROOP_COST[type];
    cell.troops[type]++;
    this.broadcastState();
  }

  handleBuildCity(playerId, x, y) {
    if (this.state.phase !== 'recruit') return;
    if (!inBounds(x, y)) return;
    const cell = this.state.map[y][x];
    if (!cell || cell.owner !== playerId) return;
    if (cell.type !== 'empty') return;
    const p = this.state.players[playerId];
    if (p.food < CITY_COST) return;
    p.food -= CITY_COST;
    cell.type = 'city';
    this.broadcastState();
  }

  onMarchArrive(m) {
    if (!inBounds(m.to.x, m.to.y)) return;
    const to = this.state.map[m.to.y][m.to.x];

    if (to.owner === m.owner) {
      to.troops.infantry += m.troops.infantry;
      to.troops.cavalry  += m.troops.cavalry;
      to.troops.lightCav += m.troops.lightCav;
      return;
    }

    const atk = totalPower(m.troops);
    let def = totalPower(to.troops);
    if (to.owner === null) def += 1;

    if (atk > def) {
      const remain = atk - def;
      const oldOwner = to.owner;
      const wasCapital = to.type === 'capital';
      to.owner = m.owner;
      to.troops = { infantry: remain, cavalry: 0, lightCav: 0 };

      if (wasCapital && oldOwner !== null) {
        const oldCap = this.state.players[oldOwner].capital;
        if (oldCap && oldCap.x === to.x && oldCap.y === to.y) {
          this.state.players[oldOwner].alive = false;
          console.log(`[房间 ${this.id}] P${oldOwner} 被 P${m.owner} 灭国`);
        }
        to.type = 'city';
      }
      this.checkVictory();
    } else {
      const remain = def - atk;
      to.troops = { infantry: remain, cavalry: 0, lightCav: 0 };
    }
    this.broadcastState();
  }

  checkVictory() {
    const alive = this.state.players.filter(p => p.alive);
    if (alive.length <= 1) {
      this.state.gameOver = true;
      this.state.phase = 'gameover';
      const winner = alive[0]?.id ?? -1;
      console.log(`[房间 ${this.id}] 游戏结束，胜者 P${winner}`);
      this.broadcast({ type: 'gameover', winner });
      this.broadcastState();
    }
  }

  broadcastState() {
    this.broadcast({ type: 'state', state: this.state });
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
  }
}

const wss = new WebSocket.Server({ port: PORT });
const rooms = new Map();

function makeRoomId() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

console.log(`服务器已启动：ws://localhost:${PORT}`);

wss.on('connection', (ws) => {
  let roomId = null;
  let playerId = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'createRoom') {
      const id = makeRoomId();
      const room = new Room(id);
      rooms.set(id, room);
      roomId = id;
      room.addClient(ws);
      ws.send(JSON.stringify({ type: 'roomCreated', roomId: id }));
      return;
    }

    if (msg.type === 'joinRoom') {
      const room = rooms.get(msg.roomId);
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: '房间不存在' }));
        return;
      }
      if (room.isFull()) {
        ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
        return;
      }
      roomId = msg.roomId;
      room.addClient(ws);
      return;
    }

    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const client = room.clients.find(c => c.ws === ws);
    if (!client) return;
    playerId = client.playerId;

    if (msg.type === 'selectCapital') room.handleSelectCapital(playerId, msg.x, msg.y);
    else if (msg.type === 'move') room.handleMove(playerId, msg.from, msg.to, msg.troops);
    else if (msg.type === 'recruit') room.handleRecruit(playerId, msg.x, msg.y, msg.troopType);
    else if (msg.type === 'buildCity') room.handleBuildCity(playerId, msg.x, msg.y);
  });

  ws.on('close', () => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.removeClient(ws);
    room.broadcastRoomState();
    if (room.clients.length === 0) {
      room.destroy();
      rooms.delete(roomId);
    }
  });
});