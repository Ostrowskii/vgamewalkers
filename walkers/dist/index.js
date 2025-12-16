var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/config.ts
var REMOTE_WSS = "wss://game.vibistudiotest.site";
function has_window() {
  return typeof window !== "undefined" && typeof window.location !== "undefined";
}
function from_global_override() {
  if (!has_window()) return void 0;
  const global_any = window;
  if (typeof global_any.__VIBI_WS_URL__ === "string") {
    return global_any.__VIBI_WS_URL__;
  }
  return void 0;
}
function normalize(value) {
  if (value.startsWith("wss://")) {
    return value;
  }
  if (value.startsWith("ws://")) {
    return `wss://${value.slice("ws://".length)}`;
  }
  return `wss://${value}`;
}
function from_query_param() {
  if (!has_window()) return void 0;
  try {
    const url = new URL(window.location.href);
    const value = url.searchParams.get("ws");
    if (value) {
      return normalize(value);
    }
  } catch {
  }
  return void 0;
}
function detect_url() {
  const manual = from_global_override() ?? from_query_param();
  if (manual) {
    return manual;
  }
  return REMOTE_WSS;
}
var WS_URL = detect_url();

// src/client.ts
var time_sync = {
  clock_offset: Infinity,
  lowest_ping: Infinity,
  request_sent_at: 0,
  last_ping: Infinity
};
var ws = new WebSocket(WS_URL);
var room_watchers = /* @__PURE__ */ new Map();
var is_synced = false;
var sync_listeners = [];
function now() {
  return Math.floor(Date.now());
}
function server_time() {
  if (!isFinite(time_sync.clock_offset)) {
    throw new Error("server_time() called before initial sync");
  }
  return Math.floor(now() + time_sync.clock_offset);
}
function ensure_open() {
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error("WebSocket not open");
  }
}
function send(obj) {
  ensure_open();
  ws.send(JSON.stringify(obj));
}
function register_handler(room2, handler) {
  if (!handler) {
    return;
  }
  if (room_watchers.has(room2)) {
    throw new Error(`Handler already registered for room: ${room2}`);
  }
  room_watchers.set(room2, handler);
}
ws.addEventListener("open", () => {
  console.log("[WS] Connected");
  time_sync.request_sent_at = now();
  ws.send(JSON.stringify({ $: "get_time" }));
  setInterval(() => {
    time_sync.request_sent_at = now();
    ws.send(JSON.stringify({ $: "get_time" }));
  }, 2e3);
});
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.$) {
    case "info_time": {
      const t = now();
      const ping2 = t - time_sync.request_sent_at;
      time_sync.last_ping = ping2;
      if (ping2 < time_sync.lowest_ping) {
        const local_avg = Math.floor((time_sync.request_sent_at + t) / 2);
        time_sync.clock_offset = msg.time - local_avg;
        time_sync.lowest_ping = ping2;
      }
      if (!is_synced) {
        is_synced = true;
        for (const cb of sync_listeners) {
          cb();
        }
        sync_listeners.length = 0;
      }
      break;
    }
    case "info_post": {
      const handler = room_watchers.get(msg.room);
      if (handler) {
        handler(msg);
      }
      break;
    }
  }
});
function gen_name() {
  const alphabet = "_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-";
  const bytes = new Uint8Array(8);
  const can_crypto = typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function";
  if (can_crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 8; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i] % 64];
  }
  return out;
}
function post(room2, data) {
  const name = gen_name();
  send({ $: "post", room: room2, time: server_time(), name, data });
  return name;
}
function load(room2, from = 0, handler) {
  register_handler(room2, handler);
  send({ $: "load", room: room2, from });
}
function watch(room2, handler) {
  register_handler(room2, handler);
  send({ $: "watch", room: room2 });
}
function on_sync(callback) {
  if (is_synced) {
    callback();
    return;
  }
  sync_listeners.push(callback);
}
function ping() {
  return time_sync.last_ping;
}

