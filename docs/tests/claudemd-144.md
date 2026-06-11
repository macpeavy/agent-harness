# CLAUDE.md feat-144-claudemd-s1-c1 Acceptance Checklist

## Pass criteria

- [x] Section '## Current phase: the spike' is gone.
- [x] New section heading is '## Current phase: hardening + measurement'.
- [x] Section body mentions: Drizzle registry, dispatch-loop daemon, amend cycle, session-main, budget guard.
- [x] Section body mentions: hardening and P4 measurement.
- [x] Section body names model seats: Haiku 4.5 (builder), claude-sonnet-4.6 (reviewer + chief).
- [x] Section body mentions Opus principal A/B as planned.
- [x] Section body references 'port' track (not 'spike' label).
- [x] All other sections unchanged (diff shows only the replaced section + test file add).

## Verification

### Old section removed
The old '## Current phase: the spike' section has been replaced entirely.

### New section structure
- Heading: `## Current phase: hardening + measurement` ✓
- First paragraph describes live system: Drizzle-backed dispatch registry, dispatch-loop daemon, amend cycle, session-main, budget guard ✓
- Second paragraph describes live phase: hardening + P4 measurement (amend rate, cost-per-feature, reliability) ✓
- Backlog reference: 'agent-harness' Linear team, 'port' track ✓
- Third paragraph names model seats:
  - builder = Claude Haiku 4.5 (cheap route, gated by `make gate-builder` — ADR 0025) ✓
  - reviewer = claude-sonnet-4.6 (pinned) ✓
  - chief = claude-sonnet-4.6 (Sonnet now; Opus principal A/B is planned) ✓

### Other sections preserved
- '## What this project is': unchanged ✓
- '## Hard conventions': unchanged ✓
- '## Coding standards & skills': unchanged ✓
- '## Where things go': unchanged ✓
- '## Decisions of record': unchanged ✓

All pass criteria met. No runtime test needed (docs-only change).
