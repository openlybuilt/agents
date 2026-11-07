# Repository instructions

- This repository executes workflows and manages VM sessions; the backend owns persistent data and orchestration. Do not add an agents database or call agents directly from the platform.
- Keep provider-specific logic inside adapters. Preserve the session contract, cancellation, cleanup, recording, and configured-capability behavior when changing providers. See [docs/vm-providers.md](docs/vm-providers.md).
- Keep sensitive values out of logs and traces. Do not expose provider credentials or live-view tokens.
- Use the existing `pnpm typecheck`, `pnpm build`, and `pnpm format:check` checks as appropriate. Follow the user's instructions before incurring provider usage or modifying tests.
- Do not create or modify README.md or other documentation files unless the user explicitly requests it.
