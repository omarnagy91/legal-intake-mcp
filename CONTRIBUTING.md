# Contributing

Issues and pull requests are welcome, especially Arabic contract phrasing the server misses (clause numbering, Hijri dates, notice periods).

## Setup

Requires Node 20 or newer.

```bash
npm ci
npm test       # builds, then runs the full suite
npm run demo   # runs every tool on both sample contracts over MCP
```

## Ground rules

- **Extract and cite, never advise.** A change that makes the server judge a clause, or return a conclusion without an anchor, will not be merged.
- **Text you return is verbatim.** Folding and normalisation are for matching only; any repair of the source text must be listed in `normalisations`.
- **Add a test with every fix**, ideally with the failing Arabic or English phrase quoted in it. Sample contracts use `example.com` and `example.org` addresses only; never put real names or addresses in samples or tests.
- No new dependencies without a reason in the pull request. The server makes no network calls and must stay that way.
- Commit messages follow Conventional Commits (`fix: ...`, `feat: ...`, `docs: ...`).

By contributing you agree your work is released under the MIT licence of this repository.
