# OSCAR demo results (npm run demo:all)

Generated: 2026-09-30T02:18:20.708Z

| demo | outcome | run | failed criteria |
| --- | --- | --- | --- |
| routine_maintenance | PASS | run-001-1 | — |
| exchange_and_mix | PASS | run-001-1 | — |
| environment_drift | PASS | run-001-1 | — |
| anomaly_recovery | PASS | run-001-1 | — |

## Criteria detail

### routine_maintenance (pass)

- run: run-001-1 / experiment: exp-001
- actions: act-001-01 imaging.scan succeeded, act-001-02 media.add succeeded, act-001-03 imaging.scan succeeded
- observations: obs-001-001, obs-001-002

- [x] run ended with reason "completed" — status=ended reason=completed
- [x] determinism not broken — determinism_broken=false
- [x] focus row within target band after run — row A volumes 770.9, 750.9, 780.9, 790.9, 765.9, 775.9 µL vs band 600–900
- [x] reservoir decreased by exactly Σ added — Σ|reservoir_delta_ul|=2226.000 vs snapshot delta=2226.000 µL
- [x] tips decreased by 6 per pickup (6 per media.add) — tips used 6 for 1 media.add action(s)
- [x] other rows / other plate unchanged (± evaporation) — all within tolerance
- [x] rescan observation after the add cites the row wells — obs-001-002 at sim 54 s covers A1,A2,A3,A4,A5,A6
- [x] every liquid action cites a fresh observation covering the row — act-001-02 -> [obs-001-001]
- [x] final report present on the Runtime — GET /api/v1/runs/{id}/report 200

### exchange_and_mix (pass)

- run: run-001-1 / experiment: exp-001
- actions: act-001-01 imaging.scan succeeded, act-001-02 media.exchange succeeded, act-001-03 plate.shake succeeded, act-001-04 imaging.scan succeeded
- observations: obs-001-001, obs-001-002

- [x] run ended with reason "completed" — status=ended reason=completed
- [x] determinism not broken — determinism_broken=false
- [x] exchange action succeeded — act-001-02 succeeded
- [x] waste +Σremoved — waste used 2399.913 vs Σremoved 2399.913 µL
- [x] reservoir −Σadded (= Σremoved under fraction exchange) — reservoir delta 2399.913 vs Σadded 2399.913 µL
- [x] row volumes restored (± evaporation tolerance) — A1: 810→809.8, A2: 800→799.8, A3: 795→794.8, A4: 805→804.8, A5: 790→789.8, A6: 800→799.8
- [x] tips −12 (two pickups) — tips used 12
- [x] shake succeeded — act-001-03 succeeded
- [x] shake started/stopped events present — shake_started=true shake_stopped=true
- [x] post-settle rescan exists — obs-001-002 at 137 s (settle until 126 s)
- [x] before/after observations comparable with different image hashes — obs-001-001 vs obs-001-002 (same wells, hashes differ)
- [x] exchange cites fresh scan evidence — act-001-02 -> [obs-001-001]
- [x] final report present on the Runtime — GET /api/v1/runs/{id}/report 200

### environment_drift (pass)

- run: run-001-1 / experiment: exp-001
- actions: act-001-01 environment.set_targets succeeded, act-001-02 imaging.scan succeeded, act-001-03 environment.await_stable succeeded, act-001-04 imaging.scan succeeded
- observations: obs-001-001, obs-001-002

- [x] run ended with reason "completed" — status=ended reason=completed
- [x] determinism not broken — determinism_broken=false
- [x] set_targets succeeded (immediate) — act-001-01 succeeded
- [x] first scan blurred with null estimates — obs-001-001 quality=blurred, estimates all null
- [x] agent decision log records that no visual conclusion was drawn — obs obs-001-001 quality=blurred (device_estimate values null): no visual conclusion drawn; not fabricating readings — awaiting environment stability before resc
- [x] await_stable succeeded — act-001-03 succeeded
- [x] a later non-blurred scan exists — obs-001-002@581s
- [x] final chamber observed within tolerance — observed 36.88 °C / 4.88 % / 93.47 % vs targets ±0.3/±0.2/±3
- [x] final report present on the Runtime — GET /api/v1/runs/{id}/report 200

### anomaly_recovery (pass)

- run: run-001-1 / experiment: exp-001
- actions: act-001-01 imaging.scan succeeded, act-001-02 media.add succeeded, act-001-03 imaging.scan succeeded
- observations: obs-001-001, obs-001-002

- [x] media.add was running when the agent was killed — act-001-02 status=running
- [x] run paused(agent_restarted) after agent restart — status reason 'agent_restarted'
- [x] no new actions while the agent is paused — actions 2 -> 2
- [x] exactly one media.* action with effects (no repeat after reconcile) — act-001-02:succeeded:wells=6
- [x] run ended and completed — status=ended reason=completed
- [x] determinism not broken — determinism_broken=false
- [x] final report present on the Runtime — GET /api/v1/runs/{id}/report 200
