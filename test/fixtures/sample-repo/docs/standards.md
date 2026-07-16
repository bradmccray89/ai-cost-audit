# Engineering standards

## Coding standards

All code must follow our standards: use two-space indentation everywhere, never use
tab characters, always prefer const over let when a binding is never reassigned, name
boolean variables with an is or has prefix, keep every function under forty lines of
code, write descriptive commit messages in the imperative mood, and add a unit test
for every exported function before opening a pull request for review.

## Review process

Every pull request needs one approval from a code owner. Squash merge only. Delete
branches after merging. Keep pull requests under four hundred changed lines whenever
practical so reviewers can give meaningful feedback in a single pass.
