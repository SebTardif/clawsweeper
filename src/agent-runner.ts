import { randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexModelArgs, redactInternalCodexModel } from "./codex-env.js";
import {
  runCodexProcess,
  type CodexAppServerProcessOptions,
  type CodexProcessResult,
} from "./codex-process.js";
import { runOpenclawProcess } from "./openclaw-process.js";

export type AgentRunner = "codex" | "openclaw";

export interface RunAgentProcessOptions {
  label: string;
  prompt: string;
  model: string;
  reasoningEffort?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  tailBytes?: number;
  outputFileBytes?: number;
  stdoutPath?: string;
  stderrPath?: string;
  appServer?: CodexAppServerProcessOptions;
  codexExtraArgs?: readonly string[];
}

export function agentRunner(env: NodeJS.ProcessEnv = process.env): AgentRunner {
  const value = env.CLAWSWEEPER_RUNNER?.trim() || "codex";
  if (value === "codex" || value === "openclaw") return value;
  throw new Error(`Invalid CLAWSWEEPER_RUNNER: ${value}. Expected "codex" or "openclaw".`);
}

export function runAgentProcess(options: RunAgentProcessOptions): CodexProcessResult {
  if (agentRunner(options.env) === "codex") {
    return runCodexProcess({
      args: codexAgentArgs(options),
      cwd: options.cwd,
      env: options.env,
      input: options.prompt,
      timeoutMs: options.timeoutMs,
      ...(options.tailBytes === undefined ? {} : { tailBytes: options.tailBytes }),
      ...(options.outputFileBytes === undefined
        ? {}
        : { outputFileBytes: options.outputFileBytes }),
      ...(options.stdoutPath ? { stdoutPath: options.stdoutPath } : {}),
      ...(options.stderrPath ? { stderrPath: options.stderrPath } : {}),
      ...(options.appServer ? { appServer: options.appServer } : {}),
    });
  }

  const model = openclawModel(options.env);
  const rawResult = runOpenclawProcess({
    label: options.label,
    prompt: options.prompt,
    model,
    ...(options.reasoningEffort?.trim() ? { reasoningEffort: options.reasoningEffort.trim() } : {}),
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    ...(options.tailBytes === undefined ? {} : { tailBytes: options.tailBytes }),
    ...(options.outputFileBytes === undefined ? {} : { outputFileBytes: options.outputFileBytes }),
    ...(options.stdoutPath ? { stdoutPath: options.stdoutPath } : {}),
    ...(options.stderrPath ? { stderrPath: options.stderrPath } : {}),
  });
  const result = redactOpenclawFailure(rawResult, model);
  const outputPath = codexOutputLastMessagePath(options.codexExtraArgs);
  if (!result.error && result.status === 0 && outputPath) {
    writeFileSync(outputPath, result.stdout, "utf8");
  }
  if (!options.appServer) return result;
  const note =
    "[clawsweeper] CLAWSWEEPER_STEERABLE_CODEX is Codex-specific; OpenClaw used a plain run.";
  return { ...result, stderr: [result.stderr.trimEnd(), note].filter(Boolean).join("\n") };
}

export function runAgentCheckoutInspection(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): CodexProcessResult {
  const env = { ...options.env, GIT_OPTIONAL_LOCKS: "0" };
  const trackedFiles = spawnSync("git", ["ls-files", "--stage", "-z"], {
    cwd: options.cwd,
    encoding: "utf8",
    env,
    timeout: options.timeoutMs,
  });
  if (trackedFiles.error || trackedFiles.status !== 0) return spawnResult(trackedFiles);
  const candidates = (trackedFiles.stdout ?? "").split("\0").flatMap((entry) => {
    const separator = entry.indexOf("\t");
    if (separator < 0) return [];
    const metadata = entry.slice(0, separator);
    const path = entry.slice(separator + 1);
    return /^(?:100644|100755) [0-9a-f]{40,64} 0$/.test(metadata) && path ? [path] : [];
  });
  const start = candidates.length > 0 ? randomInt(candidates.length) : 0;
  const orderedCandidates = [...candidates.slice(start), ...candidates.slice(0, start)];
  let fingerprintPath = "";
  let fingerprint = "";
  let openclawChallenge: { lineNumber: number; expected: string } | undefined;
  const runner = agentRunner(env);
  for (const candidate of orderedCandidates) {
    const hashed = spawnSync("git", ["hash-object", "--", candidate], {
      cwd: options.cwd,
      encoding: "utf8",
      env,
      timeout: options.timeoutMs,
    });
    const value = (hashed.stdout ?? "").trim();
    const challenge =
      runner === "openclaw" ? readChallenge(join(options.cwd, candidate)) : undefined;
    if (
      !hashed.error &&
      hashed.status === 0 &&
      /^[0-9a-f]{40,64}$/.test(value) &&
      (runner === "codex" || challenge)
    ) {
      fingerprintPath = candidate;
      fingerprint = value;
      openclawChallenge = challenge;
      break;
    }
  }
  if (!fingerprintPath) {
    return {
      status: 1,
      signal: null,
      error: new Error("Checkout inspection could not select a tracked file."),
      stdout: "",
      stderr: "",
    };
  }
  if (runner === "codex") {
    return verifyCheckoutChallenge(
      runCodexProcess({
        args: [
          "sandbox",
          "--permission-profile",
          ":read-only",
          "-C",
          options.cwd,
          "--",
          "git",
          "hash-object",
          "--",
          fingerprintPath,
        ],
        cwd: options.cwd,
        env,
        input: "",
        timeoutMs: options.timeoutMs,
      }),
      fingerprint,
      "Codex",
    );
  }
  const model = openclawModel(env);
  if (!openclawChallenge) throw new Error("OpenClaw checkout inspection challenge is missing.");
  const result = redactOpenclawFailure(
    runOpenclawProcess({
      label: "checkout-inspection",
      prompt: [
        "Use the read tool to inspect this workspace file.",
        "Read this workspace-relative path (JSON string):",
        JSON.stringify(fingerprintPath),
        `Return exactly line ${openclawChallenge.lineNumber} as plain text.`,
        "Do not add explanation, quotes, or formatting.",
      ].join("\n"),
      model,
      cwd: options.cwd,
      env,
      timeoutMs: options.timeoutMs,
      toolAccess: "read-only-inspection",
    }),
    model,
  );
  return verifyCheckoutChallenge(result, openclawChallenge.expected, "OpenClaw");
}

