// ast-grep port tests: the parsers, the formatter, and — when the binary is
// installed — real search and rewrite against a fixture.
//
// Run: node --test test/ast-grep.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatMatches, parseSearchStream, clamp } from "../server.ts";

const hasBin = (() => {
  try {
    execFileSync("ast-grep", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const SAMPLE = [
  '{"text":"console.log(\\"x\\")","range":{"start":{"line":0,"column":10}},"file":"t.ts","lines":"const a = console.log(\\"x\\");"}',
  "not json",
  '{"text":"console.log(\\"y\\")","range":{"start":{"line":4,"column":10}},"file":"t.ts","lines":"const b = console.log(\\"y\\");"}',
].join("\n");

test("parseSearchStream keeps real rows and skips noise", () => {
  const m = parseSearchStream(SAMPLE);
  assert.equal(m.length, 2);
  assert.equal(m[0].line, 1); // ast-grep lines are 0-based
  assert.equal(m[1].line, 5);
  assert.equal(m[0].file, "t.ts");
});

test("formatMatches is compact and counts the remainder", () => {
  const m = parseSearchStream(SAMPLE);
  const out = formatMatches(m);
  assert.match(out, /^2 match\(es\)/);
  assert.match(out, /t\.ts:1:11/);
  const capped = formatMatches(m, 1);
  assert.match(capped, /… 1 more match/);
});

test("empty result says so", () => {
  assert.equal(formatMatches([]), "No structural matches.");
});

test("clamp truncates and says so", () => {
  const out = clamp("x".repeat(100), 10);
  assert.match(out, /truncated at 10/);
});

test("search and rewrite against a real fixture", (t) => {
  if (!hasBin) return t.skip("ast-grep not installed");
  const dir = mkdtempSync(join(tmpdir(), "astgrep-"));
  const file = join(dir, "a.ts");
  writeFileSync(file, 'const a = console.log("x");\nconst b = console.log("y");\n');

  const search = execFileSync("ast-grep", ["run", "-p", "console.log($A)", "-l", "typescript", "--json=stream", dir], { encoding: "utf8" });
  assert.equal(parseSearchStream(search).length, 2);

  const dry = execFileSync("ast-grep", ["run", "-p", "console.log($A)", "-r", "logger.info($A)", "-l", "typescript", dir], { encoding: "utf8" });
  assert.match(dry, /logger\.info\("x"\)/);
  assert.match(readFileSync(file, "utf8"), /console\.log/, "dry run must not write");

  execFileSync("ast-grep", ["run", "-p", "console.log($A)", "-r", "logger.info($A)", "-l", "typescript", "--update-all", dir], { encoding: "utf8" });
  const after = readFileSync(file, "utf8");
  assert.match(after, /logger\.info\("x"\)/);
  assert.equal(after.includes("console.log"), false);
});
