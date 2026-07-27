# TypeScript / React / Electron Style Guide (MaDControl — legacy)

> ⚠️ **This guide documents the legacy Electron app (`Software/MaDControl/`), which is
> frozen.** The shipped, deployed app is **`Software/Control/`** — a frontend-only
> Web Serial + WASM PWA. It shares the TS/React conventions below (interface/type/enum
> rules, strict `tsconfig`, the generated `protoemb` codec boundary), but differs in
> tooling and architecture: a **flat ESLint config** (not `erb`), **Vite** (not webpack),
> **Zustand + a Web Worker + Comlink** (not Electron main/renderer IPC), and **Vitest**
> (not Jest). New app work goes in `Control`; a WASM-app-specific guide is a
> pending follow-up. Treat the Electron-specific sections below as historical.

This guide governs the desktop control app under `Software/MaDControl/` — the Electron main process (`src/main/`), the React renderer (`src/renderer/`), and the shared/util code (`src/shared/`, `src/utils/`). It documents the conventions actually used in this package so a contributor can write idiomatic code and pass the configured checks on the first try.

The stack: Electron 35 + React 19 + TypeScript 5.8, built with the `electron-react-boilerplate` (ERB) webpack setup, MUI 5 for UI, and a Rust `protoemb-bridge` child process for device I/O.

---

## Tooling & Commands

Run everything from `Software/MaDControl/` (scripts block: `package.json:37`).

```bash
npm start          # dev mode, hot reload (regenerates protocol first via prestart)
npm run package    # production build → release/build/
npm run lint       # eslint . --ext .js,.jsx,.ts,.tsx
npm run lint:fix   # eslint --fix (auto-fixes prettier + import/order, etc.)
npm test           # jest --passWithNoTests
npm run generate:proto  # regenerate src/main/generated/protoemb.ts from MaDProtocol.yaml
```

- There is **no dedicated `tsc --noEmit` / typecheck script**. Webpack builds run with `TS_NODE_TRANSPILE_ONLY=true` (`build:main`/`build:renderer`/`prestart`, `package.json:41`–`:48`), so the build will *not* fail on type errors. Type safety is enforced by your editor against `tsconfig.json` and by reviewers — **do not** rely on the build to catch type errors. (No CI workflow file is present in this directory to confirm an external gate.)
- `prestart` (`package.json:48`) and `build:main` (`package.json:41`) both run `generate:proto` first, so the generated protocol stays in sync automatically. `generate:proto` (`package.json:38`) invokes `../../Protocol/ProtoEmb/core/generate.py … --target ts --output src/main/generated`.

---

## Linting & Passing Checks

### What's enforced

`.eslintrc.js` extends the shared `erb` config (`.eslintrc.js:2`). `eslint-config-erb` (`node_modules/eslint-config-erb/index.js`) extends, in order: **`airbnb`, `airbnb/hooks`, `plugin:jest/recommended`, `plugin:promise/recommended`, `plugin:compat/recommended`, `plugin:prettier/recommended`.** Notable consequences:

1. **Prettier is an ESLint rule.** Formatting violations surface as `prettier/prettier` errors. The only non-default Prettier option lives in `package.json` (`package.json:59`): `singleQuote: true`. Everything else is Prettier defaults (2-space indent, semicolons, trailing commas, ~80 col). `.editorconfig` reinforces 2-space indent, LF, UTF-8, trim trailing whitespace, final newline (`.editorconfig:1`; trailing-whitespace trimming is disabled for `*.md`).
2. **Airbnb rules apply.** Common ones you will hit: `import/order`, `prefer-template`, `no-plusplus`, `no-continue`, `no-restricted-syntax` (no `for...of`), `global-require`, `class-methods-use-this`, `react/jsx-props-no-spreading`. Note erb relaxes `no-param-reassign` to `["error", { props: false }]`, so mutating a *property* of a parameter is allowed; only reassigning the parameter binding itself errors.
3. **`@typescript-eslint/explicit-function-return-type` and `explicit-module-boundary-types` are turned OFF by erb** — explicit return types are a project convention, not lint-enforced (see below).

The repo's local rule overrides (`.eslintrc.js:4`):

```js
rules: {
  'import/no-extraneous-dependencies': 'off',
  'react/react-in-jsx-scope': 'off',       // React 19 / new JSX transform
  'react/jsx-filename-extension': 'off',
  'import/extensions': 'off',
  'import/no-unresolved': 'off',
  'import/no-import-module-exports': 'off',
  'no-shadow': 'off',
  '@typescript-eslint/no-shadow': 'error',  // TS-aware shadow check instead
  'no-unused-vars': 'off',
  '@typescript-eslint/no-unused-vars': 'error',
}
```

