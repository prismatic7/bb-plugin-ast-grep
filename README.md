# bb-plugin-ast-grep

Structural code search and rewrite for BB agents. Match on the syntax tree
instead of text: every caller of a shape, every matching declaration, a pattern
that must not span comments or strings.

Wraps [ast-grep](https://ast-grep.github.io) (MIT) — no code from it is copied;
the plugin is a typed caller over the CLI.

## Tools

### `ast_grep_search`

```
ast_grep_search(pattern: string, lang: string, path?: string, maxMatches?: number)
```

Pass an AST pattern with metavariables — `console.log($A)`,
`if ($COND) { $$$BODY }` — plus a language. Returns
`path:line:column  source line` per match, capped at 200, with a count.

### `ast_grep_rewrite`

```
ast_grep_rewrite(pattern: string, rewrite: string, lang: string, path?: string, apply?: boolean)
```

Substitutes the pattern's metavariables into `rewrite`. **Preview-only by
default**: it returns a unified diff and writes nothing. Call it again with
`apply: true` to write. A structural rewrite is precise but not type-aware,
so the diff is the point.

## Languages

`bash c cpp csharp css elixir go haskell html java javascript json kotlin lua
php python ruby rust scala solidity swift tsx typescript yaml` — validated
against ast-grep's own `--lang` names.

## Requirements

`ast-grep` on `PATH` (or set its absolute path in the plugin settings).
`brew install ast-grep` — v0.51.3 tested.

## Install

```sh
npm install
npm run bundle
bb plugin install . --yes
bb plugin reload ast-grep
```

## Development

```sh
npm run build      # tsc typecheck
npm test           # parsers, formatter, and a real fixture run when ast-grep is present
npm run bundle     # bb plugin build → dist/
```
