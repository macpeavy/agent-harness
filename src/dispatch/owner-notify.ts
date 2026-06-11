// The real owner notification channels (AGENT-52, the ADR 0024 §5 deferral come due) —
// implementations of the `Notifier` seam in ./notify that actually reach the owner on a
// headless host. The first run proved the console line alone is missable scrollback; these
// put the signal where the owner is: the tmux session they're attached to (display-message +
// a terminal bell), and optionally an ntfy push to their devices. ConsoleNotifier stays the
// floor; the composite fans out to every configured channel and succeeds when at least one
// delivered (so the floor delivering doesn't strand the signal un-stamped and re-firing,
// while an all-channels failure leaves it pending for the next tick's retry).
//
// Per ADR 0024 the channel stays pluggable and decoupled — assembled from config at the
// composition root (session-loop main), not wired to prism.

import { $ } from "bun";
import { ConsoleNotifier, type Notifier, type ReviewReadyNotice } from "./notify";

/** The one-line owner message the non-console channels render. */
export function reviewReadyMessage(n: ReviewReadyNotice): string {
  const pr = n.prUrl ?? (n.prNumber !== null ? `PR #${n.prNumber}` : "no PR linked");
  return `review ready: "${n.featureTitle}" is built ($${n.costUsd.toFixed(2)}) — review + merge ${pr}`;
}

// How long the tmux status-line message stays up. Long enough to survive not-looking;
// any keypress dismisses it.
const TMUX_DISPLAY_MS = 30_000;

/** Runs one tmux/terminal notification — injected so the notifier is testable without tmux. */
export type TmuxDisplay = (message: string) => Promise<void>;

const defaultTmuxDisplay: TmuxDisplay = async (message) => {
  // The session-loop pane lives inside the `make up` tmux session, so an untargeted
  // display-message reaches the client attached to it. The BEL rides to the pane's tty,
  // setting the window bell flag (and ringing through, per the owner's terminal config).
  process.stdout.write("\x07");
  await $`tmux display-message -d ${TMUX_DISPLAY_MS} ${message}`.quiet();
};

/** The tmux channel: a status-line message on the attached client + a terminal bell. */
export class TmuxNotifier implements Notifier {
  constructor(private readonly display: TmuxDisplay = defaultTmuxDisplay) {}

  async reviewReady(n: ReviewReadyNotice): Promise<void> {
    await this.display(reviewReadyMessage(n));
  }
}

/** The slice of fetch the ntfy channel needs — injected so it's testable without a network. */
export type NtfyFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

/** The ntfy push channel (https://ntfy.sh or self-hosted): reaches the owner's devices when
 *  they're not at the terminal at all. Enabled by AH_NTFY_TOPIC. */
export class NtfyNotifier implements Notifier {
  constructor(
    private readonly topic: string,
    private readonly server: string = "https://ntfy.sh",
    private readonly fetchFn: NtfyFetch = fetch,
  ) {}

  async reviewReady(n: ReviewReadyNotice): Promise<void> {
    const url = `${this.server.replace(/\/$/, "")}/${this.topic}`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { Title: "Session ready for your review", Priority: "high", Tags: "eyes" },
      body: reviewReadyMessage(n),
    });
    if (!res.ok) throw new Error(`ntfy POST ${url} → ${res.status}`);
  }
}

/**
 * Fan a notice out to every configured channel. Succeeds when AT LEAST ONE delivered —
 * the notify pass stamps the signal once the owner can have seen it somewhere; a partial
 * failure is logged, not retried. Throws only when every channel failed, leaving the
 * signal un-stamped for the next tick (at-least-once over silent loss, as in ./notify).
 */
export class CompositeNotifier implements Notifier {
  constructor(private readonly channels: Notifier[]) {
    if (channels.length === 0) throw new Error("CompositeNotifier: no channels");
  }

  async reviewReady(n: ReviewReadyNotice): Promise<void> {
    // The async thunk turns a channel's synchronous throw into a rejection, so one bad
    // channel lands in `results` instead of escaping past allSettled.
    const results = await Promise.allSettled(this.channels.map(async (c) => c.reviewReady(n)));
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length === results.length)
      throw new Error(`every owner channel failed: ${failures.map((f) => String(f.reason)).join("; ")}`);
    for (const f of failures) console.warn(`owner-notify: a channel failed (delivered elsewhere): ${String(f.reason)}`);
  }
}

/** What the factory reads from config/environment to assemble the owner channel. */
export interface OwnerNotifyConfig {
  /** ntfy topic — set = the push channel is on (AH_NTFY_TOPIC). */
  ntfyTopic: string | null;
  /** ntfy server base URL (AH_NTFY_SERVER, default https://ntfy.sh). */
  ntfyServer: string;
}

/**
 * Assemble the owner channel from config: the console floor always; tmux when the process
 * runs inside the `make up` session (`inTmux`, from $TMUX at the composition root); ntfy
 * when a topic is configured.
 */
export function ownerNotifier(cfg: OwnerNotifyConfig, opts: { inTmux?: boolean } = {}): Notifier {
  const channels: Notifier[] = [new ConsoleNotifier()];
  if (opts.inTmux) channels.push(new TmuxNotifier());
  if (cfg.ntfyTopic) channels.push(new NtfyNotifier(cfg.ntfyTopic, cfg.ntfyServer));
  return channels.length === 1 ? (channels[0] as Notifier) : new CompositeNotifier(channels);
}