### How to make `npm run lint` pass

- Run `npm run lint:fix` first — it auto-resolves all `prettier/prettier` and most `import/order` errors.
- Fix remaining Airbnb errors by following the idioms (template literals not `+`, `for...of`→`.forEach`/`.map`, etc.) **or** suppress with a *targeted, single-rule* disable comment (see below).

### Suppression policy (match the repo)

Use the **narrowest** disable, naming the exact rule. Existing examples:

```ts
// src/renderer/preload.d.ts:4
// eslint-disable-next-line no-unused-vars
interface Window { electron: ElectronHandler; }

// src/renderer/hooks/useProfiles.ts:88 (and :120)
// eslint-disable-next-line no-param-reassign
event.target.value = '';
```

- File-level `/* eslint-disable <rule> */` is reserved for **generated code only** — e.g. `src/main/generated/protoemb.ts:9` (`/* eslint-disable no-bitwise */`). The preload (`src/main/preload.ts:2`) also carries a file-level `/* eslint no-unused-vars: off */` (broken for spread args); treat that as an established exception, not a pattern to copy into new hand-written files.
- **Do / Don't:**
  - Do: `// eslint-disable-next-line no-param-reassign` on the one offending line.
  - Don't: a bare `// eslint-disable-next-line` with no rule (one exists at `src/main/main.ts:137`, but don't copy it — always name the rule).

> ⚠️ Reality check: `npm run lint` is **not currently green** on the committed tree. Verified examples: `BridgeHandler.ts` trips `class-methods-use-this`, `prettier/prettier`, `global-require`, `prefer-template`, `no-restricted-syntax` (the `for…of` in `manual-move`, `DeviceInterface.ts:542`), `no-plusplus`, and `no-continue`; `App.tsx` trips `import/order` (the MUI import at `App.tsx:6` sits after local component imports). Treat the Airbnb ruleset as the **target for new/changed code** — leave files at least as clean as you found them, and prefer `lint:fix` + targeted disables over introducing new violations.

### `.eslintignore`

Build outputs (`release/app/dist/`, `release/build/`, `.erb/dll/`), `node_modules/`, generated CSS typings (`*.css.d.ts` etc.), coverage, and logs are ignored (`.eslintignore:1`). The trailing `!.erb` line re-includes the otherwise-hidden `.erb` config dir (ESLint ignores hidden dirs by default).

---

## TypeScript Conventions

### `tsconfig.json` — strict by design

`tsconfig.json:8` sets `strict: true` plus extra strictness you must satisfy:

```jsonc
"strict": true,
"noImplicitAny": true,
"noImplicitReturns": true,
"noUnusedLocals": true,
"noUnusedParameters": true,
"exactOptionalPropertyTypes": true,   // optional ≠ `| undefined`
"target": "es2022",
"module": "node16",
"moduleResolution": "node16"
```

- `exactOptionalPropertyTypes` is on: an optional `error?: string` field may **not** be explicitly assigned `undefined`. Omit the key instead of setting it to `undefined`. (Not every optional-property site has been audited for compliance; honor this when adding fields.)
- `noUnusedParameters` is on: prefix intentionally-unused params with `_` (IPC handlers use `_event`, e.g. `DeviceInterface.ts:386`/`:514`).
- `tsconfig.json` `exclude`s `test`, `release/build`, `release/app/dist`, and `.erb/dll`.

### `interface` vs `type`

- **`interface` for object/record shapes** — this is the dominant style. All of `SharedInterface.ts`, the `DeviceState`/`DeviceActions`/`DeviceContextType` in `useDevice.tsx:18`–`:50`, and the bridge event shapes in `BridgeHandler.ts:68` are `interface`.
- **`type` for unions and discriminated unions.** Examples: the bridge event union (`BridgeHandler.ts:110`) and inline string-literal unions:

```ts
// SharedInterface.ts:120
status: 'downloading' | 'complete' | 'error';
```

```ts
// BridgeHandler.ts:110 — discriminated union keyed by `event`
type BridgeEvent =
  | BridgeEventConnected
  | BridgeEventDisconnected
  | BridgeEventAck
  /* … */;
```

### Enums vs unions

