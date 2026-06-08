# agent-harness — session launch + dev ergonomics.
#
# A full chief session is one command:
#   make up    → tmux with three panes (gateway | daemon | chief), attached; you land on
#                the chief — talk to it, say "go", it dispatches. Logs visible in the panes.
#   make down  → tear the whole session down.
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

# Panes drop to a shell when their process exits, so a crash/Ctrl-C leaves the logs (and a
# prompt to restart) visible instead of vanishing.
HOLD := exec $${SHELL:-sh}

.PHONY: up down gateway daemon chief check db

up:
	@if tmux has-session -t $(SESSION) 2>/dev/null; then \
		echo "session '$(SESSION)' already up — attaching"; \
	else \
		tmux new-session -d -s $(SESSION) -n stack 'make gateway; $(HOLD)'; \
		tmux split-window -v -t $(SESSION) 'make daemon; $(HOLD)'; \
		tmux split-window -v -t $(SESSION) 'make chief; $(HOLD)'; \
		tmux select-layout -t $(SESSION) tiled >/dev/null; \
	fi
	@tmux attach -t $(SESSION)

down:
	@tmux kill-session -t $(SESSION) 2>/dev/null && echo "session '$(SESSION)' down" || echo "no session '$(SESSION)'"

gateway:
	bash -c 'set -a; source .env; set +a; exec .venv/bin/litellm --config config/litellm.yaml --port $(GATEWAY_PORT)'

daemon:
	bun run daemon

chief:
	opencode --agent chief

check:
	bun run typecheck
	bun test

db:
	bun run db:generate