// src/vibi.ts
var Vibi = class {
  constructor(room2, init, on_tick2, on_post2, smooth2, tick_rate, tolerance) {
    __publicField(this, "room");
    __publicField(this, "init");
    __publicField(this, "on_tick");
    __publicField(this, "on_post");
    __publicField(this, "smooth");
    __publicField(this, "tick_rate");
    __publicField(this, "tolerance");
    __publicField(this, "room_posts");
    __publicField(this, "local_posts");
    // predicted local posts keyed by name
    __publicField(this, "state_cache");
    // cached states keyed by tick offset
    __publicField(this, "cache_start");
    // tick corresponding to state_cache[0]
    __publicField(this, "timeline");
    this.room = room2;
    this.init = init;
    this.on_tick = on_tick2;
    this.on_post = on_post2;
    this.smooth = smooth2;
    this.tick_rate = tick_rate;
    this.tolerance = tolerance;
    this.room_posts = /* @__PURE__ */ new Map();
    this.local_posts = /* @__PURE__ */ new Map();
    this.state_cache = [];
    this.cache_start = null;
    this.timeline = null;
    on_sync(() => {
      console.log(`[VIBI] synced; watching+loading room=${this.room}`);
      watch(this.room, (post2) => {
        const prune_tick = this.prune_stale_local_predictions();
        const official_tick = this.official_tick(post2);
        const official_time = this.official_time(post2);
        const pdata = post2.data;
        const player_id = pdata && (pdata.player ?? pdata.nick);
        let invalidate_from = prune_tick;
        if (post2.name && this.local_posts.has(post2.name)) {
          const local_post = this.local_posts.get(post2.name);
          this.local_posts.delete(post2.name);
          const tick = this.official_tick(local_post);
          invalidate_from = invalidate_from === null ? tick : Math.min(invalidate_from, tick);
        }
        const drop_tick = this.drop_local_predictions(player_id, official_time);
        if (drop_tick !== null) {
          invalidate_from = invalidate_from === null ? drop_tick : Math.min(invalidate_from, drop_tick);
        }
        this.room_posts.set(post2.index, post2);
        const target_tick = invalidate_from === null ? official_tick : Math.min(invalidate_from, official_tick);
        this.invalidate_cache(target_tick);
      });
      load(this.room, 0);
    });
  }
  // cached timeline of posts per tick
  // Compute the authoritative time a post takes effect.
  official_time(post2) {
    if (post2.client_time <= post2.server_time - this.tolerance) {
      return post2.server_time - this.tolerance;
    } else {
      return post2.client_time;
    }
  }
  // Convert a post into its authoritative tick.
  official_tick(post2) {
    return this.time_to_tick(this.official_time(post2));
  }
  // Drop any lingering local predictions for the same player up to the official time.
  // Returns the earliest tick affected (for cache invalidation), or null if none removed.
  drop_local_predictions(player_id, official_time) {
    if (!player_id) return null;
    let earliest_tick = null;
    for (const [name, local_post] of this.local_posts.entries()) {
      const pdata = local_post.data;
      const lp_player = pdata && (pdata.player ?? pdata.nick);
      if (lp_player === player_id && local_post.client_time <= official_time) {
        this.local_posts.delete(name);
        const tick = this.official_tick(local_post);
        earliest_tick = earliest_tick === null ? tick : Math.min(earliest_tick, tick);
      }
    }
    if (earliest_tick !== null) {
      this.invalidate_cache(earliest_tick);
    }
    return earliest_tick;
  }
  // Reset all cached states.
  reset_cache() {
    this.state_cache.length = 0;
    this.cache_start = null;
  }
  // Drop cached states from the provided tick (inclusive) onward.
  invalidate_cache(from_tick) {
    this.invalidate_timeline();
    if (this.cache_start === null) {
      return;
    }
    const drop_from = from_tick - this.cache_start;
    if (drop_from <= 0) {
      this.reset_cache();
      return;
    }
    if (drop_from < this.state_cache.length) {
      this.state_cache.length = drop_from;
    }
  }
  // Remove stale local predictions older than the specified age (ms).
  // Returns the earliest tick affected, or null if none removed.
  prune_stale_local_predictions(max_age_ms = 1e4) {
    const now2 = this.server_time();
    let earliest_tick = null;
    for (const [name, local_post] of this.local_posts.entries()) {
      if (now2 - local_post.client_time >= max_age_ms) {
        this.local_posts.delete(name);
        const tick = this.official_tick(local_post);
        earliest_tick = earliest_tick === null ? tick : Math.min(earliest_tick, tick);
      }
    }
    if (earliest_tick !== null) {
      this.invalidate_cache(earliest_tick);
    }
    return earliest_tick;
  }
  // Invalidate the cached timeline so it will be rebuilt lazily.
  invalidate_timeline() {
    this.timeline = null;
  }
  // No extra helpers needed with local_posts: simplicity preserved
  time_to_tick(server_time2) {
    return Math.floor(server_time2 * this.tick_rate / 1e3);
  }
  server_time() {
    return server_time();
  }
  server_tick() {
    return this.time_to_tick(this.server_time());
  }
  // Total official posts loaded for this room
  post_count() {
    return this.room_posts.size;
  }
  // Compute a render-ready state by blending authoritative past and current
  // using the provided smooth(past, curr) function.
  compute_render_state() {
    const curr_tick = this.server_tick();
    const tick_ms = 1e3 / this.tick_rate;
    const tol_ticks = Math.ceil(this.tolerance / tick_ms);
    const rtt_ms = ping();
    const half_rtt = isFinite(rtt_ms) ? Math.ceil(rtt_ms / 2 / tick_ms) : 0;
    const past_ticks = Math.max(tol_ticks, half_rtt + 1);
    const past_tick = Math.max(0, curr_tick - past_ticks);
    const past_state = this.compute_state_at(past_tick);
    const curr_state = this.compute_state_at(curr_tick);
    return this.smooth(past_state, curr_state);
  }
  initial_time() {
    const post2 = this.room_posts.get(0);
    if (!post2) {
      return null;
    }
    return this.official_time(post2);
  }
  initial_tick() {
    const t = this.initial_time();
    if (t === null) {
      return null;
    }
    return this.time_to_tick(t);
  }
  build_timeline() {
    if (this.timeline) {
      return this.timeline;
    }
    const timeline = /* @__PURE__ */ new Map();
    for (const post2 of this.room_posts.values()) {
      const official_tick = this.official_tick(post2);
      if (!timeline.has(official_tick)) {
        timeline.set(official_tick, []);
      }
      timeline.get(official_tick).push(post2);
    }
    for (const post2 of this.local_posts.values()) {
      const official_tick = this.official_tick(post2);
      if (!timeline.has(official_tick)) {
        timeline.set(official_tick, []);
      }
      const local_queued = { ...post2, index: Number.MAX_SAFE_INTEGER };
      timeline.get(official_tick).push(local_queued);
    }
    for (const posts of timeline.values()) {
      posts.sort((a, b) => a.index - b.index);
    }
    this.timeline = timeline;
    return timeline;
  }
  compute_state_at(at_tick) {
    const initial_tick = this.initial_tick();
    if (initial_tick === null) {
      this.reset_cache();
      return this.init;
    }
    if (at_tick < initial_tick) {
      return this.init;
    }
    if (this.cache_start !== initial_tick) {
      this.state_cache.length = 0;
      this.cache_start = initial_tick;
    }
    const timeline = this.build_timeline();
    let state = this.init;
    let start_tick = initial_tick;
    if (this.cache_start !== null && this.state_cache.length > 0) {
      const highest_cached_tick = this.cache_start + this.state_cache.length - 1;
      const usable_cached_tick = Math.min(highest_cached_tick, at_tick);
      const cache_index = usable_cached_tick - this.cache_start;
      if (cache_index >= 0) {
        state = this.state_cache[cache_index];
        start_tick = usable_cached_tick + 1;
        if (start_tick > at_tick) {
          return state;
        }
      }
    }
    for (let tick = start_tick; tick <= at_tick; tick++) {
      state = this.on_tick(state);
      const posts = timeline.get(tick) || [];
      for (const post2 of posts) {
        state = this.on_post(post2.data, state);
      }
      if (this.cache_start !== null) {
        const cacheIndex = tick - this.cache_start;
        if (cacheIndex === this.state_cache.length) {
          this.state_cache.push(state);
        } else if (cacheIndex >= 0 && cacheIndex < this.state_cache.length) {
          this.state_cache[cacheIndex] = state;
        }
      }
    }
    return state;
  }
  // Post data to the room
  post(data) {
    const name = post(this.room, data);
    const t = this.server_time();
    const local_post = {
      room: this.room,
      index: -1,
      server_time: t,
      client_time: t,
      name,
      data
    };
    this.local_posts.set(name, local_post);
    this.invalidate_cache(this.official_tick(local_post));
  }
  compute_current_state() {
    return this.compute_state_at(this.server_tick());
  }
};

