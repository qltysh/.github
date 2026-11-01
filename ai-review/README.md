# AI review

One AI review runs when a pull request is marked ready for review. It posts important findings as inline threads and lists nits in its summary. In blocking mode, an open important finding fails the `ai-review` commit status until it's fixed, answered, or overridden. Every PR still needs a human approval.

The prompt, the rules for what blocks, and the code live here, so a change applies to every repo that calls the workflow.

## How a review goes

- **Drafts:** nothing runs. Ask anyone for an early look as usual.
- **Ready for review** (or opened as ready): the review runs, posts important findings inline, and sets `ai-review`.
- **Pushing while ready**, or commenting `/ai-review`: a re-review. It reads replies to earlier findings, resolves the threads it agrees are fixed or answered, answers the ones it still disagrees with, and posts only new findings.
- **Overrides:** a reviewer other than the author resolves the finding's thread, ideally with a reply saying why. The status updates on the next review comment, review, or `/ai-review`. An author resolving their own finding doesn't count, and the next review reopens it.
- **Skipped reviews:** if the review can't run after a retry (spend limit, outage, no API key), the status passes, the PR gets a comment saying why, and Slack hears about it. Findings from an earlier review still block. A review that runs out of its own per-review budget is different: a PR can cause that on purpose, so in blocking mode it fails, and the fix is to split the PR or have an admin bypass.
- **Outside contributors:** no automatic review. A maintainer comments `/ai-review` to run one. On public repos, a follow-up workflow gives their PRs a passing status so they're never stuck waiting.

Findings about files a PR doesn't change go in the summary and don't block, since they can't take an inline thread.

## Claude API access

The review authenticates with identity federation, so no Claude API key is stored in GitHub. Each run trades its GitHub identity token for a Claude API token that expires within the hour. One-time setup in the Claude Console:

1. A workspace named "AI Code Review", with a monthly spend limit. Usage and cost show per workspace.
2. A service account in that workspace.
3. A federation rule for GitHub Actions: issuer `https://token.actions.githubusercontent.com`, audience `https://api.anthropic.com`, targeting that service account and workspace, and allowing only tokens whose `repository_owner` is `qltysh` and whose `job_workflow_ref` is `qltysh/.github/.github/workflows/ai-review.yml@refs/heads/main`. Then only this workflow, from this repo's protected main, can get a token.
4. Org Actions variables (they aren't secrets): `AI_CODE_REVIEW_ANTHROPIC_FEDERATION_RULE_ID`, `AI_CODE_REVIEW_ANTHROPIC_ORGANIZATION_ID`, `AI_CODE_REVIEW_ANTHROPIC_SERVICE_ACCOUNT_ID`, `AI_CODE_REVIEW_ANTHROPIC_WORKSPACE_ID`.

A repo that can't use federation can pass an API key as the `anthropic-api-key` secret instead, for example `AI_CODE_REVIEW_ANTHROPIC_API_KEY`.

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
         anthropic-federation-rule-id: ${{ vars.AI_CODE_REVIEW_ANTHROPIC_FEDERATION_RULE_ID }}
         anthropic-organization-id: ${{ vars.AI_CODE_REVIEW_ANTHROPIC_ORGANIZATION_ID }}
         anthropic-service-account-id: ${{ vars.AI_CODE_REVIEW_ANTHROPIC_SERVICE_ACCOUNT_ID }}
         anthropic-workspace-id: ${{ vars.AI_CODE_REVIEW_ANTHROPIC_WORKSPACE_ID }}
       secrets:
         slack-webhook-url: ${{ secrets.AI_REVIEW_SLACK_WEBHOOK_URL }}
       permissions:
         contents: read
         pull-requests: write
         statuses: write
         id-token: write
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
- No long-lived Claude API key is stored. A run's Claude token expires within the hour, and only this workflow on protected main can get one.
- Claude Code is downloaded at a pinned version and checked against a SHA-256 hash pinned in the workflow.
- The workflows don't use `pull_request_target`.

## Cost

About $0.40–1 per review with the default budget cap of $3 a review. Reviews bill to the "AI Code Review" workspace in the Claude Console; its monthly spend limit caps them without affecting other Claude API use.

## Developing

```sh
cd ai-review && bun install && bun run check
```
