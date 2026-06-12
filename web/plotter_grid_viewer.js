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

  setData(cells, globalLines) {
    this.cells = cells || [];
    this.globalLines = globalLines || [];
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
    this.toolbar.appendChild(this.exportFavBtn);
    this.toolbar.appendChild(this.favMetaWrap);
    this.toolbar.appendChild(this.resetBtn);
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
  openZoom(c, fromEl) {
    const o = this.overlay;
    o.innerHTML = "";
    o.style.display = "block";
    o.style.background = "rgba(3,14,15,.86)";

    const rootRect = this.root.getBoundingClientRect();
    const r = fromEl.getBoundingClientRect();
    const ar = this.aspect || 1;

    const pad = 22, capH = 46;
    const availW = Math.max(80, rootRect.width - pad * 2);
    const availH = Math.max(80, rootRect.height - pad * 2 - capH);
    let imgW = availW, imgH = imgW / ar;
    if (imgH > availH) { imgH = availH; imgW = imgH * ar; }
    const panelW = imgW;
    const panelH = imgH + capH;
    const targetLeft = (rootRect.width - panelW) / 2;
    const targetTop = (rootRect.height - panelH) / 2;

    const panel = el("div",
      "position:absolute;display:flex;flex-direction:column;background:" + BAR_BG + ";" +
      "border:1px solid " + BORDER + ";border-radius:8px;overflow:hidden;box-sizing:border-box;" +
      "transition:all .22s cubic-bezier(.2,.7,.3,1);");
    panel.style.left = (r.left - rootRect.left) + "px";
    panel.style.top = (r.top - rootRect.top) + "px";
    panel.style.width = r.width + "px";
    panel.style.height = r.height + "px";
    panel.style.opacity = ".5";

    const img = el("img",
      "flex:1 1 auto;min-height:0;width:100%;object-fit:contain;display:block;background:#06181a;",
      { src: viewURL(c), draggable: false });

    // caption bar: metadata on the left, save controls on the right
    const cap = el("div",
      "flex:none;height:" + capH + "px;display:flex;align-items:center;gap:10px;padding:0 10px;" +
      "font-size:12px;line-height:1.4;");
    const metaSpan = el("div",
      "flex:1 1 auto;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;");
    metaSpan.innerHTML = this._metaHTML(c);
    cap.appendChild(metaSpan);

    const cbLabel = el("label",
      "display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap;font-size:11px;opacity:.9;flex:none;");
    const cb = el("input", "cursor:pointer;", { type: "checkbox", checked: true });
    cbLabel.appendChild(cb);
    cbLabel.appendChild(el("span", "", { textContent: "incl. metadata bar" }));
    cbLabel.onclick = (e) => e.stopPropagation();

    const saveBtn = el("button",
      "flex:none;background:#14403f;color:" + TEXT_COL + ";border:1px solid " + BORDER + ";" +
      "border-radius:5px;padding:3px 11px;cursor:pointer;font-size:12px;white-space:nowrap;",
      { textContent: "\u2913 Save", title: "Download this image" });
    saveBtn.onmouseenter = () => (saveBtn.style.background = "#1c5450");
    saveBtn.onmouseleave = () => (saveBtn.style.background = "#14403f");
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

    cap.appendChild(cbLabel);
    cap.appendChild(saveBtn);
    panel.appendChild(img);
    panel.appendChild(cap);
    o.appendChild(panel);

    panel.onclick = (e) => e.stopPropagation();
    const close = () => {
      panel.style.left = (r.left - rootRect.left) + "px";
      panel.style.top = (r.top - rootRect.top) + "px";
      panel.style.width = r.width + "px";
      panel.style.height = r.height + "px";
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

    const saveBtn = el("button",
      "margin-left:auto;background:#14403f;color:" + TEXT_COL + ";border:1px solid " + BORDER + ";" +
      "border-radius:5px;padding:2px 10px;cursor:pointer;",
      { textContent: "\u2913 Save comparison", title: "Download these images as one grid with metadata" });
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
      this.size = [1001, 886];   // +40% over the previous 715x633 default
      this.setDirtyCanvas(true, true);
    };

    const origExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      origExecuted?.apply(this, arguments);
      try {
        this.__flViewer?.setData(message?.fl_cells || [], message?.fl_global || []);
      } catch (err) {
        console.error("[FantasticGridViewer] render failed", err);
      }
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
