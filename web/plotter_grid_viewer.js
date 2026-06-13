// =============================================================================
// Fantastic Plotter Grid Viewer — interactive plot grid (web/plotter_grid_viewer.js)
// -----------------------------------------------------------------------------
// Terminal display node (the interactive twin of the Image Saver). It receives a
// parallel list of per-cell image refs + metadata from the Python node and lays
// them out as a lora x strength grid with:
//   • cells sized to the images' real aspect ratio (no cropping)
//   • hide / show any row (lora) or column (strength)
//   • click a cell to zoom it (grows from the grid, shrinks back on close);
//     the zoom panel hugs the image so the surrounding backdrop closes it
//   • star (favourite) cells and export each as a PNG with a metadata bar
//   • multi-select cells to compare them, and save the comparison as one image
// The Python side only persists the cells; everything here is pure DOM/canvas.
// =============================================================================

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const VIEWER_NODE_NAME = "FantasticPlotterGridViewer";

const NODE_COLOR   = "#114f54";
const NODE_BGCOLOR = "#1a4a4e";
const ACCENT       = "#2dd4bf";   // teal accent for selection/active
const BORDER       = "#2b6e72";
const BAR_BG       = "#0a2326";    // metadata bar background (export + panels)
const TEXT_COL     = "#e7fbf6";

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function viewURL(ref) {
  if (ref && ref.url) return ref.url;   // demo / data-URL cells
  const p = new URLSearchParams({
    filename: ref.filename || "",
    subfolder: ref.subfolder || "",
    type: ref.type || "temp",
    t: String(Date.now()),
  });
  const path = `/view?${p.toString()}`;
  try { return api.apiURL(path); } catch (_) { return path; }
}

// Build an API URL (honours ComfyUI's base path when api.apiURL is available).
function apiPath(path) {
  try { return api.apiURL(path); } catch (_) { return path; }
}

const CONTROL_LABELS = { control: "control", control_global: "Control (with global loras)" };

function parseMeta(meta) {
  const s = String(meta ?? "");
  if (s in CONTROL_LABELS) return { control: true, label: CONTROL_LABELS[s], name: s, strength: null };
  const i = s.lastIndexOf("_");
  if (i > 0) {
    const tail = s.slice(i + 1);
    const num = parseFloat(tail);
    if (!Number.isNaN(num) && /^-?\d*\.?\d+$/.test(tail)) {
      return { control: false, name: s.slice(0, i), strength: num, label: s };
    }
  }
  return { control: false, name: s, strength: null, label: s };
}

function fmtStrength(v) {
  if (v == null) return "";
  return (Math.round(v * 100) / 100).toString();
}

function el(tag, css, props) {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k.includes("-")) e.setAttribute(k, v);   // data-* / aria-* are attributes
      else e[k] = v;
    }
  }
  return e;
}

function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("img load failed: " + url));
    im.src = url;
  });
}

function safeName(s) {
  return String(s || "image").replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 80);
}

function downloadCanvas(canvas, filename) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = el("a", "display:none", { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
  }, "image/png");
}

// canvas text helpers ----------------------------------------------------------

function wrapTokens(ctx, tokens, maxW) {
  // tokens: [{word, color}] -> [[{word,color}...], ...] lines
  const spaceW = ctx.measureText(" ").width;
  const lines = [[]];
  let x = 0;
  for (const tk of tokens) {
    const w = ctx.measureText(tk.word).width;
    if (x > 0 && x + w > maxW) { lines.push([]); x = 0; }
    lines[lines.length - 1].push(tk);
    x += w + spaceW;
  }
  return lines;
}

function metaTokens(c, globalLines) {
  const teal = ACCENT, white = TEXT_COL;
  const toks = [];
  const push = (s, col) => String(s).split(/\s+/).filter(Boolean).forEach((w) => toks.push({ word: w, color: col }));
  if (c.control) {
    push(c.label, teal);
    push(c.name === "control_global" ? "(base + globals only)" : "(base model, no loras)", white);
  } else {
    push("Lora:", teal); push(c.name, white);
    if (c.strength != null) { push("Strength:", teal); push(fmtStrength(c.strength), white); }
  }
  if (globalLines && globalLines.length) { push("Globals:", teal); push(globalLines.join(", "), white); }
  return toks;
}

