'use strict';

/**
 * bot.js - Resilient Mineflayer bot
 *
 * Features:
 *  - mineflayer-pathfinder with tuned Movements (doors, parkour, lava/cliff avoidance)
 *  - Door closer (closes doors the bot opened after walking through them)
 *  - Anti-stuck + pit escape (randomized escape routine, pillar-up when trapped)
 *  - Advanced anti-AFK: moods, humanized timing, entity tracking, camera drift,
 *    hotbar fidgeting, leashed wandering
 *  - Auto-reconnect with exponential backoff + packet watchdog
 *  - Auto-respawn and auto-eat
 *  - Chat commands: !ping !coords !follow !come !stop !help
 *
 * Configuration is done through environment variables (see CONFIG below):
 *   MC_HOST, MC_PORT, MC_USERNAME, MC_AUTH (offline|microsoft), MC_VERSION,
 *   MC_ALLOWED_USERS (comma separated; empty = everyone may use commands)
 *
 * Only use this on servers where bots / AFK clients are permitted.
 */

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const CONFIG = {
  host: process.env.MC_HOST || 'localhost',
  port: parseInt(process.env.MC_PORT || '25565', 10),
  username: process.env.MC_USERNAME || 'StealthBot',
  auth: process.env.MC_AUTH || 'offline',
  version: process.env.MC_VERSION || false, // false = auto-detect
  allowedUsers: (process.env.MC_ALLOWED_USERS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  commandPrefix: '!',

  reconnect: {
    baseDelayMs: 5000,
    maxDelayMs: 5 * 60 * 1000,
    jitter: 0.25, // +/- 25% random jitter
    stableAfterMs: 60 * 1000, // connection must live this long to reset the backoff
    throttleDelayMs: 60 * 1000, // minimum delay when the server says we reconnect too fast
    loginTimeoutMs: 60 * 1000, // abort connection attempt if we never spawn
  },
  watchdog: {
    intervalMs: 10 * 1000,
    packetTimeoutMs: 60 * 1000, // no packets for this long => force reconnect
  },
  stuck: {
    checkIntervalMs: 250,
    thresholdMs: 2000, // stationary this long while trying to move => stuck
    minMoveDist: 0.3, // blocks moved that count as "progress"
    maxEscapeAttempts: 5,
  },
  antiAfk: {
    minMs: 20 * 1000, // base gap between actions (scaled by mood, humanized)
    maxMs: 40 * 1000,
    moodChangeMs: [3 * 60 * 1000, 8 * 60 * 1000], // how long a mood lasts
    driftIntervalMs: [1500, 4500], // tiny camera noise while idle
    bigActivityEveryMs: [3 * 60 * 1000, 5 * 60 * 1000], // forced short walk interval
    glanceRange: 16, // look at players/mobs within this many blocks
    hotbar: true, // fidget with hotbar slots
    wander: {
      enabled: true,
      radius: 4, // wander this far from the anchor
      maxLeash: 7, // if further than this, walk back to the anchor
      timeoutMs: 12 * 1000,
    },
  },
  eat: {
    threshold: 15, // eat when food < 15 or health < 15 (and food < 20)
    checkIntervalMs: 3000,
  },
  pathing: {
    canDig: false, // keep false so the bot never griefs terrain
    allowParkour: true,
    maxDropDown: 3, // refuse drops higher than this (cliff avoidance)
    followRange: 2,
  },
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
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
  try {
    return JSON.stringify(reason);
  } catch (_) {
    return String(reason);
  }
}

// Foods we never want to eat automatically
const BAD_FOODS = new Set([
  'rotten_flesh',
  'spider_eye',
  'poisonous_potato',
  'pufferfish',
  'chicken', // raw chicken can cause hunger
  'chorus_fruit',
  'golden_apple',
  'enchanted_golden_apple',
  'suspicious_stew',
]);

// Blocks pathfinder should treat as dangerous
const DANGEROUS_BLOCKS = [
  'lava',
  'fire',
  'soul_fire',
  'cactus',
  'sweet_berry_bush',
  'magma_block',
  'campfire',
  'soul_campfire',
  'wither_rose',
  'powder_snow',
  'cobweb',
  'web',
  'pointed_dripstone',
];

// Anti-AFK "moods": each has a pacing multiplier and per-action weights
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

// Blocks the bot may place when pillaring out of a pit
const PILLAR_BLOCKS = new Set([
  'dirt',
  'cobblestone',
  'stone',
  'netherrack',
  'cobbled_deepslate',
  'deepslate',
  'andesite',
  'diorite',
  'granite',
  'tuff',
  'end_stone',
]);

// ---------------------------------------------------------------------------
// BotSession: one connection's worth of state and behaviour
// ---------------------------------------------------------------------------
class BotSession {
  /**
   * @param {{onSpawn?:Function,onStable?:Function,onClosed:Function}} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.stopped = false;
    this.closedNotified = false;
    this.timers = new Set();

    this.spawnedAt = 0;
    this.kickReason = null;
    this.lastPacketAt = Date.now();

    // Task / movement state
    this.task = null;
    this.escaping = false;
    this.eating = false;
    this.lastPos = null;
    this.lastMoveAt = Date.now();
    this.noPathCount = 0;
    this.escapeAttempts = 0;
    this.lastEscapeAt = 0;
    this.lastNoFoodLogAt = 0;

    // Door tracking
    this.doorIds = [];
    this.doorBusy = false;
    this.knownClosedDoors = new Set();
    this.openedDoors = new Map(); // key -> { pos, minDist, since }

    // Anti-AFK state
    this.anchor = null; // home position for wandering
    this.mood = 'calm';
    this.moodUntil = 0;
    this.lastAfkActions = [];
    this.nextBigActivityAt = 0;
    this.afkBusy = false;
    this.afkActions = this.buildAfkActions();

    // Chat
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

    // Abort connection attempts that never reach spawn
    this.after(CONFIG.reconnect.loginTimeoutMs, () => {
      if (!this.spawnedAt) {
        log('warn', 'Login timeout - aborting connection attempt.');
        this.forceClose('login timeout');
      }
    });
  }

  // -------------------------------------------------------------------------
  // Timer helpers (all cleared on cleanup so nothing leaks across reconnects)
  // -------------------------------------------------------------------------
  after(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.stopped) return;
      try {
        fn();
      } catch (err) {
        log('error', 'Timer callback failed:', err);
      }
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
      } catch (err) {
        log('error', 'Interval callback failed:', err);
      }
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

  /** End the underlying connection and make sure we report closure even if 'end' never fires. */
  forceClose(reason) {
    try {
      this.bot.end(reason);
    } catch (_) {
      /* ignore */
    }
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

  // -------------------------------------------------------------------------
  // Core events: lifecycle, errors, death, chat
  // -------------------------------------------------------------------------
  bindCoreEvents() {
    const bot = this.bot;

    // Track raw packet activity for the watchdog (the client emits 'packet' for every packet)
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
      // Before spawning, make sure a failed connection always results in a retry
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

    // Pathfinder feedback used by the anti-stuck system
    bot.on('path_update', (result) => {
      if (!this.task) return;
      if (result.status === 'noPath' || result.status === 'timeout') this.noPathCount++;
      else if (result.status === 'success') this.noPathCount = 0;
    });

    bot.on('goal_reached', () => {
      if (this.task && this.task.type === 'come') {
        this.task = null;
        this.anchor = null; // re-anchor where we end up
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

    // Doors the bot is allowed to close again (iron doors need redstone)
    this.doorIds = Object.values(bot.registry.blocksByName)
      .filter((b) => (b.name.endsWith('_door') && b.name !== 'iron_door') || b.name.endsWith('_fence_gate'))
      .map((b) => b.id);

    // Background workers
    this.every(CONFIG.stuck.checkIntervalMs, () => this.stuckTick());
    this.every(CONFIG.eat.checkIntervalMs, () => this.maybeEat());
    this.every(CONFIG.watchdog.intervalMs, () => this.watchdogTick());
    this.every(250, () => this.doorTick());
    this.antiAfkLoop().catch((err) => log('error', 'Anti-AFK loop crashed:', err));

    // Tell the manager the connection is up, and later that it is stable
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

  // -------------------------------------------------------------------------
  // Pathfinder setup
  // -------------------------------------------------------------------------
  setupMovements() {
    const bot = this.bot;
    const m = new Movements(bot);

    m.canOpenDoors = true; // open doors / fence gates automatically
    m.allowParkour = CONFIG.pathing.allowParkour; // jump across small gaps
    m.allowSprinting = true;
    m.canDig = CONFIG.pathing.canDig;
    m.maxDropDown = CONFIG.pathing.maxDropDown; // cliff avoidance
    m.allow1by1towers = false; // do not place blocks while pathing...
    m.scafoldingBlocks = []; // ...(property name is spelled this way upstream)

    // Treat hazards as unsafe in addition to pathfinder's own liquid handling
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

  // -------------------------------------------------------------------------
  // Task management (follow / come)
  // -------------------------------------------------------------------------
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
    this.anchor = null; // next idle period re-anchors at the current position
    this.noPathCount = 0;
    this.escapeAttempts = 0;
    try {
      this.bot.pathfinder.setGoal(null);
      if (typeof this.bot.pathfinder.stop === 'function') this.bot.pathfinder.stop();
    } catch (_) {
      /* bot may be disconnected */
    }
    try {
      this.bot.clearControlStates();
    } catch (_) {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Anti-stuck + pit escape
  // -------------------------------------------------------------------------
  stuckTick() {
    if (!this.isReady()) return;
    const now = Date.now();
    const pos = this.bot.entity.position;

    const moved = !this.lastPos || pos.distanceTo(this.lastPos) >= CONFIG.stuck.minMoveDist;
    if (moved) {
      this.lastPos = pos.clone();
      this.lastMoveAt = now;
      // Real progress for a while => forget earlier failed escapes
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

    // Already close enough to the target: standing still is fine
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

      // 1. Drop the current goal and release every control
      bot.pathfinder.setGoal(null);
      if (typeof bot.pathfinder.stop === 'function') bot.pathfinder.stop();
      bot.clearControlStates();
      await sleep(100);

      // 2. Pick an escape strategy
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
      try {
        bot.clearControlStates();
      } catch (_) {
        /* ignore */
      }
      await sleep(200);
      this.escaping = false;
      if (this.isReady() && this.task) {
        // 3. Retry navigation with a fresh goal
        this.noPathCount = 0;
        this.lastPos = this.bot.entity.position.clone();
        this.lastMoveAt = Date.now();
        this.applyGoal();
      }
    }
  }

  /** True when every horizontal neighbour has a solid block at head level (cannot simply jump out). */
  isTrapped() {
    const bot = this.bot;
    const base = bot.entity.position.floored
