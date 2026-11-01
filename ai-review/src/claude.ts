// Runs Claude Code headless with read-only tools and a JSON schema, and returns its structured output.

export type ClaudeRequest = {
  cwd: string;
  prompt: string;
  schema: string;
  /** Directories outside cwd that the model may read, such as the review inputs. */
  addDirs: string[];
  model: string;
  budgetUsd: number;
  timeoutMs: number;
};

export type ClaudeResult = { output: unknown; costUsd: number };

export type ClaudeRunner = (request: ClaudeRequest) => Promise<ClaudeResult>;

/**
 * Tools that can change anything, run anything, or reach the network, plus reads of process and credential files.
 * The review only reads the repository and its inputs.
 */
const DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
  "Read(/proc/**)",
  "Read(/sys/**)",
  "Read(~/.claude/**)",
  "Read(~/.config/**)",
  "Read(~/.ssh/**)",
  // A checkout can store the job's token in git config.
  "Read(./.git/**)",
];

/** Claude Code stopped because the run hit its spending cap. Retrying would only spend more. */
export class BudgetError extends Error {}

/** Environment the model's process gets: enough to run and authenticate, and no GitHub token or webhooks. */
const PASSED_ENV = /^(PATH|HOME|USER|LANG|LC_\w+|TMPDIR|TERM|ANTHROPIC_\w+|CLAUDE_\w+)$/;

export function claudeEnv(source: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      (e): e is [string, string] => PASSED_ENV.test(e[0]) && e[1] !== undefined && e[1] !== "",
    ),
  );
}

export function claudeArgs(request: ClaudeRequest): string[] {
  return [
    "-p",
    request.prompt,
    "--output-format",
    "json",
    "--json-schema",
    request.schema,
    "--model",
    request.model,
    "--allowedTools",
    "Read",
    "Grep",
    "Glob",
    "--disallowedTools",
    ...DISALLOWED_TOOLS,
    // The Actions runner keeps credentials and event payloads in its temp directory.
    ...(process.env.RUNNER_TEMP ? [`Read(${process.env.RUNNER_TEMP}/**)`] : []),
    // Settings from the checked-out PR could define hooks that run commands. Only the runner's own settings load.
    "--setting-sources",
    "user",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--max-budget-usd",
    String(request.budgetUsd),
    ...request.addDirs.flatMap((dir) => ["--add-dir", dir]),
  ];
}

export const runClaude: ClaudeRunner = async (request) => {
  const proc = Bun.spawn(["claude", ...claudeArgs(request)], {
    cwd: request.cwd,
    env: claudeEnv(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), request.timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  let parsed: {
    is_error?: boolean;
    subtype?: string;
    result?: string;
    structured_output?: unknown;
    total_cost_usd?: number;
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Claude Code exited ${code} without JSON output: ${stderr.slice(0, 300) || stdout.slice(0, 300)}`);
  }
  if (parsed.subtype?.includes("budget")) throw new BudgetError(`Claude Code hit its budget: ${parsed.subtype}`);
  if (parsed.is_error || parsed.structured_output === undefined) {
    throw new Error(`Claude Code failed: ${String(parsed.result ?? stderr).slice(0, 300)}`);
  }
  return { output: parsed.structured_output, costUsd: parsed.total_cost_usd ?? 0 };
};
