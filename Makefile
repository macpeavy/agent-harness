# agent-harness — session launch + dev ergonomics.
#
# A full chief session is one command:
#   make up    → tmux with the chief (opencode) filling the window, attached; gateway +
#                daemon + session-loop ride a thin log strip across the top (out of the way).
#                Talk to the chief, say "go", it dispatches. make down tears it down.
#   make down  → tear the whole session down.
#
# The log strip's height is tunable: make up LOGS_HEIGHT=4  (or =0 to make the chief
# truly full-window — the log processes then run in a hidden tmux window, Ctrl-b 1 to peek).
#
# The pieces (also what the panes run):
#   make gateway      → LiteLLM on :4000 (reads .env; needs the .venv — see config/README.md)
#   make daemon       → the dispatch loop daemon (drives each chunk build→review→merge)
#   make session-loop → the session loop (opens session PRs, advances each session's DAG)
#   make chief        → the opencode TUI with the chief agent selected
#
# Dev:
#   make check   → typecheck + test (run before every commit)
#   make migrate → apply the substrate DB migrations once (up runs this before the panes)
#   make db      → regenerate Drizzle migrations from the schema
#
# Operator:
#   make abandon FEATURE=<id> → kill a feature: its sessions/chunks/dispatches → abandoned,
#                               close its open PRs, delete its branches (idempotent)
#
# Prereqs: tmux, bun, opencode, the litellm .venv (config/README.md), and .env (.env.example).

GATEWAY_PORT ?= 4000
SESSION ?= agent-harness
# Height (lines) of the top gateway+daemon log strip. 0 = hide them in a separate tmux
# window so the chief fills the whole window (switch to them with Ctrl-b 1).
LOGS_HEIGHT ?= 6
# Width of the live status pane — a narrow left column beside the chief (the compact card view
# fits ~20%). A percentage or a column count; tmux 3.1+ accepts `N%`.
STATUS_WIDTH ?= 20%

# Panes drop to a shell when their process exits, so a crash/Ctrl-C leaves the logs (and a
# prompt to restart) visible instead of vanishing.
HOLD := exec $${SHELL:-sh}

# Load .env (OPENROUTER_API_KEY, LITELLM_MASTER_KEY) into a command's environment. The
# gateway, the daemon (its builds call the gateway), and the chief (opencode authenticates
# to the gateway with LITELLM_MASTER_KEY) all need it.
LOADENV := set -a; source .env; set +a;

# Create the detached session at the REAL terminal size, not tmux's 80x24 default — else a
# fixed `-l` pane size (the thin log strip) is computed against 24 lines and then scaled up
# proportionally on attach, ballooning the strip. tput reads the terminal `make up` runs in.
SIZE := -x $$(tput cols 2>/dev/null || echo 200) -y $$(tput lines 2>/dev/null || echo 50)

.PHONY: up down gateway daemon session-loop chief check migrate db abandon gate-builder status

up: migrate
	@if tmux has-session -t $(SESSION) 2>/dev/null; then \
		echo "session '$(SESSION)' already up — attaching"; \
	elif [ "$(LOGS_HEIGHT)" -eq 0 ]; then \
		chief=$$(tmux new-session -d -P -F '#{pane_id}' $(SIZE) -s $(SESSION) -n chief 'make chief; $(HOLD)'); \
		tmux split-window -h -b -l $(STATUS_WIDTH) -t $$chief 'make status-watch; $(HOLD)'; \
		tmux new-window -d -t $(SESSION) -n logs 'make gateway; $(HOLD)'; \
		tmux split-window -h -t $(SESSION):logs 'make daemon; $(HOLD)'; \
		tmux split-window -h -t $(SESSION):logs 'make session-loop; $(HOLD)'; \
		tmux select-pane -t $$chief; \
	else \
		chief=$$(tmux new-session -d -P -F '#{pane_id}' $(SIZE) -s $(SESSION) -n stack 'make chief; $(HOLD)'); \
		tmux split-window -v -b -l $(LOGS_HEIGHT) -t $$chief 'make gateway; $(HOLD)'; \
		tmux split-window -h -t $(SESSION) 'make daemon; $(HOLD)'; \
		tmux split-window -h -t $(SESSION) 'make session-loop; $(HOLD)'; \
		tmux split-window -h -b -l $(STATUS_WIDTH) -t $$chief 'make status-watch; $(HOLD)'; \
		tmux select-pane -t $$chief; \
	fi
	@tmux attach -t $(SESSION)

down:
	@tmux kill-session -t $(SESSION) 2>/dev/null && echo "session '$(SESSION)' down" || echo "no session '$(SESSION)'"

gateway:
	bash -c '$(LOADENV) exec .venv/bin/litellm --config config/litellm.yaml --port $(GATEWAY_PORT)'

daemon:
	bash -c '$(LOADENV) exec bun run daemon'

session-loop:
	bash -c '$(LOADENV) exec bun run session-loop'

chief:
	bash -c '$(LOADENV) exec opencode --agent chief'

# Apply the substrate DB migrations once, before the long-running panes open the db. `up`
# depends on this so the daemon + session-loop (which open the db with migrate-on-construct
# OFF) never race each other migrating the same SQLite file (ADR 0016 refinement).
migrate:
	bash -c '$(LOADENV) bun run migrate'

# Operator kill switch: make abandon FEATURE=<featureId>
abandon:
	@test -n "$(FEATURE)" || { echo "usage: make abandon FEATURE=<featureId>"; exit 1; }
	bash -c '$(LOADENV) bun run src/cli/abandon.ts $(FEATURE)'

# Fleet status: render live fleet status from the substrate DB (one shot).
status:
	bash -c '$(LOADENV) bun run src/cli/fleet-status.ts'

# Live-refreshing fleet status — the watch pane `make up` opens so the operator can see build
# progress (and a stalled dispatch) without running `status` by hand. Re-renders every
# STATUS_INTERVAL seconds; the CLI is a cheap read of the substrate DB.
STATUS_INTERVAL ?= 5
status-watch:
	bash -c '$(LOADENV) while :; do clear; bun run src/cli/fleet-status.ts; sleep $(STATUS_INTERVAL); done'

# Builder-acceptance gate (ADR 0025): drive the real build leg against a canned write-required
# chunk and prove the model produces a typechecking diff under budget. ROUTE defaults to builder.
# A model only ships as the builder with a recorded green run. Needs the gateway up.
gate-builder:
	bash -c '$(LOADENV) bun run src/cli/gate-builder.ts $(ROUTE)'

check:
	bun run typecheck
	bun test

db:
	bun run db:generate