// Draw an image with a metadata bar beneath it. Returns a canvas.
function renderCellWithMeta(img, tokens, opts = {}) {
  const pad = opts.pad ?? 14;
  const font = opts.font ?? 22;
  const lineH = Math.round(font * 1.35);
  const iw = opts.w ?? img.naturalWidth;
  const ih = opts.h ?? img.naturalHeight;

  const meas = document.createElement("canvas").getContext("2d");
  meas.font = `${font}px system-ui, sans-serif`;
  const lines = wrapTokens(meas, tokens, iw - pad * 2);
  const barH = lines.length * lineH + pad * 2;

  const canvas = document.createElement("canvas");
  canvas.width = iw;
  canvas.height = ih + barH;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = BAR_BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, iw, ih);
  ctx.fillStyle = BAR_BG;
  ctx.fillRect(0, ih, iw, barH);
  ctx.font = `${font}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  const spaceW = ctx.measureText(" ").width;
  let y = ih + pad;
  for (const line of lines) {
    let x = pad;
    for (const tk of line) {
      ctx.fillStyle = tk.color;
      ctx.fillText(tk.word, x, y);
      x += ctx.measureText(tk.word).width + spaceW;
    }
    y += lineH;
  }
  return canvas;
}

// Just the image on a canvas at natural (or given) size — no metadata bar.
function imageToCanvas(img, w, h) {
  const iw = w ?? img.naturalWidth;
  const ih = h ?? img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = iw;
  canvas.height = ih;
  canvas.getContext("2d").drawImage(img, 0, 0, iw, ih);
  return canvas;
}

// ---------------------------------------------------------------------------
// Grid model
// ---------------------------------------------------------------------------

function buildModel(cells) {
  const parsed = cells.map((c) => ({ ...c, ...parseMeta(c.metadata) }));
  const main = parsed.filter((c) => !c.control);
  const controls = parsed.filter((c) => c.control);

  const names = [];
  const strengths = [];
  for (const c of main) {
    if (!names.includes(c.name)) names.push(c.name);
    if (c.strength != null && !strengths.some((s) => s === c.strength)) strengths.push(c.strength);
  }
  strengths.sort((a, b) => a - b);

  const at = new Map();
  for (const c of main) at.set(`${c.name}\u0000${c.strength}`, c);

  return { names, strengths, at, controls, main, parsed };
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

class GridViewer {
  constructor(node) {
    this.node = node;
    this.cells = [];
    this.globalLines = [];
    this.hiddenRows = new Set();
    this.hiddenCols = new Set();
    this.hiddenControls = new Set();   // control cell names ("control"/"control_global")
    this.rowOrder = null;              // custom lora-row order (names), or null = model order
    this.selected = new Set();
    this.favorites = new Set();
    this.runId = "";                 // archive run id ("" = ephemeral/temp)
    this.pinned = false;             // current grid pinned (exempt from cleanup)
    this.comparisons = [];           // [{name, keys}] for the current grid
    this.archiveCfg = {archive: false, maxAgeOn: true, maxAgeDays: 14,
                       lastNOn: false, lastN: 20};
    this.archiveWidget = null;       // hidden fl_archive STRING widget (set later)
    this.thumb = 150;            // cell WIDTH in px; height follows aspect
    this.aspect = 1;            // w/h, corrected once first image loads
    this._aspectLocked = false;

    this.root = el("div",
      "width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;" +
      "background:#0e2b2e;border-radius:6px;color:" + TEXT_COL + ";font-family:system-ui,sans-serif;" +
      "font-size:12px;box-sizing:border-box;position:relative;");
    this.toolbar = el("div",
      "flex:none;display:flex;align-items:center;gap:8px;padding:6px 8px;" +
      "border-bottom:1px solid " + BORDER + ";flex-wrap:wrap;");
    this.scroll = el("div", "flex:1 1 auto;overflow:auto;padding:8px;");
    this.overlay = el("div", "position:absolute;inset:0;display:none;z-index:30;");
    this.root.appendChild(this.toolbar);
    this.root.appendChild(this.scroll);
    this.root.appendChild(this.overlay);
    this._buildToolbar();
  }

  setData(cells, globalLines, runId) {
    this.cells = cells || [];
    this.globalLines = globalLines || [];
    this.runId = runId || "";
    this.model = buildModel(this.cells);
    for (const r of [...this.hiddenRows]) if (!this.model.names.includes(r)) this.hiddenRows.delete(r);
    for (const c of [...this.hiddenCols]) if (!this.model.strengths.includes(c)) this.hiddenCols.delete(c);
    const ctrlNames = this.model.controls.map((c) => c.name);
    for (const n of [...this.hiddenControls]) if (!ctrlNames.includes(n)) this.hiddenControls.delete(n);
    this.rowOrder = null;
    this.selected.clear();
    this.favorites.clear();
    this._aspectLocked = false;
    this.render();
  }

  _lookup() {
    const m = new Map();
    this.model.controls.forEach((c, i) => m.set("ctrl:" + i, c));
    this.model.main.forEach((c) => m.set(`${c.name}\u0000${c.strength}`, c));
    return m;
  }

  _effectiveRowOrder() {
    const names = this.model.names;
    if (this.rowOrder && this.rowOrder.length === names.length &&
        names.every((n) => this.rowOrder.includes(n))) {
      return this.rowOrder.slice();
    }
    return names.slice();
  }

  moveRow(name, dir) {
    const order = this._effectiveRowOrder();
    const i = order.indexOf(name);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    this.rowOrder = order;
    this.render();
  }

  // ---- toolbar ----
  _buildToolbar() {
    const mkBtn = (label, title, onClick) => {
      const b = el("button",
        "background:#14403f;color:" + TEXT_COL + ";border:1px solid " + BORDER + ";border-radius:5px;" +
        "padding:3px 9px;cursor:pointer;font-size:12px;white-space:nowrap;",
        { textContent: label, title: title || "" });
      b.onmouseenter = () => { if (!b.disabled) b.style.background = "#1c5450"; };
      b.onmouseleave = () => (b.style.background = "#14403f");
      b.onclick = onClick;
      return b;
    };

    this.compareBtn = mkBtn("Compare (0)", "Show selected cells side by side with their metadata",
      () => this.openCompare());
    this.clearSelBtn = mkBtn("Clear selection", "Deselect all cells", () => {
      this.selected.clear(); this.render();
    });
    this.exportFavBtn = mkBtn("\u2605 Export favourites (0)",
      "Download each starred image as a PNG", () => this.exportFavourites());

    this.savedBtn = mkBtn("\u2630 Saved Comparisons (0)",
      "Reopen a comparison you saved for this grid", () => this.openSavedMenu());

    // --- save / pin / delete cluster (contextual) ---
    this.saveGridBtn = mkBtn("\uD83D\uDCBE Save Grid",
      "Save this grid to disk (pinned — kept until you delete it)", () => this.saveGrid());
    this.savedLabel = el("span", "font-size:11px;color:" + ACCENT + ";white-space:nowrap;align-self:center;",
      { textContent: "\u2713 Saved" });
    this.pinBtn = mkBtn("\uD83D\uDCCC Pin", "Pin this grid so automatic cleanup never removes it",
      () => this.setPinned(!this.pinned));
    this.deleteGridBtn = mkBtn("\uD83D\uDDD1 Delete This Grid",
      "Delete this saved grid from disk", () => this.deleteCurrentGrid());

    this.savedGridsBtn = mkBtn("\uD83D\uDCC2 Saved Grids",
      "Browse and load grids saved on disk", () => this.openBrowseRuns());
    this.autoSaveStatus = el("span", "font-size:11px;white-space:nowrap;align-self:center;opacity:.85;");

    this.archiveBtn = mkBtn("\u2699 Archive Settings",
      "Auto-save, cleanup rules, and pinned-grid management", () => this.openArchivePanel());

    // "with metadata bar" toggle for the favourites export (on by default).
    this.favMetaWrap = el("label",
      "display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap;font-size:11px;opacity:.9;");
    this.favMetaCb = el("input", "cursor:pointer;", { type: "checkbox", checked: true });
    this.favMetaWrap.appendChild(this.favMetaCb);
    this.favMetaWrap.appendChild(el("span", "", { textContent: "with metadata bar" }));
    this.favMetaWrap.title = "Include a bar with each image's lora / strength / globals (off = raw image)";

    this.resetBtn = mkBtn("Reset filters", "Show all hidden rows and columns", () => {
      this.hiddenRows.clear(); this.hiddenCols.clear(); this.render();
    });

    const sizeWrap = el("label",
      "display:flex;align-items:center;gap:5px;margin-left:auto;opacity:.85;white-space:nowrap;");
    sizeWrap.appendChild(el("span", "", { textContent: "Size" }));
    this.sizeSlider = el("input", "width:110px;", { type: "range", min: "80", max: "440", step: "10" });
    this.sizeSlider.value = String(this.thumb);
    this.sizeSlider.oninput = () => { this.thumb = parseInt(this.sizeSlider.value, 10); this._applyCellSize(); };
    sizeWrap.appendChild(this.sizeSlider);

    this.toolbar.appendChild(this.compareBtn);
    this.toolbar.appendChild(this.clearSelBtn);
    this.toolbar.appendChild(this.savedBtn);
    this.toolbar.appendChild(this.exportFavBtn);
    this.toolbar.appendChild(this.favMetaWrap);
    this.toolbar.appendChild(this.saveGridBtn);
    this.toolbar.appendChild(this.savedLabel);
    this.toolbar.appendChild(this.pinBtn);
    this.toolbar.appendChild(this.deleteGridBtn);
    this.toolbar.appendChild(this.savedGridsBtn);
    this.toolbar.appendChild(this.autoSaveStatus);
    this.toolbar.appendChild(this.resetBtn);
    this.toolbar.appendChild(this.archiveBtn);
    this.toolbar.appendChild(sizeWrap);
  }

  _updateToolbar() {
    const n = this.selected.size;
    this.compareBtn.textContent = `Compare (${n})`;
    const on = n >= 2;
    this.compareBtn.disabled = !on;
    this.compareBtn.style.opacity = on ? "1" : ".45";
    this.compareBtn.style.cursor = on ? "pointer" : "default";
    this.clearSelBtn.style.display = n > 0 ? "" : "none";

    const f = this.favorites.size;
    this.exportFavBtn.textContent = `\u2605 Export favourites (${f})`;
    this.exportFavBtn.disabled = f === 0;
    this.exportFavBtn.style.opacity = f ? "1" : ".45";
    this.exportFavBtn.style.cursor = f ? "pointer" : "default";
    if (this.favMetaWrap) this.favMetaWrap.style.display = f ? "flex" : "none";

    if (this.savedBtn) {
      const sc = this.comparisons.length;
      this.savedBtn.textContent = `\u2630 Saved Comparisons (${sc})`;
      this.savedBtn.disabled = sc === 0;
      this.savedBtn.style.opacity = sc ? "1" : ".45";
      this.savedBtn.style.cursor = sc ? "pointer" : "default";
    }

    // save / pin / delete cluster — contextual on whether this grid is on disk
    const onDisk = !!this.runId;
    if (this.saveGridBtn) this.saveGridBtn.style.display = onDisk ? "none" : "";
    if (this.savedLabel) {
      this.savedLabel.style.display = onDisk ? "" : "none";
      this.savedLabel.textContent = this.pinned ? "\u2713 Saved \u00b7 pinned" : "\u2713 Saved";
    }
    if (this.pinBtn) {
      this.pinBtn.style.display = onDisk ? "" : "none";
      this.pinBtn.textContent = this.pinned ? "\uD83D\uDCCC Pinned" : "\uD83D\uDCCC Pin";
      this.pinBtn.title = this.pinned
        ? "Unpin — let automatic cleanup manage this grid again"
        : "Pin this grid so automatic cleanup never removes it";
      this.pinBtn.style.background = this.pinned ? "#1c5450" : "#14403f";
      this.pinBtn.style.borderColor = this.pinned ? ACCENT : BORDER;
    }
    if (this.deleteGridBtn) this.deleteGridBtn.style.display = onDisk ? "" : "none";

    if (this.autoSaveStatus) {
      const on = !!(this.archiveCfg && this.archiveCfg.archive);
      this.autoSaveStatus.textContent = on ? "\u25cf Auto-saving" : "\u25cb Auto-save off";
      this.autoSaveStatus.style.color = on ? ACCENT : "#9bb0b0";
      this.autoSaveStatus.title = on
        ? "Every run is being saved to disk (subject to cleanup rules)."
        : "New runs are NOT being saved automatically — use Save Grid to keep one.";
    }

    const filtered = this.hiddenRows.size + this.hiddenCols.size + this.hiddenControls.size > 0;
    this.resetBtn.style.display = filtered ? "" : "none";
  }

  _applyCellSize() {
    const w = this.thumb;
    const h = Math.max(40, Math.round(w / (this.aspect || 1)));
    this.scroll.style.setProperty("--cw", w + "px");
    this.scroll.style.setProperty("--ch", h + "px");
    if (this._table) this._table.style.gridTemplateColumns = `auto repeat(${this._visCols}, var(--cw))`;
  }

  _noteAspect(img) {
    if (this._aspectLocked) return;
    if (img.naturalWidth && img.naturalHeight) {
      this.aspect = img.naturalWidth / img.naturalHeight;
      this._aspectLocked = true;
      this._applyCellSize();
    }
  }

  // ---- main grid render ----
  render() {
    this.overlay.style.display = "none";
    this.overlay.innerHTML = "";
    this.scroll.innerHTML = "";
    this._updateToolbar();

    if (!this.cells.length) {
      this.scroll.appendChild(el("div", "opacity:.6;padding:20px;text-align:center;",
        { textContent: "Run the graph to populate the grid." }));
      return;
    }

    const m = this.model;
    if (this.globalLines.length) {
      const strip = el("div",
        "margin-bottom:8px;padding:6px 8px;background:" + BAR_BG + ";border:1px solid " + BORDER + ";" +
        "border-radius:5px;line-height:1.5;");
      strip.appendChild(el("b", "color:" + ACCENT + ";", { textContent: "Global loras: " }));
      strip.appendChild(document.createTextNode(this.globalLines.join(", ")));
      this.scroll.appendChild(strip);
    }

    const visStrengths = m.strengths.filter((s) => !this.hiddenCols.has(s));
    const visNames = this._effectiveRowOrder().filter((n) => !this.hiddenRows.has(n));
    const visControls = m.controls.filter((c) => !this.hiddenControls.has(c.name));

    this._visCols = visStrengths.length;
    this._applyCellSize();

    const table = el("div", "display:inline-grid;gap:6px;align-items:start;");
    table.style.gridTemplateColumns = `auto repeat(${visStrengths.length}, var(--cw))`;
    this._table = table;

    // header row: corner + strength headers
    const corner = el("div", "min-width:90px;display:flex;flex-direction:column;gap:3px;");
    if (this.hiddenCols.size) {
      this.hiddenCols.forEach((s) => corner.appendChild(this._restoreChip(`+ Str ${fmtStrength(s)}`, () => {
        this.hiddenCols.delete(s); this.render();
      })));
    }
    table.appendChild(corner);

    for (const s of visStrengths) {
      const h = el("div",
        "display:flex;align-items:center;justify-content:center;gap:4px;font-weight:600;" +
        "padding:2px 4px;text-align:center;");
      h.appendChild(el("span", "", { textContent: "Strength: " + fmtStrength(s) }));
      h.appendChild(this._hideBtn("Hide this strength column", () => { this.hiddenCols.add(s); this.render(); }));
      table.appendChild(h);
    }

    // control rows (each its own labeled row, now hideable)
    visControls.forEach((c) => {
      const idx = m.controls.indexOf(c);
      const lbl = el("div",
        "display:flex;align-items:center;gap:4px;justify-content:flex-end;padding-right:6px;" +
        "font-weight:600;color:" + ACCENT + ";max-width:220px;text-align:right;align-self:center;");
      lbl.appendChild(el("span", "", { textContent: c.label }));
      lbl.appendChild(this._hideBtn("Hide this control row", () => { this.hiddenControls.add(c.name); this.render(); }));
      table.appendChild(lbl);
      table.appendChild(this._cell(c, "ctrl:" + idx));
      for (let k = 1; k < visStrengths.length; k++) table.appendChild(el("div"));
    });

    // lora rows (reorderable)
    visNames.forEach((name, vi) => {
      const rowLbl = el("div",
        "display:flex;align-items:center;gap:4px;justify-content:flex-end;padding-right:6px;" +
        "font-weight:600;max-width:240px;text-align:right;word-break:break-word;align-self:center;");
      // up/down reorder controls
      const reorder = el("div", "display:flex;flex-direction:column;line-height:1;flex:none;");
      reorder.appendChild(this._moveBtn("\u25B2", "Move row up", vi > 0, () => this.moveRow(name, -1)));
      reorder.appendChild(this._moveBtn("\u25BC", "Move row down", vi < visNames.length - 1, () => this.moveRow(name, +1)));
      rowLbl.appendChild(reorder);
      rowLbl.appendChild(el("span", "", { textContent: name }));
      rowLbl.appendChild(this._hideBtn("Hide this lora row", () => { this.hiddenRows.add(name); this.render(); }));
      table.appendChild(rowLbl);

      for (const s of visStrengths) {
        const c = m.at.get(`${name}\u0000${s}`);
        if (c) table.appendChild(this._cell(c, `${name}\u0000${s}`));
        else table.appendChild(el("div",
          `width:var(--cw);height:var(--ch);border:1px dashed ${BORDER};border-radius:5px;opacity:.3;`,
          { "data-cell": "1" }));
      }
    });

    this.scroll.appendChild(table);

    // unified restore area for hidden rows + hidden control rows
    const hiddenChips = [];
    this.hiddenControls.forEach((n) => {
      const lbl = CONTROL_LABELS[n] || n;
      hiddenChips.push(this._restoreChip("+ " + lbl, () => { this.hiddenControls.delete(n); this.render(); }));
    });
    this.hiddenRows.forEach((n) => {
      hiddenChips.push(this._restoreChip("+ " + n, () => { this.hiddenRows.delete(n); this.render(); }));
    });
    if (hiddenChips.length) {
      const wrap = el("div", "margin-top:10px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;");
      wrap.appendChild(el("span", "opacity:.6;", { textContent: "Hidden:" }));
      hiddenChips.forEach((ch) => wrap.appendChild(ch));
      this.scroll.appendChild(wrap);
    }
  }

  _moveBtn(arrow, title, enabled, onClick) {
    const b = el("span",
      "cursor:" + (enabled ? "pointer" : "default") + ";font-size:9px;opacity:" + (enabled ? ".6" : ".18") + ";" +
      "padding:0 2px;user-select:none;", { textContent: arrow, title });
    if (enabled) {
      b.onmouseenter = () => (b.style.opacity = "1");
      b.onmouseleave = () => (b.style.opacity = ".6");
      b.onclick = (e) => { e.stopPropagation(); onClick(); };
    }
    return b;
  }

  _hideBtn(title, onClick) {
    const b = el("span",
      "cursor:pointer;opacity:.5;font-size:11px;border:1px solid " + BORDER + ";border-radius:3px;" +
      "padding:0 4px;line-height:15px;flex:none;", { textContent: "\u2715", title });
    b.onmouseenter = () => (b.style.opacity = "1");
    b.onmouseleave = () => (b.style.opacity = ".5");
    b.onclick = (e) => { e.stopPropagation(); onClick(); };
    return b;
  }

  _restoreChip(text, onClick) {
    const c = el("button",
      "background:#14403f;color:" + ACCENT + ";border:1px solid " + BORDER + ";border-radius:10px;" +
      "padding:1px 8px;cursor:pointer;font-size:11px;white-space:nowrap;", { textContent: text });
    c.onclick = onClick;
    return c;
  }

  _cell(c, key) {
    const wrap = el("div",
      "position:relative;width:var(--cw);height:var(--ch);border-radius:5px;overflow:hidden;" +
      "border:2px solid transparent;cursor:zoom-in;background:#06181a;", { "data-cell": "1" });
    if (this.selected.has(key)) wrap.style.borderColor = ACCENT;

    const img = el("img", "width:100%;height:100%;object-fit:cover;display:block;",
      { src: viewURL(c), draggable: false, loading: "lazy" });
    img.onload = () => this._noteAspect(img);
    wrap.appendChild(img);

    // selection checkbox (top-left)
    const sel = el("div",
      "position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:4px;cursor:pointer;" +
      "border:1px solid rgba(255,255,255,.7);background:rgba(0,0,0,.45);display:flex;" +
      "align-items:center;justify-content:center;font-size:13px;line-height:1;color:" + ACCENT + ";",
      { title: "Select for compare" });
    sel.textContent = this.selected.has(key) ? "\u2713" : "";
    sel.onclick = (e) => {
      e.stopPropagation();
      if (this.selected.has(key)) this.selected.delete(key); else this.selected.add(key);
      sel.textContent = this.selected.has(key) ? "\u2713" : "";
      wrap.style.borderColor = this.selected.has(key) ? ACCENT : "transparent";
      this._updateToolbar();
    };
    wrap.appendChild(sel);

    // favourite star (top-right) — larger, with a thicker outline so the empty
    // state stands out against light images
    const star = el("div",
      "position:absolute;top:1px;right:3px;font-size:25px;line-height:1;cursor:pointer;" +
      "-webkit-text-stroke:0.7px rgba(0,0,0,.8);text-shadow:0 1px 4px rgba(0,0,0,.95);user-select:none;",
      { title: "Favourite (for Export favourites)" });
    const paintStar = () => {
      const on = this.favorites.has(key);
      star.textContent = on ? "\u2605" : "\u2606";
      star.style.color = on ? "#ffd54a" : "rgba(255,255,255,.97)";
    };
    paintStar();
    star.onclick = (e) => {
      e.stopPropagation();
      if (this.favorites.has(key)) this.favorites.delete(key); else this.favorites.add(key);
      paintStar();
      this._persistFavorites();
      this._updateToolbar();
    };
    wrap.appendChild(star);

    // caption
    const cap = el("div",
      "position:absolute;left:0;right:0;bottom:0;padding:2px 4px;font-size:10px;line-height:1.3;" +
      "background:linear-gradient(transparent,rgba(0,0,0,.75));pointer-events:none;");
    cap.textContent = c.control ? c.label
      : (c.strength != null ? `${c.name} @ ${fmtStrength(c.strength)}` : c.name);
    wrap.appendChild(cap);

    wrap.onclick = () => this.openZoom(c, wrap);
    return wrap;
  }

  // ---- zoom: panel hugs the image, backdrop closes ----
  // Measure how tall the metadata caption will be at a given width (it wraps to
  // multiple lines when globals are present), so the zoom panel can reserve room.
  _measureCaptionH(c, width) {
    try {
      const probe = el("div",
        "position:absolute;visibility:hidden;left:-9999px;top:0;box-sizing:border-box;white-space:nowrap;" +
        "padding:6px 10px;font-size:12px;line-height:1.4;width:" + Math.round(width) + "px;");
      probe.innerHTML = this._metaCaptionHTML(c);
      document.body.appendChild(probe);
      const h = Math.ceil(probe.getBoundingClientRect().height);
      document.body.removeChild(probe);
      return h || 44;
    } catch (_) { return 44; }
  }

  openZoom(c, fromEl) {
    const o = this.overlay;
    o.innerHTML = "";
    o.style.display = "block";
    o.style.background = "rgba(3,14,15,.86)";

    const rootRect = this.root.getBoundingClientRect();
    // ComfyUI scales the DOM widget with a CSS transform to match the canvas
    // zoom, so getBoundingClientRect() reports *scaled screen* pixels while the
    // panel styles below are applied in the widget's *local* pixels (then scaled
    // again by the transform). Sizing/positioning from clientWidth/clientHeight —
    // which ignore the transform — keeps the panel correct at every zoom level.
    const pEl = this.root.parentElement;
    const localW = this.root.clientWidth || rootRect.width || 1;
    const localH = this.root.clientHeight || rootRect.height || 1;
    // bound by the parent wrapper (handles the fresh-load case where height:100%
    // hasn't resolved yet), all in local pixels.
    const visW = Math.min(localW, (pEl && pEl.clientWidth) || localW);
    const visH = Math.min(localH, (pEl && pEl.clientHeight) || localH);
    const scale = rootRect.width > 0 ? rootRect.width / localW : 1;
    // cell rect, converted from screen to local coords for the FLIP start/return
    const r = fromEl.getBoundingClientRect();
    const startLeft = (r.left - rootRect.left) / scale;
    const startTop = (r.top - rootRect.top) / scale;
    const startW = r.width / scale;
    const startH = r.height / scale;
    const ar = this.aspect || 1;

    const pad = 22, sideW = 132, gap = 8;
    const availW = Math.max(80, visW - pad * 2 - sideW - gap);
    // Provisional fit with a baseline caption reserve to get the image width…
    let capH = 44;
    let availH = Math.max(80, visH - pad * 2 - capH);
    let imgW = availW, imgH = imgW / ar;
    if (imgH > availH) { imgH = availH; imgW = imgH * ar; }
    // …then measure the caption at that width (it wraps to several lines when
    // globals are present, especially on the lower rows) and re-fit the image so
    // the full metadata is always visible instead of being clipped.
    capH = Math.max(44, Math.min(this._measureCaptionH(c, imgW), Math.round(visH * 0.45)));
    availH = Math.max(80, visH - pad * 2 - capH);
    if (imgH > availH) { imgH = availH; imgW = imgH * ar; }
    const panelW = imgW + gap + sideW;
    const panelH = imgH + capH;
    const targetLeft = (visW - panelW) / 2;
    const targetTop = (visH - panelH) / 2;

    const panel = el("div",
      "position:absolute;display:flex;flex-direction:row;background:" + BAR_BG + ";" +
      "border:1px solid " + BORDER + ";border-radius:8px;overflow:hidden;box-sizing:border-box;" +
      "transition:all .22s cubic-bezier(.2,.7,.3,1);");
    panel.style.left = startLeft + "px";
    panel.style.top = startTop + "px";
    panel.style.width = startW + "px";
    panel.style.height = startH + "px";
    panel.style.opacity = ".5";

    // left: image stacked over a metadata caption bar (full width of this column)
    const main = el("div", "flex:1 1 auto;min-width:0;display:flex;flex-direction:column;");
    const img = el("img",
      "flex:1 1 auto;min-height:0;width:100%;object-fit:contain;display:block;background:#06181a;",
      { src: viewURL(c), draggable: false });
    const cap = el("div",
      "flex:none;height:" + capH + "px;display:flex;align-items:center;" +
      "padding:6px 10px;box-sizing:border-box;font-size:12px;line-height:1.4;overflow:auto;white-space:nowrap;");
    cap.innerHTML = this._metaCaptionHTML(c);
    main.appendChild(img);
    main.appendChild(cap);

    // right: globals at the top, save controls pinned to the bottom
    const side = el("div",
      "flex:none;width:" + sideW + "px;display:flex;flex-direction:column;align-items:stretch;" +
      "gap:8px;padding:10px;border-left:1px solid " + BORDER + ";");

    const gHTML = this._globalsHTML();
    if (gHTML) {
      const gBox = el("div",
        "flex:0 1 auto;overflow:auto;font-size:11px;line-height:1.4;max-height:55%;");
      gBox.innerHTML = gHTML;
      side.appendChild(gBox);
    }
    side.appendChild(el("div", "flex:1 1 auto;"));   // spacer pushes Save to the bottom

    const saveBtn = el("button",
      "background:#14403f;color:" + TEXT_COL + ";border:1px solid " + BORDER + ";" +
      "border-radius:5px;padding:5px 0;cursor:pointer;font-size:12px;white-space:nowrap;text-align:center;",
      { textContent: "\u2913 Save", title: "Download this image" });
    saveBtn.onmouseenter = () => (saveBtn.style.background = "#1c5450");
    saveBtn.onmouseleave = () => (saveBtn.style.background = "#14403f");

    const cbLabel = el("label",
      "display:flex;align-items:flex-start;gap:5px;cursor:pointer;font-size:11px;line-height:1.3;opacity:.9;");
    const cb = el("input", "cursor:pointer;margin-top:1px;flex:none;", { type: "checkbox", checked: true });
    cbLabel.appendChild(cb);
    cbLabel.appendChild(el("span", "", { textContent: "include metadata on output image" }));
    cbLabel.onclick = (e) => e.stopPropagation();

    saveBtn.onclick = async (e) => {
      e.stopPropagation();
      const prev = saveBtn.textContent;
      saveBtn.textContent = "Saving…";
      try {
        const full = await loadImage(viewURL(c));
        const canvas = cb.checked
          ? renderCellWithMeta(full, metaTokens(c, this.globalLines))
          : imageToCanvas(full);
        downloadCanvas(canvas, `${safeName(c.metadata)}${cb.checked ? "_meta" : ""}.png`);
      } catch (err) {
        console.error("[FantasticGridViewer] zoom save failed", err);
      } finally {
        saveBtn.textContent = prev;
      }
    };

    side.appendChild(saveBtn);
    side.appendChild(cbLabel);
    panel.appendChild(main);
    panel.appendChild(side);
    o.appendChild(panel);

    panel.onclick = (e) => e.stopPropagation();
    const close = () => {
      panel.style.left = startLeft + "px";
      panel.style.top = startTop + "px";
      panel.style.width = startW + "px";
      panel.style.height = startH + "px";
      panel.style.opacity = ".2";
      setTimeout(() => { o.style.display = "none"; o.innerHTML = ""; }, 220);
    };
    o.onclick = (e) => { if (e.target === o) close(); };

    requestAnimationFrame(() => {
      panel.style.left = targetLeft + "px";
      panel.style.top = targetTop + "px";
      panel.style.width = panelW + "px";
      panel.style.height = panelH + "px";
      panel.style.opacity = "1";
    });
  }

  _metaHTML(c) {
    if (c.control) {
      const extra = c.name === "control_global"
        ? `<span style="opacity:.8">&nbsp;(base + global loras only)</span>`
        : `<span style="opacity:.8">&nbsp;(base model — no loras)</span>`;
      return `<b style="color:${ACCENT}">${c.label}</b>${extra}` +
        (this.globalLines.length ? `<span style="opacity:.7">&nbsp;|&nbsp;Globals: ${this.globalLines.join(", ")}</span>` : "");
    }
    const rows = [
      `<b style="color:${ACCENT}">Lora:</b> ${c.name}`,
      c.strength != null ? `<b style="color:${ACCENT}">Strength:</b> ${fmtStrength(c.strength)}` : "",
      this.globalLines.length ? `<b style="color:${ACCENT}">Globals:</b> ${this.globalLines.join(", ")}` : "",
    ].filter(Boolean);
    return rows.join(" &nbsp;|&nbsp; ");
  }

  // Caption for the zoom view: lora + strength on a single line (globals move to
  // the side panel). Colours kept; separated by spacing rather than stacking.
  _metaCaptionHTML(c) {
    if (c.control) {
      const extra = c.name === "control_global" ? " (base + global loras only)" : " (base model — no loras)";
      return `<b style="color:${ACCENT}">${c.label}</b><span style="opacity:.8">${extra}</span>`;
    }
    let s = `<b style="color:${ACCENT}">Lora:</b> ${c.name}`;
    if (c.strength != null) s += `&nbsp;&nbsp;&nbsp;&nbsp;<b style="color:${ACCENT}">Strength:</b> ${fmtStrength(c.strength)}`;
    return s;
  }

  _globalsHTML() {
    if (!this.globalLines.length) return "";
    const items = this.globalLines.map((g) => `<div style="opacity:.9;word-break:break-word;">${g}</div>`).join("");
    return `<div style="font-weight:600;color:${ACCENT};margin-bottom:3px;">Global loras</div>${items}`;
  }

  // ---- compare ----
  openCompare() {
    if (this.selected.size < 2) return;
    const lookup = this._lookup();
    const chosen = [...this.selected].map((k) => lookup.get(k)).filter(Boolean);
    if (chosen.length < 2) return;

    const o = this.overlay;
    o.innerHTML = "";
    o.style.display = "block";
    o.style.background = "rgba(3,14,15,.92)";

    const panel = el("div",
      "position:absolute;inset:14px;background:" + BAR_BG + ";border:1px solid " + BORDER + ";" +
      "border-radius:8px;display:flex;flex-direction:column;overflow:hidden;");
    const head = el("div",
      "flex:none;display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid " + BORDER + ";");
    head.appendChild(el("b", "color:" + ACCENT + ";", { textContent: `Comparing ${chosen.length} images` }));

    const saveSetBtn = el("button",
      "margin-left:auto;background:#14403f;color:" + ACCENT + ";border:1px solid " + ACCENT + ";" +
      "border-radius:5px;padding:2px 10px;cursor:pointer;",
      { textContent: "\uD83D\uDCBE Save comparison",
        title: "Save this set of cells so you can reopen this comparison later" });
    saveSetBtn.onclick = () => this.saveComparisonSet();
    head.appendChild(saveSetBtn);

    const saveBtn = el("button",
      "background:#14403f;color:" + TEXT_COL + ";border:1px solid " + BORDER + ";" +
      "border-radius:5px;padding:2px 10px;cursor:pointer;",
      { textContent: "\u2913 Export image", title: "Download these images as one PNG grid with metadata" });
    saveBtn.onclick = () => this.saveComparison(chosen, saveBtn);
    head.appendChild(saveBtn);

    const x = el("button",
      "background:#14403f;color:" + TEXT_COL + ";border:1px solid " + BORDER + ";" +
      "border-radius:5px;padding:2px 10px;cursor:pointer;", { textContent: "Close" });
    x.onclick = () => { o.style.display = "none"; o.innerHTML = ""; };
    head.appendChild(x);

    const strip = el("div",
      "flex:1 1 auto;display:flex;gap:10px;overflow:auto;padding:10px;align-items:stretch;");
    for (const c of chosen) {
      const col = el("div", "flex:1 1 0;min-width:160px;display:flex;flex-direction:column;gap:6px;");
      const img = el("img",
        "width:100%;flex:1 1 auto;min-height:0;object-fit:contain;border-radius:6px;background:#06181a;",
        { src: viewURL(c), draggable: false });
      const cap = el("div",
        "flex:none;font-size:11px;line-height:1.5;background:#0e2b2e;border:1px solid " + BORDER + ";" +
        "border-radius:6px;padding:6px 8px;");
      cap.innerHTML = this._metaHTML(c);
      col.appendChild(img);
      col.appendChild(cap);
      strip.appendChild(col);
    }

    panel.appendChild(head);
    panel.appendChild(strip);
    o.appendChild(panel);
    o.onclick = (e) => { if (e.target === o) { o.style.display = "none"; o.innerHTML = ""; } };
  }

  // ---- exports (canvas → PNG download) ----
  async exportFavourites() {
    if (!this.favorites.size) return;
    const lookup = this._lookup();
    const favs = [...this.favorites].map((k) => lookup.get(k)).filter(Boolean);
    const withMeta = this.favMetaCb ? !!this.favMetaCb.checked : true;
    const prev = this.exportFavBtn.textContent;
    this.exportFavBtn.textContent = "Exporting…";
    try {
      for (const c of favs) {
        const img = await loadImage(viewURL(c));
        const canvas = withMeta
          ? renderCellWithMeta(img, metaTokens(c, this.globalLines))
          : imageToCanvas(img);
        downloadCanvas(canvas, `fav_${safeName(c.metadata)}${withMeta ? "_meta" : ""}.png`);
        await new Promise((r) => setTimeout(r, 180));   // stagger so browsers don't block
      }
    } catch (err) {
      console.error("[FantasticGridViewer] export favourites failed", err);
    } finally {
      this.exportFavBtn.textContent = prev;
      this._updateToolbar();
    }
  }

  async saveComparison(chosen, btn) {
    const prev = btn ? btn.textContent : "";
    if (btn) btn.textContent = "Saving…";
    try {
      const imgs = await Promise.all(chosen.map((c) => loadImage(viewURL(c))));
      // Full-resolution cells (image + meta bar) — no downscaling, so the saved
      // comparison is just as usable as the individual favourite exports.
      const cellCanvases = imgs.map((im, i) =>
        renderCellWithMeta(im, metaTokens(chosen[i], this.globalLines)));

      const cellW = Math.max(...cellCanvases.map((c) => c.width));
      const cellH = Math.max(...cellCanvases.map((c) => c.height));
      const cols = Math.min(chosen.length, 4);
      const rows = Math.ceil(chosen.length / cols);
      const gap = 16, pad = 20;

      const out = document.createElement("canvas");
      out.width = pad * 2 + cols * cellW + (cols - 1) * gap;
      out.height = pad * 2 + rows * cellH + (rows - 1) * gap;
      const ctx = out.getContext("2d");
      ctx.fillStyle = "#0e2b2e";
      ctx.fillRect(0, 0, out.width, out.height);
      cellCanvases.forEach((cc, i) => {
        const cx = pad + (i % cols) * (cellW + gap);
        const cy = pad + Math.floor(i / cols) * (cellH + gap);
        ctx.drawImage(cc, cx + (cellW - cc.width) / 2, cy);   // center within its slot
      });
      downloadCanvas(out, `comparison_${chosen.length}.png`);
    } catch (err) {
      console.error("[FantasticGridViewer] save comparison failed", err);
    } finally {
      if (btn) btn.textContent = prev;
    }
  }

  // ---- saved comparisons (reloadable selection sets) ----
  saveComparisonSet() {
    if (this.selected.size < 2) return;
    const keys = [...this.selected];
    const dflt = `Comparison ${this.comparisons.length + 1}`;
    let name = (typeof window !== "undefined" && window.prompt)
      ? window.prompt("Name this comparison:", dflt) : dflt;
    if (name === null) return;            // cancelled
    name = String(name).trim() || dflt;
    this.comparisons = this.comparisons.filter((c) => c.name !== name);
    this.comparisons.push({ name, keys });
    this._persistComparison("save", name, keys);
    this._updateToolbar();
  }

  deleteComparison(name) {
    this.comparisons = this.comparisons.filter((c) => c.name !== name);
    this._persistComparison("delete", name, null);
    this._updateToolbar();
  }

  reopenComparison(comp) {
    const lookup = this._lookup();
    const live = comp.keys.filter((k) => lookup.has(k));
    if (!live.length) return;
    this.selected = new Set(live);
    this.render();
    this.openCompare();
  }

  // Persist a comparison change: archived runs go to the manifest via the API;
  // ephemeral grids ride along in the workflow JSON (onSerialize).
  _persistComparison(action, name, keys) {
    if (this.runId) {
      const url = apiPath(`/fantastic_loras/run/${this.runId}/comparison`);
      try {
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, name, keys: keys || [] }),
        }).catch(() => {});
      } catch (_) {}
    }
    this._persistState();
  }

  // Favourites: archived runs store them in the manifest; either way they ride
  // along in the serialized grid state so they survive a reload.
  _persistFavorites() {
    if (this.runId) {
      try {
        fetch(apiPath(`/fantastic_loras/run/${this.runId}/favorites`), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ favorites: [...this.favorites] }),
        }).catch(() => {});
      } catch (_) {}
    }
    this._persistState();
  }

  // Write the current grid state into the serialized fl_grid_ref widget. Widget
  // values persist reliably across reloads/tab-switches (the same channel the
  // loaders use for lora_data), which a JS-only state change would not trigger.
  _persistState() {
    if (!this.stateWidget) return;
    try {
      const state = {
        cells: this.cells || [],
        global: this.globalLines || [],
        runId: this.runId || "",
        // archived runs keep these in the manifest (source of truth); for
        // ephemeral grids the workflow copy is all there is.
        comparisons: this.runId ? [] : this.comparisons,
        favorites: this.runId ? [] : [...this.favorites],
        pinned: this.pinned,
      };
      this.stateWidget.value = JSON.stringify(state);
      this.node?.setDirtyCanvas?.(true, true);
    } catch (_) {}
  }

  // Restore grid state from a parsed fl_grid_ref payload (or legacy o.fl_grid).
  restoreState(g) {
    if (!g || !Array.isArray(g.cells)) return;
    this.setData(g.cells, g.global || [], g.runId || "");
    this.comparisons = g.comparisons || [];
    this.favorites = new Set(g.favorites || []);
    this.pinned = !!g.pinned;
    this.render();            // repaint so restored favourite stars show
    this._updateToolbar();
    if (g.runId) this.loadRun(g.runId);   // manifest is the source of truth for archived runs
  }

  openSavedMenu() {
    if (!this.comparisons.length) return;
    const o = this.overlay;
    o.innerHTML = ""; o.style.display = "block"; o.style.background = "rgba(3,14,15,.6)";
    const panel = el("div",
      "position:absolute;top:44px;left:8px;min-width:240px;max-width:340px;max-height:70%;overflow:auto;" +
      "background:" + BAR_BG + ";border:1px solid " + BORDER + ";border-radius:8px;padding:8px;z-index:40;");
    panel.appendChild(el("div", "font-weight:600;color:" + ACCENT + ";margin-bottom:6px;",
      { textContent: "Saved comparisons" }));
    for (const comp of this.comparisons) {
      const row = el("div",
        "display:flex;align-items:center;gap:6px;padding:4px 2px;border-bottom:1px solid #14403f;");
      const open = el("button",
        "flex:1 1 auto;text-align:left;background:none;border:none;color:" + TEXT_COL + ";" +
        "cursor:pointer;font-size:12px;padding:2px 4px;",
        { textContent: `${comp.name}  (${comp.keys.length})` });
      open.onmouseenter = () => (open.style.color = ACCENT);
      open.onmouseleave = () => (open.style.color = TEXT_COL);
      open.onclick = () => { o.style.display = "none"; o.innerHTML = ""; this.reopenComparison(comp); };
      const del = el("button",
        "flex:none;background:none;border:none;color:#e57373;cursor:pointer;font-size:13px;",
        { textContent: "\u2715", title: "Delete this comparison" });
      del.onclick = (e) => { e.stopPropagation(); this.deleteComparison(comp.name); row.remove();
        if (!this.comparisons.length) { o.style.display = "none"; o.innerHTML = ""; } };
      row.appendChild(open); row.appendChild(del);
      panel.appendChild(row);
    }
    o.appendChild(panel);
    o.onclick = (e) => { if (e.target === o) { o.style.display = "none"; o.innerHTML = ""; } };
  }

  // ---- archive settings ----
  _syncArchiveWidget() {
    if (this.archiveWidget) {
      try { this.archiveWidget.value = JSON.stringify(this.archiveCfg); } catch (_) {}
    }
  }

  // Global defaults (persisted server-side in the user dir). A brand-new node
  // with no saved fl_archive starts from these; changing settings updates them.
  async _loadArchiveDefaults() {
    try {
      const res = await fetch(apiPath("/fantastic_loras/archive_defaults"));
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.defaults && typeof data.defaults === "object") {
        this.archiveCfg = { ...this.archiveCfg, ...data.defaults };
        this._syncArchiveWidget();
        this._updateToolbar();
      }
    } catch (_) { /* offline / route missing — keep built-in defaults */ }
  }

  _saveArchiveDefaults() {
    try {
      fetch(apiPath("/fantastic_loras/archive_defaults"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaults: this.archiveCfg }),
      }).catch(() => {});
    } catch (_) {}
  }

  openArchivePanel() {
    const o = this.overlay;
    o.innerHTML = ""; o.style.display = "block"; o.style.background = "rgba(3,14,15,.7)";
    const panel = el("div",
      "position:absolute;top:44px;right:8px;width:300px;max-height:80%;overflow:auto;" +
      "background:" + BAR_BG + ";border:1px solid " + BORDER + ";border-radius:8px;padding:12px;z-index:40;" +
      "display:flex;flex-direction:column;gap:10px;");

    const cfg = this.archiveCfg;
    const mkCheck = (checked, label) => {
      const wrap = el("label", "display:flex;align-items:center;gap:7px;cursor:pointer;font-size:12px;");
      const cb = el("input", "cursor:pointer;", { type: "checkbox", checked: !!checked });
      wrap.appendChild(cb); wrap.appendChild(el("span", "", { textContent: label }));
      return { wrap, cb };
    };
    const mkNum = (val, min, max) => el("input",
      "width:64px;background:#0e2b2e;color:" + TEXT_COL + ";border:1px solid " + BORDER + ";" +
      "border-radius:4px;padding:2px 6px;font-size:12px;",
      { type: "number", min: String(min), max: String(max), value: String(val) });

    // archive master toggle
    const arch = mkCheck(cfg.archive, "Auto-save every run to disk");
    arch.wrap.style.fontWeight = "600";
    panel.appendChild(arch.wrap);

    const note = el("div",
      "font-size:11px;line-height:1.5;color:#e0b76a;background:#2a230e;border:1px solid #5a4a18;" +
      "border-radius:6px;padding:7px 9px;",
      { textContent: "While on, every generated image is written to the output folder " +
        "(output/fantastic-loras-grids) and kept on disk. This uses disk space that grows " +
        "with each run — the options below keep it in check." });

    const sub = el("div", "display:flex;flex-direction:column;gap:9px;padding-left:4px;");

    // max-age
    const ageRow = el("div", "display:flex;align-items:center;gap:6px;font-size:12px;");
    const age = mkCheck(cfg.maxAgeOn, "Delete runs older than");
    const ageNum = mkNum(cfg.maxAgeDays, 1, 3650);
    ageRow.appendChild(age.wrap); ageRow.appendChild(ageNum); ageRow.appendChild(el("span", "", { textContent: "days" }));

    // last-N
    const nRow = el("div", "display:flex;align-items:center;gap:6px;font-size:12px;");
    const lastN = mkCheck(cfg.lastNOn, "Keep only the last");
    const nNum = mkNum(cfg.lastN, 1, 100000);
    nRow.appendChild(lastN.wrap); nRow.appendChild(nNum); nRow.appendChild(el("span", "", { textContent: "runs" }));

    const manage = el("button",
      "background:#14403f;color:" + TEXT_COL + ";border:1px solid " + BORDER + ";border-radius:5px;" +
      "padding:5px 10px;cursor:pointer;font-size:12px;margin-top:2px;",
      { textContent: "\uD83D\uDCCC Manage pinned grids\u2026" });
    manage.onclick = () => this.openManageGrids();

    sub.appendChild(note);
    sub.appendChild(ageRow);
    sub.appendChild(nRow);
    sub.appendChild(manage);
    panel.appendChild(sub);

    const apply = () => {
      this.archiveCfg = {
        archive: arch.cb.checked,
        maxAgeOn: age.cb.checked,
        maxAgeDays: Math.max(1, parseInt(ageNum.value, 10) || 14),
        lastNOn: lastN.cb.checked,
        lastN: Math.max(1, parseInt(nNum.value, 10) || 20),
      };
      this._syncArchiveWidget();
      this._updateToolbar();
      sub.style.display = arch.cb.checked ? "flex" : "none";
    };
    for (const inp of [arch.cb, age.cb, lastN.cb, ageNum, nNum]) {
      inp.onchange = apply; inp.oninput = apply;
    }
    sub.style.display = cfg.archive ? "flex" : "none";

    const close = el("button",
      "align-self:flex-end;background:#14403f;color:" + TEXT_COL + ";border:1px solid " + BORDER + ";" +
      "border-radius:5px;padding:3px 12px;cursor:pointer;font-size:12px;", { textContent: "Done" });
    close.onclick = () => { apply(); this._saveArchiveDefaults(); o.style.display = "none"; o.innerHTML = ""; };
    panel.appendChild(close);

    o.appendChild(panel);
    o.onclick = (e) => { if (e.target === o) { apply(); o.style.display = "none"; o.innerHTML = ""; } };
  }

  // ---- browse archived runs ----
  async openBrowseRuns() {
    const o = this.overlay;
    o.innerHTML = ""; o.style.display = "block"; o.style.background = "rgba(3,14,15,.85)";
    const panel = el("div",
      "position:absolute;inset:24px;background:" + BAR_BG + ";border:1px solid " + BORDER + ";" +
      "border-radius:8px;display:flex;flex-direction:column;overflow:hidden;");
    const head = el("div",
      "flex:none;display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid " + BORDER + ";");
    head.appendChild(el("b", "color:" + ACCENT + ";", { textContent: "Saved runs" }));
    const x = el("button",
      "margin-left:auto;background:#14403f;color:" + TEXT_COL + ";border:1px solid " + BORDER + ";" +
      "border-radius:5px;padding:2px 10px;cursor:pointer;", { textContent: "Close" });
    x.onclick = () => { o.style.display = "none"; o.innerHTML = ""; };
    head.appendChild(x);
    const list = el("div", "flex:1 1 auto;overflow:auto;padding:8px;display:flex;flex-direction:column;gap:6px;");
    list.appendChild(el("div", "opacity:.7;font-size:12px;", { textContent: "Loading\u2026" }));
    panel.appendChild(head); panel.appendChild(list);
    o.appendChild(panel);
    o.onclick = (e) => { if (e.target === o) { o.style.display = "none"; o.innerHTML = ""; } };

    let runs = [];
    try {
      const res = await fetch(apiPath("/fantastic_loras/runs"));
      runs = (await res.json()).runs || [];
    } catch (_) { runs = []; }

    list.innerHTML = "";
    if (!runs.length) {
      list.appendChild(el("div", "opacity:.7;font-size:12px;",
        { textContent: "No saved runs yet. Turn on archive and run the plotter." }));
      return;
    }
    for (const r of runs) {
      const row = el("div",
        "display:flex;align-items:center;gap:10px;padding:7px 8px;border:1px solid " + BORDER + ";" +
        "border-radius:6px;background:#0e2b2e;");
      const label = el("div", "flex:1 1 auto;min-width:0;");
      label.appendChild(el("div", "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
        { textContent: (r.pinned ? "\uD83D\uDCCC " : "") + (r.name || "grid") }));
      label.appendChild(el("div", "font-size:11px;opacity:.7;",
        { textContent: `${r.created_str || ""}  \u00b7  ${r.cell_count} cells  \u00b7  ${r.comparison_count} saved${r.pinned ? "  \u00b7  pinned" : ""}` }));
      const load = el("button",
        "flex:none;background:#14403f;color:" + ACCENT + ";border:1px solid " + ACCENT + ";" +
        "border-radius:5px;padding:3px 10px;cursor:pointer;font-size:12px;", { textContent: "Load" });
      load.onclick = () => { o.style.display = "none"; o.innerHTML = ""; this.loadRun(r.run_id); };
      const del = el("button",
        "flex:none;background:none;border:1px solid #5a2a2a;color:#e57373;border-radius:5px;" +
        "padding:3px 8px;cursor:pointer;font-size:12px;", { textContent: "\uD83D\uDDD1" });
      del.onclick = async (e) => {
        e.stopPropagation();
        if (typeof window !== "undefined" && window.confirm &&
            !window.confirm(`Delete the saved grid "${r.name || "grid"}"? This can't be undone.`)) return;
        try { await fetch(apiPath(`/fantastic_loras/run/${r.run_id}`), { method: "DELETE" }); } catch (_) {}
        row.remove();
        if (this.runId === r.run_id) { this.runId = ""; this.pinned = false; this._persistState(); this._updateToolbar(); }
      };
      row.appendChild(label); row.appendChild(load); row.appendChild(del);
      list.appendChild(row);
    }
  }

  async loadRun(runId) {
    try {
      const res = await fetch(apiPath(`/fantastic_loras/run/${runId}`));
      if (!res.ok) return;
      const man = await res.json();
      this.setData(man.cells || [], man.global || [], man.run_id || runId);
      this.comparisons = (man.comparisons || []).map((c) => ({ name: c.name, keys: c.keys || [] }));
      this.favorites = new Set(man.favorites || []);
      this.pinned = !!man.pinned;
      this.render();            // repaint so restored favourite stars show
      this._updateToolbar();
      this._persistState();   // record the loaded run id so a reload restores it
    } catch (err) {
      console.error("[FantasticGridViewer] loadRun failed", err);
    }
  }

  // ---- save / pin / delete current grid ----
  async saveGrid() {
    if (this.runId) return;            // already on disk; pin/delete handle the rest
    if (!this.cells.length) return;
    const prev = this.saveGridBtn ? this.saveGridBtn.textContent : "";
    if (this.saveGridBtn) { this.saveGridBtn.textContent = "Saving\u2026"; this.saveGridBtn.disabled = true; }
    try {
      const res = await fetch(apiPath("/fantastic_loras/save_grid"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cells: this.cells, global: this.globalLines,
          comparisons: this.comparisons, pinned: true,
        }),
      });
      if (!res.ok) {
        let msg = "Could not save grid.";
        try { msg = (await res.json()).error || msg; } catch (_) {}
        if (typeof window !== "undefined" && window.alert) window.alert("Save Grid: " + msg);
        return;
      }
      const data = await res.json();
      this.runId = data.run_id || "";
      this.pinned = !!data.pinned;
      if (Array.isArray(data.cells) && data.cells.length) {
        // repoint cells at the durable archive copies
        this.cells = data.cells;
        this.model = buildModel(this.cells);
      }
    } catch (err) {
      console.error("[FantasticGridViewer] saveGrid failed", err);
    } finally {
      if (this.saveGridBtn) { this.saveGridBtn.textContent = prev; this.saveGridBtn.disabled = false; }
      this._persistState();
      this._updateToolbar();
    }
  }

  async setPinned(pinned) {
    if (!this.runId) return;
    try {
      const res = await fetch(apiPath(`/fantastic_loras/run/${this.runId}/pin`), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: !!pinned }),
      });
      if (res.ok) this.pinned = !!(await res.json()).pinned;
    } catch (_) {}
    this._persistState();
    this._updateToolbar();
  }

  async deleteCurrentGrid() {
    if (!this.runId) return;
    if (typeof window !== "undefined" && window.confirm &&
        !window.confirm("Delete this saved grid from disk? This can't be undone.")) return;
    try { await fetch(apiPath(`/fantastic_loras/run/${this.runId}`), { method: "DELETE" }); } catch (_) {}
    // grid stays on screen, but it's now unsaved again (Save Grid reappears)
    this.runId = "";
    this.pinned = false;
    this._persistState();
    this._updateToolbar();
  }

  // ---- manage pinned / saved grids (cleanup) ----
  async openManageGrids() {
    const o = this.overlay;
    o.innerHTML = ""; o.style.display = "block"; o.style.background = "rgba(3,14,15,.85)";
    const panel = el("div",
      "position:absolute;inset:24px;background:" + BAR_BG + ";border:1px solid " + BORDER + ";" +
      "border-radius:8px;display:flex;flex-direction:column;overflow:hidden;");
    const head = el("div",
      "flex:none;display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid " + BORDER + ";");
    head.appendChild(el("b", "color:" + ACCENT + ";", { textContent: "Manage saved grids" }));
    const delBtn = el("button",
      "margin-left:auto;background:#3a1414;color:#ffb4b4;border:1px solid #5a2a2a;border-radius:5px;" +
      "padding:3px 10px;cursor:pointer;", { textContent: "Delete selected" });
    const x = el("button",
      "background:#14403f;color:" + TEXT_COL + ";border:1px solid " + BORDER + ";" +
      "border-radius:5px;padding:3px 10px;cursor:pointer;", { textContent: "Close" });
    x.onclick = () => { o.style.display = "none"; o.innerHTML = ""; };
    head.appendChild(delBtn); head.appendChild(x);
    const body = el("div", "flex:1 1 auto;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:14px;");
    body.appendChild(el("div", "opacity:.7;", { textContent: "Loading\u2026" }));
    panel.appendChild(head); panel.appendChild(body);
    o.appendChild(panel);
    o.onclick = (e) => { if (e.target === o) { o.style.display = "none"; o.innerHTML = ""; } };

    let runs = [];
    try { runs = (await (await fetch(apiPath("/fantastic_loras/runs"))).json()).runs || []; } catch (_) {}

    const checks = new Map();   // run_id -> checkbox
    const section = (title, sub, list) => {
      const wrap = el("div", "display:flex;flex-direction:column;gap:6px;");
      wrap.appendChild(el("div", "font-weight:600;color:" + ACCENT + ";",
        { textContent: `${title} (${list.length})` }));
      if (sub) wrap.appendChild(el("div", "font-size:11px;opacity:.7;margin-top:-2px;", { textContent: sub }));
      if (!list.length) {
        wrap.appendChild(el("div", "font-size:12px;opacity:.6;padding:2px 0;", { textContent: "None." }));
      }
      for (const r of list) {
        const row = el("label",
          "display:flex;align-items:center;gap:9px;padding:6px 8px;border:1px solid " + BORDER + ";" +
          "border-radius:6px;background:#0e2b2e;cursor:pointer;");
        const cb = el("input", "cursor:pointer;", { type: "checkbox" });
        checks.set(r.run_id, cb);
        const lab = el("div", "flex:1 1 auto;min-width:0;");
        lab.appendChild(el("div", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
          { textContent: (r.pinned ? "\uD83D\uDCCC " : "") + (r.name || "grid") }));
        lab.appendChild(el("div", "font-size:11px;opacity:.7;",
          { textContent: `${r.created_str || ""}  \u00b7  ${r.cell_count} cells  \u00b7  ${r.comparison_count} saved` }));
        row.appendChild(cb); row.appendChild(lab);
        wrap.appendChild(row);
      }
      return wrap;
    };

    body.innerHTML = "";
    const pinned = runs.filter((r) => r.pinned);
    const auto = runs.filter((r) => !r.pinned);
    body.appendChild(section("Pinned grids", "Kept until you delete them — not affected by cleanup rules.", pinned));
    body.appendChild(section("Auto-saved grids", "Managed automatically by the cleanup rules above.", auto));

    delBtn.onclick = async () => {
      const ids = [...checks.entries()].filter(([, cb]) => cb.checked).map(([id]) => id);
      if (!ids.length) return;
      if (typeof window !== "undefined" && window.confirm &&
          !window.confirm(`Delete ${ids.length} saved grid${ids.length > 1 ? "s" : ""}? This can't be undone.`)) return;
      for (const id of ids) {
        try { await fetch(apiPath(`/fantastic_loras/run/${id}`), { method: "DELETE" }); } catch (_) {}
        if (this.runId === id) { this.runId = ""; this.pinned = false; }
      }
      this._updateToolbar();
      this.openManageGrids();   // refresh
    };
  }
}