function readChallenge(path: string): { lineNumber: number; expected: string } | undefined {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch {
    return undefined;
  }
  const candidates = content
    .split(/\r?\n/)
    .map((line, index) => ({ lineNumber: index + 1, expected: line }))
    .filter(
      ({ expected }) =>
        expected.length > 0 && expected.length <= 512 && expected.trim() === expected,
    );
  return candidates.length > 0 ? candidates[randomInt(candidates.length)] : undefined;
}

function verifyCheckoutChallenge(
  result: CodexProcessResult,
  fingerprint: string,
  runner: "Codex" | "OpenClaw",
): CodexProcessResult {
  if (result.error || result.status !== 0) return result;
  if (result.stdout.trim() !== fingerprint) {
    return {
      status: 1,
      signal: result.signal,
      error: new Error(`${runner} checkout inspection did not return the runner challenge.`),
      stdout: "",
      stderr: result.stderr,
    };
  }
  return {
    ...result,
    stdout: "",
  };
}

function spawnResult(result: ReturnType<typeof spawnSync>): CodexProcessResult {
  return {
    status: result.status,
    signal: result.signal,
    ...(result.error ? { error: result.error } : {}),
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function redactOpenclawFailure(result: CodexProcessResult, model: string): CodexProcessResult {
  const redact = (value: string): string =>
    redactInternalCodexModel(value).replaceAll(model, "[REDACTED_INTERNAL_MODEL]");
  const failed = Boolean(result.error) || result.status !== 0;
  return {
    ...result,
    ...(result.error ? { error: copyError(result.error, redact(result.error.message)) } : {}),
    stdout: failed ? redact(result.stdout) : result.stdout,
    stderr: redact(result.stderr),
  };
}

function copyError(error: Error, message: string): Error {
  const copy = new Error(message);
  copy.name = error.name;
  const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
  if (typeof code === "string") (copy as NodeJS.ErrnoException).code = code;
  return copy;
}

export function codexAgentArgs(options: RunAgentProcessOptions): string[] {
  const extraArgs = [...(options.codexExtraArgs ?? [])];
  const hasOrderedModelArgs = extraArgs.includes("--model");
  const hasOrderedReasoningConfig = extraArgs.some((value) =>
    /^model_reasoning_effort\s*=/.test(value),
  );
  const reasoningEffort = options.reasoningEffort?.trim();
  return [
    "exec",
    ...(hasOrderedModelArgs ? [] : codexModelArgs(options.model)),
    ...(reasoningEffort && !hasOrderedReasoningConfig
      ? ["-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`]
      : []),
    ...extraArgs,
  ];
}

function openclawModel(env: NodeJS.ProcessEnv): string {
  const model = env.CLAWSWEEPER_OPENCLAW_MODEL?.trim();
  if (!model) {
    throw new Error("CLAWSWEEPER_OPENCLAW_MODEL is required when CLAWSWEEPER_RUNNER=openclaw.");
  }
  if (!/^[^\s/]+\/[^\s/]+$/.test(model)) {
    throw new Error(
      "CLAWSWEEPER_OPENCLAW_MODEL must use provider/model form when CLAWSWEEPER_RUNNER=openclaw.",
    );
  }
  return model;
}

function codexOutputLastMessagePath(args: readonly string[] | undefined): string | undefined {
  if (!args) return undefined;
  const index = args.lastIndexOf("--output-last-message");
  const value = index === -1 ? undefined : args[index + 1];
  return value?.trim() || undefined;
}
