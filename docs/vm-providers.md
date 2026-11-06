# Extending VM providers

This guide describes the current agents/backend/platform implementation. The supported combinations today are OnKernel Browser and Daytona Windows Computer. Other provider drafts are not enabled. A provider is advertised only when it is registered and configured.

## How execution fits together

1. The platform obtains provider capabilities through the backend and saves a provider and execution target with a workflow.
2. The backend owns workflow versions, runs, recordings, and history. It resolves inputs, checks an explicit provider against agents' capabilities, and asks agents to start the run.
3. Agents validates the workflow, selects the matching provider, opens a session, executes steps, and reports results, events, and recording data to the backend. Agents has no database.

When a saved workflow omits the provider, agents uses the catalog's default for its target. An explicit unavailable or incompatible provider must fail rather than silently switch providers.

## Add an adapter

1. Add the provider identifier to `ProviderId` in `src/computer/session.ts` and to `providerIds` and `supportedTargets` in `src/computer/provider-catalog.ts`. Only change `defaults` when deliberately changing the default for an existing target.
2. Implement `ComputerProvider.open` and a `ComputerSession` in `src/computer/`. Read `ComputerOpenOptions`, including the execution target, timeout, and abort signal. Reject unsupported targets explicitly.
3. Register a configured adapter in `src/server.ts`, under its provider ID and supported target in the `ComputerProviders` registry. Keep provider credentials in environment variables, not workflow definitions or logs. An unconfigured adapter must not appear in `provider-capabilities`.
4. If introducing a **new target**, update the target types and validation in agents and backend, then update platform capability parsing, provider/VM choices, and step editors together. Merely registering an adapter does not make a new OS type work throughout the product.
5. Validate the integration before advertising it. Follow the checklist below and document any constraints in the PR.

See `src/computer/onkernel.ts` and `src/computer/daytona.ts` for existing implementations. The backend's provider discovery is in `src/runs/agents-client.ts`; platform capability parsing is in `src/components/workflows/use-provider-capabilities.ts` in the platform repo.

## Session contract

The complete interface is in `src/computer/session.ts`:

- **Screenshots and clicking:** `screenshot()` returns PNG bytes. Click coordinates use that screenshot's pixel space. Validate dimensions and reject invalid coordinates; do not silently clamp them. Keep the image dimensions and coordinate mapping consistent across scaling and resize. The workflow runner validates manual coordinates; the AI path can retry invalid coordinates with a fresh screenshot.
- **Input and navigation:** implement `navigate`, `click`, `type`, and `pressKeys`. Text entry must preserve the supplied text. Key entries are sequential; `+` joins keys in a chord, such as `Ctrl+l`.
- **Scrolling:** `scroll` is coordinate-based wheel input for AI actions; `scrollPage` supports page-pixel workflow steps. Windows workflow steps use optional `scrollWheel` and wheel ticks. Reject unsupported directions or units clearly rather than pretending a scroll succeeded. Daytona currently rejects horizontal wheel input.
- **Live view:** expose `liveViewUrl` only when it is suitable to pass through backend to the UI. Do not include provider credentials in URLs or logs.
- **Recordings:** implement `startRecording`, `stopRecording`, and the recording's streaming `download` method. Provider-specific reference IDs are optional; streaming the data is the important boundary. Report recording failure separately from workflow status and confirm the saved recording plays after the session closes. Do not introduce an arbitrary recording size cap. Native Daytona recording has been unreliable in previous tests.
- **Lifecycle:** honor cancellation and timeouts, clean up partially created resources, and make close/stop safe under repeated calls. Preserve enough provider information to recover or clean up after ambiguous creation failures. Do not expose secrets in errors or traces.

Current run limits allow up to one hour. The runner currently uses a ten-minute recording export window for Browser and a one-hour export window for Windows, plus cleanup time. Resource lifetime must cover execution and finalization. Adding providers with different finalization needs may require an explicit runtime change; do not assume those target-based limits are a generic provider contract.

## Validation checklist

Use existing checks (`pnpm typecheck`, `pnpm build`, and `pnpm format:check`) and validate in an isolated environment with the user's authorization before consuming provider resources.

- Confirm discovery exposes only configured combinations; check unavailable, unknown, and incompatible providers and legacy defaults.
- Create a session and verify live view, screenshots, coordinate mapping, click, text, key chords, navigation, and each supported scroll mode on a controlled page or application.
- Run a workflow through backend and agents; check step results, event metadata, error reporting, cancellation, timeout, and cleanup, including failure during creation.
- Start, stop, export, save, and play a recording after the session is closed. Verify failures are reported and resources are still cleaned up.
- Confirm credentials, prompts, page contents, screenshots, and input values are not emitted in event logs. Do not expose temporary live-view URLs in public examples.
- Verify the full one-hour execution budget and finalization grace against the provider's actual resource limits. Keep a provider disabled until its required capabilities, including recording, are validated.

Avoid claiming a provider or target is supported based only on an SDK interface or a local mock. Record what was actually exercised and any remaining limitations in the PR.
