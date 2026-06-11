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


## Lora chooser & favourites

Clicking **➕ Add Lora** or any lora name in the stack opens a custom chooser panel:

- **☆ / ★ star button** next to each lora name — click it to toggle that lora as a favourite. The panel stays open so you can star several at once.
- **Favourites float to the top** of the list, separated from the rest by a thin rule, sorted alphabetically within each group.
- **Favourites are global** — stored in your browser's `localStorage` so they're shared across all nodes and persist between sessions.
- **Live search bar** — auto-focused when the panel opens; start typing to filter the list. Both the favourites section and the main list filter simultaneously.


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


## Lora Randomizer

Clicking **🎲 Add Lora Randomizer** adds a special randomizer line. On creation it immediately rolls a random lora from your node's enabled folders. Randomizer lines work like normal lora rows but have four extra controls on the left and right:

```
[✓] 🎲 🔓 🔄  flux/styles/ anime.safetensors   S [1.00]  📂 ▲ ▼ ✕
```


- Dismiss with **✕**, **Esc**, or by clicking outside the panel.



## How it works

- **Backend** (`nodes.py`): parses the stack JSON, resolves lora paths via `folder_paths.get_full_path`, loads with `comfy.utils.load_torch_file` (cached per path), applies via `comfy.sd.load_lora_for_models`. The stack is carried in a hidden `lora_data` STRING widget so it reaches Python and serializes with the workflow. CLIP is declared in `INPUT_TYPES["optional"]` so an unconnected input arrives as `None`. Auto-roll lines are re-randomized at execution time; `IS_CHANGED` returns a random token whenever an active auto-roll line exists to prevent ComfyUI from caching the result.
- **API route**: `GET /lora_folder_loader/loras` serves the lora filename list to the frontend.
- **Frontend** (`web/lora_folder_loader.js`): DOM widgets for lora rows, folder filter panel, lora chooser panel, and per-line randomizer folder panel. Favourites are stored in `localStorage` under the key `fll_favorites`. Tooltips are custom DOM elements (instant, teal-bordered) rather than native browser title attributes.

## Notes

- With an explicit folder selection, loras added to disk later aren't auto-included — open the panel and tick the new folder; it re-reads disk each time it opens.
- A lora referenced in a saved workflow but missing on disk is skipped with a console warning rather than failing the run.
- The node widens slightly when one or more randomizer lines are present to accommodate the extra icons, and shrinks back when all randomizer lines are removed.
