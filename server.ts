// bb-plugin-ast-grep — structural search and rewrite for BB agents.
//
// Wraps the ast-grep CLI (MIT, https://ast-grep.github.io) so an agent can
// match on syntax rather than text. No code from ast-grep is copied: this is
// a thin, typed caller, the same relationship bb-plugin-rtk has with rtk.
//
// Two tools:
//   bb_ast_search  — pattern → matches (path:line:col + the line)
//   bb_ast_rewrite — pattern + rewrite → a unified diff, or the applied edit
//
// A rewrite is preview-only unless `apply: true`, because a structural rewrite
// is the one operation here that changes files without a human seeing it first.
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const execFileAsync = promisify(execFileCb);

const DEFAULT_BIN = "ast-grep";
const MAX_MATCHES = 200;
const MAX_OUTPUT_CHARS = 24_000;

/** Languages ast-grep ships grammars for, as its own `--lang` names. */
export const LANGUAGES = [
  "bash", "c", "cpp", "csharp", "css", "elixir", "go", "haskell", "html",
  "java", "javascript", "json", "kotlin", "lua", "php", "python", "ruby",
  "rust", "scala", "solidity", "swift", "tsx", "typescript", "yaml",
] as const;

export interface SearchMatch {
  file: string;
  line: number;
  column: number;
  text: string;
  source: string;
}

/** Parse `ast-grep run --json=stream` output (one JSON object per line). */
export function parseSearchStream(stdout: string): SearchMatch[] {
  const out: SearchMatch[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let row: any;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const start = row?.range?.start;
    if (!row?.file || !start) continue;
    out.push({
      file: row.file,
      line: (start.line ?? 0) + 1,
      column: (start.column ?? 0) + 1,
      text: row.text ?? "",
      source: row.lines ?? "",
    });
  }
  return out;
}

/** Render matches as compact, token-cheap lines. */
export function formatMatches(matches: SearchMatch[], cap = MAX_MATCHES): string {
  if (!matches.length) return "No structural matches.";
  const shown = matches.slice(0, cap);
  const lines = shown.map(
    (m) => `${m.file}:${m.line}:${m.column}  ${m.source.trim() || m.text.trim()}`,
  );
  const more = matches.length > shown.length ? `\n… ${matches.length - shown.length} more match(es)` : "";
  return `${matches.length} match(es)\n${lines.join("\n")}${more}`;
}