- **`enum` for protocol/domain codes** (mirrors firmware): `NotificationType` (`SharedInterface.ts:1`), `FaultedReason` (`:21`), `RestrictedReason` (`:34`), and all generated enums (`protoemb.ts`). `NotificationType` is a **string** enum (user-facing values: `ERROR = 'ERROR'`, `WARN = 'WARN'`, …); `FaultedReason`/`RestrictedReason` are plain numeric enums.
- **String-literal unions for small local closed sets** (`status`, `moveType: 'linear' | 'dwell' | 'arc' | 'math'` `SharedInterface.ts:79`).

### Naming

- `PascalCase`: types, interfaces, enums, React components, classes (`BridgeHandler`, `DeviceInterface`). Enum members are `SCREAMING_SNAKE_CASE` (`FaultedReason.ESD_POWER`).
- `camelCase`: variables, functions, methods, hook functions (`useDevice`, `useDeviceStatusQuery`).
- `SCREAMING_SNAKE_CASE`: module-level constants (`BATCH_MOVE_COUNT` `DeviceInterface.ts:38`, `ONE_MINUTE_MS`/`SAMPLE_STORAGE_COUNT` `BridgeHandler.ts:123`–`:124`) and generated message IDs (`MSG_READ_SAMPLE`).
- When importing a generated type that collides with a `SharedInterface` type, alias both with a `Proto`/`Shared` prefix (`BridgeHandler.ts:20`–`:30` / `:42`):

```ts
import { MachineState as SharedMachineState } from '@shared/SharedInterface';
import { MachineState as ProtoMachineState } from '../generated/protoemb';
```

### Explicit return types

- **Renderer hook action functions: annotate the return type.** Every action in `useDevice.tsx` is explicitly typed (`useDevice.tsx:177`):

```ts
const connect = useCallback(
  async (portPath: string, baudRate: number): Promise<string> => { … },
  [],
);
```

- Bridge/handler methods are explicitly `: void` / `: Promise<…>` (`BridgeHandler.ts:193`, `DeviceInterface.ts:474`, `DeviceInterface.ts:1011`). Because `eslint-config-erb` turns **off** `explicit-function-return-type`, this is a *project convention*, not lint-enforced — follow it for public methods and hook actions anyway.

### null vs undefined

- **`| null` for "absent/cleared cached state"**: `lastMachineState: MachineState | null` (`DeviceInterface.ts:250`), `machineState: MachineState | null` (`useDevice.tsx:21`). Initialize to `null`, reset to `null` on disconnect.
- **`?` (optional / `undefined`) for "may not be provided"**: optional struct fields (`gaugeLengthMm?: number` `SharedInterface.ts:155`, `error?: string`).
- Coalesce defensively with `??`: `newProfile.maxForce ?? 0` (`DeviceInterface.ts:602`), `typeMap[notification.type] ?? SharedNotificationType.INFO` (`BridgeHandler.ts:610`).

### async / await & error handling

- Prefer `async/await`; wrap IPC and child-process calls in `try/catch`.
- **Normalize unknown errors** with this exact idiom (used everywhere):

```ts
// DeviceInterface.ts:413, useDevice.tsx:186, etc.
const errorMessage = error instanceof Error ? error.message : String(error);
```

- **Two distinct error styles, pick by layer:**
  - **Renderer hook actions: re-throw a normalized `Error`** so callers/UI can surface it (`useDevice.tsx:185`–`:188`, `useDevice.tsx:244`–`:250`).
  - **Renderer actions that return a result object: return `{ success: false, error }`** instead of throwing (e.g. `streamGCode` — `useDevice.tsx:332`–`:342` — and `flashFirmwareFromFile`, `downloadTestFile`).
  - **Main-process IPC handlers: return `{ success, error }` result objects** for long operations (`run-test` `DeviceInterface.ts:646`/`:747`/`:752`; `flash-from-file`; `download-test-file`), or `throw new Error(message)` for connect-style failures (`DeviceInterface.ts:416`) so the renderer's `invoke().catch` fires.

### `any` usage

`any` is tolerated **only** at untyped boundaries: the bridge event listener varargs (`waitForBridgeEvent(... filter?: (...args: any[]) => boolean): Promise<any>` `DeviceInterface.ts:185`–`:186`), `*.contract.test.ts` casts to reach private methods, and the main-process logger's variadic args (`logger.ts:18`). Prefer `unknown` for new boundary code — the preload (`preload.ts:84`) and renderer event handlers (`useDevice.tsx:124`) already use `(...args: unknown[])`.

### Imports & path aliases

