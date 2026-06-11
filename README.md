# comfyui_fantastic-loras

A ComfyUI custom node pack for stacking multiple LoRAs, with a built-in folder filter, favourites system, randomizer lines, and multi-model support. Based on the underlying Power Lora Loader node by rgthree.

## Nodes

Both nodes appear in the add-node menu under **loaders** (search "fantastic lora").

### Fantastic Lora Loader 📁
Single model + optional CLIP. Internal class name `FantasticLoraLoader`.

| Input | Required? | |
|---|---|---|
| `MODEL` | yes | model to patch |
| `CLIP` | **optional** | connect to apply clip strengths and get a patched `CLIP` back; leave unconnected for model-only |

Outputs: `MODEL`, `CLIP`. When CLIP isn't connected the CLIP output passes `None`.

### Fantastic Lora Loader (Multi-Model) 📁
Same as above, plus up to 4 additional optional MODEL inputs. Use this when running multiple samplers with different models — patch all of them through one unified lora stack. Internal class name `FantasticLoraLoaderMulti`.

A compact **Model paths: N / 5  ➕ ➖** bar lets you add and remove model input/output pairs dynamically. Each extra model is patched with the same lora stack (model strength only); the shared CLIP is patched once via the primary path.

## Install

```bash
cd ~/ComfyUI2/custom_nodes
git clone https://github.com/YOUR_USERNAME/comfyui_fantastic-loras
```

Restart ComfyUI and hard-refresh the browser (Ctrl+Shift+R). No Python dependencies beyond ComfyUI itself.

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

The Plotter is a sweep node: instead of applying all enabled loras as a single combined stack, it applies each lora **individually** to the base model and emits the results as a list — one generation per cell. Connect it to a KSampler → VAE Decode → Fantastic Plotter Image Saver (see below) and ComfyUI will automatically run the downstream graph once per cell, producing a grid of images.

Inputs are identical to the Multi-Model loader: a primary MODEL + optional CLIP, plus up to four additional optional MODEL paths. The stack UI is the same — add, reorder, enable/disable, randomize.

### Strength modes

The Plotter adds two buttons below the lora stack:

**📊 Strength mode** toggles between:

| Mode | Behaviour |
|---|---|
| **Per-line** (default) | Each enabled lora produces one cell at its own stack-row strength. 2 loras = 2 cells. |
| **Global (sweep)** | Per-line strengths are ignored. Every enabled lora is swept across the global strength list. 2 loras × 3 strengths = 6 cells, ordered lora-major (lora 1 at each strength, then lora 2). Set your saver's column count to the number of strengths to get a true XY grid: loras as rows, strengths as columns. |

**🎚 Global strengths** opens a popup with 10 individual number fields. Blanks are skipped; order and duplicates are preserved. The button face shows the active list. Both the mode and the strength list serialize inside `lora_data` and save with the workflow.

Per-line strength inputs are greyed out while Global mode is active.

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

Connect the Plotter's `MODEL` list → KSampler → VAE Decode → `images`, and the Plotter's `metadata` list → `metadata`. The node outputs a single `grid` IMAGE you can pass to any Save Image node.

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
| **🖼 Grid mode** button | Overlay | Toggles between the two layout modes (see below). |

### Grid modes

**Overlay (default):** the metadata label is drawn as a semi-transparent box in the top-right corner of each cell image. The full grid is then composed automatically.

**Classic (border labels):** cells are kept clean. The lora names are printed down the left margin and the strength values are printed across the top — matching the classic XY plot layout. This mode requires a complete lora × strength rectangle (i.e. Global sweep mode on the Plotter); if the metadata doesn't form a clean grid it falls back to Overlay with a console note.

### Auto column detection

When `images_per_row` is `0`, the node reads the `metadata` list and counts the number of **distinct strength values**. That becomes the column count, so Global-mode sweeps automatically lay out as a true XY grid (loras = rows, strengths = columns) without any manual configuration.

## How it works

- **Backend** (`nodes.py`): parses the stack JSON, resolves lora paths via `folder_paths.get_full_path`, loads with `comfy.utils.load_torch_file` (cached per path), applies via `comfy.sd.load_lora_for_models`. The stack is carried in a hidden `lora_data` STRING widget so it reaches Python and serializes with the workflow. CLIP is declared in `INPUT_TYPES["optional"]` so an unconnected input arrives as `None`. Auto-roll lines are re-randomized at execution time; `IS_CHANGED` returns a random token whenever an active auto-roll line exists to prevent ComfyUI from caching the result.
- **API route**: `GET /lora_folder_loader/loras` serves the lora filename list to the frontend.
- **Frontend** (`web/lora_folder_loader.js`): DOM widgets for lora rows, folder filter panel, lora chooser panel, and per-line randomizer folder panel. Favourites are stored in `localStorage` under the key `fll_favorites`. Tooltips are custom DOM elements (instant, teal-bordered) rather than native browser title attributes.

## Notes

- With an explicit folder selection, loras added to disk later aren't auto-included — open the panel and tick the new folder; it re-reads disk each time it opens.
- A lora referenced in a saved workflow but missing on disk is skipped with a console warning rather than failing the run.
- The node widens slightly when one or more randomizer lines are present to accommodate the extra icons, and shrinks back when all randomizer lines are removed.
