#!/usr/bin/env node
// Real-thread smoke test for the working-directory bug.
//
// Why this exists: the unit tests passed while bb_ast_search walked the user's
// home directory. The tool context carries threadId and projectId but no cwd,
// so a plugin that resolves a relative path against the *project* is wrong
// inside any thread whose environment is a different directory — a worktree, an
// attached workspace, an unmanaged path. Only a real thread shows it.
//
// What it does: makes a temp workspace holding one marker file, spawns a thread
// on that workspace (with a project whose own path is somewhere else), asks the
// agent to run bb_ast_search with path ".", and checks that the absolute path
// it reports is inside the workspace. A regression shows up as the project
// path, $HOME, or anything else outside the workspace.
//
// It spends one model turn, so it is NOT part of `npm test`:
//   npm run smoke            # or: node scripts/smoke-cwd.mjs
//   BB_SMOKE_PROJECT=proj_…  # pick the project to spawn under
//   BB_SMOKE_KEEP=1          # keep the temp workspace and print it
//
// Canonical copy: ${UPSTREAM}. A repo that vendors this file keeps
// HARNESS_VERSION in step with it; change the prompt and marker only.
//
// Exit: 0 pass, 1 fail (prints what the agent actually said), 77 skipped.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

// Bump when the harness LOGIC changes (comparison, exit codes, failure
// classification) — not when you change the prompt or the marker, which every
// copy is meant to change. A vendored copy that reports a different number is
// stale, and that is the point of the number.
const HARNESS_VERSION = 1;
const UPSTREAM = "https://github.com/prismatic7/bb-plugin-ast-grep/blob/main/scripts/smoke-cwd.mjs";

const MARKER = "cwd-probe-marker.ts";

function bbBinary() {
  if (process.env.BB_BIN) return process.env.BB_BIN;
  const fallback = join(process.env.HOME ?? "", ".bb", "bin", "bb");
  return fallback;
}

async function bb(args, opts = {}) {
  const { stdout, stderr } = await run(bbBinary(), args, {
    maxBuffer: 16 * 1024 * 1024,
    timeout: opts.timeout ?? 120_000,
  });
  if (stderr && opts.logStderr) process.stderr.write(stderr);
  return stdout;
}

function skip(reason) {
  console.log(`SKIP: ${reason}`);
  process.exit(77);
}

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const PROMPT = `One tool call, then one line of output.

Call bb_ast_search with:
  pattern: console.log($A)
  lang: typescript
  path: .

Then reply with exactly one line: the absolute file path of the first match,
including its :line:column suffix. No prose, no second tool call.`;

async function main() {
  // The CLI must be there, or there is nothing to test.
  try {
    await bb(["--version"], { timeout: 20_000 });
  } catch {
    skip(`bb CLI not found at ${bbBinary()} (set BB_BIN)`);
  }

  // A project to spawn under. Its path must differ from the workspace we pass,
  // because that difference is the whole test.
  let projects;
  try {
    projects = JSON.parse(await bb(["project", "list", "--json"], { timeout: 30_000 }));
  } catch (err) {
    skip(`cannot list bb projects: ${err.message}`);
  }
  const rows = Array.isArray(projects) ? projects : (projects.projects ?? []);
  const wanted = process.env.BB_SMOKE_PROJECT;
  const project = wanted ? rows.find((p) => p.id === wanted) : rows[0];
  if (!project) skip(wanted ? `no project ${wanted}` : "no bb projects registered");

  // A workspace far away from the project, with one file only this workspace has.
  const workspace = await mkdtemp(join(tmpdir(), "bb-cwd-smoke-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, MARKER), 'const probe = console.log("cwd-probe");\n', "utf8");
  const promptFile = join(workspace, "prompt.txt");
  await writeFile(promptFile, PROMPT, "utf8");

  const ws = real(workspace);
  let threadId = null;
  try {
    let spawned;
    try {
      spawned = JSON.parse(
        await bb(["thread", "spawn", "--project", project.id, "--environment", workspace,
                  "--prompt-file", promptFile, "--json"], { timeout: 120_000 }),
      );
    } catch (err) {
      return fail(`thread spawn failed: ${err.stderr || err.message}`, ws, null);
    }
    threadId = spawned.id ?? spawned.thread?.id;
    if (!threadId) return fail("thread spawn returned no id", ws, null);

    try {
      await bb(["thread", "wait", threadId, "--timeout", "420"], { timeout: 460_000 });
    } catch (err) {
      return fail(`thread did not reach idle: ${err.stderr || err.message}`, ws, threadId);
    }

    const output = await bb(["thread", "output", threadId], { timeout: 60_000 });

    // The bug's signature: the reply never names the marker, because the tool
    // searched a different tree — and usually found *a* match there, which is
    // what made it invisible in the first place.
    if (!output.includes(MARKER)) {
      const firstPath = /(\/[^\s:()"']+)(?::\d+:\d+)?/.exec(output);
      return fail(
        `the reply never names ${MARKER} — the tool searched a different tree` +
          (firstPath ? `\n  first path in the reply: ${firstPath[1]}` : "") +
          `\n  expected: ${ws}/${MARKER}\n  reply:\n${indent(output)}`,
        ws,
        threadId,
      );
    }
    const reported = new RegExp(`(\\S*${MARKER.replace(/\./g, "\\.")})(?::\\d+:\\d+)?`).exec(output);
    const got = real(reported[1]);
    if (!got.startsWith(ws + "/")) {
      const localSource = (project.sources ?? []).find((src) => src.type === "local_path");
      const projectPath = real(localSource?.path ?? "");
      const home = real(process.env.HOME ?? "/nonexistent");
      const why = projectPath && got.startsWith(projectPath + "/")
        ? `resolved against the PROJECT path (${projectPath})`
        : got.startsWith(home + "/")
          ? `resolved against $HOME (${home})`
          : "resolved outside the thread's environment";
      return fail(`${why}\n  expected under: ${ws}\n  got:            ${got}`, ws, threadId);
    }
    if (!got.endsWith("/" + MARKER)) {
      return fail(`resolved inside the workspace but to the wrong file: ${got}`, ws, threadId);
    }

    console.log(`PASS (harness v${HARNESS_VERSION}): bb_ast_search resolved "." to the thread's environment (${got})`);
    const localPath = (project.sources ?? []).find((src) => src.type === "local_path")?.path ?? "?";
    console.log(`      project ${project.id} (${localPath}) ≠ workspace ${ws}`);
    if (threadId) console.log(`      thread: ${threadId}`);
    return 0;
  } finally {
    if (!process.env.BB_SMOKE_KEEP) await rm(workspace, { recursive: true, force: true });
    else console.log(`      workspace kept: ${workspace}`);
  }
}

function indent(text) {
  return String(text ?? "").split("\n").map((l) => "    " + l).join("\n");
}

function fail(message, workspace, threadId) {
  console.error(`FAIL (harness v${HARNESS_VERSION}): ${message}`);
  if (threadId) console.error(`      thread: ${threadId}`);
  console.error(`      workspace: ${workspace}`);
  return 1;
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(`ERROR (harness v${HARNESS_VERSION}): ${err?.stack ?? err}`);
    process.exit(1);
  },
);
