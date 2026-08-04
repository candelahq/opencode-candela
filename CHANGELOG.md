# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-08-03

### Added
- Settings test suite with 20 tests covering all update functions
- Tool cost breakdown (`/tools` slash command) with proportional cost allocation
- Analytics tests for `getToolCostBreakdown` (4 tests)
- README documentation
- This changelog

## [0.5.2] - 2026-08-03

### Added
- `/history` slash command to browse recent sessions with cost, duration, tags, and repo
- `/patterns` slash command for time-of-day cost analysis (morning/afternoon/evening/night)
- `/annotate` slash command for git commit cost metadata trailers
- Automatic git repository detection for per-repo cost attribution
- `getSessionHistory()` and `getTimeOfDayPatterns()` analytics functions
- 5 new analytics tests

## [0.5.1] - 2026-08-03

### Added
- `/quiet` command and `CANDELA_QUIET` setting to suppress info toasts
- `/tag` command for session cost attribution (auto-detects git branch)
- `/cap` command and `CANDELA_SESSION_CAP` for per-session spending limits
- Session cost forecasting based on call rate extrapolation

## [0.5.0] - 2026-08-03

### Added
- Context window gauge with visual token usage indicator and compaction warnings
- `/goal` slash command and `CANDELA_DAILY_GOAL` for daily cost targets

### Fixed
- JSONL analytics rotation: prune entries >90 days, cap at 10MB
- CodeRabbit review: timestamp validation, MAX_FILE_BYTES enforcement

## [0.4.0] - 2026-08-03

### Added
- Cost streaks tracking consecutive under-budget days
- Cost anomaly detection alerting at 2x+ average session cost
- Budget pacing forecast estimating exhaustion time
- Model efficiency scoring by cost-per-call
- Weekly spending digest with week-over-week comparison
- `/export` command for JSON + CSV data export

### Fixed
- Session baseline drift causing inaccurate cost/call deltas

## [0.3.0] - 2026-08-01

### Added
- Per-response cost deltas in prompt and status bar
- Startup spend trend summary (yesterday, weekly, daily average)
- Sidebar session activity and tool usage statistics
- Cross-promotion for Candela web dashboard

## [0.2.0] - 2026-07-30

### Added
- TUI sidebar dashboard with live cost metrics
- Budget tracking with grant support and threshold warnings
- `/cost`, `/budget`, `/models`, `/dashboard` slash commands
- Smart model routing suggestions based on budget thresholds
- Cost-awareness system prompt injection during compaction

[0.6.0]: https://github.com/candelahq/opencode-candela/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/candelahq/opencode-candela/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/candelahq/opencode-candela/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/candelahq/opencode-candela/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/candelahq/opencode-candela/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/candelahq/opencode-candela/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/candelahq/opencode-candela/releases/tag/v0.2.0
