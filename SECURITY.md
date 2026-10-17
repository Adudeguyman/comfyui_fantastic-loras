# Security notes

This pack registers HTTP routes on ComfyUI's built-in server under
`/fantastic_loras/…` (plus the legacy `GET /lora_folder_loader/loras`).
As of v2.2.1, every route that can create, modify or delete a file is
protected against cross-site request forgery and path escape.

## Same-origin enforcement (CSRF)

All mutating routes are wrapped in `_mutation_guard` (`nodes.py`), which
rejects a request unless:

1. **Origin check (403)** — the request carries an `Origin` (or `Referer`)
   header whose host matches the `Host` header. A hostile web page open in
   the same browser as ComfyUI cannot forge a request against these
   endpoints: browsers attach the page's real origin to every POST/DELETE
   and it will not match.
2. **Content-type check (415, POST only)** — the body must be declared
   `Content-Type: application/json`. Cross-origin, that header forces a CORS
   preflight, which ComfyUI does not approve — so "simple request" CSRF
   (e.g. an auto-submitting `<form>`) is impossible even where an Origin
   header might be absent.

ComfyUI core applies its own origin middleware app-wide
(`server.py`, `create_origin_only_middleware`), but only when both headers
are present and the host is loopback. The checks here hold unconditionally.

Read-only `GET` routes are unguarded, matching core behaviour.

## Filesystem containment

No route can touch a path outside its intended directory:

| Surface | Confinement |
|---|---|
| Run archive (`DELETE /run/{rid}`, manifest writes) | `rid` must match `^\d{8}-\d{6}-[0-9a-f]{6}$` (`_safe_run_id`), and `_delete_run` additionally verifies the resolved real path is inside the archive root (`_contained_in`) before `shutil.rmtree`. |
| Lora stack presets | `_preset_safe_name` strips path separators and reserved characters, then verifies the resolved path is inside the preset directory. |
| Any Selector presets | Category is validated against the live `folder_paths` category whitelist; `_sel_preset_path` sanitizes the name and verifies containment. |
| Prefs / archive defaults | Fixed file paths under `ComfyUI/user/fantastic-loras/`; written atomically via a temp file + `os.replace`. |

All storage lives under `ComfyUI/user/fantastic-loras/` and
`output/fantastic-loras-grids/`. The pack makes no outbound network
requests from Python or JavaScript; the only network activity is the
browser talking to the local ComfyUI server.

## Directory creation

An unauthenticated `GET` has no filesystem side effect at all: no read
route creates, writes, renames or deletes anything. The storage helpers
(`_grid_archive_root`, `_user_config_dir`, `_preset_dir`,
`_sel_preset_dir`) take a `create` flag; only the guarded write paths
create directories, and every read path passes `create=False` and treats
a missing directory as empty.

## Output escaping (XSS)

Text that can come from outside the pack (lora and folder names, preset
names, plotter metadata, global lora lines, run archive manifests) is
HTML-escaped before it is placed in the page (`flgEscape` in
`lora_folder_loader.js`, `escHtml` in `plotter_grid_viewer.js` and
`lora_mimic.js`), or set via `textContent`. The Grid Viewer's `metadata`
and `global_loras_info` inputs accept any string, so they are treated as
untrusted.

## Reporting

Open an issue at
https://github.com/Adudeguyman/comfyui_fantastic-loras/issues.