// package.json
var package_default = {
  name: "vibi",
  type: "module",
  scripts: {
    check: "tsc --target esnext --noEmit --skipLibCheck",
    dev: "bun run index.ts",
    server: "bun run src/server.ts",
    client: "bun run client_cli.ts",
    deploy: "bash scripts/deploy.sh"
  },
  dependencies: {
    ws: "^8.18.0"
  },
  devDependencies: {
    "@types/ws": "^8.5.13"
  }
};

// walkers/index.ts
var TICK_RATE = 24;
var TOLERANCE = 10;
var PIXELS_PER_SECOND = 200;
var PIXELS_PER_TICK = PIXELS_PER_SECOND / TICK_RATE;
var WORLD_WIDTH = 1920;
var WORLD_HEIGHT = 1080;
var PLAYER_MARGIN = 12;
var initial = {};
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function on_tick(state) {
  const new_state = {};
  for (const [char, player] of Object.entries(state)) {
    const next_px = player.px + player.d * PIXELS_PER_TICK + player.a * -PIXELS_PER_TICK;
    const next_py = player.py + player.s * PIXELS_PER_TICK + player.w * -PIXELS_PER_TICK;
    new_state[char] = {
      px: clamp(next_px, PLAYER_MARGIN, WORLD_WIDTH - PLAYER_MARGIN),
      py: clamp(next_py, PLAYER_MARGIN, WORLD_HEIGHT - PLAYER_MARGIN),
      w: player.w,
      a: player.a,
      s: player.s,
      d: player.d
    };
  }
  return new_state;
}
function on_post(post2, state) {
  switch (post2.$) {
    case "spawn": {
      if (state[post2.nick]) {
        return state;
      }
      const player = {
        px: clamp(post2.px, PLAYER_MARGIN, WORLD_WIDTH - PLAYER_MARGIN),
        py: clamp(post2.py, PLAYER_MARGIN, WORLD_HEIGHT - PLAYER_MARGIN),
        w: 0,
        a: 0,
        s: 0,
        d: 0
      };
      return { ...state, [post2.nick]: player };
    }
    case "down": {
      const updated = { ...state[post2.player], [post2.key]: 1 };
      return { ...state, [post2.player]: updated };
    }
    case "up": {
      const updated = { ...state[post2.player], [post2.key]: 0 };
      return { ...state, [post2.player]: updated };
    }
  }
  return state;
}
function create_game(room2, smooth2) {
  return new Vibi(room2, initial, on_tick, on_post, smooth2, TICK_RATE, TOLERANCE);
}
var canvas = document.getElementById("game");
var ctx = canvas.getContext("2d");
function resize_canvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resize_canvas();
window.addEventListener("resize", resize_canvas);
var room = prompt("Enter room name:");
if (!room) room = gen_name();
var nick = prompt("Enter your nickname (single character):");
if (!nick || nick.length !== 1) {
  alert("Nickname must be exactly one character!");
  throw new Error("Nickname must be one character");
}
console.log("[GAME] Room:", room, "Nick:", nick);
var smooth = (past, curr) => {
  const out = {};
  for (const [char, player] of Object.entries(past)) {
    out[char] = { ...player };
  }
  if (curr[nick]) {
    out[nick] = { ...curr[nick] };
  }
  return out;
};
var game = create_game(room, smooth);
document.title = `Walkers ${package_default.version}`;
var key_states = { w: false, a: false, s: false, d: false };
on_sync(() => {
  const spawn_x = 200;
  const spawn_y = 200;
  console.log(`[GAME] Synced; spawning '${nick}' at (${spawn_x},${spawn_y})`);
  game.post({ $: "spawn", nick, px: spawn_x, py: spawn_y });
  const valid_keys = /* @__PURE__ */ new Set(["w", "a", "s", "d"]);
  function handle_key_event(e) {
    const key = e.key.toLowerCase();
    const is_down = e.type === "keydown";
    if (!valid_keys.has(key)) {
      return;
    }
    if (key_states[key] === is_down) {
      return;
    }
    key_states[key] = is_down;
    const action = is_down ? "down" : "up";
    game.post({ $: action, key, player: nick });
  }
  window.addEventListener("keydown", handle_key_event);
  window.addEventListener("keyup", handle_key_event);
  setInterval(render, 1e3 / TICK_RATE);
});
function render() {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const curr_tick = game.server_tick();
  const state = game.compute_render_state();
  const scale_x = canvas.width / WORLD_WIDTH;
  const scale_y = canvas.height / WORLD_HEIGHT;
  ctx.fillStyle = "#000";
  ctx.font = "14px monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  try {
    const st = game.server_time();
    const pc = game.post_count ? game.post_count() : 0;
    const rtt = ping();
    ctx.fillText(`room: ${room}`, 8, 6);
    ctx.fillText(`time: ${st}`, 8, 24);
    ctx.fillText(`tick: ${curr_tick}`, 8, 42);
    ctx.fillText(`post: ${pc}`, 8, 60);
    if (isFinite(rtt)) {
      ctx.fillText(`ping: ${Math.round(rtt)} ms`, 8, 78);
    }
  } catch {
  }
  ctx.fillStyle = "#000";
  ctx.font = "24px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [char, player] of Object.entries(state)) {
    const x = Math.floor(player.px * scale_x);
    const y = Math.floor(player.py * scale_y);
    ctx.fillText(char, x, y);
  }
}
export {
  create_game
};
//# sourceMappingURL=index.js.map
