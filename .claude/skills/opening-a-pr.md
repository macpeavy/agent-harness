---
name: opening-a-pr
description: Use for commit and PR conventions, and the substrate-owns-git boundary. How a build chunk's change becomes a commit and a PR.
---

# Commits & PRs

**When:** finishing a build chunk. Note the boundary first: in the fleet, **the substrate
owns git and GitHub — a build agent edits files and does not run git or open a PR.** This
skill is the convention the *substrate* (and a human) follows; an agent building a chunk
just leaves a clean, typechecking, tested working tree.

**Files:** the change itself; the commit message; the PR title/body.

## How

1. **Typecheck and test first.** `bun run typecheck` and `bun test` both green, or the
   change isn't done.
2. **One coherent change per commit**, scoped to one surface (one file, per ADR 0014).
3. **Conventional commit message:** `type(scope): summary` — `feat`, `fix`, `refactor`,
   `chore`, `docs`, `test`. Reference the issue id where there is one. The substrate's
   build-leg uses `feat: <title> (<issue-id>)`.
4. **Branch naming:** `agent/<issue-id>-<slug>` for a build chunk (the build-leg's
   pattern); `strategy/<date>-<slug>` for a chief `[Brief]` PR.
5. **PR body states what and why** in plain engineering prose — no agent self-identification,
   no automation trailers (the output norm). Name the issue and what the change does.
6. **Never force-push `main`; never merge without owner approval.** The merge gate is the
   owner's (ADR 0011) — a strong-reviewed PR waits for the owner to merge.

## Worked example

The substrate's build-leg, after the agent leaves a changed worktree:

```ts
const commitMsg = `feat: ${issue.title} (${issue.id})`;
await $`git -C ${worktree} add -A`.quiet();
await $`git -C ${worktree} commit -q -m ${commitMsg}`;
await $`git -C ${worktree} push -u origin ${branch}`.quiet();
const prUrl = (await $`gh pr create --repo ${GH_REPO} --head ${branch} \
  --base main --title ${commitMsg} --body ${prBody}`.text()).trim();
```

Scoped commit, conventional message with the issue id, a PR that becomes the review
surface. The agent that built the code never ran any of this.
