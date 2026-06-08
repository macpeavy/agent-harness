// src/cli/status.ts — displays fleet-wide build status via the substrate
// Run: bun run ./src/cli/status.ts

import { $ } from "bun";

const SESSION = "agent-harness";

interface PaneInfo {
  paneId: string;
  command: string;
  workingDir?: string;
}

async function showStatus(): Promise<void> {
  try {
    // Check if tmux session exists first
    const hasSession = await $`tmux has-session -t ${SESSION} 2>/dev/null`.text();
    if (!hasSession) {
      console.log("Fleet is not running: tmux session '" + SESSION + "' does not exist");
      return;
    }

    // Get pane information
    const panesOutput = await $`tmux list-panes -t ${SESSION} -F '#{pane_id} #{pane_current_command} #{pane_working_dir}'`.text();
    const lines = panesOutput.trim().split('\n');

    const panes: PaneInfo[] = lines.map(line => {
      const parts = line.split(' ').filter(part => part !== '');
      // Ensure we have at least paneId and command
      const paneId = parts[0] || "";
      const command = parts[1] || "(empty)";
      const workingDir = parts.slice(2).join(" ");
      return { paneId, command, workingDir };
    });

    console.log("\n=== Fleet Status ===");
    if (panes.length === 0) {
      console.log("No panes found in session");
    } else {
      console.log(`Session: ${SESSION}`);
      console.log(`Pane Count: ${panes.length}\n`);
      
      panes.forEach((pane, index) => {
        console.log(`Pane #${index + 1}: ${pane.paneId}`);
        console.log(`  Command: ${pane.command || '(empty)'}`);
        if (pane.workingDir) {
          console.log(`  Working Directory: ${pane.workingDir}`);
        }
        console.log();
      });
    }
    console.log("====================\n");
  } catch (err) {
    console.error("Failed to get tmux status:", err);
    console.log("Fleet is not running or tmux not available");
    process.exit(1);
  }
}

showStatus()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
