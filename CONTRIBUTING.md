# Contributing to the MFX Hub TypeScript SDK

Thank you for helping. Bug reports, fixes, documentation and tests are all welcome.

## Before you start

- **A security problem?** Do not open an issue. Follow [SECURITY.md](SECURITY.md).
- **A question about your account, a terminal or the API itself?** Write to support@mfxhub.com.
  The documentation is at [docs.mfxhub.com](https://docs.mfxhub.com).
- **A bug in the SDK?** Open an issue with the SDK version (`npm ls @mfxhub/sdk`), your Node.js
  version, what you did, what you expected and what happened. Leave out API keys, broker logins
  and passwords, and anything else that identifies an account.
- **A larger change?** Open an issue first, so we can agree on the shape before you write it.

## Setting up

You need Node.js 22 or 24.

```bash
npm ci
npm test                 # the unit tests, with 100% coverage required
npm run lint             # ESLint, strict type-checked rules
npm run format           # Prettier
npm run typecheck        # strict TypeScript
npm run check:gen        # the generated types match spec/openapi.yaml
```

The unit tests need no network and no MFX Hub account: every call is answered by a scripted
response.

The shared SDK test suite, which every MFX Hub SDK passes, runs against a fake MFX Hub that is a
Python 3.12 program, vendored in `test/conformance/suite`:

```bash
uv venv --python 3.12 .hub
uv pip install --python .hub --require-hashes -r test/conformance/hub-requirements.txt
MFX_SUITE_PYTHON=.hub/bin/python npm run test:conformance   # .hub\Scripts\python.exe on Windows
```

## What a change needs

- **Tests first.** A fix comes with the test that failed before it. Coverage stays at 100%.
- **Types.** `strict` TypeScript passes, with no `any` in the public surface.
- **The SDK's rules hold.** Every write takes an `idempotencyKey` and none invents one; execution
  methods resolve to a result and never reject for what the platform or the network does; prices,
  volumes and money are decimal strings, never a `number`; a private key never reaches a log, a
  string or JSON.
- **No hand edits in `src/generated`.** It is generated from `spec/openapi.yaml` by `npm run gen`,
  and CI fails on any difference. A change to the API description comes from MFX Hub, not from a
  pull request here.
- **A line in [CHANGELOG.md](CHANGELOG.md)** under _Unreleased_, written for someone upgrading.

## Signing off your commits

Every commit must carry a Developer Certificate of Origin sign-off: a statement that you wrote the
change, or otherwise have the right to submit it under this project's licence. The full text is at
[developercertificate.org](https://developercertificate.org). Add it with `-s`:

```bash
git commit -s -m "fix: a stream reconnect keeps its subscriptions"
```

which appends `Signed-off-by: Your Name <you@example.com>`, using the name and email in your git
configuration. A pull request with an unsigned commit cannot be merged; `git commit --amend -s`
or `git rebase --signoff` fixes it.

## How a pull request lands

The SDK is developed in a private repository alongside the platform it calls, and each release is
published here as a single commit. So a pull request here is not merged directly. Instead:

1. We review it here, in public, as usual.
2. Once it is approved, we apply it to the next release, keeping you as the commit's author and
   your sign-off.
3. When that release is published, we close the pull request with a link to it, and the
   changelog credits you.

The release that carries your change is usually the next one. If we cannot take a change, we say
why in the pull request.

## Licence

By contributing, you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE), the same as the rest of the project.

## Code of conduct

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).
