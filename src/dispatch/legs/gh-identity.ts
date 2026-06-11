// The harness's own GitHub identity (service layer, AGENT-54) — who the substrate posts as,
// so the PR-reading legs can tell owner feedback from the harness's own comments (the PR
// body, droppings annotations, etc.) and never route the bot's words back as owner findings.
//
// Resolution: AH_BOT_LOGIN (config) pins it; otherwise one `gh api user` derives the
// authenticated login and the answer is memoized for the process. A failed derivation
// resolves null — the read legs then filter nothing, which over-reads rather than crashes
// the probe (and logs once so the gap is visible).

import { $ } from "bun";
import type { SubstrateConfig } from "../../config";

let cached: string | null | undefined;

/** The authenticated gh login the substrate operates as, or null when it can't be known. */
export async function resolveBotLogin(config: SubstrateConfig): Promise<string | null> {
  if (config.botLogin) return config.botLogin;
  if (cached !== undefined) return cached;
  try {
    cached = (await $`gh api user --jq .login`.quiet().text()).trim() || null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`gh-identity: cannot resolve the bot login (gh api user failed: ${message}) — owner-feedback filtering is off`);
    cached = null;
  }
  return cached;
}

/** Reset the memo — tests only. */
export function resetBotLoginCache(): void {
  cached = undefined;
}