Aliases are defined in `tsconfig.json:22`, mirrored in Jest (`package.json:86`) and the ESLint resolver (`.eslintrc.js:21`):

| Alias | Path |
|---|---|
| `@main/*` | `src/main/*` |
| `@renderer/*` | `src/renderer/*` |
| `@shared/*` | `src/shared/*` |
| `@utils/*` | `src/utils/*` |
| `@components/*` | `src/renderer/components/*` |

- **Cross-area imports use aliases**: `import { deviceLogger } from '@utils/logger'` (`BridgeHandler.ts:19`), `import { SampleData, … } from '@shared/SharedInterface'` (`BridgeHandler.ts:20`–`:30`).
- **Generated protocol is imported relatively**, not via alias: `from '../generated/protoemb'` (`BridgeHandler.ts:31`–`:64`).
- **Import order** is enforced by Airbnb's `import/order` (builtin → external → internal, alphabetized within groups). Run `lint:fix` to satisfy it.

---

## Process Architecture & the Renderer Boundary

### Main vs renderer

- `src/main/` — Node/Electron only. Entry `main.ts`; IPC and device logic in `src/main/handlers/` (`BridgeHandler.ts`, `DeviceInterface.ts`, `NotificationSender.ts`); generated protocol in `src/main/generated/`.
- `src/renderer/` — browser context (React). **No Node APIs.** Talks to main *only* through `window.electron`.
- `src/shared/SharedInterface.ts` — the **single source of truth for types crossing the IPC boundary**. Both processes import from `@shared/SharedInterface`.

### The `contextBridge` is the only door

The renderer never imports `ipcRenderer` directly. `preload.ts:82` defines `electronHandler` and `preload.ts:102` exposes it via `contextBridge.exposeInMainWorld('electron', …)` with exactly three methods (`on`, `invoke`, `removeAllListeners`); `preload.d.ts:1` augments `Window`. All renderer code calls `window.electron.ipcRenderer.*`.

**Every channel name is a member of the `Channels` union** in `preload.ts:5`. **Add new channels there first** — passing a string not in the union is a type error.

---

## IPC Conventions

### Channel naming

Lowercase, hyphen-delimited, grouped by domain (`preload.ts:5`):

- **Request/response (renderer → main → return)**: imperative verbs — `device-connect`, `get-machine-configuration`, `save-machine-configuration`, `set-motion-enabled`, `manual-move`, `run-test`, `download-test-file`.
- **Push events (main → renderer)**: `*-updates` / `*-progress` / `*-status` — `sample-data-updates`, `machine-state-updates`, `machine-configuration-updates`, `device-status-updates`, `file-download-progress`, `firmware-flash-status`. (Notifications are an exception: `notification-error` / `-warning` / `-info` / `-success`.)

### Request/response pattern

Renderer side — wrap `invoke` in a `useCallback`, normalize errors:

```ts
// useDevice.tsx:237
const setMotionEnabled = useCallback(
  async (enabled: boolean): Promise<boolean> => {
    try {
      return await window.electron.ipcRenderer.invoke('set-motion-enabled', enabled);
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : 'Failed to set motion enabled',
      );
    }
  },
  [],
);
```

Main side — register in `setupIPCHandlers()` (`DeviceInterface.ts:383`) with `ipcMain.handle`, ignore the event arg as `_event`:

```ts
// DeviceInterface.ts:514
ipcMain.handle('set-motion-enabled', async (_event, enabled: boolean) => {
  const ackPromise = waitForBridgeEvent(
    this.bridge, 'ack', 2000,
    (command: number) => command === MSG_WRITE_MOTION_ENABLE,
  );
  this.bridge.writeMotionEnable(enabled);
  const [, success] = await ackPromise;
  return success;
});
```

The `waitForBridgeEvent(bridge, eventName, timeout, filter?)` helper (`DeviceInterface.ts:181`) is the standard way to turn the bridge's `EventEmitter` callbacks into an awaitable, timeout-bounded promise. Reuse it rather than hand-rolling listeners.

### Push pattern

Main pushes with `this.window.webContents.send('<channel>', payload)` (`DeviceInterface.ts:289`). The renderer subscribes inside a `useEffect`, registers with `ipcRenderer.on`, and **always cleans up with `removeAllListeners` on unmount**:

```ts
// useDevice.tsx:154 / :167
window.electron.ipcRenderer.on('sample-data-updates', handleSampleData);
// …
return () => {
  window.electron.ipcRenderer.removeAllListeners('sample-data-updates');
};
```

