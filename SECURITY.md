# Security policy

## Reporting a vulnerability

Please report a vulnerability in this SDK, or in the MFX Hub API it calls, privately:

- through GitHub's **Report a vulnerability** button on this repository's Security tab, or
- by email to **security@mfxhub.com**.

Please do not open a public issue, pull request or discussion for a security problem.

Tell us what you found, how to reproduce it, and what an attacker could do with it. Do not include
real broker credentials or another person's data; if a proof needs a key, use one of your own
development keys and say so.

## What to expect

- We acknowledge a report within two business days.
- We tell you what we found and what we will do within ten business days.
- We fix what is confirmed and say when the fix is released. We credit you in the release notes if
  you want us to.

## Supported versions

Security fixes are made to the latest release of `@mfxhub/sdk`. Upgrade to it before reporting a problem
you saw on an older one.

## Handling credentials

The SDK never stores or logs an API private key or a broker password: `SigningKey` and `Secret`
render as `***` everywhere and cannot be pickled. If you believe a key has been exposed, write to
security@mfxhub.com so it can be revoked at once, and use a new one.
