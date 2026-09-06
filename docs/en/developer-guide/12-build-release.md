# Build & Release

This chapter covers web frontend builds, Windows release packaging, installers, and the desktop launcher. `BUILD.md` in the project root carries the same content; the two can be cross-referenced.

## Web Frontend Builds

```bash
bun run build:web        # Build v3 + mobile
bun run build:v3         # Desktop only
bun run build:mobile     # Mobile only
# or
node scripts/build-web.mjs [v3|mobile]
```

- Runs the Vite build under `web/<target>/` (installs dependencies first if needed, `NODE_ENV=production` enables optimizations);
- Output at `web/<target>/dist/`, served statically by the HTTP server;
- Frontend development: `npm run dev` under `web/v3/` (Vite dev server).

## Windows Release Directory (exe)

Prerequisites: bun installed (compile time only) and git.

```powershell
bun run build:exe        # → scripts/win/build_exe.ps1
```

Output: `dist/win-unpacked/agent-society.exe` + companion files.

Packaging strategy:

1. `bun build --compile` produces the single-file `agent-society.exe`;
2. Files **tracked by git and allowed for release** are copied to the output (untracked files never enter the package);
3. Excluded: `docs/`, `runtime/`, `agent-society-data*`, `config/`, top-level dot-entries;
4. Runtime-required build artifacts ship along (e.g. `ffmpeg.exe`);
5. Compile temporaries are cleaned (e.g. `start.js.map`).

Post-packaging checks:

- `dist/win-unpacked/agent-society.exe` exists;
- The output directory contains none of the exclusions above.

## Windows zip Package

```powershell
bun run package          # → scripts/win/pack.cmd → pack.ps1
```

- Runs build_exe first, then compresses `dist/win-unpacked/` into `dist/agent-society-<timestamp>.zip`;
- Uses 7-Zip when available, falling back to `Compress-Archive`;
- Custom file name: `powershell -File scripts/win/pack.ps1 -OutputName "agent-society-custom"`.

## Windows Installer (Inno Setup)

Prerequisites: `bun run build:exe` already run; Inno Setup 6+ installed.

```
ISCC scripts/win/setup.iss        # or compile in the Inno Setup IDE
# Output: dist/AgentSociety_Setup.exe
```

Installer behavior:

- Content comes directly from `dist/win-unpacked/`;
- Shortcuts and first launch pass the user data directory parameter: `{userdocs}\Agent Society Data`;
- Per-user install; no administrator rights required.

> `build:installer` in package.json only prints a hint; it does not invoke ISCC.

## Desktop Launcher (GUI/)

`GUI/` is a Tauri 2 launcher: starts the server without a terminal window, tray presence, a progress window, then opens the main window and a floating monitor once the server is ready.

```bash
# Development
cd GUI/src-tauri && cargo tauri dev

# Package (NSIS installer → GUI/src-tauri/dist/)
cd GUI && scripts\copy-node-sidecar.cmd   # copy the system node.exe as sidecar
cd src-tauri && cargo tauri build
```

Key points:

- Release mode uses the **bundled sidecar node.exe**; if missing it errors out — never silently falls back to the system node;
- Server directory resolution: walks up at most 10 levels from the exe looking for a directory containing `start-wrapper.mjs`;
- Port comes from server config (app.local.json → app.json → 3000); the launcher does not pass `--port`;
- Details in `GUI/README.md`.

## Version & License

- Version number in `package.json`;
- License: Apache License 2.0 (`LICENSE`).

## Release Checklist

1. [ ] `npm test` fully green
2. [ ] `npm run lint` / `npm run typecheck` pass
3. [ ] `bun run build:web` succeeds, `web/*/dist/` updated
4. [ ] `bun run build:exe` succeeds, output directory verified
5. [ ] Installer/launcher manually verified in a clean environment
