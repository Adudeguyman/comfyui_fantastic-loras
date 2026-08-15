# Fantastic Loras 2.0

A LoRA toolkit for ComfyUI: pick which LoRA subfolders a node draws from so you're only ever searching the models you're working with, stack up to 12 LoRAs across several models from one node, and run a proper XY LoRA test bench in a single queue.

![version](https://img.shields.io/badge/version-2.2.0-0a6166) ![nodes 2.0](https://img.shields.io/badge/Nodes%202.0-compatible-7ec87e) ![license](https://img.shields.io/badge/license-MIT-blue)

<p align="center">
  <img src="screenshots/main_loader.png" alt="The Fantastic Lora Loader node, showing its 12 lora slots and preset bar" width="760"><br>
  <em>The Fantastic Lora Loader with 12 lora slots and presets</em>
</p>

<p align="center">
  <img src="screenshots/main_theme.png" alt="The same loader node in an alternate colour theme" width="760"><br>
  <em>Now with Themes!</em>
</p>

<p align="center">
  <img src="screenshots/folders.png" alt="The folder picker open, with a search box and a list of lora subfolders" width="520"><br>
  <em>Filter which subdirectories are used when searching for loras</em>
</p>

<p align="center">
  <img src="screenshots/lorapicker.png" alt="The lora picker open, filtered to one folder, with a search box and starred favourites at the top" width="620"><br>
  <em>Search for a Lora from only your selected folders. Save your favorites for quick access</em>
</p>

<p align="center">
  <img src="screenshots/lorasettings.png" alt="The per-lora options panel, showing model routing rows with individual strength controls" width="380"><br>
  <em>Adjust loras strength for each connected model</em>
</p>

<p align="center">
  <img src="screenshots/plotter.jpg" alt="The Fantastic Lora Plotter node with three loras queued, a global strength sweep, and its run summary" width="760"><br>
  <em>Pick your Loras and the strengths to try, add a control image, and queue once — every combination generates on its own</em>
</p>

<p align="center">
  <img src="screenshots/gridviewer.png" alt="The Grid Viewer showing a grid of generated comparison images" width="760"><br>
  <em>Effortlessly generate multiple iterations to compare Loras and their strengths. Rearrange the output as you see fit</em>
</p>

<p align="center">
  <img src="screenshots/grids.jpg" alt="Side by side comparison of the overlay-label grid and the classic border-label grid" width="860"><br>
  <em>Choose between modern and classic grid outputs</em>
</p>

---

## What it does

**One loader instead of a chain of them.** Twelve LoRA slots in a single node, feeding up to five separate MODEL outputs. Each LoRA can go to all five models, or just one, or to different models at different strengths — so a two-pass workflow where the refiner needs your detail LoRA at 0.4 and the base pass wants it at 1.0 is one node, not two loaders and a mental note. Slot order is apply order and you drag slots to change it. A footer prints exactly what each model output will receive, in order, so you can confirm the wiring matches your intent without tracing wires.

Alongside that: named presets that save and reload your whole stack (or merge into it without wiping what's there), folder filtering for people whose `loras` directory holds dozens of model subfolders, and randomizer slots that roll a different LoRA each queue — useful for rediscovering things buried in a large collection.

**An XY LoRA test bench that runs in one queue.** The Plotter takes the same slot grid, but instead of stacking your LoRAs it tests them against each other — LoRAs on one axis, strengths on the other, exactly the XY plot you'd build by hand. It emits one MODEL per test cell as a list output, so ComfyUI runs your sampler once per cell automatically — you hit Queue once and get the whole comparison, no batch loops or manual re-queueing. Feed the results to the Image Saver for a single labelled grid image — choose between a modern text-overlay layout or a classic A1111-style grid with labels down the margins — or to the Grid Viewer to browse them interactively on the canvas. It can also hold a set of LoRAs constant across every cell, and include a no-LoRA baseline so you can see what each one is actually contributing.

**Mirror LoRA selections that live somewhere else.** The Mimic exists for when the LoRA list is authored in a node that isn't this one — rgthree's Power Lora Loader, the stock loader, Efficiency or Comfyroll stackers — and you want that same list applied to a *different* model path. It reads the source's configured LoRAs and applies them to its own MODEL and CLIP, so you're not taking a wire from a model that's already been modified. Each mirrored LoRA can track the source live or be unlinked for an independent strength.

Two cases it's specifically built for: **split high/low models** like Wan 2.2, where LoRAs come as `..._high` / `..._low` pairs and it can find and substitute the matching half automatically; and **subgraphs**, where a companion node bridges the boundary so a Mimic outside can see loaders buried inside (or vice versa). It's the experimental corner of the pack — it reads other nodes' settings by inspecting the graph rather than through any official interface, so verify it mirrored what you expected before trusting a long run.

## Install

**ComfyUI-Manager (easiest):** open the Manager → **Install Custom Nodes** → search **Fantastic Loras** → Install → restart when prompted.

**Manual:**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Adudeguyman/comfyui_fantastic-loras
```

Restart ComfyUI, then hard-refresh your browser (Ctrl+Shift+R). Nothing else to install.

Two ready-made workflows are in the `example_workflows` folder — drag either onto the ComfyUI canvas to try things out.

**Nodes 2.0 ready.** Everything works under both the classic canvas and the newer Nodes 2.0 renderer, and you can switch between them at any time without breaking a saved workflow. The node panels are real interface elements rather than canvas drawings, so they behave the same either way.

## Quick start

1. Add **Fantastic Lora Loader 📁** (double-click the canvas, search "fantastic").
2. Wire your **MODEL** into it and its output onward to your sampler. Wire **CLIP** too if your setup uses text-encoder LoRA weights — for models where LoRAs only touch the diffusion model, you can leave it unconnected.
3. Click **Add lora…** and pick one. It lands in the first empty slot.
4. Adjust its strength with **− +** or by scrolling over the number.
5. Queue as normal.

That's the whole basic loop. Everything below is optional.

---

## The nodes

| Node | What it's for |
|---|---|
| **Fantastic Lora Loader 📁** | The main one. Stack LoRAs onto one or several models. |
| **Fantastic Lora Plotter 📊** | XY test bench — sweep LoRAs against strengths and get a comparison grid. |
| **Fantastic Plotter Global Lora 🌐** | LoRAs applied to *every* image in a comparison. |
| **Fantastic Plotter Image Saver 📊** | Turns the comparison into one labelled grid image. |
| **Fantastic Plotter Grid Viewer 🔍** | Browse the results interactively, zoom, and pick winners. |
| **Fantastic Lora Mimic 🪞** | Mirror a LoRA list authored in another loader onto an independent model path. |
| **Fantastic Any Selector 🎯** | A filename picker with folder filtering, for any loader. |
| **Fantastic Seeds 🌱** | A seed source with fixed / randomize / locked modes and a history. |

All of them appear under **loaders** in the add-node menu.

---

## Using the loader

The loader is one self-contained panel inside the node.

### The top strip

- **Add lora…** — opens the picker. Type to search; ☆ stars a LoRA so it floats to the top next time.
- **🎲 Add random** — adds a slot that picks a random LoRA for you (see [Randomizer](#randomizer)).
- **n / 12** — how many of the 12 slots are filled.
- **chains N/5 − +** — how many models this node feeds (see [Multiple models](#multiple-models)).
- **.ext** — show or hide the `.safetensors` on the end of every name.
- **Theme** — four colour schemes: Fantastic Teal, Boring Blue, Like, TEAL Teal, and Accountant. Changing it restyles the panel *and* the node colour across every node in the pack. If you've hand-picked a colour for a node yourself, the theme leaves it alone.

### The LoRA slots

Twelve slots in two columns. Click any empty one to add a LoRA. Each filled slot shows:

- **● green dot** — click to disable this LoRA without removing it.
- **number** — the order it's applied in. Reading order: left to right, then down.
- **folder path** above the **LoRA name** — click the name to swap it for a different one.
- **M1 M2 …** — which models this LoRA is feeding, when you're using more than one.
- **− 1.00 +** — the strength. Click the steppers, scroll over it, or type a number. This is the base strength every model uses unless you override one individually under ⚙.
- **⚙** — per-model routing and **per-model strengths**, plus randomizer settings. This is where you set a LoRA to 1.0 on one model and 0.4 on another.
- **☰** — drag this to move the LoRA to a different slot.
- **✕** — remove it.

At the bottom, a footer spells out exactly what each model will receive, in order — handy for confirming things are wired the way you think.

### The ⚙ options

- **Model routing** — one row per model, each showing the checkpoint actually wired into it. Toggle a model's dot to include or exclude this LoRA from it.
- **Per-model strength** — each routed row has its own strength field. Leave them alone and they follow the chip's base strength, so changing the chip changes all of them. Type a value into one and that model breaks away and keeps its own — the base no longer drags it along. This is how you run a detail LoRA at 1.0 on the base pass and 0.4 on the refiner.
- **Randomizer settings** — for random slots only: roll, lock, auto-roll, and which folders this slot draws from.
- **Remove lora**.

New LoRAs start routed to every model at the base strength, so you only need to open this when you want something different.

---

## Presets

Save a set of LoRAs and reload it later. The **PRESET** row sits just under the top strip.

- **Save** — names the current set and stores it. If the name's taken, it asks before overwriting rather than quietly replacing it. If you have random slots, it asks whether to keep them random or freeze them to whatever they rolled.
- **Load** — replaces everything: LoRAs, strengths, folder filter, and model count.
- **+ Add to stack** — merges a preset's LoRAs into what you already have, leaving everything else alone. Duplicates are skipped, and if it won't all fit in 12 slots it tells you what didn't make it.
- **★** — favourite a preset so it pins to the top of the list.
- **⋮** — Overwrite with what's currently on the node, Rename, Duplicate, or Delete.
- The **category** dropdown groups presets however you like (by model, by project, by mood).

If you change anything after loading, the preset name turns **orange italic and says "(modified)"** so you know your current setup no longer matches what's saved. That covers everything a preset stores — the LoRAs, their order, strengths, enable states and routing, plus the folder filter and the model count.

Presets are files on disk in `ComfyUI/user/fantastic-loras/presets/`, so they're shared by every workflow and survive updates.

---

## Filtering by folder

If you have hundreds of LoRAs, the **FOLDERS** bar narrows things down. Every node has one.

Click it to open the picker: type to search, use **all** / **none** for bulk changes, and ☆ star folders you use constantly so they pin to the top. Selected folders show as chips you can remove with ✕.

The filter controls what the LoRA picker offers *and* what the randomizer draws from, so the two never disagree. It's saved per node, with the workflow.

The picker shows your folders as an indented tree. Any folder with subfolders gets a **▣ / ▨ / ▢ branch toggle** showing whether all, some, or none of the folders beneath it are enabled, with an `on/total` count — click it to select or clear that whole branch, at any depth. Clicking anywhere on a branch row cycles it: **this folder and everything beneath it** (▣) → **just this folder** (◧) → **off** (▢) → back again. A folder that holds no loras of its own skips the middle step, since there's nothing to select there. Folders that hold only subfolders show in italic, since there's nothing to select in them directly. Each branch has a **▾ / ▸ expander** to fold it away, plus **collapse all** / **expand all** in the picker header — handy once you have a few levels of nesting. Collapsed branches are remembered across sessions. Searching switches to a flat list of full paths so matches are unambiguous.

Otherwise folders are exact: picking `flux` by name gives you LoRAs sitting directly in `flux`, not everything nested beneath it — use its branch toggle if you want the subfolders too.

---

## Randomizer

**🎲 Add random** adds a slot that picks a LoRA for you. Great for discovering things you'd forgotten you had.

On the slot itself:

- **🎲** — roll a new LoRA right now.
- **🔓 / 🔒** — lock it to keep the current pick from changing. A locked slot's dice greys out.
- **⚙ → Randomizer** — turn on **auto-roll** (a fresh pick every time you queue), or narrow which folders *this slot* draws from.

Per-slot folder scope is a subset of the node's folder filter — a random slot can never pull from a folder the node has filtered out.

**Auto-roll** picks the new LoRA when you hit Queue, so what you see on the node is what's about to be generated.

---

## Multiple models

Some workflows run more than one model — a high and low pass, a refiner, or two checkpoints being compared. The **chains** control adds up to 5.

Each extra model gets its own MODEL input and output. There's a single CLIP input shared by all of them, and it stays optional — chains with no CLIP connected simply apply the model half of each LoRA. By default every LoRA feeds every model; use **⚙ → Model routing** when you want a LoRA on only one of them, or at different strengths on each.

---

## The XY LoRA test bench (the Plotter)

The Plotter uses the same slot grid as the loader, but the meaning changes: each slot is a **test cell**, not a layer. Add five LoRAs and you're asking for five images, each with one LoRA applied to the base model — not one image with all five stacked.

### Wiring it

Wire `MODEL` into your sampler exactly like a normal loader, and `CLIP` too if your model uses it. The `metadata` output carries a label for each cell — send it to the **Image Saver** along with your generated images, and it does the rest.

The trick that makes this work in one queue: `MODEL` and `metadata` are **list outputs**. ComfyUI runs everything downstream once per item, so a 12-cell sweep runs your sampler 12 times off a single Queue press. You don't batch anything or re-queue by hand — but everything downstream of the Plotter does run 12 times, so a heavy upscale chain in that path costs you 12 upscales.

**Fix your seed** before you start. A comparison with a random seed per cell tells you nothing about the LoRAs, since you're also changing the noise.

### Per-line vs Global strength

**Per-line** runs each LoRA once, at whatever strength you set on its chip. Good for "which of these twelve do I actually like."

**Global** runs *every* LoRA at *every* strength in a shared list — this is the classic XY plot: LoRAs down the Y axis, strengths across the X. Set the list with **🎚 strengths** (`0.5, 0.75, 1.0`). Chip strengths grey out in this mode, since the shared list is what's being swept.

### Baselines and constants

**Control image** adds one cell with no LoRAs at all — the raw base model. It's the reference that makes everything else legible, and it's cheap. Leave it on.

**🌐 Add Global Lora** spawns and wires a Global Lora node: LoRAs there apply to *every* cell, on top of whatever's being tested. This is how you isolate one variable — hold your style and detail LoRAs constant while character LoRAs sweep. That node has its own two baseline toggles (pure base model, and globals-only), which take over from the Plotter's own control toggle while it's connected.

### Sweeping across more than one model

The Plotter carries the same **chains** control as the loader, with `MODEL 2`–`MODEL 5` outputs. Each one runs the same sweep on a different checkpoint, so you can ask "how does this LoRA set behave on these two base models" and get both grids from a single queue.

Unlike the loader, there's **no per-LoRA routing here** — every LoRA is tested against every connected model, since the point is comparison. The `M1 M2 …` tags on each chip are telling you that, not offering a choice. The footer lists each chain with the checkpoint currently wired into it (or *not connected*), and the ⚙ modal shows the same list per LoRA along with its sweep strength.

### Two grid layouts

The Image Saver composes everything into one image, in whichever style you prefer:

- **Overlay** — a modern look. Each cell keeps its own small label drawn in the corner, so cells stay self-describing however the grid is cropped or shared.
- **Classic** — the A1111-style XY grid. Cells stay clean and unmarked, with LoRA names printed down the left margin and strength values across the top. Needs a complete LoRA × strength rectangle, so use Global sweep mode; if the cells don't form a clean grid it falls back to Overlay and says so in the console.

Toggle with the **🖼 Grid mode** button on the Image Saver.

### Watch the count

The SWEEP footer does the arithmetic live: `4 lora lines × 3 strengths = 12 images + 1 control · 2 model chains`. Read it before queueing. The multiplication gets away from people — six LoRAs at four strengths across two models is 48 generations plus baselines.

## Fantastic Plotter Image Saver 📊

Internal class name `FantasticPlotterImageSaver`. Combines three nodes into one:

1. **LoRA Plot Image Saver** — overlays a metadata label on each cell
2. **Image List to Image Batch** (comfyui-impact-pack) — resizes cells to a common size and stacks them into a batch
3. **FL Image Batch To Grid** (comfyui_fill-nodes) — composes the batch into a single grid image

Feed it your generated images and the Plotter's `metadata` output. It gives back a composed `grid` image for any Save Image node, and passes the individual cells straight through — so a Grid Viewer can hang off this node rather than re-tapping earlier wires.

The **🔍 Add Grid Viewer (connected)** button drops a Grid Viewer beside the Saver with everything already wired.

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

**Classic (border labels):** the A1111-style XY grid. Cells are kept clean, with lora names printed down the left margin and strength values across the top. This mode requires a complete lora × strength rectangle (i.e. Global sweep mode on the Plotter); if the metadata doesn't form a clean grid it falls back to Overlay with a console note.

### Auto column detection

When `images_per_row` is `0`, the node reads the `metadata` list and counts the number of **distinct strength values**. That becomes the column count, so Global-mode sweeps automatically lay out as a true XY grid (loras = rows, strengths = columns) without any manual configuration.

One special case: when you're testing several loras at a **single shared strength** (so there's one image per lora and only one distinct strength), auto would otherwise put them all in a single column. By default (`single_strength_layout = row`), this case instead lays them out side by side in one row. Set it to **`column`** to revert to the single-column stack. It only affects this single-strength case — when strengths vary (already a row) or `images_per_row` is set, it does nothing.

---

## Fantastic Plotter Global Lora 🌐

Holds LoRAs that apply to **every** image in a comparison, on top of whatever the Plotter is testing. If you're comparing character LoRAs but always want your style LoRA active, it goes here — the characters vary, the style stays put.

### Stack and strength

It uses a simple row list rather than the slot grid: **➕ Add Lora**, then one row per LoRA with an enable box, the name (click to swap), a strength field, and arrows to reorder. It has the same FOLDERS bar as every other node. There's no randomizer here — the list stays fixed for the whole run.

Each LoRA runs at its own fixed strength on every image. So with `painterly` at 0.8 and `texture` at 0.5, both apply at those strengths to every cell while the Plotter's own LoRAs sweep.

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

- The Plotter's own **Control Image** toggle is **disabled** and relabeled "Control via Global node" — control is now driven entirely by the Global Lora node's two toggles.
- Disconnecting the Global Lora node re-enables the Plotter's own control toggle.
- The global loras are applied **after** each swept cell's own lora, stacking on top of it. For example, if the Plotter is sweeping `character_v2` at strengths 0.5 and 1.0, and the Global node has `style_painterly` at 0.8, the saver sees four cells: character_v2 + painterly at 0.5, character_v2 + painterly at 1.0, and (if both controls are on) pure base, and painterly-only.

## Fantastic Plotter Grid Viewer 🔍

Internal class name `FantasticPlotterGridViewer`. Found in **loaders**. This is the interactive twin of the Image Saver — a terminal display node (like the built-in Preview Image, but with far more interaction).

### How to wire it

Connect the matching outputs from the **Image Saver** — `images`, `metadata`, and optionally `global_loras_info`. Easier still, use the Saver's **🔍 Add Grid Viewer (connected)** button and it wires itself.

The one thing to get right: the viewer needs the **individual cells**, not the Saver's composed `grid`. You can't pull cells back out of a flattened image. The Saver's `images` output is the per-cell list passed through at full resolution, which is what you want here.

You can run both — the Saver's `grid` output for a flat PNG to keep, the Viewer for browsing.

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

## Fantastic Any Selector 🎯

A filename picker that works with **any** loader, not just LoRA ones — and brings the folder filter with it.

Easiest way in: **right-click any loader** and pick **🎯 Add Fantastic Any Selector**. It spawns one beside the node, opens the right input, and wires it up. Or add it yourself and drag its **name** output onto a loader's converted model / clip / vae / upscale input. It works out which folder that loader draws from, offers you that folder's files behind the same chip filter bar as the rest of the pack, and passes the chosen filename along. It never loads anything itself.

- **Presets** — the **Presets** button lists what's saved for this folder; **Save** names the current pick *and* its folder filter. They're stored **per folder category**, so a selector wired to a VAE loader only ever offers VAE presets, and one on a diffusion model loader only offers those. Saving over an existing name asks first; ✕ on a row in the list deletes it. Rewiring to a different category swaps the list to that folder's presets.
- **Folder filter** — the same chip bar, filtered to whichever category it detected. Each category keeps its own filter and its own ★ favourites, so a selector pointed at `diffusion_models` doesn't inherit your `vae` choices.
- **One connection at a time.** Wiring the output somewhere else moves it rather than adding a second link, which keeps the category unambiguous. Need two loaders on different files? Use two selectors.
- **Unwired**, it says so and does nothing — it can't guess a category without a target.
- Changing what it's wired into clears the selection, since a filename from one category won't validate against another.

The output connects to any input by design, which means ComfyUI won't type-check that link. Wire it somewhere nonsensical and it'll be allowed, then fail when you queue. That's the trade for one node covering every category. The filename itself is passed as an ordinary string, so receiving loaders compare it exactly as they would their own widget value.

## Fantastic Lora Mimic 🪞

Internal class name `FantasticLoraMimic`. Found in **loaders**.

> ⚠️ **Experimental.** The Mimic node (and its Subgraph Companion) is still a proof-of-concept. It reads other nodes' configured loras through informal ComfyUI frontend internals and covers a fixed set of loader families, so it can break with ComfyUI updates or with loaders it doesn't have an adapter for. Treat it as a convenience for dual-model workflows, not a guaranteed-stable part of the pack — double-check that what it mirrors matches what you intend before relying on a result.

<p align="center">
  <img src="screenshots/loramimic.png" alt="A Fantastic Lora Mimic node mirroring two loras from an rgthree Power Lora Loader beside it" width="700"><br>
  <em>Wirelessly mirror Loras from other nodes. For whatever reason. Experimental.</em>
</p>

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

---

## Where your settings live

| What | Where |
|---|---|
| Presets (lora stacks) | `ComfyUI/user/fantastic-loras/presets/` |
| Presets (Any Selector) | `ComfyUI/user/fantastic-loras/selector_presets/<category>/` |
| Favourites, theme, `.ext` toggle | `ComfyUI/user/fantastic-loras/prefs.json` |
| Grid Viewer archive defaults | `ComfyUI/user/fantastic-loras/archive_defaults.json` |
| Your LoRA stack, folder filter, strengths | Saved inside the workflow itself |

The first three follow your ComfyUI install, so they're the same in every workflow and survive updates. The last one travels with the workflow file, so sharing a workflow shares its LoRA setup.

## Good to know

- **A LoRA that's missing from disk is skipped**, with a note in the console — a workflow referencing a deleted LoRA still runs.
- **Loading a preset tells you** if any of its LoRAs have since been deleted.
- **Disabled or zero-strength LoRAs cost nothing** — they're skipped entirely, not applied at 0.
- **Nodes resize themselves** to fit their contents. If one looks too small after an update, it'll correct itself on the next redraw.
- **Both renderers behave identically** — if something looks wrong after switching between the classic canvas and Nodes 2.0, a browser refresh sorts it.

## Troubleshooting

**A node is blank, or buttons do nothing.** Hard-refresh the browser (Ctrl+Shift+R). Browsers cache the old code aggressively.

**Presets or favourites aren't saving.** These need a ComfyUI *restart* (not just a refresh) after installing or updating, since the pack adds server routes at startup.

**A new LoRA folder isn't showing up.** Open the FOLDERS picker — it re-reads the disk each time it opens. If you have an explicit folder selection, tick the new folder to include it.

**The comparison grid is enormous.** Check the SWEEP footer count before queueing; LoRAs × strengths multiplies fast.

## What's new in 2.2

- **Fantastic Seeds 🌱** — a seed source with fixed, randomize-every-queue, and locked-random modes, plus a history of the last 10 seeds you queued.
- The folder picker is now a **collapsible tree**. Branches cycle between the whole branch, just that folder, and off; expanders and a collapse-all remember their state.
- The loader and Plotter footers show how many loras your folder filter is letting through.

## What's new in 2.1

- **Fantastic Any Selector 🎯** — a filename picker for any loader, with folder filtering and per-category presets. Right-click a loader to add one already wired.
- The Plotter's Grid Viewer now labels its hidden rows and hidden columns separately, below the grid.
- Panels of overlapping pack nodes stack correctly when clicked.

## Upgrading from v1

The old single-model **Fantastic Lora Loader** node has been replaced by the multi-model one (which is now just called **Fantastic Lora Loader 📁**). Old workflows using the single-model node will need it swapped for the new one — your LoRA list, strengths, and folder filter all carry over.

Favourites and theme choice from v1 lived in your browser and don't migrate to the new on-disk settings; you'll want to re-star your regulars once.

## Under the hood

For the curious, or anyone wanting to build on this:

- LoRA stacks are stored as JSON in a hidden widget on the node, which is how they serialize with the workflow.
- Each model chain gets an independent copy of the base model, so LoRAs on one never leak into another.
- LoRAs are applied through ComfyUI's own `comfy.sd.load_lora_for_models`, the same path the stock loader uses, with the loaded file cached per path.
- Auto-roll happens in the browser at queue time rather than during execution — this keeps the generation path identical to a normal run.
- The Plotter applies each LoRA individually to a copy of the base model rather than stacking them, emitting one model and metadata pair per cell.
- The panels are plain DOM inside the node body, which is why they work under both renderers.

## Licence

MIT — see [LICENSE](LICENSE).
