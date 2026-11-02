# Project working conventions

- All project source, dependencies, tests, scratch files, and build artifacts belong under D:\VScodeProgects. This project root is D:\VScodeProgects\harness-engineering; Pi is the separate existing repository D:\VScodeProgects\pi.
- Work through complete authorized milestones; do not stop after small changes when independent work remains.
- At the end of each milestone, write one accessible Chinese Markdown summary under D:\Obsidian\main\90-Templates\Harness Engineering. Inspect existing numbered files and use the next integer, naming the file 数字_改动.md with a concrete description of the milestone's advance.
- Each milestone summary explains what was done and added, significance, value and functionality, measured results, problems solved, technologies used, difficulties encountered, likely difficulties for the user, and next steps. Distinguish measured evidence from untested claims.
- Preserve existing changes in the Pi repository. Prefer public SDK/Extension interfaces in production; M0 source imports are validation scaffolding.
- M0 reproducible check: npm run verify:runtime. It uses an offline scripted model with actual Pi sessions and tools. Do not present it as evidence of live model quality or evolution benefits.
- M1 uses exact registry SDK dependencies from package-lock.json. Production adapters import public package exports, not neighboring Pi internal source paths.
- For code changes, run npm run check and relevant Node tests; run npm test for milestone acceptance. Preserve independent verification, state/event transactions, cancellation controls, and the distinction between task completion and export errors.
- M1 accepted baseline and test evidence are recorded in validation/task-execution/acceptance.json. Do not overwrite historical acceptance evidence merely to make a new change look passing; record new milestone results separately.
- M2 adds per-tool governance and approvals. Keep side-effect tools non-retryable, distinguish timeout from unknown outcomes, bind approval to exact arguments/target/policy, and atomically consume approval with attempt budget authorization.
- M2 acceptance evidence is recorded in validation/tool-governance/acceptance.json. Full regression covers 49 unique cases; an additional targeted audit check validates ask is not logged as granted permission. Preserve previous milestone records.
- M3 adds durable checkpoints, operation evidence, and explicit resume. Never treat message_end as already persisted; retain native Session snapshots at complete boundaries. Resume forks the saved Session, inherits cumulative budgets, and claims one child per source transactionally.
- Refuse unknown post-checkpoint side effects, unmetered model requests, uncertain verifier termination, workspace/artifact drift, and missing history. Never silently restart from scratch or inherit old approval receipts.
- M3 acceptance is recorded in validation/recovery/acceptance.json with 70 passing cases (49 regression + 21 new). Preserve historical milestone evidence. Run npm run demo:recovery for the self-contained owned-Worker crash demo.

- Current modules, tests, scripts and document filenames are named by responsibility. Historical validation manifests remain immutable and refer to their original paths. See validation/README.md.
- Context snapshots are frozen per Run and bound to checkpoints. Resume must not re-query current memory; reject modified snapshots. Do not treat extension callback exceptions alone as a reliable provider-request barrier.
- Memory is explicitly authored with source references, workspace isolation, bounded retrieval, revision checks, expiry and retirement. Never promote model claims or compaction evidence indexes into verified facts automatically.
- Run npm run demo:context for the local long-material demonstration; its output measures mechanisms, not live model quality.
- Context/memory acceptance: validation/context-memory/acceptance.json, 84 passing tests (70 regression + 14 new), plus 9 runtime compatibility checks. Preserve its evidence separately from historical baselines.
- Benchmark acceptance is separate from model capability: npm test validates mechanisms without paid calls; benchmarks/baselines/deepseek-flash-2026-11-02 records 32 real trials and independent audit. Never relabel scripted trials as live.
- Keep fixed task/verifier/runtime fingerprints and seeded paired trial order. Retain failed trials and separate memory-dependent information-availability cases from general-task claims. Do not overwrite published baselines or silently rerun selected failures.
- Benchmark results and experiences are append-only SQLite evidence; diagnoses remain unestablished and cannot become automatic policies. Raw Sessions, memory, and benchmark databases remain local under ignored artifacts.
- Before real provider dispatch, persist modelInFlight and check estimated remaining cost. A host rejection before dispatch must not invent uncertain provider usage; a genuinely interrupted dispatch must remain uncertain and block safe replay.
- Context capacity estimates exclude host-only details/usage/timestamp metadata; details may contain complete duplicate tool output. Preserve full native evidence while estimating provider-visible content.
- Current acceptance: validation/benchmark/acceptance.json; 99 passing tests (84 regression + 15 new), 32 live trials, 88 independently rerun fixed checks.
