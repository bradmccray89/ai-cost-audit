# Project instructions

This is a TypeScript monorepo. Use npm workspaces. Run tests with vitest before
committing. Prefer functional patterns and avoid classes unless modeling stateful
resources.

## Coding standards

All code must follow our standards: use two-space indentation everywhere, never use
tab characters, always prefer const over let when a binding is never reassigned, name
boolean variables with an is or has prefix, keep every function under forty lines of
code, write descriptive commit messages in the imperative mood, and add a unit test
for every exported function before opening a pull request for review.

See @docs/standards.md for the full standards document.

## Architecture notes

Services live under packages/services. Shared utilities live under packages/shared.
Never import a service from another service directly; go through the shared event bus.
