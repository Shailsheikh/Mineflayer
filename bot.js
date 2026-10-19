'use strict';

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

const CONFIG = {
  host: process.env.MC_HOST || 'Notzz_aahil.aternos.me',
  port: parseInt(process.env.MC_PORT || '58642', 10),
  username: process.env.MC_USERNAME || 'pro_ninja_aahil',
  auth: process.env.MC_AUTH || 'offline',
  version: process.env.MC_VERSION || false,
  allowedUsers: [],
  commandPrefix: '!',

  reconnect: {
    baseDelayMs: 5000,
    maxDelayMs: 5 * 60 * 1000,
    jitter: 0.25,
    stableAfterMs: 60 * 1000,
    throttleDelayMs: 60 * 1000,
    loginTimeoutMs: 60 * 1000,
  },
  watchdog: {
    intervalMs: 10 * 1000,
    packetTimeoutMs: 60 * 1000,
  },
  stuck: {
    checkIntervalMs: 250,
    thresholdMs: 2000,
    minMoveDist: 0.3,
    maxEscapeAttempts: 5,
  },
  antiAfk: {
    minMs: 20 * 1000,
    maxMs: 40 * 1000,
    moodChangeMs: [3 * 60 * 1000, 8 * 60 * 1000],
    driftIntervalMs: [1500, 4500],
    bigActivityEveryMs: [3 * 60 * 1000, 5 * 60 * 1000],
    glanceRange: 16,
    hotbar: true,
    wander: {
      enabled: true,
      radius: 4,
      maxLeash: 7,
      timeoutMs: 12 * 1000,
    },
  },
  eat: {
    threshold: 15,
    checkIntervalMs: 3000,
  },
  pathing: {
    canDig: false,
    allowParkour: true,
    maxDropDown: 3,
    followRange: 2,
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function log(level, ...args) {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[${new Date().toISOString()}] [${level.toUpperCase()}]`, ...args);
}

function weightedPick(items) {
  const total = items.reduce((sum, i) => sum + i.w, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.w;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

function reasonToString(reason) {
  if (typeof reason === 'string') return reason;
  try { return JSON.stringify(reason); } catch (_) { return String(reason); }
}

const BAD_FOODS = new Set([
  'rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish',
  'chicken', 'chorus_fruit', 'golden_apple', 'enchanted_golden_apple', 'suspicious_stew',
]);

const DANGEROUS_BLOCKS = [
  'lava', 'fire', 'soul_fire', 'cactus', 'sweet_berry_bush',
  'magma_block', 'campfire', 'soul_campfire', 'wither_rose', 'powder_snow', 'cobweb', 'web', 'pointed_dripstone',
];

const AFK_MOODS = {
  calm: {
    gap: 1.2,
    weights: { look: 40, glanceEntity: 15, lookBlock: 15, microMove: 10, sneakTap: 10, jump: 5, swing: 5, hotbar: 10, wander: 5 },
  },
  restless: {
    gap: 0.7,
    weights: { look: 25, glanceEntity: 10, lookBlock: 10, microMove: 20, sneakTap: 15, jump: 20, swing: 15, hotbar: 10, wander: 15 },
  },
  curious: {
    gap: 0.9,
    weights: { look: 25, glanceEntity: 30, lookBlock: 35, microMove: 5, sneakTap: 5, jump: 5, swing: 5, hotbar: 5, wander: 10 },
  },
  sleepy: {
    gap: 1.5,
    weights: { look: 55, glanceEntity: 10, lookBlock: 10, microMove: 5, sneakTap: 10, jump: 3, swing: 5, hotbar: 5, wander: 2 },
  },
};

const GLANCE_TYPES = new Set(['player', 'mob', 'hostile', 'animal', 'passive', 'living']);
const INTEREST_RE = /chest|barrel|furnace|crafting_table|torch|lantern|door|bed|sign|bookshelf|anvil|enchanting|flower|sapling/;
const EYE_HEIGHT = 1.62;

const PILLAR_BLOCKS = new Set([
  'dirt', 'cobblestone', 'stone', 'netherrack', 'cobbled_deepslate',
  'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'end_stone',
]);

class BotSession {
  constructor(hooks) {
    this.hooks = hooks;
    this.stopped = false;
    this.closedNotified = false;
    this.timers = new Set();
    this.spawnedAt = 0;
    this.kickReason = null;
    this.lastPacketAt = Date.now();

    this.task = null;
    this.escaping = false;
    this.eating = false;
    this.lastPos = null;
    this.lastMoveAt = Date.now();
    this.noPathCount = 0;
    this.escapeAttempts = 0;
    this.lastEscapeAt = 0;
    this.lastNoFoodLogAt = 0;

    this.doorIds = [];
    this.doorBusy = false;
    this.knownClosedDoors = new Set();
    this.openedDoors = new Map();

    this.anchor = null;
    this.mood = 'calm';
    this.moodUntil = 0;
    this.lastAfkActions = [];
    this.nextBigActivityAt = 0;
    this.afkBusy = false;
    this.afkActions = this.buildAfkActions();

    this.nextSayAt = 0;
    this.commands = new Map();

    this.bot = mineflayer.createBot({
      host: CONFIG.host,
      port: CONFIG.port,
      username: CONFIG.username,
      auth: CONFIG.auth,
      version: CONFIG.version,
      checkTimeoutInterval: 60 * 1000,
    });
    this.bot.loadPlugin(pathfinder);

    this.registerCommands();
    this.bindCoreEvents();

    this.after(CONFIG.reconnect.loginTimeoutMs, () => {
      if (!this.spawnedAt) {
        log('warn', 'Login timeout - aborting connection attempt.');
        this.forceClose('login timeout');
      }
    });
  }

  after(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.stopped) return;
      try { fn(); } catch (err) { log('error', 'Timer callback failed:', err); }
    }, ms);
    this.timers.add(t);
    return t;
  }

  every(ms, fn) {
    const t = setInterval(() => {
      if (this.stopped) return;
      try {
        const result = fn();
        if (result && typeof result.catch === 'function') {
          result.catch((err) => log('warn', 'Interval task failed:', err.message || err));
        }
      } catch (err) { log('error', 'Interval callback failed:', err); }
    }, ms);
    this.timers.add(t);
    return t;
  }

  cleanup() {
    this.stopped = true;
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers.clear();
  }

  forceClose(reason) {
    try { this.bot.end(reason); } catch (_) {}
    this.after(2000, () => this.finish(reason));
  }

  finish(reason) {
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.cleanup();
    this.hooks.onClosed({ reason: reasonToString(reason), kickReason: this.kickReason });
  }

  isReady() {
    return !this.stopped && !!this.bot.entity && this.bot.isAlive !== false;
  }

  isIdle() {
    return this.isReady() && !this.task && !this.escaping && !this.eating;
  }

  bindCoreEvents() {
    const bot = this.bot;

    bot._client.on('packet', () => {
      this.lastPacketAt = Date.now();
    });

    bot.on('login', () => log('info', `Logged in as ${bot.username}`));
    bot.once('spawn', () => this.onFirstSpawn());

    bot.on('kicked', (reason) => {
      this.kickReason = reasonToString(reason);
      log('warn', 'Kicked from server:', this.kickReason);
    });

    bot.on('error', (err) => {
      log('error', 'Bot error:', err && err.message ? err.message : err);
      if (!this.spawnedAt) this.after(10 * 1000, () => this.forceClose('connection error'));
    });

    bot.on('end', (reason) => {
      log('warn', 'Connection ended:', reasonToString(reason));
      this.finish(reason);
    });

    bot.on('death', () => {
      log('warn', 'Bot died - respawning.');
      this.cancelTask();
      this.after(500, () => {
        if (this.bot.isAlive !== true) this.bot.respawn();
      });
    });

    bot.on('health', () => {
      this.maybeEat().catch(() => {});
    });

    bot.on('chat', (username, message) => this.handleChat(username, message, false));
    bot.on('whisper', (username, message) => this.handleChat(username, message, true));

    bot.on('path_update', (result) => {
      if (!this.task) return;
      if (result.status === 'noPath' || result.status === 'timeout') this.noPathCount++;
      else if (result.status === 'success') this.noPathCount = 0;
    });

    bot.on('goal_reached', () => {
      if (this.task && this.task.type === 'come') {
        this.task = null;
        this.anchor = null;
        this.escapeAttempts = 0;
        this.say('I have arrived.');
      } else if (this.task && this.task.type === 'wander') {
        this.endWander(this.task);
      }
    });
  }

  onFirstSpawn() {
    const bot = this.bot;
    this.spawnedAt = Date.now();
    log('info', `Spawned at ${this.formatPos(bot.entity.position)}`);

    this.setupMovements();

    this.doorIds = Object.values(bot.registry.blocksByName)
      .filter((b) => (b.name.endsWith('_door') && b.name !== 'iron_door') || b.name.endsWith('_fence_gate'))
      .map((b) => b.id);

    this.every(CONFIG.stuck.checkIntervalMs, () => this.stuckTick());
    this.every(CONFIG.eat.checkIntervalMs, () => this.maybeEat());
    this.every(CONFIG.watchdog.intervalMs, () => this.watchdogTick());
    this.every(250, () => this.doorTick());
    this.antiAfkLoop().catch((err) => log('error', 'Anti-AFK loop crashed:', err));

    if (this.hooks.onSpawn) this.hooks.onSpawn();
    this.after(CONFIG.reconnect.stableAfterMs, () => {
      if (this.hooks.onStable) this.hooks.onStable();
    });
  }

  watchdogTick() {
    const silentFor = Date.now() - this.lastPacketAt;
    if (silentFor > CONFIG.watchdog.packetTimeoutMs) {
      log('warn', `Watchdog: no packets for ${Math.round(silentFor / 1000)}s - forcing reconnect.`);
      this.forceClose('watchdog timeout');
    }
  }

  formatPos(p) {
    return `${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}`;
  }

  setupMovements() {
    const bot = this.bot;
    const m = new Movements(bot);

    m.canOpenDoors = true;
    m.allowParkour = CONFIG.pathing.allowParkour;
    m.allowSprinting = true;
    m.canDig = CONFIG.pathing.canDig;
    m.maxDropDown = CONFIG.pathing.maxDropDown;
    m.allow1by1towers = false;
    m.scafoldingBlocks = [];

    if (m.blocksToAvoid instanceof Set) {
      for (const name of DANGEROUS_BLOCKS) {
        const block = bot.registry.blocksByName[name];
        if (block) m.blocksToAvoid.add(block.id);
      }
    }

    bot.pathfinder.setMovements(m);
    bot.pathfinder.thinkTimeout = 5000;
    bot.pathfinder.tickTimeout = 5;
    this.movements = m;
  }

  getPlayerEntity(name) {
    const player = this.bot.players[name];
    return player && player.entity ? player.entity : null;
  }

  startTask(task) {
    const keepAnchor = this.anchor;
    this.cancelTask();
    if (task.type === 'wander') this.anchor = keepAnchor;
    this.task = task;
    this.noPathCount = 0;
    this.escapeAttempts = 0;
    this.lastPos = this.bot.entity.position.clone();
    this.lastMoveAt = Date.now();
    this.applyGoal();
  }

  applyGoal() {
    if (!this.task) return;
    const goal = this.task.makeGoal();
    if (!goal) {
      this.cancelTask();
      return;
    }
    this.bot.pathfinder.setGoal(goal, this.task.dynamic);
  }

  cancelTask() {
    this.task = null;
    this.anchor = null;
    this.noPathCount = 0;
    this.escapeAttempts = 0;
    try {
      this.bot.pathfinder.setGoal(null);
      if (typeof this.bot.pathfinder.stop === 'function') this.bot.pathfinder.stop();
    } catch (_) {}
    try { this.bot.clearControlStates(); } catch (_) {}
  }

  stuckTick() {
    if (!this.isReady()) return;
    const now = Date.now();
    const pos = this.bot.entity.position;

    const moved = !this.lastPos || pos.distanceTo(this.lastPos) >= CONFIG.stuck.minMoveDist;
    if (moved) {
      this.lastPos = pos.clone();
      this.lastMoveAt = now;
      if (this.escapeAttempts > 0 && now - this.lastEscapeAt > 8000) this.escapeAttempts = 0;
    }

    if (!this.task || this.escaping) {
      this.lastMoveAt = now;
      return;
    }

    const targetPos = this.task.targetPos();
    if (!targetPos) {
      this.say('I lost sight of my target - stopping.');
      this.cancelTask();
      return;
    }

    if (pos.distanceTo(targetPos) <= this.task.arriveDistance) {
      this.lastMoveAt = now;
      return;
    }

    if (now - this.lastMoveAt < CONFIG.stuck.thresholdMs) return;

    const pf = this.bot.pathfinder;
    const trying = (typeof pf.isMoving === 'function' && pf.isMoving()) || this.noPathCount >= 2;
    if (trying) {
      this.escape().catch((err) => log('error', 'Escape routine failed:', err));
    }
  }

  async escape() {
    if (this.escaping || !this.isReady()) return;
    this.escaping = true;
    this.escapeAttempts++;
    this.lastEscapeAt = Date.now();
    const bot = this.bot;

    try {
      if (this.escapeAttempts > CONFIG.stuck.maxEscapeAttempts) {
        log('warn', 'Giving up after repeated escape attempts.');
        if (this.task && this.task.type !== 'wander') this.say("I'm stuck and can't find a way - stopping.");
        this.cancelTask();
        return;
      }

      log('warn', `Stuck detected (attempt ${this.escapeAttempts}) at ${this.formatPos(bot.entity.position)} - escaping.`);

      bot.pathfinder.setGoal(null);
      if (typeof bot.pathfinder.stop === 'function') bot.pathfinder.stop();
      bot.clearControlStates();
      await sleep(100);

      let done = false;
      if (this.isTrapped()) {
        done = await this.pillarUp();
      }
      if (!done) {
        const strategies = [
          async () => {
            await bot.look(rand(-Math.PI, Math.PI), 0);
            await this.hold({ forward: true, jump: true, sprint: true }, randInt(500, 1000));
          },
          async () => {
            await this.hold({ [pick(['left', 'right'])]: true, jump: true }, randInt(400, 800));
            await this.hold({ forward: true, jump: true }, randInt(300, 600));
          },
          async () => {
            await this.hold({ back: true, sneak: true }, randInt(500, 900));
            await this.hold({ [pick(['left', 'right'])]: true }, randInt(300, 600));
          },
          async () => {
            await bot.look(bot.entity.yaw + rand(1.5, 3.1) * pick([-1, 1]), 0);
            await this.hold({ forward: true, sprint: true, jump: true }, randInt(600, 1100));
          },
        ];
        await pick(strategies)();
      }
    } finally {
      try { bot.clearControlStates(); } catch (_) {}
      await sleep(200);
      this.escaping = false;
      if (this.isReady() && this.task) {
        this.noPathCount = 0;
        this.lastPos = this.bot.entity.position.clone();
        this.lastMoveAt = Date.now();
        this.applyGoal();
      }
    }
  }

  isTrapped() {
    const bot = this.bot;
    const base = bot.entity.position.floored();
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    return dirs.every(([dx, dz]) => {
      const head = bot.blockAt(base.offset(dx, 1, dz));
      return head && head.boundingBox === 'block';
    });
  }

  findPlacementBlock() {
    return this.bot.inventory
      .items()
      .find((i) => PILLAR_BLOCKS.has(i.name) || i.name.endsWith('_planks'));
  }

  async pillarUp(maxBlocks = 6) {
    const bot = this.bot;
    const item = this.findPlacementBlock();
    if (!item) {
      log('warn', 'Trapped but no placeable blocks in inventory.');
      return false;
    }

    try {
      await bot.equip(item, 'hand');
    } catch (err) {
      log('warn', 'Could not equip pillar block:', err.message);
      return false;
    }

    log('info', 'Trapped - pillaring up.');
    for (let i = 0; i < maxBlocks && this.isReady(); i++) {
      if (i > 0 && !this.isTrapped()) break;

      const startY = bot.entity.position.y;
      const reference = bot.blockAt(bot.entity.position.offset(0, -0.5, 0));
      if (!reference || reference.boundingBox !== 'block') {
        await sleep(150);
        continue;
      }

      bot.setControlState('jump', true);
      const risen = await this.waitFor(() => bot.entity.position.y - startY > 1.02, 900, 15);
      if (risen) {
        try {
          await bot.placeBlock(reference, new Vec3(0, 1, 0));
        } catch (err) {
          log('debug', 'placeBlock failed:', err.message);
        }
      }
      bot.setControlState('jump', false);
      await sleep(200);
    }
    return true;
  }

  async waitFor(predicate, timeoutMs, intervalMs = 20) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && !this.stopped) {
      if (predicate()) return true;
      await sleep(intervalMs);
    }
    return predicate();
  }

  async hold(states, ms) {
    for (const [key, value] of Object.entries(states)) this.bot.setControlState(key, value);
    await sleep(ms);
    this.bot.clearControlStates();
  }

  async doorTick() {
    if (this.doorBusy || !this.isReady() || this.escaping) return;
    if (!this.task && this.openedDoors.size === 0) return;

    this.doorBusy = true;
    try {
      const bot = this.bot;
      const botPos = bot.entity.position;
      const now = Date.now();

      const found = bot.findBlocks({ matching: this.doorIds, maxDistance: 6, count: 24 });
      for (const p of found) {
        const block = bot.blockAt(p);
        if (!block || typeof block.getProperties !== 'function') continue;
        const props = block.getProperties();
        if (typeof props.open !== 'boolean') continue;
        if (props.half === 'upper') continue;

        const key = p.toString();
        if (!props.open) {
          this.knownClosedDoors.add(key);
          this.openedDoors.delete(key);
        } else if (this.knownClosedDoors.has(key)) {
          this.knownClosedDoors.delete(key);
          this.openedDoors.set(key, { pos: p.clone(), minDist: Infinity, since: now });
        }
      }

      for (const [key, entry] of this.openedDoors) {
        const center = entry.pos.offset(0.5, 0.5, 0.5);
        const dist = botPos.distanceTo(center);
        entry.minDist = Math.min(entry.minDist, dist);

        if (now - entry.since > 30000) {
          this.openedDoors.delete(key);
          continue;
        }

        const passed = entry.minDist < 1.8 && dist > 2.5 && dist <= 4.5;
        if (!passed) continue;

        this.openedDoors.delete(key);
        const block = bot.blockAt(entry.pos);
        if (!block || typeof block.getProperties !== 'function') continue;
        const props = block.getProperties();
        if (props.open !== true) continue;

        try {
          await bot.lookAt(center, false);
          await bot.activateBlock(block);
          this.knownClosedDoors.add(key);
        } catch (err) {}
      }
    } finally {
      this.doorBusy = false;
    }
  }

  updateMood() {
    const now = Date.now();
    if (now < this.moodUntil) return;
    this.mood = pick(Object.keys(AFK_MOODS).filter((m) => m !== this.mood));
    const [lo, hi] = CONFIG.antiAfk.moodChangeMs;
    this.moodUntil = now + randInt(lo, hi);
  }

  nextGapMs() {
    const { minMs, maxMs } = CONFIG.antiAfk;
    if (Math.random() < 0.08) return randInt(3000, 8000);
    const triangular = (Math.random() + Math.random()) / 2;
    const base = minMs + triangular * (maxMs - minMs);
    const scaled = base * AFK_MOODS[this.mood].gap;
    return Math.round(clamp(scaled, minMs * 0.75, maxMs * 1.15));
  }

  buildAfkActions() {
    return {
      look: () => this.afkLookAround(),
      glanceEntity: () => this.afkGlanceEntity(),
      lookBlock: () => this.afkLookBlock(),
      microMove: () => this.afkMicroMove(),
      sneakTap: () => this.afkSneak(),
      jump: () => this.afkJump(),
      swing: () => this.afkSwing(),
      hotbar: () => this.afkHotbar(),
      wander: () => this.afkWander(),
    };
  }

  afkAvailable(name) {
    const cfg = CONFIG.antiAfk;
    const entity = this.bot.entity;
    switch (name) {
      case 'glanceEntity': return this.glanceCandidates().length > 0;
      case 'microMove': return this.isSafeSpot();
      case 'jump': return !entity.isInWater && !entity.isInLava;
      case 'hotbar': return cfg.hotbar && !this.eating;
      case 'wander': return cfg.wander.enabled;
      default: return true;
    }
  }

  chooseAfkAction() {
    const
