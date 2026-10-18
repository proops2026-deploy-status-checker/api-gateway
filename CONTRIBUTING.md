# Contributing to api-gateway

## Workflow
- GitHub Flow: branch from `master`, open a PR into `master`. Direct pushes to `master` are blocked.
- 1 approval from the other maintainer is required; new commits dismiss earlier approvals.
- Resolve every review thread before merging.
- Squash merge only — the PR title becomes the commit on `master`.

## Branch names
`<type>/<owner>/<short-description>`, e.g. `fix/duc/patch-deploys-route`, `docs/tien/pr-template`.

## PR titles (Conventional Commits)
`<type>(<scope>): <subject>` — imperative, lower-case, no trailing period, ≤ 72 chars.

- Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `build`, `ci`, `style`
- Scopes in this repo: `routes`, `auth`, `proxy`, `k8s`, `docker` — omit the scope for repo-wide changes
- Breaking change: add `!` after the type/scope and a `BREAKING CHANGE:` footer
- Add `Refs: TIE-xx` when the change has a Linear issue

## Before opening a PR
```bash
npm run lint
npm test
```
