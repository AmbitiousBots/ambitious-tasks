# Contributing

Ambitious Tasks is a JSON command-line module for bots. Contributions should make a task easier to complete or a stored result more dependable while preserving the shared module contract.

Open an issue to discuss a behavior change. Pull requests should explain the user-visible result, show the exact verification output, and record design decisions that a contributor can understand without private context. Follow the [code of conduct](CODE_OF_CONDUCT.md).

Install mise and elan as described in [README.md](README.md), then run:

```sh
mise trust && mise install
npm ci
npm run release:check
verify/run
npm outdated
npm audit
```

The release check includes types, lint, import boundaries, tests, the JSON contract, TLA+ models, Lean proofs and feature verification. Fix a failing check at its cause. Add behavior coverage for a changed promise; do not write tests that depend only on private implementation details.

Keep domain logic pure in `src/domain/`, database access in `src/db/`, and argument parsing in `src/cli/`. Time and randomness enter through the CLI and are passed to the logic. Add forward-only numbered migrations for schema changes. Released migrations are not edited. Update the feature map and command documentation with user-visible changes.

Code, fixtures, comments and documentation must be understandable without access to the maintainers' private systems. The standalone check enforces this requirement. New dependencies need exact versions, a reason for existing, and a clean audit. Preserve the Apache-2.0 license and existing notices. By contributing, you agree that your contributions are provided under that license.
