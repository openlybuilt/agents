# Openly agents

The agents service executes Openly workflows. It opens a configured computer session, performs workflow steps, and reports status, events, live-view information, and recordings to the backend. The backend owns the database and starts and stops runs; the platform communicates with the backend rather than calling agents directly.

For the complete local setup, see the [computer-use repository](https://github.com/openlybuilt/computer-use). To add a VM provider, see [Extending VM providers](docs/vm-providers.md).

## Requirements and configuration

Use Node.js 24, pnpm 11.25.0, a running Openly backend, an OpenAI API key and model, and at least one configured VM provider. The agents service listens on `127.0.0.1`, port `3100` by default.

| Variable                | Purpose                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `PORT`                  | Agents port; default `3100`.                                           |
| `BACKEND_URL`           | Backend loopback origin, such as `http://127.0.0.1:3000`.              |
| `AGENTS_API_TOKEN`      | Shared bearer token for backend-to-agents requests.                    |
| `AGENTS_CALLBACK_TOKEN` | Shared bearer token for agents-to-backend callbacks.                   |
| `OPENAI_API_KEY`        | API key for the computer-use model.                                    |
| `OPENAI_MODEL`          | Model name used for AI actions.                                        |
| `ONKERNEL_API_KEY`      | Enables OnKernel Browser sessions when set.                            |
| `DAYTONA_API_KEY`       | Enables Daytona Windows sessions when set.                             |
| `DAYTONA_API_URL`       | Optional Daytona API origin; defaults to `https://app.daytona.io/api`. |

The two service tokens must match their corresponding backend values and be 32–256 URL-safe characters. `BACKEND_URL` must be an HTTP origin on `127.0.0.1`. Keep keys and tokens outside the repository.

## Run locally

From this directory, after configuring the environment and starting the backend:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

`GET /health` checks the process. The backend uses the authenticated `/capabilities` and `/provider-capabilities` endpoints to discover configured targets and providers. OnKernel supports Browser; Daytona supports Windows Computer. Daytona's native recording has been unreliable in prior validation; check playback in your environment.

## Checks

```sh
pnpm typecheck
pnpm build
pnpm format:check
```

Provider sessions may incur provider and model usage charges. Live views and recordings can contain information visible in the VM; handle them accordingly.

## License

[MIT](LICENSE).