/** Clamp long tool output so a rewrite diff can't flood a thread. */
export function clamp(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… output truncated at ${max} characters`;
}

const langSchema = z
  .enum(LANGUAGES)
  .describe("Language grammar to parse with. Use typescript for .ts, tsx for .tsx.");

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("bb-plugin-ast-grep loaded");

  const settings = bb.settings.define({
    astGrepPath: {
      type: "string" as const,
      label: "ast-grep binary",
      default: "",
      description: "Absolute path to ast-grep. Empty = use `ast-grep` from PATH.",
    },
  });
  let { astGrepPath } = await settings.get();
  settings.onChange((next) => {
    astGrepPath = next.astGrepPath;
  });

  const bin = () => (astGrepPath.trim() ? astGrepPath.trim() : DEFAULT_BIN);

  function requireBin(): string | null {
    if (bin() !== DEFAULT_BIN && !existsSync(bin())) return null;
    return bin();
  }

  async function run(args: string[], cwd: string, signal?: AbortSignal) {
    try {
      const { stdout, stderr } = await execFileAsync(requireBin() ?? DEFAULT_BIN, args, {
        cwd,
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        signal,
      });
      return { ok: true as const, stdout, stderr };
    } catch (err: any) {
      // ast-grep exits 0 with matches and 1 with none; anything else is a real error.
      if (err?.code === 1 && typeof err.stdout === "string") {
        return { ok: true as const, stdout: err.stdout, stderr: err.stderr ?? "" };
      }
      const detail = (err?.stderr || err?.message || "unknown error").toString().slice(0, 800);
      return { ok: false as const, message: `ast-grep failed: ${detail}` };
    }
  }

  bb.agents.registerTool({
    name: "bb_ast_search",
    description:
      "Search code by syntax tree instead of text: pass an AST pattern with $METAVARIABLES " +
      "(e.g. 'console.log($A)', 'if ($COND) { $$$BODY }') and a language. Matches calls, " +
      "declarations and structures that regex cannot express, and ignores formatting. " +
      "Use it to find every caller of a shape, every matching declaration, or a pattern " +
      "that must not span comments and strings.",
    parameters: z.object({
      pattern: z.string().min(1).describe("AST pattern with $METAVAR and $$$MULTI metavariables."),
      lang: langSchema,
      path: z.string().optional().describe("File or directory to search. Default: the project root."),
      maxMatches: z.number().int().min(1).max(MAX_MATCHES).optional().describe("Cap on returned matches (default 200)."),
    }),
    async execute({ pattern, lang, path, maxMatches }, { threadId, projectId, signal }) {
      const cwd = await threadCwd(bb, threadId, projectId);
      const target = path ? (isAbsolute(path) ? path : resolve(cwd, path)) : cwd;
      const args = ["run", "-p", pattern, "-l", lang, "--json=stream", target];
      const r = await run(args, cwd, signal);
      if (!r.ok) return r.message;
      const matches = parseSearchStream(r.stdout);
      return formatMatches(matches, maxMatches ?? MAX_MATCHES);
    },
  });

  bb.agents.registerTool({
    name: "bb_ast_rewrite",
    description:
      "Rewrite code by syntax pattern: matches an AST pattern and replaces each match with " +
      "`rewrite`, where $METAVARIABLES from the pattern are substituted. By default it returns " +
      "a unified diff and changes nothing — read it, then call again with apply: true. " +
      "Structural rewrites are precise but not type-aware: check the diff.",
    parameters: z.object({
      pattern: z.string().min(1).describe("AST pattern to match."),
      rewrite: z.string().min(1).describe("Replacement, using the pattern's $METAVARIABLES."),
      lang: langSchema,
      path: z.string().optional().describe("File or directory. Default: the project root."),
      apply: z.boolean().optional().describe("Write the change. Default false (preview diff only)."),
    }),
    async execute({ pattern, rewrite, lang, path, apply }, { threadId, projectId, signal }) {
      const cwd = await threadCwd(bb, threadId, projectId);
      const target = path ? (isAbsolute(path) ? path : resolve(cwd, path)) : cwd;
      const args = ["run", "-p", pattern, "-r", rewrite, "-l", lang];
      if (apply) args.push("--update-all");
      args.push(target);
      const r = await run(args, cwd, signal);
      if (!r.ok) return r.message;
      const body = (r.stdout || "").trim();
      if (!body) return "No structural matches — nothing to rewrite.";
      const header = apply ? "Applied:" : "Preview (nothing written; call again with apply: true to write):";
      return `${header}\n${clamp(body)}`;
    },
  });

  bb.onDispose(() => {
    bb.log.info("bb-plugin-ast-grep disposed");
  });
}

/** The directory this thread actually works in: its environment's path, not
 *  the project root. A worktree or an attached workspace is a different
 *  directory from the project, and resolving paths against the project puts
 *  files in the wrong tree. */
export async function threadCwd(bb: BbPluginApi, threadId: string, projectId: string): Promise<string> {
  const asPath = (v: any): string | null =>
    v && typeof v === "object" && typeof v.path === "string" && v.path.trim() ? v.path : null;
  try {
    const t: any = await bb.sdk.threads.get({ threadId } as any);
    const thread = t?.thread ?? t;
    const envId = thread?.environmentId;
    if (envId) {
      const e: any = await bb.sdk.environments.get({ environmentId: envId } as any);
      const p = asPath(e?.environment ?? e);
      if (p) return p;
    }
  } catch {
    // fall through to the project
  }
  try {
    const p: any = await bb.sdk.projects.get({ projectId } as any);
    const sources = (p?.project ?? p)?.sources ?? [];
    const src = Array.isArray(sources) ? sources.find((s: any) => s.type === "local_path") : null;
    if (src?.path) return src.path;
  } catch {
    // fall through to the server cwd
  }
  return process.cwd();
}
