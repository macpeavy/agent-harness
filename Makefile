# agent-harness — session launch + dev ergonomics.
#
# A full chief session is one command:
#   make up    → tmux with the chief (opencode) filling the window, attached; gateway +
#                daemon ride a thin log strip across the top (glanceable, out of the way).
#                Talk to the chief, say "go", it dispatches. make down tears it down.
#   make down  → tear the whole session down.
#
# The log strip's height is tunable: make up LOGS_HEIGHT=4  (or =0 to make the chief
# truly full-window — gateway + daemon then run headless, logs to .orchestrator/*.log).
#
# The pieces (also what the panes run):
#   make gateway → LiteLLM on :4000 (reads .env; needs the .venv — see config/README.md)
#   make daemon  → the dispatch loop daemon
#   make chief   → the opencode TUI with the chief agent selected
#
# Dev:
#   make check → typecheck + test (run before every commit)
#   make db    → regenerate Drizzle migrations from the schema
#
# Prereqs: tmux, bun, opencode, the litellm .venv (config/README.md), and .env (.env.example).

GATEWAY_PORT ?= 4000
SESSION ?= agent-harness
# Height (lines) of the top gateway+daemon log strip. 0 = hide them in a separate tmux
# window so the chief fills the whole window (switch to them with Ctrl-b 1).
LOGS_HEIGHT ?= 6

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

.PHONY: up down gateway daemon chief check db

up:
	@if tmux has-session -t $(SESSION) 2>/dev/null; then \
		echo "session '$(SESSION)' already up — attaching"; \
	elif [ "$(LOGS_HEIGHT)" -eq 0 ]; then \
		tmux new-session -d $(SIZE) -s $(SESSION) -n chief 'make chief; $(HOLD)'; \
		tmux new-window -d -t $(SESSION) -n logs 'make gateway; $(HOLD)'; \
		tmux split-window -h -t $(SESSION):logs 'make daemon; $(HOLD)'; \
	else \
		chief=$$(tmux new-session -d -P -F '#{pane_id}' $(SIZE) -s $(SESSION) -n stack 'make chief; $(HOLD)'); \
		tmux split-window -v -b -l $(LOGS_HEIGHT) -t $$chief 'make gateway; $(HOLD)'; \
		tmux split-window -h -t $(SESSION) 'make daemon; $(HOLD)'; \
		tmux select-pane -t $$chief; \
	fi
	@tmux attach -t $(SESSION)

down:
	@tmux kill-session -t $(SESSION) 2>/dev/null && echo "session '$(SESSION)' down" || echo "no session '$(SESSION)'"

gateway:
	bash -c '$(LOADENV) exec .venv/bin/litellm --config config/litellm.yaml --port $(GATEWAY_PORT)'

daemon:
	bash -c '$(LOADENV) exec bun run daemon'

chief:
	bash -c '$(LOADENV) exec opencode --agent chief'

check:
	bun run typecheck
	bun test

db:
	bun run db:generate