Renderer event handlers receive untyped varargs and cast the first arg (`useDevice.tsx:124`):

```ts
const handleSampleData = (...args: unknown[]) => {
  const data = args[0] as SampleData;
  // …
};
```

---

## React Conventions

### Component declaration

- **Functional components only.** No class components.
- The prevailing style is a **default-exported function**, in one of two forms:

```ts
// MachineStatus.tsx:90 / :167 — named declaration + default export
function StatusComponent() { … }
export default StatusComponent;

// App.tsx:23 / Dashboard, TestRunner — inline default
export default function App() { … }
```

- `React.FC<Props>` appears in a couple of files (`GCodeGenerator.tsx:12`, `TestProfile.tsx:145`) but the **majority pattern is a plain function** — prefer the plain function form for new components, typing props via a destructured parameter:

```ts
// TestRunner.tsx:32 (props interface at :28)
export default function TestRunner({ onRunTest }: TestRunnerProps) { … }
```

- Props interfaces are named `<Component>Props` and declared in the same file.
- One component per file. The file/route name is what matters for imports; the internal identifier may differ (`MachineStatus.tsx` exports `StatusComponent` as default).

### Barrel exports

Each folder (`components/`, `pages/`, `hooks/`) has an `index.ts` re-exporting its public surface so consumers import from the folder:

```ts
// components/index.ts:1
export { default as NavBar } from './NavBar';
export { default as MachineStatus } from './MachineStatus';
// hooks/index.ts:1
export { useDevice, DeviceProvider } from './useDevice';
export { useProfiles } from './useProfiles';
```

Consume via `import { useDevice } from '@renderer/hooks'` (`MachineStatus.tsx:5`).

### Hooks & state management

- Hook files live in `src/renderer/hooks/`. Files exporting JSX (a Provider) are `.tsx` (`useDevice.tsx`); pure-logic hooks are `.ts` (`useProfiles.ts`). Note `useDeviceStatusQuery.tsx` is `.tsx` despite returning no JSX — prefer `.ts` for new JSX-free hooks.
- Hook names start with `use`. Custom hooks return either a result object (`useDeviceStatusQuery` returns `{ data, isLoading, error }`, `useDeviceStatusQuery.tsx:15`) or a tuple (`useDevice` returns `[DeviceState, DeviceActions]`, `useDevice.tsx:517`).
- **Centralized device state uses React Context, not Redux.** `DeviceProvider` (`useDevice.tsx:59`) owns all device state and provides `{ deviceState, actions }`; components call `const [state, actions] = useDevice()`. The consumer hook throws if used outside the provider:

```ts
// useDevice.tsx:520
if (context === undefined) {
  throw new Error('useDevice must be used within a DeviceProvider');
}
```

- **Memoize the context value and the actions object** with `useMemo`, and wrap every action in `useCallback` with correct deps (`useDevice.tsx:464` for `actions`, `:504` for `contextValue`) to avoid re-rendering all consumers.
- Use `useRef` for mutable values that must not trigger re-renders (sample ring buffer, in-flight load promise — `useDevice.tsx:80`–`:82`).
- `@tanstack/react-query` is a dependency but device status is currently a hand-rolled hook; prefer the existing Context/hook pattern for device state.

### UI library

MUI 5 (`@mui/material`) with a dark theme created once in `App.tsx:17` and provided via `ThemeProvider`. Routing is `react-router-dom`'s `MemoryRouter` (`App.tsx:1`). Use MUI components (`Box`, `Grid`, `Typography`, `Skeleton`) and `sx`/`style` props as in `MachineStatus.tsx`. Show `<Skeleton>` while data is `null` (`MachineStatus.tsx:153`).

---

## Generated Protocol Code

`src/main/generated/protoemb.ts` is **generated from `Protocol/MaDProtocol.yaml`** and is marked `DO NOT EDIT` (`protoemb.ts:1`–`:7`).

