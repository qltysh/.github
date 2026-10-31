// The few GitHub API calls the review makes, with the workflow's token.

import type { ReviewThread } from "./gate.ts";

export type PullRequest = {
  number: number;
  title: string;
  body: string | null;
  draft: boolean;
  state: string;
  user: { login: string };
  head: { sha: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string };
};

/** A review thread with every comment, for reading prior findings and their replies. */
export type ThreadDetail = ReviewThread & {
  path: string;
  line: number | null;
  /** association is GitHub's author_association, e.g. MEMBER or NONE. */
  comments: { databaseId: number; author: string; association: string; body: string }[];
};

export type ReviewComment = {
  path: string;
  line: number;
  start_line?: number;
  side: "RIGHT";
  start_side?: "RIGHT";
  body: string;
};

export class GitHub {
  constructor(
    private readonly token: string,
    readonly repo: string,
    private readonly apiUrl = "https://api.github.com",
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${(await response.text()).slice(0, 300)}`);
    return response.status === 204 ? null : response.json();
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const result = (await this.request("POST", "/graphql", { query, variables })) as { data?: T; errors?: unknown };
    if (result.errors || !result.data) throw new Error(`GraphQL error: ${JSON.stringify(result.errors).slice(0, 300)}`);
    return result.data;
  }

  getPull(number: number): Promise<PullRequest> {
    return this.request("GET", `/repos/${this.repo}/pulls/${number}`) as Promise<PullRequest>;
  }

  listOpenPulls(): Promise<PullRequest[]> {
    return this.request("GET", `/repos/${this.repo}/pulls?state=open&per_page=100`) as Promise<PullRequest[]>;
  }

  async listThreads(number: number): Promise<ThreadDetail[]> {
    const [owner, name] = this.repo.split("/");
    type Node = {
      id: string;
      isResolved: boolean;
      resolvedBy: { login: string } | null;
      path: string;
      line: number | null;
      comments: {
        nodes: { databaseId: number; author: { login: string } | null; authorAssociation: string; body: string }[];
      };
    };
    const threads: ThreadDetail[] = [];
    let after: string | null = null;
    do {
      const data: {
        repository: {
          pullRequest: { reviewThreads: { nodes: Node[]; pageInfo: { hasNextPage: boolean; endCursor: string } } };
        };
      } = await this.graphql(
        `query($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) { pullRequest(number: $number) {
            reviewThreads(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { id isResolved resolvedBy { login } path line
                comments(first: 50) { nodes { databaseId author { login } authorAssociation body } } }
            } } } }`,
        { owner, name, number, after },
      );
      const page = data.repository.pullRequest.reviewThreads;
      for (const node of page.nodes) {
        const comments = node.comments.nodes.map((c) => ({
          databaseId: c.databaseId,
          author: c.author?.login ?? "ghost",
          association: c.authorAssociation,
          body: c.body,
        }));
        threads.push({
          id: node.id,
          isResolved: node.isResolved,
          resolvedBy: node.resolvedBy?.login ?? null,
          author: comments[0]?.author ?? "ghost",
          body: comments[0]?.body ?? "",
          path: node.path,
          line: node.line,
          comments,
        });
      }
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return threads;
  }

  /** Bodies of the reviews `login` has submitted on the PR, oldest first. */
  async reviewBodiesFrom(number: number, login: string): Promise<string[]> {
    const reviews = (await this.request("GET", `/repos/${this.repo}/pulls/${number}/reviews?per_page=100`)) as {
      user: { login: string } | null;
      body: string | null;
    }[];
    return reviews.filter((r) => r.user?.login === login || r.user?.login === `${login}[bot]`).map((r) => r.body ?? "");
  }

  createReview(number: number, commitId: string, body: string, comments: ReviewComment[]): Promise<unknown> {
    return this.request("POST", `/repos/${this.repo}/pulls/${number}/reviews`, {
      commit_id: commitId,
      event: "COMMENT",
      body,
      comments,
    });
  }

  reply(number: number, commentId: number, body: string): Promise<unknown> {
    return this.request("POST", `/repos/${this.repo}/pulls/${number}/comments/${commentId}/replies`, { body });
  }

  comment(number: number, body: string): Promise<unknown> {
    return this.request("POST", `/repos/${this.repo}/issues/${number}/comments`, { body });
  }

  async setResolved(threadId: string, resolved: boolean): Promise<void> {
    const mutation = resolved ? "resolveReviewThread" : "unresolveReviewThread";
    await this.graphql(`mutation($id: ID!) { ${mutation}(input: { threadId: $id }) { thread { id } } }`, {
      id: threadId,
    });
  }

  setStatus(sha: string, state: "success" | "failure" | "pending", description: string, targetUrl?: string) {
    return this.request("POST", `/repos/${this.repo}/statuses/${sha}`, {
      state,
      context: "ai-review",
      description: description.slice(0, 140),
      target_url: targetUrl,
    });
  }

  /** The latest ai-review status on a commit, or null if there is none. */
  async getStatus(sha: string): Promise<string | null> {
    const result = (await this.request("GET", `/repos/${this.repo}/commits/${sha}/status?per_page=100`)) as {
      statuses: { context: string; state: string }[];
    };
    return result.statuses.find((s) => s.context === "ai-review")?.state ?? null;
  }
}
