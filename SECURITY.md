# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities by email to **greg@daintree.org**, not as a public issue. A public issue discloses the bug before there's a fix.

Include what you found, how to reproduce it, the Daintree version and platform, and what an attacker could do with it. A proof of concept helps if you have one.

## What counts

Daintree drives coding agents that run with your credentials, so the boundaries around them matter most. Reports in these areas are especially welcome:

- Authorization of the MCP server and its tool surface, including tool-set tiers
- Bypassing a confirmation or an ownership check
- Crossing a remote-host boundary or a plugin boundary
- The IPC surface and the preload bridge
- Credential and token handling, or terminal contents leaving the machine

Bugs that don't have a security impact belong in a regular issue; see [CONTRIBUTING.md](CONTRIBUTING.md).
