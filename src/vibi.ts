import * as client from "./client.ts";

type Post<P> = {
  room: string;
  index: number;
  server_time: number;
  client_time: number;
  name?: string; // unique id for dedup/reindex (optional for legacy)
  data: P;
};

export class Vibi<S, P> {
  room:        string;
  init:        S;
  on_tick:     (state: S) => S;
  on_post:     (post: P, state: S) => S;
  smooth:      (past: S, curr: S) => S;
  tick_rate:   number;
  tolerance:   number;
  room_posts:  Map<number, Post<P>>;
  local_posts: Map<string, Post<P>>; // predicted local posts keyed by name
  state_cache: S[];                  // cached states keyed by tick offset
  cache_start: number | null;        // tick corresponding to state_cache[0]
  timeline:    Map<number, Post<P>[]> | null; // cached timeline of posts per tick

  // Compute the authoritative time a post takes effect.
  private official_time(post: Post<P>): number {
    if (post.client_time <= post.server_time - this.tolerance) {
      return post.server_time - this.tolerance;
    } else {
      return post.client_time;
    }
  }

  // Convert a post into its authoritative tick.
  private official_tick(post: Post<P>): number {
    return this.time_to_tick(this.official_time(post));
  }

  // Drop any lingering local predictions for the same player up to the official time.
  // Returns the earliest tick affected (for cache invalidation), or null if none removed.
  private drop_local_predictions(player_id: string | undefined, official_time: number): number | null {
    if (!player_id) return null;

    let earliest_tick: number | null = null;

    for (const [name, local_post] of this.local_posts.entries()) {
      const pdata: any = local_post.data as any;
      const lp_player: string | undefined = (pdata && (pdata.player ?? pdata.nick)) as string | undefined;
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
  private reset_cache(): void {
    this.state_cache.length = 0;
    this.cache_start = null;
  }

  // Drop cached states from the provided tick (inclusive) onward.
  private invalidate_cache(from_tick: number): void {
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
  private prune_stale_local_predictions(max_age_ms: number = 10_000): number | null {
    const now = this.server_time();
    let earliest_tick: number | null = null;

    for (const [name, local_post] of this.local_posts.entries()) {
      if (now - local_post.client_time >= max_age_ms) {
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
  private invalidate_timeline(): void {
    this.timeline = null;
  }

  constructor(
    room:      string,
    init:      S,
    on_tick:   (state: S) => S,
    on_post:   (post: P, state: S) => S,
    smooth:    (past: S, curr: S) => S,
    tick_rate: number,
    tolerance: number
  ) {
    this.room        = room;
    this.init        = init;
    this.on_tick     = on_tick;
    this.on_post     = on_post;
    this.smooth      = smooth;
    this.tick_rate   = tick_rate;
    this.tolerance   = tolerance;
    this.room_posts  = new Map();
    this.local_posts = new Map();
    this.state_cache = [];
    this.cache_start = null;
    this.timeline    = null;

    // Wait for initial time sync before interacting with server
    client.on_sync(() => {
      console.log(`[VIBI] synced; watching+loading room=${this.room}`);
      // Watch the room with callback
      client.watch(this.room, (post) => {
        // Drop stale muletas (>=10s old) and track earliest invalidation tick.
        const prune_tick = this.prune_stale_local_predictions();

        const official_tick = this.official_tick(post);
        const official_time = this.official_time(post);
        const pdata: any = post.data as any;
        const player_id: string | undefined = (pdata && (pdata.player ?? pdata.nick)) as string | undefined;
        let invalidate_from: number | null = prune_tick;

        // If this official post matches a local predicted one, drop the local copy
        if (post.name && this.local_posts.has(post.name)) {
          const local_post = this.local_posts.get(post.name)!;
          this.local_posts.delete(post.name);
          const tick = this.official_tick(local_post);
          invalidate_from = invalidate_from === null ? tick : Math.min(invalidate_from, tick);
        }

        // Drop any lingering local predictions for the same player up to this official time.
        const drop_tick = this.drop_local_predictions(player_id, official_time);
        if (drop_tick !== null) {
          invalidate_from = invalidate_from === null ? drop_tick : Math.min(invalidate_from, drop_tick);
        }

        this.room_posts.set(post.index, post);
        const target_tick = invalidate_from === null ? official_tick : Math.min(invalidate_from, official_tick);
        this.invalidate_cache(target_tick);
      });

      // Load all existing posts
      client.load(this.room, 0);
    });
  }

  // No extra helpers needed with local_posts: simplicity preserved

  time_to_tick(server_time: number): number {
    return Math.floor((server_time * this.tick_rate) / 1000);
  }

  server_time(): number {
    return client.server_time();
  }

  server_tick(): number {
    return this.time_to_tick(this.server_time());
  }

  // Total official posts loaded for this room
  post_count(): number {
    return this.room_posts.size;
  }

  // Compute a render-ready state by blending authoritative past and current
  // using the provided smooth(past, curr) function.
  compute_render_state(): S {
    const curr_tick  = this.server_tick();
    const tick_ms    = 1000 / this.tick_rate;
    const tol_ticks  = Math.ceil(this.tolerance / tick_ms);
    const rtt_ms     = client.ping();
    const half_rtt   = isFinite(rtt_ms) ? Math.ceil((rtt_ms / 2) / tick_ms) : 0;
    const past_ticks = Math.max(tol_ticks, half_rtt + 1);
    const past_tick  = Math.max(0, curr_tick - past_ticks);

    const past_state = this.compute_state_at(past_tick);
    const curr_state = this.compute_state_at(curr_tick);

    return this.smooth(past_state, curr_state);
  }

  initial_time(): number | null {
    const post = this.room_posts.get(0);
    if (!post) {
      return null;
    }
    return this.official_time(post);
  }

  initial_tick(): number | null {
    const t = this.initial_time();
    if (t === null) {
      return null;
    }
    return this.time_to_tick(t);
  }

  private build_timeline(): Map<number, Post<P>[]> {
    if (this.timeline) {
      return this.timeline;
    }

    const timeline = new Map<number, Post<P>[]>();

    for (const post of this.room_posts.values()) {
      const official_tick = this.official_tick(post);
      if (!timeline.has(official_tick)) {
        timeline.set(official_tick, []);
      }
      timeline.get(official_tick)!.push(post);
    }

    for (const post of this.local_posts.values()) {
      const official_tick = this.official_tick(post);
      if (!timeline.has(official_tick)) {
        timeline.set(official_tick, []);
      }
      const local_queued: Post<P> = { ...post, index: Number.MAX_SAFE_INTEGER };
      timeline.get(official_tick)!.push(local_queued);
    }

    for (const posts of timeline.values()) {
      posts.sort((a, b) => a.index - b.index);
    }

    this.timeline = timeline;
    return timeline;
  }

  compute_state_at(at_tick: number): S {
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

    const timeline   = this.build_timeline();
    let state: S     = this.init;
    let start_tick   = initial_tick;

    if (this.cache_start !== null && this.state_cache.length > 0) {
      const highest_cached_tick = this.cache_start + this.state_cache.length - 1;
      const usable_cached_tick  = Math.min(highest_cached_tick, at_tick);
      const cache_index         = usable_cached_tick - this.cache_start;
      if (cache_index >= 0) {
        state      = this.state_cache[cache_index];
        start_tick = usable_cached_tick + 1;
        if (start_tick > at_tick) {
          return state;
        }
      }
    }

    for (let tick = start_tick; tick <= at_tick; tick++) {
      state = this.on_tick(state);

      const posts = timeline.get(tick) || [];
      for (const post of posts) {
        state = this.on_post(post.data, state);
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
  post(data: P): void {
    const name = client.post(this.room, data);
    const t    = this.server_time();

    const local_post: Post<P> = {
      room:        this.room,
      index:       -1,
      server_time: t,
      client_time: t,
      name,
      data
    };

    this.local_posts.set(name, local_post);
    this.invalidate_cache(this.official_tick(local_post));
  }

  compute_current_state(): S {
    return this.compute_state_at(this.server_tick());
  }
}
