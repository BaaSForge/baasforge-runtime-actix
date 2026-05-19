queue worker:
{
          "name": "isolation: sdk-same-unit-path-qw-start-handler-homonymous-wf-triple",
          "pass": false,
          "error": "qw stage-b start+handler: {\"status\":\"completed\",\"result\":{\"scopeFromHandler\":null,\"unitPathFromHandler\":\"test.wf.workflow.http-same-path-wf-handler-isolation\"}}"
        },

---

## actor alarms (intermittent — loss vs delay)

**Status:** ~0–1 failures per full run after mitigations; remaining flakes below.

### Flaky tests (observed)

| Test | Typical error |
|------|----------------|
| `alarms: alarm-past-time` | `past-due alarm never fired within 120000ms: {"alarmFired":false}` |
| `alarms: multiple-alarms-distinct-names` | `expected 3 distinct alarms to fire within 120000ms: {"firedCount":0}` (also seen `firedCount:1` earlier) |

Other alarm tests (`set-alarm-fires`, `duplicate-alarm-name-replaces`, passivation, etc.) were flaky before mitigations; now mostly stable.

### What the tests assert (intentionally strict on loss, loose on timing)

- **No wall-clock “fire at T±ε”** — polls until predicate or timeout (`waitForActorState` in `units/actor-tests/index.ts`).
- `ALARM_EVENTUAL_TIMEOUT_MS` default **120s** (`ACTOR_ALARM_EVENTUAL_TIMEOUT_MS` override); poll every **500ms** (`ALARM_POLL_MS`).
- `alarm-past-time`: `setAlarm("past", { fireAfterMs: 0 })` → must see `alarmFired === true` (immediate due; delay acceptable, **loss not**).
- `multiple-alarms-distinct-names`: schedules `a`/`b`/`c` at +500/+1000/+1500ms → must see `firedCount >= 3` (each `onAlarm` increments; **all three must run**, not on schedule).

Units: `units/actor-tests/alarms/alarm-past-time.ts`, `multiple-alarms-distinct-names.ts`. Inline runners in `units/actor-tests/index.ts` (~alarms section).

### Root cause: production alarm path under load (not test timing)

**Global alarm queue (`actor:alarms:global` ZSET in Actor Redis)**

- Sweeper: `src/services/actor_worker/alarms.rs` — loop every **200ms**, `pop_due_alarms` → spawn handlers (semaphore **64**).
- Pop: `src/services/actor_engine.rs` — Lua `ZRANGEBYSCORE` + `ZREM`, **max 32 members per sweep** (`MAX_ALARMS_POPPED_PER_SWEEP`).
- **Pop-before-ack:** member removed from global ZSET before handler finishes. On handler **Ok** → `cancel_alarm` (per-actor + global). On **Err** → `restore_alarm_to_global` (re-ZADD from per-actor `alarms` key score). If per-actor entry missing, restore is no-op → **permanent loss**.
- `set_alarm` clamps `fire_at_ms` to `max(now, requested)`; `{ fireAfterMs }` resolved in `manager.rs` at commit (`relative: true`).

**Why tests look like “loss” after 120s**

1. **Sweeper backlog** — full actor suite + many actors scheduling alarms; only 32 pops/200ms. Due alarms sit in global ZSET; test actor’s alarms may not reach front for a long time. Looks like `firedCount:0` / `alarmFired:false` until timeout. User accepts delay; 120s should usually suffice but not under heavy backlog.
2. **WS + actor parallel (fixed in test.sh)** — running `ws-tests.mjs` parallel with trigger starved sweeper; logs showed **~2+ min gap** with no `[alarm_sweeper] dispatching` while an alarm was registered (`duplicate-alarm-name-replaces` case). `test.sh` now runs **actor trigger first, WS second** (sequential).
3. **QuickJS test runner** — single OS thread; blocking `fetch`/`sleep` in poll loops. Alarm tests run **sequentially** (`mapPool(alarmJobs, 1)` in `handleRequest`) before rest at `ACTOR_TEST_RUNNER_CONCURRENCY` (8 in `test.sh`). Reduces runner contention; does not fix server queue depth.
4. **Earlier bug (fixed):** sweeper **awaited** full batch → starved loop; **pop without re-queue** on failure → loss. Now spawn + restore + `manager.rs` dedupe `pending_alarms` by name (last wins).

