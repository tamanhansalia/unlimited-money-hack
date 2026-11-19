# ViralClip Studio interface

The desktop renderer lives in `desktop-app/src` (`index.html`, `styles.css`, `main.js`). Tokens are defined on `:root` in `styles.css`.

- **Look:** near-black canvas (`--bg`) with a soft ambient glow and faint grid; panels are frosted glass (`.glass`: translucent gradient, hairline `--border`, inset top highlight, backdrop blur). Primary actions are off-white buttons; mint (`--accent`) marks selection, focus, progress and the "Ready" state. Status colors: `--success`, `--warning`, `--danger`.
- **Shell:** custom title bar (Electron `titleBarOverlay`, 52px) + sidebar (Library, Generate, Connections, live job card). Below 1200px the sidebar becomes an icon rail; below 1060px the library inspector stacks under the preview with a sticky action bar.
- **Library:** clip list (lazy video thumbnails, ↑/↓ or j/k to move, `/` to search), preview monitor with loading/error overlays, publishing inspector with live counters and inline validation (title required, YouTube 100-char title / 500-char tags, X 280 chars, Instagram 2,200-char caption).
- **Generate:** dedicated page. Source (validated YouTube link or local file) + clip count stepper (1–10). Progress panel parses engine output into steps (source → transcribe → highlights → render N of M), with elapsed time and collapsible log. Runs in the background; the sidebar card and toasts report completion.
- **Feedback:** skeleton loaders on first load, spinners inside busy buttons, toasts (success / error / info, with Undo or Review actions), dialogs that can't be dismissed mid-request.
- Bundle Inter and the Phosphor icon font locally; every icon-only control has an accessible name. Respect `prefers-reduced-motion`.