// ---------------------------------------------------------------------------
// Register the extension
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "FantasticLoras.GridViewer",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== VIEWER_NODE_NAME) return;

    nodeType.color = NODE_COLOR;
    nodeType.bgcolor = NODE_BGCOLOR;

    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      origCreated?.apply(this, arguments);
      const viewer = new GridViewer(this);
      this.__flViewer = viewer;
      this.addDOMWidget(VIEWER_NODE_NAME, "fl_grid", viewer.root, {
        serialize: false,
        hideOnZoom: false,
        getValue: () => "",
        setValue: () => {},
      });

      // Hide the fl_archive config widget and bind it to the viewer; the Archive
      // settings UI reads/writes this widget's JSON value (Python reads it too).
      const aw = (this.widgets || []).find((w) => w && w.name === "fl_archive");
      if (aw) {
        aw.computeSize = () => [0, -4];
        aw.type = "fl_hidden";
        aw.hidden = true;
        viewer.archiveWidget = aw;
        const hadSaved = !!(aw.value && String(aw.value).trim());
        try {
          if (hadSaved) viewer.archiveCfg = { ...viewer.archiveCfg, ...JSON.parse(aw.value) };
        } catch (_) {}
        viewer._syncArchiveWidget();
        // Brand-new node (no archive config saved in the workflow): start from the
        // global defaults. A workflow's own saved config always wins over these.
        if (!hadSaved) viewer._loadArchiveDefaults();
      }

      // Hide the fl_grid_ref state widget — its serialized value is how the grid
      // (and its comparisons/favourites) survive a reload or tab switch.
      const sw = (this.widgets || []).find((w) => w && w.name === "fl_grid_ref");
      if (sw) {
        sw.computeSize = () => [0, -4];
        sw.type = "fl_hidden";
        sw.hidden = true;
        sw.serializeValue = () => sw.value;   // ensure it serializes
        viewer.stateWidget = sw;
      }
      viewer._updateToolbar();   // reflect auto-save status / empty state

      this.size = [1001, 886];   // +40% over the previous 715x633 default
      this.setDirtyCanvas(true, true);
    };

    const origExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      origExecuted?.apply(this, arguments);
      try {
        const v = this.__flViewer;
        if (!v) return;
        const runId = Array.isArray(message?.fl_run_id) ? message.fl_run_id[0] : (message?.fl_run_id || "");
        v.setData(message?.fl_cells || [], message?.fl_global || [], runId || "");
        v.comparisons = [];          // a real run is a clean slate
        v.pinned = false;            // auto-saved runs start unpinned
        v._persistState();           // record this run so a reload restores it
        v._updateToolbar();
      } catch (err) {
        console.error("[FantasticGridViewer] render failed", err);
      }
    };

    // Legacy fallback: also mirror state into o.fl_grid. Primary persistence is
    // the fl_grid_ref widget value (set via _persistState), which reliably
    // survives reloads; this keeps older saved workflows loadable too.
    const origSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (o) {
      origSerialize?.apply(this, arguments);
      try {
        const v = this.__flViewer;
        if (v && Array.isArray(v.cells) && v.cells.length) {
          o.fl_grid = {
            cells: v.cells,
            global: v.globalLines || [],
            runId: v.runId || "",
            comparisons: v.runId ? [] : v.comparisons,
            favorites: v.runId ? [] : [...v.favorites],
            pinned: v.pinned,
          };
        }
      } catch (_) {}
    };

    const origConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (o) {
      origConfigure?.apply(this, arguments);
      const apply = () => {
        const v = this.__flViewer;
        if (!v) return false;
        // Prefer the state widget (reliable), fall back to legacy o.fl_grid.
        let g = null;
        try { if (v.stateWidget && v.stateWidget.value) g = JSON.parse(v.stateWidget.value); } catch (_) {}
        if ((!g || !Array.isArray(g.cells)) && o && o.fl_grid && Array.isArray(o.fl_grid.cells)) g = o.fl_grid;
        if (g && Array.isArray(g.cells)) { v.restoreState(g); return true; }
        return false;
      };
      try {
        if (!apply()) {
          // viewer or widget value not ready yet — retry on the next tick
          setTimeout(() => { try { apply(); } catch (_) {} }, 0);
        }
      } catch (_) {}
    };

    const origResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      size[0] = Math.max(420, size[0]);
      size[1] = Math.max(320, size[1]);
      origResize?.apply(this, arguments);
    };
  },
});

export { GridViewer, buildModel, parseMeta };
