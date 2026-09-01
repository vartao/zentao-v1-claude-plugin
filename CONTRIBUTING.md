# Contributing

1. Create a focused branch and keep organization-specific fields or URLs out of the public codebase.
2. Run `npm install`, `npm run build`, `npm run typecheck`, and `npm test`.
3. Add mock-server tests for API behavior. Tests must never access a real ZenTao server.
4. Run `npm run build:plugin` and validate the generated marketplace before submitting a pull request.

Do not commit credentials, private hostnames, real user names, production IDs, or exported ZenTao data.
