# comfyui_fantastic-loras

A ComfyUI custom node pack for stacking, lora testing (with a XY plotter with a grid output and a custom comparison node), and mirroring LoRAs for multi-model workflows.

## Overview

- **Loaders** — stack multiple LoRAs onto one or several models (such as workflows for Ideogram4), with a folder filter, favourites, and randomizer lines (`Fantastic Lora Loader`).
- **Plotter** — sweep your LoRA stack across a grid, optionally layering global LoRAs and control/baseline cells (`Fantastic Lora Plotter`, `Fantastic Plotter Global Lora`, `Fantastic Plotter Image Saver`, `Fantastic Plotter Grid Viewer`).
- **Mimic** — mirror or wire in LoRAs from other loaders (including rgthree's Power Lora Loader, Efficiency/Comfyroll stackers, and stock loaders) onto an independent model/clip path for use in dual-model workflows (like Ideogram4), with a High/Low mode for split models like Wan 2.2, and a Subgraph Companion helper for crossing subgraph boundaries (`Fantastic Lora Mimic`, `Fantastic Lora Mimic Subgraph Companion`).

## Install

**ComfyUI-Manager (recommended):** open the Manager, choose **Install Custom Nodes**, search for **Fantastic Loras**, and install. Restart ComfyUI when prompted.

**Manual:**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Adudeguyman/comfyui_fantastic-loras
```

Restart ComfyUI and hard-refresh the browser (Ctrl+Shift+R). No Python dependencies beyond ComfyUI itself.

## Nodes

All nodes appear in the add-node menu under **loaders** (search "fantastic lora").

### Fantastic Lora Loader 📁
A primary model + optional CLIP, plus up to 4 additional optional MODEL inputs added on demand. Internal class name `FantasticLoraLoaderMulti`.

| Input | Required? | |
|---|---|---|
| `MODEL` | yes | primary model to patch |
| `CLIP` | **optional** | connect to apply clip strengths and get a patched `CLIP` back; leave unconnected for model-only |

Outputs: `MODEL`, `CLIP`, `lora_stack`. When CLIP isn't connected the CLIP output passes `None`.

The node starts with a single model path — out of the box it looks and behaves exactly like a plain single-model loader. A compact **Model paths: N / 5  ➕ ➖** bar lets you add and remove extra model input/output pairs dynamically. Use the extra paths when running multiple samplers with different models — patch all of them through one unified lora stack. Each extra model is patched with the same stack (model strength only); the shared CLIP is patched once via the primary path.

## Using the nodes

Each node has:

- **📁 Folders** — opens the folder filter (see below).
- **➕ Add Lora** — opens the lora chooser (filtered by your enabled folders) to append a lora to the stack.
- **🎲 Add Lora Randomizer** — adds a randomizer line (see below).
- One row per lora: an **enable checkbox**, the **lora name** (click to swap), a single **S** (strength) field that applies to both model and clip simultaneously, plus **▲ ▼** to reorder and **✕** to remove.

The S field tracks the CLIP connection live: when nothing is wired into CLIP it shows a dim `(no CLIP)` note and clip strength is ignored. LoRAs apply top-to-bottom; disabled and zero-strength rows are skipped. The whole stack saves and loads with the workflow.

> **Tip:** Hovering any icon on a lora row shows a tooltip explaining what it does and its current state.


## Folder filter

Click **📁 Folders** to open a stay-open tree panel:

- **All (no filter)** / **None** reset or clear everything.
- Each row is a folder with a checkbox and lora count. Parent folders are tri-state aggregates — clicking one toggles every folder beneath it; mixed states show as indeterminate. Carets expand/collapse branches.
- A folder that contains its own loras **and** subfolders gets an italic *(files here)* child row, so `flux/styles` can be toggled independently of loose files in `flux/`.
- `(root)` = loras sitting directly in `models/loras`.
- The filter is **per-node** and saves with the workflow. The button label shows `n/total` enabled folders.
- Filtering is by exact containing folder — enabling a parent is a shortcut for enabling all its children, not a wildcard that auto-includes future subfolders.

Stored in `node.properties["Enabled Lora Folders"]`:

| Value | Meaning |
|---|---|
| `null` | No filter (all loras). |
| `{ "version": 2, "folders": ["flux/styles", "(root)"] }` | Exact enabled-folder list. |
| `["flux"]` (legacy v1 array) | Matches that folder plus everything nested under it; auto-upgraded to v2 on first toggle. |


## Lora chooser & favorites

Clicking **➕ Add Lora** or any lora name in the stack opens a custom chooser panel:

- **☆ / ★ star button** next to each lora name — click it to toggle that lora as a favourite. The panel stays open so you can star several at once.
- **Favourites float to the top** of the list, separated from the rest by a thin rule, sorted alphabetically within each group.
- **Favourites are global** — stored in your browser's `localStorage` so they're shared across all nodes and persist between sessions.
- **Live search bar** — auto-focused when the panel opens; start typing to filter the list. Both the favourites section and the main list filter simultaneously.


## Lora Randomizer

Clicking **🎲 Add Lora Randomizer** adds a special randomizer line. On creation it immediately rolls a random lora from your node's enabled folders. Randomizer lines work like normal lora rows but have four extra controls on the left and right:

```
[✓] 🎲 🔓 🔄  flux/styles/ anime.safetensors   S [1.00]  📂 ▲ ▼ ✕
```


### Randomizer controls

| Icon | Name | Behaviour |
|---|---|---|
| 🎲 | **Dice** | Manually re-rolls a new random lora from this line's folder pool. Avoids re-picking the current lora when alternatives exist. Dimmed and disabled while the line is locked. |
| 🔓 / 🔒 | **Lock** | Click 🔓 to freeze the lora on this line — neither the dice nor auto-roll can change it. Click 🔒 to unlock and re-enable randomization. |
| 🔄 | **Auto-roll** | When **on** (full brightness), the backend picks a fresh random lora from this line's folder pool on **every queued generation**. When **off** (dimmed ~30%), the lora stays fixed between runs. The lock overrides auto-roll — a locked line is never changed regardless of the 🔄 state. |
| 📂 | **Folder scope** | Opens a per-line panel listing the folders currently enabled in the node's 📁 filter. Check or uncheck folders to narrow which ones this line randomizes from. Each randomizer line keeps its own independent selection — one line can pull only from `flux/styles` while another pulls from `ideogram4`. |

### How auto-roll works

Auto-roll happens **at execution time in the backend**, not in the UI. When any active auto-roll line exists the node reports itself as changed on every queue (`IS_CHANGED` returns a random token), so ComfyUI always re-executes rather than serving a cached result. The roll uses the same folder-intersection logic as the manual dice: the node's enabled-folder set is intersected with the line's own 📂 selection to build the pool.

Note: because the roll is backend-side, the lora name displayed on the node face reflects the last manually-rolled pick, not the one used in the most recent generation.

### Per-line folder scope vs. node folder filter

The 📂 icon on each randomizer line is a **subset** of whatever the node's 📁 filter currently allows — you can't roll from a folder that the node filter has excluded. If the node filter changes, lines that had that folder selected will simply have a smaller (or empty) pool until you re-enable it.



- Dismiss with **✕**, **Esc**, or by clicking outside the panel.



---

## Fantastic Lora Plotter 📊

Internal class name `FantasticLoraPlotter`. Found in **loaders** alongside the other nodes.

The Plotter is a lora testing "sweep" node: instead of applying all enabled loras as a single combined stack, it applies each lora **individually** to the base model and emits the results as a list — one generation per cell. Connect it to a KSampler → VAE Decode → Fantastic Plotter Image Saver (see below) and ComfyUI will automatically run the downstream graph once per cell, producing a grid of images.

Inputs are identical to the loader: a primary MODEL + optional CLIP, plus up to four additional optional MODEL paths. The stack UI is the same — add, reorder, enable/disable, randomize. There's also an optional **`global_loras`** input — connect a Fantastic Plotter Global Lora node here to apply a fixed set of "background" loras to every swept cell in addition to the cell's own lora/strength. The Plotter has a **🌐 Add Global Lora node (connected)** button that drops one into the graph (to the left of the Plotter) with its output already wired to this input; the button greys out to "Global Lora node connected" once one is attached.

### Strength modes

The Plotter adds two buttons below the lora stack:

**📊 Strength mode** toggles between:

| Mode | Behaviour |
|---|---|
| **Per-line** (default) | Each enabled lora produces one cell at its own stack-row strength. 2 loras = 2 cells. |
| **Global (sweep)** | Per-line strengths are ignored. Every enabled lora is swept across the global strength list. 2 loras × 3 strengths = 6 cells, ordered lora-major (lora 1 at each strength, then lora 2). Set your saver's column count to the number of strengths to get a true XY grid: loras as rows, strengths as columns. |

**🎚 Global strengths** opens a popup with 10 individual number fields. Blanks are skipped; order and duplicates are preserved. The button face shows the active list. Both the mode and the strength list serialize inside `lora_data` and save with the workflow.

Per-line strength inputs are greyed out while Global mode is active.

### Control Image

The Plotter has a **Control Image** toggle that adds a baseline generation with zero loras applied, so you can see the pure base model. When a Fantastic Plotter Global Lora node is attached to the `global_loras` input, this toggle is disabled — control is instead driven from the Global Lora node, which has its own two control options (see below).

### Multi-model sweep

The optional MODEL 2–5 paths run the same sweep in parallel — each extra model produces its own list of patched results at the same lora/strength combinations as the primary path. Leave them unconnected to ignore them.

### Metadata output

The `metadata` output is a list of strings, one per cell, in the format `<lora_name>_<strength>` (e.g. `raegram3_1.0`). Wire this to the Fantastic Plotter Image Saver to label each cell automatically.

---

## Fantastic Plotter Image Saver 📊

Internal class name `FantasticPlotterImageSaver`. Combines three nodes into one:

1. **LoRA Plot Image Saver** — overlays a metadata label on each cell
2. **Image List to Image Batch** (comfyui-impact-pack) — resizes cells to a common size and stacks them into a batch
3. **FL Image Batch To Grid** (comfyui_fill-nodes) — composes the batch into a single grid image

Connect the Plotter's `MODEL` list → KSampler → VAE Decode → `images`, and the Plotter's `metadata` list → `metadata`. The node outputs the composed `grid` IMAGE (pass it to any Save Image node), plus three passthroughs — `images` (the per-cell list it received, clean/full-res), `metadata`, and `global_loras_info` — so a Grid Viewer (or anything needing the raw cells) can hang off this node instead of re-tapping the source wires.

The node also has an **🔍 Add Grid Viewer (connected)** button: click it to drop a Fantastic Plotter Grid Viewer into the graph just to the right of the Saver, with its `images`, `metadata`, and `global_loras_info` inputs already wired to the Saver's matching passthrough outputs. (If the button can't find those outputs, the Saver node predates them — delete and re-add it.)

### Controls

| Widget | Default | |
|---|---|---|
| **Constrain Image Output Size** | Off | When on, each cell is scaled down so its longest side equals **Max Cell Size** before the grid is assembled. Useful when rendering many large images — keeps the final output a manageable size. |
| **Max Cell Size** | 768 | Longest side per cell in pixels (max 2048). Greyed out when Constrain is off. |
| `text_color` | white | Label text colour. |
| `background_color` | black | Label box background colour. |
| `font_size` | 38 | Label font size in pixels. |
| `padding` | 10 | Padding inside the label box and around the border labels in Classic mode. |
| `opacity` | 1.0 | Opacity of the label box (Overlay mode only). |
| `images_per_row` | 0 | 0 = auto (see below). Any positive value overrides. Ignored in Classic mode. |
| `single_strength_layout` | row | When every lora is tested at the same single strength (one image per lora), choose whether they lay out in one **row** or stack in one **column**. |
| **🖼 Grid mode** button | Overlay | Toggles between the two layout modes (see below). |

### Grid modes

**Overlay (default):** the metadata label is drawn as a semi-transparent box in the top-right corner of each cell image. The full grid is then composed automatically.

**Classic (border labels):** cells are kept clean. The lora names are printed down the left margin and the strength values are printed across the top — matching the classic XY plot layout. This mode requires a complete lora × strength rectangle (i.e. Global sweep mode on the Plotter); if the metadata doesn't form a clean grid it falls back to Overlay with a console note.

### Auto column detection

When `images_per_row` is `0`, the node reads the `metadata` list and counts the number of **distinct strength values**. That becomes the column count, so Global-mode sweeps automatically lay out as a true XY grid (loras = rows, strengths = columns) without any manual configuration.

One special case: when you're testing several loras at a **single shared strength** (so there's one image per lora and only one distinct strength), auto would otherwise put them all in a single column. By default (`single_strength_layout = row`), this case instead lays them out side by side in one row. Set it to **`column`** to revert to the single-column stack. It only affects this single-strength case — when strengths vary (already a row) or `images_per_row` is set, it does nothing.

---

## Fantastic Plotter Global Lora 🌐

Internal class name `FantasticPlotterGlobalLora`. Found in **loaders** alongside the other nodes.

A companion to the Fantastic Lora Plotter. This node lets you define a set of "global" loras that get applied to every swept cell **in addition to** the cell's own lora. This is useful for exploring how a style lora (e.g., `painterly.safetensors`) interacts with different character or subject loras — the character lora sweeps while the style stays constant.

### Stack and strength

The Global Lora node has the full lora-stack UI: folder filter, favourites, add/remove/reorder loras, per-line strength controls, enable/disable checkboxes. There is **no randomizer** — the list stays fixed for the run.

Each enabled lora runs at its own per-line strength (e.g., if you add `painterly` with strength 0.8 and `texture` with strength 0.5, both run at those fixed strengths on every swept cell). When connected to the Plotter's `global_loras` input, the Plotter's own stack loras sweep across their strengths while these globals stay constant.

### Control images

The Global Lora node has two toggles (not buttons):

| Toggle | Behaviour |
|---|---|
| **Control Image (no loras applied)** | When on, the Plotter adds a baseline generation with zero loras — the pure base model, so you see the vanilla output. |
| **Control Image (global loras applied)** | When on, the Plotter adds a second baseline with only the global loras applied (none of the swept loras). Useful to see what the globals alone contribute. |

Enable both and the grid gains two control-image rows at the top, each repeated across every column.

### Plotter behaviour when attached

When a Global Lora node is connected to the Plotter's `global_loras` input:

- The Plotter's own **Control Image** toggle is **disabled** and relabeled "Set control on Global Lora Node" — control is now driven entirely by the Global Lora node's two toggles.
- Disconnecting the Global Lora node re-enables the Plotter's own control toggle.
- The global loras are applied **after** each swept cell's own lora, stacking on top of it. For example, if the Plotter is sweeping `character_v2` at strengths 0.5 and 1.0, and the Global node has `style_painterly` at 0.8, the saver sees four cells: character_v2 + painterly at 0.5, character_v2 + painterly at 1.0, and (if both controls are on) pure base, and painterly-only.

## Fantastic Plotter Grid Viewer 🔍

Internal class name `FantasticPlotterGridViewer`. Found in **loaders**. This is the interactive twin of the Image Saver — a terminal display node (like the built-in Preview Image, but with far more interaction).

### How to wire it

The viewer needs the **individual** cell images, not the Saver's already-composed grid (you can't pull cells back out of a flattened image). The easiest way to wire it is straight off the **Image Saver**, which passes the per-cell data through:

- `images` ← the Saver's **`images`** output (the per-cell list it received, passed through clean/full-res — *not* the composed `grid`)
- `metadata` ← the Saver's **`metadata`** output
- `global_loras_info` (optional) ← the Saver's **`global_loras_info`** output

(You can also tap those three directly from the VAE Decode + Plotter if you prefer; the Saver passthrough just keeps everything coming from one node.) Connect VAE Decode → Image Saver, then Image Saver → Grid Viewer. The Saver still gives you a flat PNG via its `grid` output to save; the Viewer gives you the interactive board.

### Interactions

- **Graph layout** — cells are laid out as a lora × strength grid (rows = loras, columns = strengths), with control images in their own labeled rows at the top, mirroring the Saver's look. The global loras are listed in a strip across the top.
- **Hide / show rows and columns** — every row and column header has a ✕ to hide it. Hidden rows appear as chips beneath the grid (and hidden columns as chips in the top-left corner); click a chip or **Reset filters** to bring them back. This lets you focus on a subset without re-running the graph.
- **Click to zoom** — click any cell and it grows out of the grid into a large centered view with its full metadata (lora, strength, globals). Click anywhere off the image and it shrinks back into its place in the grid.
- **Select & compare** — each cell has a checkbox in its corner. Tick two or more, then hit **Compare (N)** to see them side by side, each captioned with exactly what the Plotter used for that image (lora name, strength, and any global loras). **Clear selection** resets the ticks. In the compare view, **⤓ Export image** downloads the side-by-side as one PNG, and **💾 Save comparison** stores that set of cells so you can reopen the live comparison later (see below).
- **Thumbnail size** — a slider in the toolbar scales every cell live.

### Saved comparisons

The grid persists with your workflow — reopening the workflow or switching tabs brings the last run's grid back without re-running (only lightweight image references are stored, not the pixels). On top of that you can bank specific comparisons:

- **💾 Save comparison** (in the compare view) saves the current set of selected cells under a name. **☰ Saved Comparisons (N)** in the toolbar lists them — click one to reopen that comparison live, or ✕ to delete it.
- A saved comparison is **bound to its run's grid**. Reopening the workflow restores the grid and its saved comparisons together. **Running the Plotter again is a clean slate** — the new grid replaces the old one and the previous run's selection, favourites, and saved comparisons are cleared, since they belonged to a grid that no longer exists.

### Saving grids to disk

By default, grid images live in ComfyUI's temp folder, which is cleared on restart — so the in-workflow grid restores within a session (reload, tab switch) but not after a full restart. To keep grids permanently you save them to disk, where each saved grid is a run folder under `output/fantastic-loras-grids/<run_id>/` (its own subfolder, never the output root) with a `manifest.json` holding the layout, metadata, and saved comparisons.

There are two ways a grid lands on disk, and the toolbar shows which state you're in:

- **💾 Save Grid** — saves the current grid on demand. Manually-saved grids are **pinned**: they're kept until you delete them and are never touched by automatic cleanup. Once saved, the button area shows **✓ Saved**, a **📌 Pin / Pinned** toggle, and **🗑 Delete This Grid**.
- **Auto-save every run** (in Archive Settings) — writes *every* run to disk automatically. Auto-saved grids start unpinned and are subject to the cleanup rules. A status indicator in the toolbar (**● Auto-saving** / **○ Auto-save off**) always shows whether new runs are being kept.
- **📂 Saved Grids** — browse and load grids from disk. Always available, even with auto-save off, so turning auto-save off never orphans grids you already saved. Each entry is named after the loras it swept (joined with ` / `) plus any global loras tagged `(global)`, shows a 📌 if pinned, plus the date/time, and has Load and 🗑.

### Archive Settings ⚙

- **Auto-save every run to disk** — the toggle described above. A note reminds you it keeps every generated image on disk and uses space. The cleanup rules below appear when it's on.
- **Delete runs older than [N] days** — *on by default, 14 days.*
- **Keep only the last [N] runs** — off by default. When both rules are on they apply together: an *unpinned* run is removed if it's older than the age limit **or** falls outside the newest N. Pinned grids are exempt. Cleanup runs after each auto-saved generation, and never deletes the run just created.
- **📌 Manage pinned grids** — a cleanup manager. Pinned grids (exempt from auto-cleanup, so the only way to remove them is here) are listed at the top; auto-saved grids are listed in their own section below. Check any and delete them together, with a confirm step.

Your Archive Settings (the auto-save toggle and the cleanup rules) are remembered as **global defaults**: changing them saves to a small `archive_defaults.json` in ComfyUI's user directory (`user/fantastic-loras/`), and any *new* Grid Viewer node starts from those settings instead of the built-ins. A workflow that already has its own saved settings keeps them — the global default only seeds brand-new nodes. (On older ComfyUI versions without a user-directory API, the file falls back to the pack folder.)

Saved grids reference files by name, so moving the workflow to another machine (or deleting the output files) means a grid won't reload there.

The node is freely resizable; the grid scrolls inside it. A standalone `grid_viewer_demo.html` (openable in any browser) is included for previewing the interactions outside ComfyUI.

## Fantastic Lora Mimic 🪞

Internal class name `FantasticLoraMimic`. Found in **loaders**.

> ⚠️ **Experimental.** The Mimic node (and its Subgraph Companion) is still a proof-of-concept. It reads other nodes' configured loras through informal ComfyUI frontend internals and covers a fixed set of loader families, so it can break with ComfyUI updates or with loaders it doesn't have an adapter for. Treat it as a convenience for dual-model workflows, not a guaranteed-stable part of the pack — double-check that what it mirrors matches what you intend before relying on a result.

Applies a set of loras onto **its own** `model`/`clip` — without ever taking the source's MODEL path. The point: you can reproduce the loras another node is using on a *separate* model pipeline, with no risk of inheriting that node's already-patched model. Useful for models with dual model workflows such as Wan 2.2, Ideogram4, or 2nd-pass setups. There are two ways to feed it (if a wire is connected it always wins over the picker):

**1. Pick (any node) — recommended.** With nothing wired, choose a **source** node in the Mimic's UI and it mirrors that node's configured loras into itself — read live from the graph in the frontend, before execution. This is the fuller-featured path, giving you per-lora control: each mirrored lora can either **directly mimic (link)** the source — its strength tracks the source live, so you set it once on the source and forget it — or be **unlinked for fine control**, letting you override that lora's strength on the Mimic independently of the source. It can read several loader families: our own stack nodes (they carry a `lora_data` blob); the stock `LoraLoader` / `LoraLoaderModelOnly` (and shape-compatible ones like the pysssss loader); rgthree's `Power Lora Loader`; and numbered-widget stackers like Efficiency `LoRA Stacker` and Comfyroll `CR LoRA Stack`. Controls:
- **source** — a dropdown of compatible nodes (labelled `#id title`), or **(auto-detect)** which uses the only compatible source when there's exactly one, or **(none)**.
- **live_mirror** (on by default) — keeps copying as you edit the source; turn off to only update on demand.
- **↻ Pull now** — copy the source's loras immediately.
- A status line shows what's currently being mimicked.

**2. Wire (cooperating nodes).** Connect any **`LORA_STACK`** output into the Mimic's `lora_stack` input. Our `Fantastic Lora Loader` emits a `lora_stack` output, and the Mimic also accepts the common Efficiency-style `LORA_STACK` (list of `(name, model_strength, clip_strength)`), so third-party stackers work too. The Mimic re-emits the resolved stack on its own `lora_stack` output for chaining. **Note the tradeoff:** a `LORA_STACK` is only resolved tuples computed when the graph runs, with no per-lora link/strength metadata, so the wire path **can't** offer the picker's strength controls — it's hardwired to directly mimic whatever the connected node produces, applied flat. To change a wired lora's strength, adjust it on the upstream node, or use the picker instead.

Outputs: `MODEL`, `CLIP`, `lora_stack` (the resolved stack, for chaining), and `mimicked` (a STRING summary of what was applied).

### High / Low Model Mode (split models like Wan 2.2)

Wan 2.2 and similar split setups use two models — a high-noise and a low-noise pass — and loras are usually trained as a pair (`coollora_ep19_high.safetensors` / `coollora_ep234_low.safetensors`). Flip the **High / Low Model Mode** switch at the top of the Mimic, and each mirrored lora gains companion controls so you can feed the *other* half's lora onto this Mimic's model:

- **🔎 find companion** opens a ranked menu of the closest-matching lora names — best matches first, the original omitted. It ignores the noise token and volatile epoch/step/version numbers when matching, so `..._ep19_high` still finds `..._ep234_low`. A `low`/`high` tag and a filter box help you pick; you can also type to search any lora.
- The chosen companion **replaces** the original on this model and gets its **own strength**. The original name stays visible but dimmed.
- **also apply original** stacks the original on top of the companion too — handy for a shared speed-up lora that's identical on both halves.
- **use source lora** applies the original lora on this model as-is, with no companion — useful when a lora has no real counterpart for the other half. While active, the find-companion search is disabled (it shows "✓ using source lora"); toggle it off to search again. Any companion you'd already picked is kept but unused while this is on.
- No companion chosen yet and "use source lora" off → the original is applied as a fallback, so nothing silently drops.

Companion choices, strengths, and the mode toggle persist with the workflow. High/Low mode only affects the *picker* path; if you feed the Mimic a `LORA_STACK` wire, wire the half you want directly.

### Fantastic Lora Mimic Subgraph Companion 🧩 (the "sniffer")

The Mimic's picker reads nodes in its own graph scope, so it can't see lora loaders buried inside a **subgraph** (those live in the subgraph's own nested graph). This companion node bridges that boundary. Place it in the **same scope as the sources** — it scans every compatible lora loader/stacker there (our nodes, stock, pysssss, rgthree, Efficiency/Comfyroll), combines their enabled loras, and emits them as a single `LORA_STACK`. Because `LORA_STACK` wires pass cleanly through subgraph input/output slots, that stack reaches a Mimic on the other side:

- **Sources buried, Mimic outside:** put the sniffer inside the subgraph, wire its `lora_stack` out through a subgraph output to the Mimic's `lora_stack` input.
- **Mimic buried, sources outside:** put the sniffer outside with the sources, wire its `lora_stack` into a subgraph input, then to the Mimic inside.

It has an optional `lora_stack` passthrough input (merged first) so sniffers can be chained or fed an existing stack. The node shows a live readout of what it's forwarding. Note: a wired stack uses the Mimic's flat wire path, so the Mimic's per-source grouping and High/Low companion UI don't apply to sniffer-forwarded loras — for those features, keep the Mimic in the same scope as the sources. Cooperating sources that already output `LORA_STACK` (our loaders, ecosystem stackers) don't need the sniffer at all — wire their stack through the boundary directly.

Notes/limitations (it's a POC): the picker reads *configured* widget values from the graph, so it reflects what a source is set to, not anything a node computes at runtime in Python (our own randomizer is fine — the frontend bakes the rolled pick into `lora_data` before queueing). The picker understands our `lora_data` format, the stock `LoraLoader`/`LoraLoaderModelOnly` (and shape-compatible forks like pysssss's), rgthree's Power Lora Loader, and numbered-widget stackers (Efficiency `LoRA Stacker`, Comfyroll `CR LoRA Stack`); other third-party loaders would need their own small adapter, or can feed the Mimic via a `LORA_STACK` wire instead. Graph-introspection uses informal ComfyUI frontend internals, so it's wrapped defensively.

## How it works

- **Backend** (`nodes.py`): parses the stack JSON, resolves lora paths via `folder_paths.get_full_path`, loads with `comfy.utils.load_torch_file` (cached per path), applies via `comfy.sd.load_lora_for_models`. The stack is carried in a hidden `lora_data` STRING widget so it reaches Python and serializes with the workflow. CLIP is declared in `INPUT_TYPES["optional"]` so an unconnected input arrives as `None`. Auto-roll lines are re-randomized at execution time; `IS_CHANGED` returns a random token whenever an active auto-roll line exists to prevent ComfyUI from caching the result.
  - **Plotter sweep:** the Plotter applies each enabled lora individually to a copy of the base model (not stacked), emitting one model+metadata pair per cell. If a Global Lora node is attached, its loras are then stacked on top of each swept cell's result. Control images (baseline generations with zero or global-only loras) are appended as extra cells.
  - **Image Saver:** receives lists of images and metadata, splits control cells out, optionally constrains size, then renders either an overlay-label style or a classic XY-grid layout (with control rows at the top) into a single grid image. Control cell metadata (`control` and `control_global`) are handled as special labels.
- **API route**: `GET /lora_folder_loader/loras` serves the lora filename list to the frontend.
- **Frontend** (`web/lora_folder_loader.js`): DOM widgets for lora rows, folder filter panel, lora chooser panel, and per-line randomizer folder panel. Favourites are stored in `localStorage` under the key `fll_favorites`. Tooltips are custom DOM elements (instant, teal-bordered) rather than native browser title attributes. The Plotter adds global-strength controls and a control-image toggle (disabled when a Global Lora node is attached). The Global Lora node uses the same stack UI as the loaders but adds two control toggles.
- **Grid Viewer frontend** (`web/plotter_grid_viewer.js`): a separate extension. The Python node (`OUTPUT_NODE`) saves each cell to the temp folder and returns `{"ui": {"fl_cells": [...refs+metadata], "fl_global": [...]}}`; the frontend reads this in `onExecuted` and builds the interactive grid in an `addDOMWidget` container. All zoom / filter / compare interaction is pure DOM with no extra round-trips to the server.
- **Mimic frontend** (`web/lora_mimic.js`): a separate extension covering both the Mimic and its Subgraph Companion. The Mimic's UI state (selected sources, per-lora link/companion/force flags, group-bypass overrides, High/Low mode) lives on the node instance and is serialized into the same hidden `lora_data` widget as a JSON object (`{loras, mimicSources, groupForced, highLow}`); a live-mirror timer (`tick`) reconciles against the source nodes' widgets and re-renders. On the Python side, `_expand_mimic_payload` interprets that JSON (handling High/Low companions and the `useOriginal`/`forced` overrides) when nothing is wired, while a connected `LORA_STACK` wire (via `_normalize_stack`) takes precedence and is applied flat. Source-type adapters (stock/pysssss, rgthree Power Lora Loader, Efficiency/Comfyroll numbered stackers, our own `lora_data` nodes) all live in `readSourceLoras`.

## Notes

- With an explicit folder selection, loras added to disk later aren't auto-included — open the panel and tick the new folder; it re-reads disk each time it opens.
- A lora referenced in a saved workflow but missing on disk is skipped with a console warning rather than failing the run.
- The node widens slightly when one or more randomizer lines are present to accommodate the extra icons, and shrinks back when all randomizer lines are removed.
