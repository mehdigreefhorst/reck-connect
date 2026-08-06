# satellite/renderer/src/viewer

The file-viewer popup. Cmd+click on a path in a terminal pane or an
opened markdown file spawns a small BrowserWindow showing that file,
with live editing, conflict-prevention, and Speak/TTS parity.

For the broader rendering pipeline view (markdown / source / xterm,
+ the cross-process Cmd+click → popup flow + security boundaries),
see [`docs/architecture.md`](../../../../docs/architecture.md) and
[`docs/markdown-viewer-integration.md`](../../../../docs/markdown-viewer-integration.md).

## Module map

| File | Responsibility |
|---|---|
| `FileViewerHost.ts` | Top-level boot. Reads `?path=` from the URL, asks main to read the file, dispatches to the markdown renderer or the CodeMirror editor, wires auto-save / watch / conflict banner / Speak bar / spinner. Owns per-session state via a WeakMap keyed by the root element. |
| `MarkdownRenderer.ts` | `markdown-it` (`html: false`) + DOMPurify + highlight.js. Annotates internal links with `class="reck-internal-link"`; `mount()` wires Cmd+click interception so navigating between linked files cascades through `reckAPI.files.openInViewer`. |
| `ImageRenderer.ts` | The image surface. `mountImage()` renders through `<img src="reck-img://…">` — never inlined, which is what keeps a hostile `.svg` in Chromium's secure static mode. Fit by default (`max-width/height: 100%`, so small images are never upscaled); click toggles 1:1 with anchored scroll. `renderImageError()` covers the seven failure reasons. |
| `CodeEditor.ts` | CodeMirror 6 mount, extension-detected language, theme-adapter. `mountCodeEditor()` returns `{view, getContent, setContent, dispose}`. `pickLanguageForPath(path)` looks up `@codemirror/language-data` by extension. |
| `LinkDetector.ts` | Pure helpers for scrollback path detection: `isPathLike(token)` classifier + `detectPathsInLine(line)` scanner returning `{text, start, end}` per match. URL spans are excluded. |
| `PathLinkProvider.ts` | Installs xterm's `registerLinkProvider` on a `Terminal`. Hover-driven; batches the line's path candidates through `files.resolve` and caches the result on the `IBufferLine` via a `WeakMap`. Emits links only when the path exists OR its parent dir exists; activate gated on `event.metaKey`. |
| `AutoSave.ts` | `createAutoSave({save, debounceMs, onStateChange, onError})`. Per-file debounced (400 ms default) save coordinator; serialized in-flight + single-slot queue. State transitions drive the spinner. |
| `Spinner.ts` | 16 px CSS-spin component for the reserved 24×24 top-right header slot. `show()` / `hide()` are inflight-counted so concurrent operations don't toggle it off prematurely. |
| `ConflictBanner.ts` | Non-modal banner with three actions (Force mine / Force theirs / Open diff). Editor underneath stays interactive. |
| `FileViewerSpeak.ts` | Parity for the in-pane TTS Speak bar inside the file viewer. Reuses `TtsEngine` and `SpeakControlBar` (both surface-agnostic) and binds ⌘⇧S/X/+/- shortcuts at the window level. The bar is pinned bottom-right via a `.file-viewer-speak-bar` modifier so it can't collide with the top-right spinner. |

## Adding a new viewer type

The host dispatches by extension at `renderForPath`. To add a new
surface (e.g., a JSON tree viewer):

1. Add an extension probe (`isJsonPath(p)`).
2. In the dispatch block, instantiate your surface and write into
   `shell.body`.

   **If your surface reads binary content, dispatch BEFORE `files.read`,
   not in the mode chain.** `files.read` refuses any file with a NUL byte
   in its first 8 KiB, so a binary surface placed in the `if (mode === …)`
   chain never runs — the read fails first with `code: "binary"`. The
   image surface short-circuits at the top of both `renderForPath` and
   `renderStationRemote` for exactly this reason, and
   `FileViewerHost.test.ts` pins that `files.read` is never called for an
   image path.
3. If the surface needs to participate in Speak, supply a `getContent()`
   that returns the textual content the user expects to be read aloud.
4. If the surface needs to participate in auto-save, expose a `dispatch`
   hook that calls `autoSave.markDirty(content)` on every edit.

Tests live next to the implementation (`Foo.ts` + `Foo.test.ts`). Run
the suite with:

```bash
cd satellite
VITE_RECK_STATION_ROOT=/home/pi/projects \
  RECK_STATION_ROOT=/home/pi/projects \
  pnpm test
```

The two pre-existing env-gated failures (`project-push.test.ts` and
`rsync-copy.test.ts`) are tracked in `docs/LEARNINGS.md` and are
unrelated to this feature.

## Security boundary

Every IPC channel for the file viewer (`file:read`, `file:write`,
`file:stat`, `file:resolve`, `file:create`, `file:watch:*`,
`file:openInViewer`, `file:imageMeta`, `file:openExternally`) runs
through `resolveInsideAllowedRoots` on the main side.

The `reck-img://` scheme is a second entry point to the same bytes, so it
re-applies that validator itself rather than trusting the URL the renderer
built — plus an image-extension allowlist, so it cannot serve `.env` or a
private key at any MIME type. See `main/image-protocol.ts` for the full
threat model before changing it. Roots are derived from `MOUNT_POINT` plus (planned in a
follow-up) each daemon project's `cwd`. Symlink escapes are caught
by `realpath`-based containment checks. See
`satellite/main/file-allowlist.ts` for the validator and
`docs/LEARNINGS.md` for the design rationale.
