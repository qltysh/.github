# AI review

An AI review of each pull request before a person reviews it. In blocking mode, an open important finding fails the `ai-review` commit status until it's fixed, answered, or overridden. Every PR still needs a human approval.

There are two ways to use it. Repos on Claude Code Review use only the gate here, which turns its 🔴 findings into a merge requirement. Repos that don't use Claude Code Review can run this engine's own reviewer. Either way the workflows live here, so a change applies to every repo that calls them.

## Gating Claude Code Review

Repos that use Claude Code Review, Anthropic's managed reviewer, use only the gate from here. Claude Code Review posts findings inline marked 🔴 Important, 🟡 Nit or 🟣 Pre-existing, and its check never fails. `claude-code-review-gate.yml` sets the `ai-review` status from its 🔴 threads:

- **Waiting:** pending until Claude Code Review has finished on the PR's head commit, so a commit can't pass before it's reviewed. Drafts get no status.
- **Open 🔴 finding:** fails in blocking mode. Claude resolves the thread itself when a later push fixes it.
- **Overrides:** a reviewer other than the author resolves the thread, ideally with a reply saying why. An author resolving their own finding doesn't count.
- **Skipped reviews:** if Claude Code Review skips the PR (its spend limit) or doesn't finish, the status passes, unless 🔴 findings from an earlier review are still open.
- **Fork PRs:** Claude Code Review only reviews them when a maintainer comments `@claude review`. The gate runs on its check_run event, which carries a write token, so fork PRs get a status too.

Add `.github/workflows/ai-review.yml` to the repo:

```yaml
name: AI review gate
on:
  pull_request:
    types: [opened, reopened, ready_for_review, synchronize]
  check_run:
    types: [completed]
  pull_request_review:
    types: [submitted]
  pull_request_review_comment:
    types: [created]
  issue_comment:
    types: [created]
permissions: {}
jobs:
  gate:
    uses: qltysh/.github/.github/workflows/claude-code-review-gate.yml@main
    with:
      mode: advisory
    permissions:
      checks: read
      pull-requests: read
      statuses: write
```

What Claude Code Review flags, and what counts as 🔴, comes from the repo's `REVIEW.md` and `CLAUDE.md`. It reads `REVIEW.md` from the default branch, and honors instructions that lower severity or skip paths only when that branch is protected by a ruleset that dismisses approvals on new pushes or requires approval of the last push. Locally, `/code-review` in Claude Code runs a review of the current branch; it reads `CLAUDE.md` but not `REVIEW.md`.

## Built-in reviewer

The rest of this README covers the engine's own reviewer, for repos that don't use Claude Code Review.

## How a review goes

- **Drafts:** nothing runs. Ask anyone for an early look as usual.
- **Ready for review** (or opened as ready): the review runs, posts important findings inline, and sets `ai-review`.
- **Pushing while ready**, or commenting `/ai-review`: a re-review. It reads replies to earlier findings, resolves the threads it agrees are fixed or answered, answers the ones it still disagrees with, and posts only new findings.
- **Overrides:** a reviewer other than the author resolves the finding's thread, ideally with a reply saying why. The status updates on the next review comment, review, or `/ai-review`. An author resolving their own finding doesn't count, and the next review reopens it.
- **Skipped reviews:** if the review can't run after a retry (spend limit, outage, no API key), the status passes, the PR gets a comment saying why, and Slack hears about it. Findings from an earlier review still block. A review that runs out of its own per-review budget is different: a PR can cause that on purpose, so in blocking mode it fails, and the fix is to split the PR or have an admin bypass.
- **Outside contributors:** no automatic review. A maintainer comments `/ai-review` to run one. On public repos, a follow-up workflow gives their PRs a passing status so they're never stuck waiting.

Findings about files a PR doesn't change go in the summary and don't block, since they can't take an inline thread.

## Adopting it in a repo

1. Add `.github/workflows/ai-review.yml`:

   ```yaml
   name: AI review
   on:
     pull_request:
       types: [opened, reopened, ready_for_review, synchronize]
     pull_request_review:
       types: [submitted]
     pull_request_review_comment:
       types: [created]
     issue_comment:
       types: [created]
   permissions: {}
   jobs:
     ai-review:
       if: github.event_name != 'issue_comment' || (github.event.issue.pull_request && startsWith(github.event.comment.body, '/ai-review'))
       uses: qltysh/.github/.github/workflows/ai-review.yml@main
       with:
         mode: advisory
       secrets:
         anthropic-api-key: ${{ secrets.AI_REVIEW_ANTHROPIC_API_KEY }}
         slack-webhook-url: ${{ secrets.AI_REVIEW_SLACK_WEBHOOK_URL }}
       permissions:
         contents: read
         pull-requests: write
         statuses: write
   ```

2. Add `.github/ai-review.md` with what's specific to the repo: what it is, what matters most, and any severity rules. The review reads it from the base branch, so a PR can't change its own instructions.

3. Public repos only: pass `public: true`, and add `.github/workflows/ai-review-status.yml`:

   ```yaml
   name: AI review status
   on:
     workflow_run:
       workflows: ["AI review"]
       types: [completed]
   permissions: {}
   jobs:
     status:
       uses: qltysh/.github/.github/workflows/ai-review-status.yml@main
       with:
         mode: advisory
       permissions:
         pull-requests: read
         statuses: write
   ```

4. Once advisory mode has run long enough to trust, switch `mode` to `blocking` in both files and add `ai-review` as a required status check in the repo's ruleset, sourced from GitHub Actions.

`context-repos`, `context-app-id` and `context-app-private-key` let the review read other repos in the org, for example the code that needs what a Terraform change grants. The workflow mints a read-only token for just those repos and leaves no token on disk. They're ignored when `public: true`, so private code can't reach a public comment.

## Running it locally

From a clone of the repo you're working in, with Claude Code installed and signed in:

```sh
git clone -q --depth 1 https://github.com/qltysh/.github ~/.cache/qlty-ai-review 2>/dev/null || git -C ~/.cache/qlty-ai-review pull -q
bun ~/.cache/qlty-ai-review/ai-review/src/cli.ts local --base origin/main
```

It reviews committed changes on the current branch against `origin/main`, prints the findings, and exits 1 if any are important. It doesn't post anything.

## Safety

- The model gets read-only tools (Read, Grep, Glob). It can't run commands, edit files, or reach the network, and it can't read process, git, or runner credential files.
- Its process gets no GitHub token or webhook URL. Secret-shaped text is redacted before anything is posted.
- Settings and hooks from the checked-out PR are not loaded. Rules files and the repo's instructions come from the base branch.
- Claude Code is downloaded at a pinned version and checked against a SHA-256 hash pinned in the workflow.
- The workflows don't use `pull_request_target`.

## Cost

About $0.40–1 per review with the default budget cap of $3 a review. Reviews bill to the Console workspace behind `AI_REVIEW_ANTHROPIC_API_KEY`; set a monthly spend limit there.

## Developing

```sh
cd ai-review && bun install && bun run check
```
