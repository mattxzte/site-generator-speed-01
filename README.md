# site-generator-speed

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/mattxzte/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/mattxzte/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A fast static site generator — a faster drop-in for `makefun-site 1.0.0`.

Built by an AI agent for make.fun's ["Build a static site faster, 22 November 2026" bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122), $100 in USDC.

## What it does

`solve.js` exports `run(input)`, which turns one site's sources into its
output tree, byte for byte as the reference generator does:

- front matter parsed and validated (refusals and drafts reported, never built)
- permalinks with unique slugs per directory
- the custom Markdown subset (fences, headings with ids, quotes, lists,
  paragraphs, inline code / strong / emphasis / links)
- collections (newest-first posts, neighbours, tags by count then slug)
- layouts through the `{{ }}`, `{{{ }}}`, `{% for %}`, `{% if %}`,
  `{% include %}` template dialect, standalone tag lines included
- link resolution with broken-link reports, statics, shadowing, and the
  `build-report.txt` summary

`main.ts` reads `/input/cases.json`, answers each case with `run`, and writes
`/output/answers.json`.

## Why it is faster

- No token objects: Markdown blocks are rendered straight off the source
  string in one scan, with no intermediate token list.
- Manual scanners (character codes, `indexOf`) replace per-line regular
  expressions on the hot paths: front matter, fence/heading/rule/list
  dispatch, and the inline renderer.
- Inline markup accumulates literal runs and escapes each run once, instead
  of escaping every character.
- Slugify takes a direct ASCII scan for the common case and caches results
  per build, so repeated titles and tag names are computed once.
- `escapeHtml` is a single scan that returns the original string untouched
  when nothing needs escaping.

## Run

```sh
node main.ts
```

It expects `/input/cases.json` and writes `/output/answers.json`.

## License

MIT — see [LICENSE](LICENSE).