- **Never hand-edit it.** To change protocol types, edit `Protocol/MaDProtocol.yaml` (or the templates) and run `npm run generate:proto` (or rely on the `prestart`/`build:main` pre-hooks).
- It is the **only** file allowed a file-level `/* eslint-disable … */` for a *generated* reason (`protoemb.ts:9`, `no-bitwise`).
- It is consumed exclusively in the main process. `BridgeHandler` imports the `encode*`/`decode*` functions, generated enums/structs, and `MSG_*` command IDs (`BridgeHandler.ts:31`–`:64`), uses them for typed wire framing over the bridge's NDJSON channel, then **maps generated types ↔ `SharedInterface` types** in private `*ToShared` methods (`BridgeHandler.ts:639`) before anything crosses IPC.
- Keep the generated layer behind `BridgeHandler`/`DeviceInterface`: the renderer must depend on `@shared/SharedInterface`, never on `../generated/protoemb`.
- **Watch for divergence:** `SharedInterface.FaultedReason` has a `USER_REQUEST` member (`SharedInterface.ts:31`) that the generated enum lacks (generated `FaultedReason` ends at `FORCE_GAUGE_COMMUNICATION = 8`, `protoemb.ts:26`), so `stateToShared` bridges them with `as unknown as SharedFaultedReason` (`BridgeHandler.ts:651`). When such a cast is necessary, isolate it in the mapping layer — never leak an untyped cast into renderer code.

---

## File & Folder Organization

```
src/
  main/                 # Electron main process (Node)
    main.ts, menu.ts, preload.ts, util.ts, dataManager.ts
    handlers/           # BridgeHandler.ts, DeviceInterface.ts, NotificationSender.ts, *.contract.test.ts
    generated/          # protoemb.ts (DO NOT EDIT)
  renderer/             # React app (browser)
    App.tsx, index.tsx, preload.d.ts
    components/         # presentational/composite components + index.ts barrel
    pages/             # route-level screens + index.ts barrel
    hooks/             # useDevice.tsx, useProfiles.ts, … + index.ts barrel
    utils/             # renderer-only helpers (logger.ts — wraps console)
  shared/               # SharedInterface.ts — IPC type contract (both processes)
  utils/                # cross-process helpers (logger.ts — wraps electron-log)
```

- New IPC channel → add to `Channels` (`preload.ts:5`), add `ipcMain.handle` in `DeviceInterface.setupIPCHandlers()` (`DeviceInterface.ts:383`), add a `useCallback` action in `useDevice.tsx`, and add the action's type to the `DeviceActions` interface (`useDevice.tsx:29`).
- New cross-boundary type → define it in `src/shared/SharedInterface.ts`.

### Logging

Use the module loggers, not `console.*`. `src/utils/logger.ts` exports `deviceLogger`, `dataLogger`, `uiLogger` (`logger.ts:39`–`:41`) — a `Logger` class wrapping `electron-log` — for main-process code (`BridgeHandler.ts`/`DeviceInterface.ts` use `deviceLogger`). A **separate** renderer logger, `src/renderer/utils/logger.ts`, wraps `console` in a structured way for the browser context.

---

## Testing

- `npm test` runs Jest (`ts-jest`, `jsdom` env, `--passWithNoTests`; jest config at `package.json:73`–`:109`). Jest's `moduleNameMapper` mirrors the tsconfig aliases (`package.json:86`). Only the `*.contract.test.ts` files are currently committed.
- Test files use the suffix **`*.contract.test.ts`** and live beside the code under test (`src/main/handlers/BridgeHandler.contract.test.ts`).
- Mock `electron` at the top of main-process tests (`BridgeHandler.contract.test.ts:1`). To reach private methods, the tests cast the instance to `any` (`new BridgeHandler() as any`, `:24`) — acceptable in tests only.
- Structure with `describe`/`test`/`expect` (`:22`). These are protocol round-trip "contract" tests: encode with a generated `encode*` (e.g. `encodeMachineState`), feed the bytes through a handler method (`bridge.handleDataEvent(MSG_READ_STATE, …)`), and assert the emitted `SharedInterface` shape.
- Playwright E2E tests live in the `SIL/` workspace, not here.

---

## Quick Do / Don't

- **Do** add every new channel to the `Channels` union before using it. **Don't** pass a bare string to `invoke`/`send`.
- **Do** import shared types from `@shared/SharedInterface`. **Don't** import `../generated/protoemb` from the renderer.
- **Do** edit `MaDProtocol.yaml` + regenerate. **Don't** hand-edit `src/main/generated/`.
- **Do** `removeAllListeners` in every `useEffect` cleanup. **Don't** leak IPC subscriptions.
- **Do** normalize errors with `error instanceof Error ? error.message : String(error)`.
- **Do** `npm run lint:fix` before committing and prefer targeted `// eslint-disable-next-line <rule>`. **Don't** add bare disables or file-level disables to hand-written files.
- **Do** use `_`-prefixed params for unused IPC `_event` args (satisfies `noUnusedParameters`).