### Failure signatures in logs

- `[set_alarm] alarm registered` for actor but **no** matching `[alarm_sweeper] dispatching` / `alarm run ok` for that `unit_path`/`actor_id`/`alarm_name` within 120s → backlog or lost after pop.
- `scheduledAt` set, `alarmFired` false (set-alarm-fires) → schedule handler committed, alarm dispatch never observed.
- `firedCount:1` with 3 scheduled → partial delivery (2 lost or still queued).
- Search `test.terminal.log` / server logs: `alarm_sweeper`, `set_alarm`, `alarm run failed, re-queued`.

### Mitigations already applied

| Area | Change |
|------|--------|
| Server | At-least-once: ack on success, `restore_alarm_to_global` on failure; semaphore inside spawned tasks; no batch-await in sweeper |
| Server | `set_alarm` clamp; `pop_due_alarms` LIMIT 32; `manager` pending alarm dedupe by name |
| Units | `fireAfterMs` in alarm handlers (Rust computes fire time at registration) |
| Tests | Poll-until (`waitForActorState`), 120s timeout, no `firedAt` vs `Date.now()` checks |
| Tests | Alarm inline jobs sequential first; WS after actor in `test.sh` |
| Tests | `duplicate-alarm-name-replaces`: `first:120_000`, `second:1_500` so spurious first schedule does not fire during hold |

### Likely remaining issues (for fix)

1. **Global ZSET as single FIFO by score** — unrelated due alarms compete; 32/sweep × 5/s = ~160/s max dispatch starts; handler may take seconds each → effective throughput lower. Stale/orphan global members (old runs, deleted actors) consume pop slots if not cleaned (`delete_actor` scrubs by prefix in `actor_engine.rs` but only on delete).
2. **Pop-before-ack + restore gap** — crash or `ZSCORE` miss on per-actor key after pop → loss. Harden: claim/lease in global ZSET, or pop only when handler slot free, or don’t ZREM until ack.
3. **`alarm-past-time` last in alarm sequence** — runs after ~6 other alarm tests; any accumulated global backlog hits “immediate” alarm last. `firedCount:0` after 120s suggests never dispatched, not slow handler.
4. **`multiple-alarms` with `firedCount:0`** — all three never ran (total starvation) vs `1` (partial) — distinguish in logs via per-name `alarm run ok` for `a`/`b`/`c`.

### Files to touch when fixing

- `src/services/actor_worker/alarms.rs` — sweeper, concurrency, spawn/restore
- `src/services/actor_engine.rs` — `set_alarm`, `pop_due_alarms`, `restore_alarm_to_global`, `cancel_alarm`, delete cleanup
- `src/services/actor_worker/manager.rs` — `pending_alarms` → `set_alarm`
- `units/actor-tests/index.ts` — alarm inline tests, `waitForActorState`, job ordering
- `units/actor-tests/test.sh` — `ACTOR_TEST_RUNNER_CONCURRENCY`, sequential WS

### Env / repro

```bash
./units/actor-tests/test.sh          # loop for flakes
ACTOR_ALARM_EVENTUAL_TIMEOUT_MS=180000 ./units/actor-tests/test.sh
# Logs: units/actor-tests/test.terminal.log, .output.log
```

### Suggested directions (not done)

- Increase `MAX_ALARMS_POPPED_PER_SWEEP` or shard global alarm ZSET by project/hash.
- TEST_MODE: `FLUSHDB` or trim `actor:alarms:global` at suite start.
- Metric: re-queue rate, global ZSET length, time-from-due-to-dispatch.
- Optional test: assert per-alarm state (e.g. `firedNames: string[]`) not just count — catches wrong alarm firing, not queue starvation.


