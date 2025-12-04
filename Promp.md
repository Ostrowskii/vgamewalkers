currently, in this repository, every time we render a frame, we re-compute the states, from
the first frame, all the way to the last. this is prohibitive: after ~3 minutes or so that a
room has been active, vibi.ts will start lagging a lot. our goal is to improve vibi.ts, so that
 it caches past states; that way, when we need to compute the state of tick 50, for example, if
 we already have state 46 cached, then, we only need to recompute 47, 48, 49, 50. note that the
 user is instructed not to mutate the state on its on_tick/on_post handlers. that means that vibi.ts
can assume that's the case. as such, to record a state, we could just hold an array which would
 store the state of every tick even if doing so would lead to immense space requirements. As soon as the 
 client enters the game, it will compute all the states from initial_tick, append it to a array, up to the current tick, then for tick current_tick + 1, it will query the state arrays and only compute the new state.
 
 
smarter strategy would be to simply cache the last state, and update it when a tick/event
occurs. yet, note that the tick on which a post occurred is computed based on the post's
fields, and that isn't guaranteed to be in order; i.e., a post that we process after could take
 place in an earlier tick. that's why compute_state_at on vibi.ts first builds a timeline
(mapping tick → posts), and only then computes each tick, from beginning to end. because of
that, caching the latest state isn't enough; we need to cache, for now, all past states, too. 




======================
to do so while
avoiding space waste, we'll use an immutable rollback list (a logarithmic-space history/undo
stack, sometimes called a "skew binary" or "exponentially-spaced snapshot" structure). there is
 an example on ./rollback.js. it must be ported to .ts, and incorporated into this codebase
cleanly. you must reason about it to learn how it works. whenever we compute a tick's state, we
 push that to this structure. and before computing a tick's state, we make sure to start from
the most recent snapshot available. finally, when we receive a new post from the internet,
before storing it, we must invalidate snapshot states accordingly. for example, if we receive a
 post whose official tick is 1700, we must remove all cached states of tick >= 1700 from the
cached state rollback list. now, implement these changes, and include a file to test them
comprehensively (mock as needed). let me know when you're done