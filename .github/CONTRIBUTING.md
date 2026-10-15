# Contributing to Ccut

Thanks for wanting to help! Bug fixes, small improvements and well-scoped features are all welcome.

1. **Open an issue first** for anything bigger than a small fix, so we can agree on the approach before you write code.
2. Fork the repository and create a branch from `main`.
3. Make your change, run the checks and open a pull request.

## Setup

See [Getting started](../README.md#-getting-started) in the README. In short:

```bash
bun install
cp apps/web/.env.example apps/web/.env.local
bun run dev:web            # editor at http://localhost:3000
```

The editor imports the compositor from the prebuilt package in [`packages/opencut-wasm`](../packages/opencut-wasm), so you only need Rust when you change something under `rust/`. In that case, read [its README](../packages/opencut-wasm/README.md) to rebuild the package.

`apps/electron` is the Ccut desktop app. `apps/desktop` is OpenCut's experimental native desktop app, which Ccut does not use.

## Code style

- Tabs for indentation, LF line endings in new files.
- Functions with two or more parameters take one object (`foo({ a, b })`); ESLint enforces this.
- No `eslint-disable`, `@ts-ignore`/`@ts-expect-error`, unsafe `as` casts, or new entries in `eslint-suppressions.json`.
- No new dependency without a short explanation of why it is needed.
- UI text is in English.

## Tests

Write tests where real behaviour can break: logic, stored data, security, time or memory limits. A bug fix should come with a test that fails without it. Keep UI components thin and put decisions in small pure helpers that are easy to test.

Before you open a pull request:

```bash
bun run qa                 # TypeScript (0 errors), bun test, ESLint (0 errors)
```

## Stored projects

People's real projects live in the app's local storage. A change that touches stored data must include a tested, additive migration; never rewrite or delete existing projects.
