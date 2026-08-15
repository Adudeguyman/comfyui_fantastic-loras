// Fantastic Lora Loader — frontend UI
// ------------------------------------
// Handles the loader and plotter nodes:
//   FantasticLoraLoaderMulti     — lora stack + dynamic extra MODEL paths
//   FantasticLoraPlotter         — same UI, sweep stage
//
// The loader starts with zero extra model paths (looks like a plain single-
// model loader) and reveals additional MODEL paths on demand via the ➕ bar.
// NEW in this version:
//   • Custom lora chooser DOM panel replaces LiteGraph.ContextMenu, giving
//     full control over per-item interactions.
//   • Each lora in the chooser has a ☆ / ★ star button.  Clicking it toggles
//     the lora as a favourite without closing the panel.  Favourites are
//     persisted in localStorage and sorted to the top of the list (within the
//     folder-filtered set), separated from non-favourites by a thin rule.
//   • A live search/filter bar narrows the visible list as you type.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const MULTI_NODE_NAME = "FantasticLoraLoaderMulti";
const PLOT_NODE_NAME  = "FantasticLoraPlotter";
const SAVER_NODE_NAME = "FantasticPlotterImageSaver";
const GLOBAL_NODE_NAME = "FantasticPlotterGlobalLora";
const VIEWER_NODE_NAME = "FantasticPlotterGridViewer";
const ALL_NODE_NAMES  = [MULTI_NODE_NAME, PLOT_NODE_NAME];
// Every node in the pack that the theme picker recolours.
const SV_THEMED_NODES = new Set([MULTI_NODE_NAME, PLOT_NODE_NAME, SAVER_NODE_NAME, GLOBAL_NODE_NAME, VIEWER_NODE_NAME, "FantasticAnySelector", "FantasticSeeds"]);

const DATA_WIDGET          = "lora_data";
const NODE_COLOR           = "#0f848a";
const NODE_BGCOLOR         = "#0a6166";
const DEFAULT_WIDTH        = 560;
const MAX_EXTRA_MODELS     = 4;
const PROP_ENABLED_FOLDERS = "Enabled Lora Folders";
const ROOT_LABEL           = "(root)";
const PREFS_CACHE_KEY      = "fll_prefs_cache";  // mirrors the server copy

// ===========================================================================
// User prefs — favourites, theme and display toggles, stored server side at
// ComfyUI/user/fantastic-loras/prefs.json so they follow the install rather
// than the browser profile. localStorage is only a first-paint cache: reads
// are synchronous off that, writes go to both.
// ===========================================================================

const PREFS_DEFAULT = { favoriteLoras: [], favoriteFolders: [], favoritePresets: [], theme: "teal", showExt: false, collapsedFolders: [] };
let FLL_PREFS = (() => {
  try { return Object.assign({}, PREFS_DEFAULT, JSON.parse(localStorage.getItem(PREFS_CACHE_KEY) || "{}")); }
  catch (_) { return Object.assign({}, PREFS_DEFAULT); }
})();
let prefsLoaded = false;

function cachePrefs() {
  try { localStorage.setItem(PREFS_CACHE_KEY, JSON.stringify(FLL_PREFS)); } catch (_) {}
}

async function loadPrefs() {
  if (prefsLoaded) return FLL_PREFS;
  prefsLoaded = true;
  try {
    const r = await api.fetchApi("/fantastic_loras/prefs");
    const d = await r.json();
    if (d && d.prefs) { FLL_PREFS = Object.assign({}, PREFS_DEFAULT, d.prefs); cachePrefs(); repaintSlotNodes(); }
  } catch (_) {}
  return FLL_PREFS;
}

let prefsSaveTimer = null;
function savePrefs(patch) {
  Object.assign(FLL_PREFS, patch);
  cachePrefs();
  clearTimeout(prefsSaveTimer);
  prefsSaveTimer = setTimeout(() => {
    api.fetchApi("/fantastic_loras/prefs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefs: FLL_PREFS }),
    }).catch(() => {});
  }, 250);
}

function repaintSlotNodes() {
  try {
    for (const n of (app.graph?._nodes || [])) {
      if (n.__lflView === "slots") n.__lflRender?.();
      n.__asRender?.();          // Any Selector panels show filenames too
      n.__sdRender?.();          // ...and the seed panel
    }
  } catch (_) {}
}

function loadFavorites() { return new Set(FLL_PREFS.favoriteLoras || []); }
function saveFavorites(set) { savePrefs({ favoriteLoras: [...set] }); }

// ===========================================================================
// Lora list + folder helpers
// ===========================================================================

let loraFilesCache = null;

async function getLoraFiles(forceRefresh = false) {
  if (loraFilesCache == null || forceRefresh) {
    try {
      const res  = await api.fetchApi("/lora_folder_loader/loras");
      const json = await res.json();
      loraFilesCache = (json || []).map(e => typeof e === "string" ? e : e?.name).filter(Boolean);
    } catch (err) {
      console.warn("[FantasticLoraLoader] Failed to fetch lora list", err);
      loraFilesCache = loraFilesCache || [];
    }
  }
  return loraFilesCache;
}

function folderOf(file) {
  const n = String(file).replaceAll("\\", "/");
  const i = n.lastIndexOf("/");
  return i === -1 ? ROOT_LABEL : n.slice(0, i);
}

function baseName(file) {
  const n = String(file).replaceAll("\\", "/");
  return n.slice(n.lastIndexOf("/") + 1);
}

function collectUnits(files) {
  const m = new Map();
  for (const f of files) { const d = folderOf(f); m.set(d, (m.get(d) || 0) + 1); }
  return m;
}

function normPath(p) { return String(p).replaceAll("\\", "/").replace(/\/+$/, ""); }

// ===========================================================================
// Folder filter state
// ===========================================================================

function getEffectiveEnabledSet(node, unitPaths) {
  const v = node.properties?.[PROP_ENABLED_FOLDERS];
  if (v == null) return null;
  let list = null, legacy = false;
  if (Array.isArray(v))                   { list = v; legacy = true; }
  else if (typeof v === "string")         { list = v.split(",").map(s=>s.trim()).filter(Boolean); legacy = true; }
  else if (v && Array.isArray(v.folders)) { list = v.folders; }
  else return null;
  const entries = list.map(normPath);
  const set = new Set();
  if (legacy) {
    for (const u of unitPaths)
      for (const p of entries)
        if (u === p || u.startsWith(p + "/")) { set.add(u); break; }
  } else {
    const us = new Set(unitPaths);
    for (const p of entries) if (us.has(p)) set.add(p);
  }
  return set;
}

function setEnabledFolders(node, setOrNull) {
  node.properties = node.properties || {};
  node.properties[PROP_ENABLED_FOLDERS] =
    setOrNull == null ? null : { version: 2, folders: [...setOrNull].sort() };
  node.__plffUpdateFolderBtn?.();
  syncData(node);   // refresh enabledFolders pool used by auto-roll lines
  node.setDirtyCanvas(true, true);
}

function folderButtonSuffix(node) {
  const v = node.properties?.[PROP_ENABLED_FOLDERS];
  if (v == null) return "All";
  if (!loraFilesCache) { getLoraFiles().then(() => node.__plffUpdateFolderBtn?.()); return "…"; }
  const eff = getEffectiveEnabledSet(node, collectUnits(loraFilesCache).keys());
  if (eff == null) return "All";
  if (eff.size === 0) return "None!";
  return `${eff.size}/${collectUnits(loraFilesCache).size}`;
}

// ===========================================================================
// Folder tree
// ===========================================================================

function buildTree(units) {
  const root = { path: "", name: "", children: new Map(), unitCount: 0 };
  for (const [path, count] of units) {
    if (path === ROOT_LABEL) { root.children.set(ROOT_LABEL, { path: ROOT_LABEL, name: ROOT_LABEL, children: new Map(), unitCount: count }); continue; }
    let cur = root, acc = "";
    for (const part of path.split("/")) {
      acc = acc ? `${acc}/${part}` : part;
      if (!cur.children.has(part)) cur.children.set(part, { path: acc, name: part, children: new Map(), unitCount: 0 });
      cur = cur.children.get(part);
    }
    cur.unitCount = count;
  }
  return root;
}

function subtreeUnits(n, out = []) { if (n.unitCount > 0) out.push(n.path); for (const c of n.children.values()) subtreeUnits(c, out); return out; }
function subtreeFileTotal(n) { let t = n.unitCount; for (const c of n.children.values()) t += subtreeFileTotal(c); return t; }
function sortedChildren(n) {
  return [...n.children.values()].sort((a, b) => {
    if (a.path === ROOT_LABEL) return -1; if (b.path === ROOT_LABEL) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

// ===========================================================================
// Shared styles (folder filter + lora chooser + model bar)
// ===========================================================================

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    /* ── slot-view strength field: native spinners steal width and clip the
         value, so hide them and use the full box for the number ── */
    input.lfl-str::-webkit-outer-spin-button,
    input.lfl-str::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
    input.lfl-str{-moz-appearance:textfield;appearance:textfield;}
    /* ── shared chrome ── */
    .lfl-panel,.lfl-chooser{position:fixed;display:flex;flex-direction:column;max-height:70vh;
      background:var(--comfy-menu-bg,#202020);color:var(--fg-color,#ddd);
      border:1px solid var(--border-color,#4e4e4e);border-radius:6px;
      box-shadow:0 6px 20px rgba(0,0,0,.55);font:12px Arial,sans-serif;user-select:none;}
    .lfl-panel{z-index:10010;min-width:280px;max-width:440px;}
    .lfl-chooser{z-index:10012;width:420px;max-width:92vw;}
    .lfl-header,.lfl-chooser-header{display:flex;align-items:center;padding:6px 8px;
      border-bottom:1px solid var(--border-color,#444);font-weight:600;}
    .lfl-header .lfl-title,.lfl-chooser-title{flex:1;}
    .lfl-close{cursor:pointer;opacity:.7;padding:0 4px;}.lfl-close:hover{opacity:1;}
    /* ── folder filter panel ── */
    .lfl-actions{display:flex;gap:6px;padding:6px 8px;border-bottom:1px solid var(--border-color,#444);}
    .lfl-btn{cursor:pointer;padding:2px 10px;border-radius:4px;border:1px solid var(--border-color,#555);
      background:var(--comfy-input-bg,#2a2a2a);color:inherit;font:inherit;}.lfl-btn:hover{filter:brightness(1.3);}
    .lfl-tree{overflow:auto;padding:4px 8px 8px 8px;}
    .lfl-row{display:flex;align-items:center;gap:5px;padding:1px 2px;border-radius:3px;white-space:nowrap;}
    .lfl-row:hover{background:rgba(255,255,255,.07);}
    .lfl-caret{width:13px;text-align:center;cursor:pointer;opacity:.75;flex:none;}
    .lfl-caret.lfl-none{cursor:default;opacity:0;}
    .lfl-row input[type=checkbox]{margin:0;flex:none;cursor:pointer;}
    .lfl-name{flex:1;overflow:hidden;text-overflow:ellipsis;cursor:pointer;}
    .lfl-name.lfl-virtual{font-style:italic;opacity:.85;}
    .lfl-count{opacity:.5;flex:none;margin-left:4px;}
    .lfl-children{margin-left:13px;padding-left:5px;border-left:1px dotted rgba(255,255,255,.15);}
    .lfl-empty{padding:10px;opacity:.6;}
    /* ── lora chooser panel ── */
    .lfl-chooser-search{padding:5px 8px;border-bottom:1px solid var(--border-color,#333);}
    .lfl-chooser-searchinput{width:100%;box-sizing:border-box;padding:4px 7px;
      background:var(--comfy-input-bg,#2a2a2a);color:inherit;
      border:1px solid var(--border-color,#555);border-radius:3px;font:inherit;outline:none;}
    .lfl-chooser-searchinput:focus{border-color:#0f848a;}
    .lfl-chooser-list{overflow-y:auto;flex:1;padding:3px 0;}
    .lfl-chooser-item{display:flex;align-items:center;padding:4px 8px;cursor:pointer;gap:6px;
      border-radius:3px;margin:0 3px;}
    .lfl-chooser-item:hover{background:rgba(255,255,255,.08);}
    .lfl-star{flex:none;font-size:16px;width:22px;text-align:center;cursor:pointer;
      line-height:1;transition:transform .12s,opacity .12s;}
    .lfl-star.off{opacity:.25;}.lfl-star.off:hover{opacity:.65;}
    .lfl-star.on{color:#f5c518;opacity:1;}.lfl-star.on:hover{transform:scale(1.25);}
    .lfl-item-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .lfl-item-dir{opacity:.45;}
    .lfl-chooser-sep{margin:5px 10px;border:none;border-top:1px solid var(--border-color,#3a3a3a);}
    .lfl-chooser-empty{padding:10px 12px;opacity:.6;}
    /* ── custom tooltip ── */
    .lfl-tip{position:fixed;z-index:10050;pointer-events:none;max-width:240px;
      background:#111;color:#eee;border:1px solid #0f848a;border-radius:5px;
      padding:5px 8px;font:11px/1.35 Arial,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.5);}
    .lfl-tip b{color:#27d3dc;}
  `;
  document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// Custom hover tooltip (instant, themed — nicer than native title delay)
// ---------------------------------------------------------------------------

let tipEl = null;
function ensureTip() {
  if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "lfl-tip"; tipEl.style.display = "none"; document.body.appendChild(tipEl); }
  return tipEl;
}
function positionTip(ev) {
  if (!tipEl) return;
  const pad = 14;
  const r = tipEl.getBoundingClientRect();
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + r.width  > window.innerWidth  - 8) x = ev.clientX - r.width  - pad;
  if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
  tipEl.style.left = `${Math.max(4, x)}px`;
  tipEl.style.top  = `${Math.max(4, y)}px`;
}
function attachTip(el, html) {
  el.addEventListener("mouseenter", ev => { const t = ensureTip(); t.innerHTML = html; t.style.display = "block"; positionTip(ev); });
  el.addEventListener("mousemove", positionTip);
  el.addEventListener("mouseleave", () => { if (tipEl) tipEl.style.display = "none"; });
}
function hideTip() { if (tipEl) tipEl.style.display = "none"; }

// ===========================================================================
// Folder filter panel
// ===========================================================================

let openPanel = null;
function closeFolderPanel() { if (openPanel) { openPanel.dispose(); openPanel = null; } }

// Parameterized folder-tree panel. opts: { key, title, allLabel, poolFilter
// (Set of allowed unit paths, or null = every folder), readSet(allUnits)->Set|null,
// writeSet(setOrNull, allUnits) }.
async function showFolderPanelCore(node, event, opts) {
  if (openPanel?.key === opts.key) { closeFolderPanel(); return; }
  closeFolderPanel();
  injectStyles();
  const files = await getLoraFiles(true);
  let units = collectUnits(files);
  if (opts.poolFilter) units = new Map([...units].filter(([p]) => opts.poolFilter.has(p)));
  const allUnits = [...units.keys()];
  const tree = buildTree(units);
  node.__plffUpdateFolderBtn?.();

  const panel = document.createElement("div"); panel.className = "lfl-panel";
  const header = document.createElement("div"); header.className = "lfl-header";
  header.innerHTML = `<span class="lfl-title">${opts.title}</span>`;
  const close = document.createElement("span"); close.className = "lfl-close"; close.textContent = "✕";
  close.addEventListener("click", closeFolderPanel); header.appendChild(close); panel.appendChild(header);

  const actions = document.createElement("div"); actions.className = "lfl-actions";
  const mkBtn = (label, fn) => { const b = document.createElement("button"); b.className = "lfl-btn"; b.textContent = label; b.addEventListener("click", fn); actions.appendChild(b); };
  mkBtn(opts.allLabel || "All", () => { opts.writeSet(null, allUnits); renderTree(); });
  mkBtn("None", () => { opts.writeSet(new Set(), allUnits); renderTree(); });
  panel.appendChild(actions);

  const treeEl = document.createElement("div"); treeEl.className = "lfl-tree"; panel.appendChild(treeEl);
  const expanded = new Set();
  if (allUnits.length <= 30) { const ex = n => { for (const c of n.children.values()) { expanded.add(c.path); ex(c); } }; ex(tree); }
  else { for (const c of tree.children.values()) expanded.add(c.path); }

  const effSet = () => { const e = opts.readSet(allUnits); return e == null ? new Set(allUnits) : e; };
  const toggleUnits = paths => {
    const set = effSet(); const allOn = paths.every(u => set.has(u));
    for (const u of paths) allOn ? set.delete(u) : set.add(u);
    opts.writeSet(set, allUnits); renderTree();
  };
  const makeRow = ({ caret, caretPath, label, count, virtual, checked, indeterminate, onToggle, title }) => {
    const row = document.createElement("div"); row.className = "lfl-row";
    const caretEl = document.createElement("span"); caretEl.className = "lfl-caret" + (caret ? "" : " lfl-none");
    caretEl.textContent = caret ? (expanded.has(caretPath) ? "▾" : "▸") : "▸";
    if (caret) caretEl.addEventListener("click", e => { e.stopPropagation(); expanded.has(caretPath) ? expanded.delete(caretPath) : expanded.add(caretPath); renderTree(); });
    row.appendChild(caretEl);
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = checked; cb.indeterminate = !!indeterminate;
    cb.addEventListener("click", e => { e.preventDefault(); onToggle(); }); row.appendChild(cb);
    const name = document.createElement("span"); name.className = "lfl-name" + (virtual ? " lfl-virtual" : "");
    name.textContent = label; name.title = title ?? label; name.addEventListener("click", onToggle); row.appendChild(name);
    const cnt = document.createElement("span"); cnt.className = "lfl-count"; cnt.textContent = `(${count})`; row.appendChild(cnt);
    return row;
  };
  const renderNode = (tn, container, set) => {
    const hasChildren = tn.children.size > 0, unitsBelow = subtreeUnits(tn), onCount = unitsBelow.filter(u => set.has(u)).length;
    container.appendChild(makeRow({ caret: hasChildren, caretPath: tn.path, label: tn.name, title: tn.path,
      count: subtreeFileTotal(tn), checked: onCount === unitsBelow.length && unitsBelow.length > 0,
      indeterminate: !!(onCount > 0 && onCount < unitsBelow.length), onToggle: () => toggleUnits(unitsBelow) }));
    if (hasChildren && expanded.has(tn.path)) {
      const kids = document.createElement("div"); kids.className = "lfl-children";
      if (tn.unitCount > 0) kids.appendChild(makeRow({ caret: false, label: "(files here)", title: `${tn.path} — loras directly in this folder`,
        virtual: true, count: tn.unitCount, checked: set.has(tn.path), indeterminate: false, onToggle: () => toggleUnits([tn.path]) }));
      for (const child of sortedChildren(tn)) renderNode(child, kids, set);
      container.appendChild(kids);
    }
  };
  const renderTree = () => {
    treeEl.textContent = "";
    if (!allUnits.length) { const e = document.createElement("div"); e.className = "lfl-empty"; e.textContent = opts.emptyText || "No loras found in models/loras."; treeEl.appendChild(e); return; }
    const set = effSet(); for (const child of sortedChildren(tree)) renderNode(child, treeEl, set);
  };
  renderTree();

  document.body.appendChild(panel);
  const x = event?.clientX ?? window.innerWidth / 2, y = event?.clientY ?? window.innerHeight / 3;
  const rect = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  panel.style.top  = `${Math.max(8, Math.min(y + 6, window.innerHeight - rect.height - 8))}px`;

  const onPD = e => { if (!panel.contains(e.target)) closeFolderPanel(); };
  const onKD = e => { if (e.key === "Escape") closeFolderPanel(); };
  setTimeout(() => { document.addEventListener("pointerdown", onPD, true); document.addEventListener("keydown", onKD, true); }, 0);
  openPanel = { el: panel, node, key: opts.key, dispose: () => { document.removeEventListener("pointerdown", onPD, true); document.removeEventListener("keydown", onKD, true); panel.remove(); } };
}

// ===========================================================================
// Lora chooser panel  (custom DOM — enables star toggle without closing)
// ===========================================================================

let openChooserPanel = null;
function closeChooserPanel() { if (openChooserPanel) { openChooserPanel.dispose(); openChooserPanel = null; } }

async function showLoraChooser(node, event, onChoose, scopeSet) {
  closeChooserPanel();
  injectStyles();

  const files = await getLoraFiles(true);
  const units = collectUnits(files);
  const enabledSet = getEffectiveEnabledSet(node, units.keys());

  let loras = files.slice();
  if (enabledSet != null) loras = loras.filter(l => enabledSet.has(folderOf(l)));
  if (scopeSet != null) loras = loras.filter(l => scopeSet.has(folderOf(l)));

  if (!loras.length) {
    // Renderer-agnostic notice (works with or without the LiteGraph global).
    const note = document.createElement("div");
    note.textContent = "No loras in enabled folders — adjust the folder filter";
    note.style.cssText = `position:fixed;z-index:10003;background:${SV.panel};border:1px solid ${SV.btnBorder};color:${SV.text};` +
      "border-radius:6px;padding:8px 12px;font:12px Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);max-width:280px;";
    const ex = event && typeof event.clientX === "number" ? event.clientX : (window.innerWidth / 2 - 140);
    const ey = event && typeof event.clientY === "number" ? event.clientY : 120;
    note.style.left = Math.min(ex, window.innerWidth - 300) + "px";
    note.style.top = (ey + 8) + "px";
    document.body.appendChild(note);
    const kill = () => { note.remove(); window.removeEventListener("pointerdown", kill, true); };
    setTimeout(() => window.addEventListener("pointerdown", kill, true), 0);
    setTimeout(kill, 3500);
    return;
  }

  // Live favourites set — mutated in-place as the user clicks stars so
  // re-renders within the same open session are consistent.
  const favs = loadFavorites();

  const panel = document.createElement("div"); panel.className = "lfl-chooser";

  // ── Header ──────────────────────────────────────────────────────────────
  const header = document.createElement("div"); header.className = "lfl-chooser-header";
  const title  = document.createElement("span"); title.className = "lfl-chooser-title";
  title.textContent = "Choose a lora";
  header.appendChild(title);
  const closeBtn = document.createElement("span"); closeBtn.className = "lfl-close"; closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", closeChooserPanel); header.appendChild(closeBtn);
  panel.appendChild(header);

  // ── Search ───────────────────────────────────────────────────────────────
  const searchWrap = document.createElement("div"); searchWrap.className = "lfl-chooser-search";
  const searchInput = document.createElement("input"); searchInput.className = "lfl-chooser-searchinput";
  searchInput.placeholder = "Filter loras…";
  searchInput.addEventListener("pointerdown", e => e.stopPropagation());
  searchWrap.appendChild(searchInput); panel.appendChild(searchWrap);

  // ── List ─────────────────────────────────────────────────────────────────
  const list = document.createElement("div"); list.className = "lfl-chooser-list";
  panel.appendChild(list);

  // Build one item row
  const makeItem = (path) => {
    const item = document.createElement("div"); item.className = "lfl-chooser-item";

    // Star toggle
    const isFav = favs.has(path);
    const star = document.createElement("span");
    star.className = `lfl-star ${isFav ? "on" : "off"}`;
    star.textContent = isFav ? "★" : "☆";
    star.title = isFav ? "Remove from favourites" : "Add to favourites";
    star.addEventListener("click", e => {
      e.stopPropagation();
      const nowFav = favs.has(path);
      nowFav ? favs.delete(path) : favs.add(path);
      saveFavorites(favs);
      renderList(searchInput.value); // re-sort: fav moves to/from top
    });
    item.appendChild(star);

    // Name: dim folder prefix + bright filename
    const nameEl = document.createElement("span"); nameEl.className = "lfl-item-name";
    const dir = folderOf(path);
    if (dir !== ROOT_LABEL) {
      const dirSpan = document.createElement("span"); dirSpan.className = "lfl-item-dir";
      dirSpan.textContent = dir + "/"; nameEl.appendChild(dirSpan);
    }
    const fileSpan = document.createElement("span"); fileSpan.textContent = baseName(path);
    nameEl.appendChild(fileSpan);
    nameEl.title = path;
    item.appendChild(nameEl);

    // Click row → select lora
    item.addEventListener("click", () => {
      onChoose(path);
      node.setDirtyCanvas(true, true);
      closeChooserPanel();
    });

    return item;
  };

  const alph = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });

  const renderList = (filter = "") => {
    list.textContent = "";
    const q = filter.trim().toLowerCase();
    const visible = q ? loras.filter(l => l.toLowerCase().includes(q)) : loras.slice();

    if (!visible.length) {
      const empty = document.createElement("div"); empty.className = "lfl-chooser-empty";
      empty.textContent = "No matches."; list.appendChild(empty); return;
    }

    const favorites   = visible.filter(l =>  favs.has(l)).sort(alph);
    const nonFavorites = visible.filter(l => !favs.has(l)).sort(alph);

    for (const p of favorites)    list.appendChild(makeItem(p));

    if (favorites.length && nonFavorites.length) {
      const sep = document.createElement("hr"); sep.className = "lfl-chooser-sep";
      list.appendChild(sep);
    }

    for (const p of nonFavorites) list.appendChild(makeItem(p));
  };

  renderList();
  searchInput.addEventListener("input", () => renderList(searchInput.value));

  // ── Position ─────────────────────────────────────────────────────────────
  document.body.appendChild(panel);
  const x = event?.clientX ?? window.innerWidth / 2;
  const y = event?.clientY ?? window.innerHeight / 3;
  const rect = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(x, window.innerWidth  - rect.width  - 8))}px`;
  panel.style.top  = `${Math.max(8, Math.min(y + 6, window.innerHeight - rect.height - 8))}px`;

  // Auto-focus search so the user can start typing immediately
  setTimeout(() => searchInput.focus(), 30);

  const onPD = e => { if (!panel.contains(e.target)) closeChooserPanel(); };
  const onKD = e => { if (e.key === "Escape") closeChooserPanel(); };
  setTimeout(() => {
    document.addEventListener("pointerdown", onPD, true);
    document.addEventListener("keydown",    onKD, true);
  }, 0);

  openChooserPanel = {
    dispose: () => {
      document.removeEventListener("pointerdown", onPD, true);
      document.removeEventListener("keydown",    onKD, true);
      panel.remove();
    },
  };
}

// ===========================================================================
// Lora stack state helpers
// ===========================================================================

function getDataWidget(node) { return node.widgets?.find(w => w.name === DATA_WIDGET); }

function hideWidget(node, w) {
  if (!w) return;
  // Canvas (LiteGraph) renderer: zero size + no-op draw.
  w.computeSize = () => [0, -4]; w.type = "lfl_hidden"; w.hidden = true;
  // Vue renderer (Nodes 2.0): visibility comes from widget.options.hidden.
  // Without this the widget still renders (as a generic value input) AND still
  // occupies layout, so clicks land on invisible widgets. Mutate in place —
  // replacing the options object would break anything holding a reference.
  if (!w.options) w.options = {};
  w.options.hidden = true;
  if (w.element) w.element.style.display = "none";
  w._origDraw = w.draw; w.draw = function () {};
}

function clipConnected(node) {
  const inp = (node.inputs || []).find(i => i?.name === "clip");
  return !!(inp && inp.link != null);
}

function effectiveEnabledFoldersArray(node) {
  const v = node.properties?.[PROP_ENABLED_FOLDERS];
  if (v == null) return null;                 // null => all folders
  if (!loraFilesCache) return null;           // can't resolve "all" yet; treat as all
  const eff = getEffectiveEnabledSet(node, collectUnits(loraFilesCache).keys());
  return eff == null ? null : [...eff];
}

function syncData(node) {
  const w = getDataWidget(node);
  if (!w) return;
  // Slot order IS apply order: entries serialize in array order.
  const payload = { loras: node.__loraStack || [], enabledFolders: effectiveEnabledFoldersArray(node) };
  if (node.__isPlotter) {
    payload.plotMode = node.__plotMode === "global" ? "global" : "perline";
    payload.globalStrengths = Array.isArray(node.__globalStrengths) ? node.__globalStrengths : [];
    payload.controlImage = !!node.__controlImage;
  }
  if (node.__isGlobalLora) {
    payload.controlNone = !!node.__ctrlNone;
    payload.controlGlobal = !!node.__ctrlGlobal;
  }
  w.value = JSON.stringify(payload);
}

function loadStackFromData(node) {
  const w = getDataWidget(node);
  let stack = [];
  try {
    const parsed = JSON.parse(w?.value || "{}");
    const entries = Array.isArray(parsed) ? parsed : parsed.loras || [];
    stack = entries.filter(e => e && (e.name || e.lora || e.random)).map(e => {
      const s = e.strength != null ? Number(e.strength) : Number(e.model ?? 1);
      const out = { on: e.on !== false, name: e.name || e.lora || "", model: s, clip: e.clip != null && e.strength == null ? Number(e.clip) : s };
      if (e.targets && typeof e.targets === "object") out.targets = e.targets;
      if (typeof e.gx === "number") out.gx = e.gx;
      if (typeof e.gy === "number") out.gy = e.gy;
      if (e.source) out.source = e.source;
      // Randomizer-line fields (passed through harmlessly by the backend)
      if (e.random) {
        out.random   = true;
        out.locked   = !!e.locked;
        out.autoRoll = !!e.autoRoll;
        out.folders  = Array.isArray(e.folders) ? e.folders : null;
      }
      return out;
    });
  } catch (_) { stack = []; }
  node.__loraStack = stack;
  // Plotter-only fields (harmlessly ignored by the other node types).
  try {
    const parsed = JSON.parse(w?.value || "{}");
    if (parsed && !Array.isArray(parsed)) {
      if (parsed.plotMode === "global" || parsed.plotMode === "perline") node.__plotMode = parsed.plotMode;
      if (Array.isArray(parsed.globalStrengths))
        node.__globalStrengths = parsed.globalStrengths.map(Number).filter(n => !isNaN(n));
      if (typeof parsed.controlImage === "boolean") node.__controlImage = parsed.controlImage;
      if (typeof parsed.controlNone === "boolean") node.__ctrlNone = parsed.controlNone;
      if (typeof parsed.controlGlobal === "boolean") node.__ctrlGlobal = parsed.controlGlobal;
    }
  } catch (_) {}
}

function snapHeight(node) { const [, h] = node.computeSize(); node.size[1] = h; }

// ===========================================================================
// Randomizer lines — helpers
// ===========================================================================

const RAND_EXTRA_WIDTH = 108;  // extra node width while ≥1 randomizer line exists
const MIN_NODE_WIDTH   = 320;

// Widen the node on the 0→n randomizer-line transition, shrink back on n→0.
// Uses a delta (not a stored width) so manual user resizes are respected.
function adjustRandWidth(node) {
  // Slot view has a fixed two-column layout — its width must not jump around
  // when randomizer lines come and go (that bump is for the classic row list).
  if (node.__lflView === "slots") { node.__lflLastRandCount = (node.__loraStack || []).filter(e => e.random).length; return; }
  const c = (node.__loraStack || []).filter(e => e.random).length;
  const last = node.__lflLastRandCount ?? 0;
  if (last === 0 && c > 0)      node.size[0] = node.size[0] + RAND_EXTRA_WIDTH;
  else if (last > 0 && c === 0) node.size[0] = Math.max(MIN_NODE_WIDTH, node.size[0] - RAND_EXTRA_WIDTH);
  node.__lflLastRandCount = c;
}

// The folders a randomizer line may pull from: the node's enabled folders,
// optionally narrowed by the line's own entry.folders selection.
async function nodeEnabledFolders(node) {
  const files = await getLoraFiles(true);
  const units = collectUnits(files);
  const eff = getEffectiveEnabledSet(node, units.keys());
  const list = (eff == null ? [...units.keys()] : [...eff]).sort((a, b) => {
    if (a === ROOT_LABEL) return -1; if (b === ROOT_LABEL) return 1;
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });
  return { files, units, folders: list };
}

async function pickRandomLora(node, entry) {
  const { files, folders } = await nodeEnabledFolders(node);
  let allowed = new Set(folders);
  if (Array.isArray(entry.folders)) {
    allowed = new Set(entry.folders.filter(f => allowed.has(f)));
  }
  const pool = files.filter(f => allowed.has(folderOf(f)));
  if (!pool.length) return null;
  // Avoid re-picking the same lora when there's a choice
  if (entry.name && pool.length > 1) {
    const others = pool.filter(f => f !== entry.name);
    return others[Math.floor(Math.random() * others.length)];
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------------------------------------------------------------------------
// Per-line folder selection panel (📂 icon on randomizer rows)
// ---------------------------------------------------------------------------

let openLinePanel = null;
function closeLinePanel() { if (openLinePanel) { openLinePanel.dispose(); openLinePanel = null; } }

async function showLineFolderPanel(node, entry, event) {
  if (openLinePanel?.entry === entry) { closeLinePanel(); return; }
  closeLinePanel();
  injectStyles();

  const { units, folders: available } = await nodeEnabledFolders(node);

  const panel = document.createElement("div"); panel.className = "lfl-panel";

  const header = document.createElement("div"); header.className = "lfl-header";
  header.innerHTML = `<span class="lfl-title">Randomizer folders</span>`;
  const close = document.createElement("span"); close.className = "lfl-close"; close.textContent = "✕";
  close.addEventListener("click", closeLinePanel); header.appendChild(close); panel.appendChild(header);

  const actions = document.createElement("div"); actions.className = "lfl-actions";
  const mkBtn = (label, fn) => {
    const b = document.createElement("button"); b.className = "lfl-btn"; b.textContent = label;
    b.addEventListener("click", fn); actions.appendChild(b);
  };
  const apply = () => { syncData(node); renderList(); node.__lflRender?.(); };
  mkBtn("All enabled", () => { entry.folders = null; apply(); });
  mkBtn("None",        () => { entry.folders = [];   apply(); });
  panel.appendChild(actions);

  const listEl = document.createElement("div"); listEl.className = "lfl-tree";
  panel.appendChild(listEl);

  const isChecked = f => entry.folders == null ? true : entry.folders.includes(f);

  const renderList = () => {
    listEl.textContent = "";
    if (!available.length) {
      const e = document.createElement("div"); e.className = "lfl-empty";
      e.textContent = "No folders enabled — adjust the node's 📁 Folders filter first.";
      listEl.appendChild(e); return;
    }
    for (const f of available) {
      const row = document.createElement("div"); row.className = "lfl-row";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = isChecked(f);
      const toggle = () => {
        if (entry.folders == null) entry.folders = available.slice(); // materialize "all"
        const i = entry.folders.indexOf(f);
        i === -1 ? entry.folders.push(f) : entry.folders.splice(i, 1);
        apply();
      };
      cb.addEventListener("click", e => { e.preventDefault(); toggle(); });
      row.appendChild(cb);
      const name = document.createElement("span"); name.className = "lfl-name";
      name.textContent = f; name.title = f;
      name.addEventListener("click", toggle);
      row.appendChild(name);
      const cnt = document.createElement("span"); cnt.className = "lfl-count";
      cnt.textContent = `(${units.get(f) || 0})`;
      row.appendChild(cnt);
      listEl.appendChild(row);
    }
  };
  renderList();

  document.body.appendChild(panel);
  const x = event?.clientX ?? window.innerWidth / 2, y = event?.clientY ?? window.innerHeight / 3;
  const rect = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(x, window.innerWidth  - rect.width  - 8))}px`;
  panel.style.top  = `${Math.max(8, Math.min(y + 6, window.innerHeight - rect.height - 8))}px`;

  const onPD = e => { if (!panel.contains(e.target)) closeLinePanel(); };
  const onKD = e => { if (e.key === "Escape") closeLinePanel(); };
  setTimeout(() => { document.addEventListener("pointerdown", onPD, true); document.addEventListener("keydown", onKD, true); }, 0);
  openLinePanel = { entry, dispose: () => {
    document.removeEventListener("pointerdown", onPD, true);
    document.removeEventListener("keydown", onKD, true);
    panel.remove();
  } };
}

// ===========================================================================
// Lora row DOM widget (shared between both nodes)
// ===========================================================================

function buildRowDOM(node) {
  injectStyles();
  const root = document.createElement("div");
  root.style.cssText = "display:flex;flex-direction:column;gap:3px;font:12px Arial,sans-serif;color:var(--fg-color,#ddd);width:100%;box-sizing:border-box;padding:2px 0;";

  const numInput = (val, dim, onChange) => {
    const i = document.createElement("input"); i.type = "number"; i.step = "0.05"; i.value = String(val);
    i.style.cssText = "width:54px;flex:none;background:var(--comfy-input-bg,#2a2a2a);color:inherit;border:1px solid var(--border-color,#555);border-radius:3px;font:inherit;text-align:center;padding:1px 3px;" + (dim ? "opacity:.35;" : "");
    i.addEventListener("change", () => onChange(parseFloat(i.value)));
    i.addEventListener("pointerdown", e => e.stopPropagation()); return i;
  };

  const mkIcon = (txt, tip, color, fn) => {
    const b = document.createElement("span"); b.textContent = txt;
    b.style.cssText = "flex:none;cursor:pointer;opacity:.75;min-width:22px;text-align:center;font-size:15px;line-height:1;padding:0 1px;" + (color ? `color:${color};` : "");
    b.addEventListener("mouseenter", () => (b.style.opacity = "1")); b.addEventListener("mouseleave", () => (b.style.opacity = ".75"));
    b.addEventListener("click", () => { hideTip(); fn(); }); b.addEventListener("pointerdown", e => e.stopPropagation());
    if (tip) attachTip(b, tip);
    return b;
  };

  const swap = (i, j) => { const s = node.__loraStack; [s[i], s[j]] = [s[j], s[i]]; };
  const commit = () => { syncData(node); render(); adjustRandWidth(node); snapHeight(node); node.setDirtyCanvas(true, true); };

  const render = () => {
    if (node.__lflView === "slots") { renderSlotView(node, root); return; }
    root.textContent = "";
    const stack = node.__loraStack || [], hasClip = clipConnected(node);
    const globalMode = node.__isPlotter && node.__plotMode === "global";
    if (!stack.length) {
      const empty = document.createElement("div"); empty.textContent = "No loras yet — click ➕ Add Lora.";
      empty.style.cssText = "opacity:.55;padding:4px 2px;"; root.appendChild(empty); return;
    }
    stack.forEach((entry, idx) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:4px;background:rgba(255,255,255,.04);border-radius:4px;padding:2px 5px;";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = entry.on; cb.title = "Enable / disable"; cb.style.flex = "none";
      cb.addEventListener("change", () => { entry.on = cb.checked; commit(); }); cb.addEventListener("pointerdown", e => e.stopPropagation()); row.appendChild(cb);

      // ── Randomizer-only left controls: 🎲 dice + 🔓/🔒 lock + 🔄 auto-roll ──
      if (entry.random) {
        const dice = document.createElement("span");
        dice.textContent = "🎲";
        dice.style.cssText =
          "flex:none;text-align:center;min-width:22px;font-size:15px;line-height:1;padding:0 1px;" +
          (entry.locked ? "opacity:.3;cursor:default;" : "opacity:.85;cursor:pointer;");
        dice.addEventListener("mouseenter", () => { if (!entry.locked) dice.style.opacity = "1"; });
        dice.addEventListener("mouseleave", () => { if (!entry.locked) dice.style.opacity = ".85"; });
        dice.addEventListener("click", async () => {
          if (entry.locked) return;
          hideTip();
          const pick = await pickRandomLora(node, entry);
          if (pick != null) { entry.name = pick; commit(); }
        });
        dice.addEventListener("pointerdown", e => e.stopPropagation());
        attachTip(dice, entry.locked
          ? "<b>Roll</b> — disabled while locked 🔒"
          : "<b>Roll the dice</b><br>Pick a new random lora from this line's folders.");
        row.appendChild(dice);

        row.appendChild(mkIcon(
          entry.locked ? "🔒" : "🔓",
          entry.locked
            ? "<b>Locked</b> — this lora is frozen.<br>Click to unlock and re-enable 🎲 / 🔄."
            : "<b>Unlocked</b> — click to lock this lora<br>so the dice and auto-roll can't change it.",
          null,
          () => {
            entry.locked = !entry.locked;
            // Turning the lock on also disables auto-roll so it can't be
            // accidentally left active on a frozen line.
            if (entry.locked) entry.autoRoll = false;
            commit();
          }
        ));
        // Style the lock icon after it's appended so locked = red pill, unlocked = dim.
        const lockEl = row.lastElementChild;
        if (entry.locked) {
          lockEl.style.cssText += "background:rgba(239,83,80,.22);border:1px solid rgba(239,83,80,.55);border-radius:4px;padding:0 3px;opacity:1;";
        } else {
          lockEl.style.opacity = ".4";
          lockEl.addEventListener("mouseenter", () => lockEl.style.opacity = ".75");
          lockEl.addEventListener("mouseleave", () => lockEl.style.opacity = ".4");
        }

        const ar = document.createElement("span");
        ar.textContent = "🔄";
        const arOn = !!entry.autoRoll && !entry.locked;  // locked => always treated as off
        ar.style.cssText =
          "flex:none;text-align:center;min-width:22px;font-size:15px;line-height:1;padding:0 1px;" +
          (entry.locked ? "opacity:.2;cursor:default;" : arOn ? "opacity:1;cursor:pointer;" : "opacity:.3;cursor:pointer;");
        if (!entry.locked) {
          ar.addEventListener("mouseenter", () => { if (!arOn) ar.style.opacity = ".6"; });
          ar.addEventListener("mouseleave", () => { if (!arOn) ar.style.opacity = ".3"; });
          ar.addEventListener("click", () => { hideTip(); entry.autoRoll = !entry.autoRoll; commit(); });
        }
        ar.addEventListener("pointerdown", e => e.stopPropagation());
        attachTip(ar, entry.locked
          ? "<b>Auto-roll: disabled</b><br>Unlock 🔓 this line to enable auto-roll."
          : arOn
            ? "<b>Auto-roll: ON</b><br>Picks a new random lora on <i>every</i> queued run."
            : "<b>Auto-roll: OFF</b><br>Click to re-randomize this line automatically on every queued run.");
        row.appendChild(ar);
      }

      const nameEl = document.createElement("span");
      nameEl.title = entry.name ? entry.name + "  (click to change)" : "Randomizer line — roll 🎲 or pick folders 📂";
      nameEl.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;" + (entry.on ? "" : "opacity:.45;text-decoration:line-through;");
      if (!entry.name) {
        const ph = document.createElement("span");
        ph.style.cssText = "opacity:.5;font-style:italic;";
        ph.textContent = "(no lora — roll 🎲 or pick folders 📂)";
        nameEl.appendChild(ph);
      } else {
        // Show dim folder prefix + bright bold filename (mirrors the chooser)
        const dir = folderOf(entry.name);
        if (dir !== ROOT_LABEL) {
          const d = document.createElement("span"); d.style.cssText = "opacity:.45;font-size:11px;"; d.textContent = dir + "/"; nameEl.appendChild(d);
        }
        const fn = document.createElement("span"); fn.style.cssText = "font-size:14px;font-weight:bold;"; fn.textContent = baseName(entry.name); nameEl.appendChild(fn);
      }
      nameEl.addEventListener("click", e => showLoraChooser(node, e, value => { entry.name = value; commit(); }));
      nameEl.addEventListener("pointerdown", e => e.stopPropagation()); row.appendChild(nameEl);

      const sLabel = document.createElement("span"); sLabel.textContent = "S";
      sLabel.title = globalMode
        ? "Per-line strength ignored — using Global strengths"
        : (hasClip ? "Strength (model + clip)" : "Strength (model — CLIP not connected)");
      sLabel.style.cssText = "opacity:" + (globalMode ? ".3" : ".6") + ";flex:none;font-size:11px;"; row.appendChild(sLabel);
      const sInput = numInput(entry.model, globalMode, v => { const val = isNaN(v) ? 0 : v; entry.model = val; entry.clip = val; syncData(node); });
      if (globalMode) { sInput.disabled = true; sInput.title = "Per-line strength ignored in Global mode"; }
      row.appendChild(sInput);
      if (!hasClip && !node.__isGlobalLora) {
        const note = document.createElement("span"); note.textContent = "(no CLIP)";
        note.style.cssText = "opacity:.3;font-size:10px;flex:none;white-space:nowrap;"; row.appendChild(note);
      }
      // ── Randomizer-only right control: 📂 per-line folder selection ─────
      if (entry.random) {
        const sel = Array.isArray(entry.folders) ? entry.folders.length : null;
        row.appendChild(mkIcon(
          "📂",
          (sel == null
            ? "<b>Folders: all enabled</b>"
            : `<b>Folders: ${sel} selected</b>`) +
          "<br>Choose which subfolders this line randomizes from.",
          null,
          (e) => showLineFolderPanel(node, entry, e)
        ));
      }
      row.appendChild(mkIcon("▲", "Move this lora up",   null,      () => { if (idx > 0) { swap(idx, idx-1); commit(); } }));
      row.appendChild(mkIcon("▼", "Move this lora down", null,      () => { if (idx < stack.length-1) { swap(idx, idx+1); commit(); } }));
      row.appendChild(mkIcon("✕", "Remove this lora",    "#e57373", () => { stack.splice(idx, 1); commit(); }));
      root.appendChild(row);
    });
  };

  node.__lflRender = render; node.__lflCommit = commit; render(); return root;
}

// ===========================================================================
// Graph editor — free-canvas node interface (the loader's only view)
// ===========================================================================
//
// Three node types on a draggable 2D canvas: folder sources (left) feed lora
// nodes (middle) which feed model chains (right). Every node is absolutely
// positioned and freely draggable; wires follow them live. A lora's left wire
// is its folder source; its right strength tabs are per-chain connections
// (click to edit, double-click to disconnect) that write the `targets` map the
// backend honours. Positions persist: lora gx/gy ride in lora_data, folder and
// model positions in node.properties.lflGraph.

const FLG_CHAIN_COLORS = [null, "#1d9e8f", "#d99a3a", "#9b8cff", "#6fae4f", "#d56fa0"];

function flgChainCount(node) {
  return Math.min(5, Math.max(1, (node.properties?.extra_model_count || 0) + 1));
}

function flgEscape(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
}

function flgHexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Effective per-chain strength map. targets absent => uniform (every chain at
// entry.model). Returns { [chainIdx]: strength } for connected chains only.
function flgChainMap(entry, chains) {
  const out = {};
  const t = entry.targets;
  if (t && typeof t === "object") {
    for (let c = 1; c <= chains; c++) if (t[c] != null) out[c] = Number(t[c]);
  } else {
    const s = Number(entry.model ?? 1);
    for (let c = 1; c <= chains; c++) out[c] = s;
  }
  return out;
}

// Materialise an explicit targets map (seeded from the uniform strength across
// all current chains) so a per-chain edit can be applied without changing the
// other chains.
function flgEnsureTargets(entry, chains) {
  if (!entry.targets || typeof entry.targets !== "object") {
    const s = Number(entry.model ?? 1), t = {};
    for (let c = 1; c <= chains; c++) t[c] = s;
    entry.targets = t;
  }
  return entry.targets;
}

// Best-effort: resolve the display name of whatever MODEL is plugged into a
// chain input, by tracing the link back (through reroutes) to its source node.
function flgModelLabel(node, c) {
  try {
    const inName = c === 1 ? "model" : "model_" + c;
    const inp = (node.inputs || []).find(i => i && i.name === inName);
    if (!inp || inp.link == null) return null;
    const graph = node.graph; if (!graph) return null;
    const links = graph.links || graph._links || {};
    const first = links[inp.link]; if (!first) return null;
    let origin = graph.getNodeById ? graph.getNodeById(first.origin_id) : null;
    let guard = 0;
    while (origin && guard++ < 12) {
      const t = origin.type || origin.comfyClass || "";
      if (/reroute/i.test(t) && origin.inputs && origin.inputs[0] && origin.inputs[0].link != null) {
        const l2 = links[origin.inputs[0].link]; if (!l2) break;
        origin = graph.getNodeById(l2.origin_id); continue;
      }
      break;
    }
    if (!origin) return null;
    const ws = origin.widgets || [];
    const clean = (v) => v.split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|sft|pt|pth|gguf|bin)$/i, "");
    let w = ws.find(w => w && typeof w.value === "string" && /(ckpt|checkpoint|unet|model|lora)_?name$/i.test(w.name || ""));
    if (!w) w = ws.find(w => w && typeof w.value === "string" && /\.(safetensors|ckpt|sft|pt|pth|gguf)$/i.test(w.value));
    if (w) return clean(w.value);
    return origin.title || origin.type || origin.comfyClass || null;
  } catch (_) { return null; }
}

// ===========================================================================
// Slot-grid loader UI: media-loader style. A fixed 2x6 grid of lora
// slots; slot order (reading order) IS the apply order. Folder filtering is a
// chip combobox over the node-wide enabled-folders property. Per-lora advanced
// options (model routing, per-chain strengths, randomizer) live in a modal.
// ===========================================================================

const SLOT_MAX = 12;
const SLOT_COLS = 2;
const SV_MIN_W = 860;   // two readable columns, with room for the − + steppers

// -- palette lifted from the MiniMax media loader --------------------------
// -- themes: each is a tonal ramp off a base colour. Semantic accents (chain
//    colours, green power dial, purple randomiser, red danger) stay fixed so
//    they remain distinguishable on every background.
const SV_THEMES = {
  teal: {
    label: "Fantastic Teal", swatch: "#173035", nodeColor: "#1d4a52", nodeBg: "#173035",
    panel: "#173035", inset: "#122529", slotEmpty: "#152b2f",
    border: "#1f4249", border2: "#1e3e45", dashed: "#224249",
    btn: "#1e3e45", btnBorder: "#2b5b64", btnHover: "#265059", btnText: "#dceaec",
    field: "#14282c", header: "#1a373d", rowOn: "#1a3b42", rowHover: "#20474f",
    badgeBg: "#1d4650", badgeFg: "#8fd0dc", accent: "#4c9fb0",
    text: "#e2ecee", dim: "#a6bcc0", mut: "#7c979c", faint: "#688288", ghost: "#587075",
  },
  slate: {
    label: "Boring Blue", swatch: "#191c22", nodeColor: "#2a3140", nodeBg: "#191c22",
    panel: "#191c22", inset: "#12151b", slotEmpty: "#141820",
    border: "#2a2f3a", border2: "#2e3440", dashed: "#2b313d",
    btn: "#2b3140", btnBorder: "#3a4252", btnHover: "#333b4d", btnText: "#d7dbe2",
    field: "#1b2029", header: "#1b1f27", rowOn: "#1b2230", rowHover: "#20283a",
    badgeBg: "#233042", badgeFg: "#8fb6e8", accent: "#6f86b8",
    text: "#dde2ea", dim: "#a9b2c2", mut: "#6b7484", faint: "#5c6472", ghost: "#4d5563",
  },
  node: {
    label: "Like, TEAL Teal", swatch: "#0a6166", nodeColor: "#0f848a", nodeBg: "#0a6166",
    panel: "#0a6166", inset: "#085256", slotEmpty: "#0a595e",
    border: "#0e7d84", border2: "#0c757b", dashed: "#107f86",
    btn: "#0c757b", btnBorder: "#12939b", btnHover: "#0e858c", btnText: "#f0fbfc",
    field: "#085458", header: "#0b686d", rowOn: "#0a7076", rowHover: "#0c8188",
    badgeBg: "#0d858c", badgeFg: "#d9f7fa", accent: "#5fe0ea",
    text: "#f0fbfc", dim: "#c6e6e8", mut: "#a3d3d6", faint: "#92c8cb", ghost: "#82bcbf",
  },
  graphite: {
    label: "Accountant.", swatch: "#2b2b2b", nodeColor: "#3d3d3d", nodeBg: "#2b2b2b",
    panel: "#2b2b2b", inset: "#212121", slotEmpty: "#262626",
    border: "#3a3a3a", border2: "#363636", dashed: "#3b3b3b",
    btn: "#363636", btnBorder: "#4a4a4a", btnHover: "#414141", btnText: "#e0e0e0",
    field: "#242424", header: "#303030", rowOn: "#343434", rowHover: "#3f3f3f",
    badgeBg: "#3c4450", badgeFg: "#9fb6c9", accent: "#6f86b8",
    text: "#e3e3e3", dim: "#adadad", mut: "#858585", faint: "#737373", ghost: "#626262",
  },
};
const SV_THEME_DEFAULT = "teal";

// Live palette. Every render reads these at draw time, so switching themes is
// just an Object.assign + re-render — no rebuild of the module needed.
const SV = {
  green: "#7ec87e", greenHov: "#a8e6a8", purple: "#b48ce8", purpleBorder: "#4c3d6e",
  danger: "#e08a8a", dangerHov: "#f2adad",
  cog: "#e0a94c", cogHov: "#f0c980",
};
function svThemeName() {
  const n = FLL_PREFS.theme;
  return (n && SV_THEMES[n]) ? n : SV_THEME_DEFAULT;
}
function svApplyTheme(name) {
  const t = SV_THEMES[name] || SV_THEMES[SV_THEME_DEFAULT];
  for (const k of Object.keys(t)) {
    if (k !== "label" && k !== "swatch" && k !== "nodeColor" && k !== "nodeBg") SV[k] = t[k];
  }
}
svApplyTheme(svThemeName());
// Pull the authoritative prefs from disk, then re-apply and repaint.
loadPrefs().then(() => { svApplyTheme(svThemeName()); repaintSlotNodes(); });

// Every theme's node colours, so we can tell "we set this" from "the user
// picked a custom colour in ComfyUI" and only ever restyle our own.
function svIsThemeNodeColor(c) {
  if (!c) return true;
  const lc = String(c).toLowerCase();
  if (lc === NODE_COLOR.toLowerCase() || lc === NODE_BGCOLOR.toLowerCase()) return true;
  return Object.values(SV_THEMES).some(t => t.nodeColor.toLowerCase() === lc || t.nodeBg.toLowerCase() === lc);
}

// The Vue renderer (Nodes 2.0) reads colour off the node INSTANCE, not the
// registered class — setting nodeType.color only ever worked on the canvas
// renderer. Set both here so the node is coloured in either renderer.
function svApplyNodeColors(node, force) {
  const t = SV_THEMES[svThemeName()] || SV_THEMES[SV_THEME_DEFAULT];
  if (!force && !(svIsThemeNodeColor(node.color) && svIsThemeNodeColor(node.bgcolor))) return;
  node.color = t.nodeColor;
  node.bgcolor = t.nodeBg;
  try { node.setDirtyCanvas?.(true, true); } catch (_) {}
}

function svSetTheme(name) {
  if (!SV_THEMES[name]) return;
  savePrefs({ theme: name });
  svApplyTheme(name);
  // Repaint every node of ours currently on the canvas: panel + node colours.
  try {
    for (const n of (app.graph?._nodes || [])) {
      const cls = n.comfyClass || n.type;
      if (!SV_THEMED_NODES.has(cls)) continue;
      svApplyNodeColors(n);
      if (n.__lflView === "slots") n.__lflRender?.();
      n.__asRender?.();
      n.__sdRender?.();
    }
    app.graph?.setDirtyCanvas?.(true, true);
  } catch (_) {}
}
const SV_CHAIN_TEXT   = [null, "#4cc3e0", "#e0a94c", "#b48ce8", "#8fd08f", "#e896bd"];
const SV_CHAIN_BORDER = [null, "#255c6b", "#6b5525", "#4c3d6e", "#3e5c3e", "#6b3350"];

function svBtn(label, title, fn) {
  const b = document.createElement("button");
  b.textContent = label; if (title) b.title = title;
  b.style.cssText = `background:${SV.btn};border:1px solid ${SV.btnBorder};color:${SV.btnText};border-radius:6px;padding:4px 11px;font:12px Arial,sans-serif;cursor:pointer;flex:none;`;
  b.addEventListener("mouseenter", () => b.style.background = SV.btnHover);
  b.addEventListener("mouseleave", () => b.style.background = SV.btn);
  b.addEventListener("pointerdown", e => e.stopPropagation());
  b.addEventListener("click", (e) => { hideTip(); fn(e); });
  return b;
}

function svChainsRouted(entry, chains) {
  // Which chains this entry feeds: no targets -> all current chains (uniform).
  const t = entry.targets;
  if (t == null || typeof t !== "object") { const a = []; for (let c = 1; c <= chains; c++) a.push(c); return a; }
  return Object.keys(t).map(Number).filter(c => c >= 1 && c <= chains).sort((a, b) => a - b);
}

function svChainStrength(entry, c) {
  const t = entry.targets;
  if (t == null || typeof t !== "object") return Number(entry.model ?? 1);
  return t[c] != null ? Number(t[c]) : null;
}

// Base (chip) strength edit: follow-unless-overridden — routed chains whose
// value equals the old base track the new one; individually-set chains keep.
function svSetBaseStrength(entry, v) {
  const old = Number(entry.model ?? 1);
  entry.model = v; entry.clip = v;
  const t = entry.targets;
  if (t && typeof t === "object") for (const k of Object.keys(t)) { if (Number(t[k]) === old) t[k] = v; }
}

const SV_STEP = 0.05;

// Strength control: − field + . The steppers are the quick adjustment;
// the field still takes typed values and arrow keys.
function svStrengthInput(value, onSet, wide, disabled) {
  injectStyles();
  const box = document.createElement("span");
  box.style.cssText = "flex:none;display:inline-flex;align-items:center;gap:2px;";

  const i = document.createElement("input");
  i.type = "number"; i.step = String(SV_STEP); i.value = Number(value).toFixed(2);
  i.dataset.ctl = "1"; i.className = "lfl-str";
  i.style.cssText = `width:${wide ? 52 : 48}px;background:${SV.field};border:1px solid ${SV.border2};color:${SV.text};border-radius:4px;font:12px ui-monospace,monospace;text-align:center;padding:3px 2px;outline:none;flex:none;box-sizing:border-box;`;
  i.addEventListener("pointerdown", e => e.stopPropagation());
  i.addEventListener("focus", () => { i.style.borderColor = SV.accent; i.select(); });
  i.addEventListener("blur", () => { i.style.borderColor = SV.border2; });
  i.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") i.blur(); });
  i.addEventListener("change", () => { const v = parseFloat(i.value); if (!isNaN(v)) onSet(v); });

  // Rounded to the step grid so repeated clicks don't accumulate float dust
  // (0.8 + 0.05 + 0.05 would otherwise drift to 0.9000000000000001).
  const bump = (dir) => {
    const cur = parseFloat(i.value);
    const base = isNaN(cur) ? 0 : cur;
    const next = Math.round((base + dir * SV_STEP) / SV_STEP) * SV_STEP;
    const clamped = Math.max(-10, Math.min(10, Math.round(next * 100) / 100));
    i.value = clamped.toFixed(2);
    onSet(clamped);
  };
  const step = (label, dir, title) => {
    const b = document.createElement("span"); b.dataset.ctl = "1";
    b.textContent = label; b.title = title;
    b.style.cssText = `flex:none;width:17px;text-align:center;border:1px solid ${SV.btnBorder};background:${SV.btn};` +
      `color:${SV.dim};border-radius:3px;font-size:12px;line-height:17px;height:19px;cursor:pointer;user-select:none;box-sizing:border-box;` +
      (disabled ? "opacity:.3;cursor:default;" : "");
    if (!disabled) {
      b.addEventListener("mouseenter", () => { b.style.background = SV.btnHover; b.style.color = SV.text; });
      b.addEventListener("mouseleave", () => { b.style.background = SV.btn; b.style.color = SV.dim; });
      b.addEventListener("pointerdown", e => e.stopPropagation());
      b.addEventListener("click", (e) => { e.stopPropagation(); bump(dir); });
    }
    return b;
  };
  // Wheel over the control steps it. The canvas zooms on wheel, so the event
  // has to be stopped here — and passive:false is required for preventDefault.
  if (!disabled) {
    box.addEventListener("wheel", (e) => {
      e.preventDefault(); e.stopPropagation();
      bump(e.deltaY < 0 ? +1 : -1);
    }, { passive: false });
    box.title = `Scroll to adjust by ${SV_STEP}`;
  }
  box.appendChild(step("−", -1, `Decrease by ${SV_STEP}`));
  box.appendChild(i);
  box.appendChild(step("+", +1, `Increase by ${SV_STEP}`));
  box.__input = i;
  return box;
}

// ---------------------------------------------------------------------------
// Folder chip combobox: chips = enabled folder units (null = all). Dropdown
// lists every unit grouped by its top-level parent; click toggles.
// ---------------------------------------------------------------------------
let openFolderCombo = null;
function closeFolderCombo() { if (openFolderCombo) { openFolderCombo.dispose(); openFolderCombo = null; } }

// Which branches are collapsed in the folder picker. A browser-level pref, so
// a deep tree stays tidy across nodes and sessions.
function loadCollapsed() { return new Set(FLL_PREFS.collapsedFolders || []); }
function saveCollapsed(set) { savePrefs({ collapsedFolders: [...set] }); }

function loadFolderFavs() { return new Set(FLL_PREFS.favoriteFolders || []); }
function saveFolderFavs(set) { savePrefs({ favoriteFolders: [...set] }); }

async function svOpenFolderDropdown(node, anchor) {
  closeFolderCombo(); closeFolderPanel(); closeChooserPanel();
  const files = await getLoraFiles();
  const units = [...collectUnits(files).keys()].map(normPath).sort();
  const favs = loadFolderFavs();

  const panel = document.createElement("div");
  panel.style.cssText = `position:fixed;z-index:10001;background:${SV.inset};border:1px solid ${SV.border2};border-radius:6px;min-width:320px;max-width:520px;font:12px Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);display:flex;flex-direction:column;max-height:340px;`;
  const r = anchor.getBoundingClientRect();
  panel.style.left = Math.round(Math.min(r.left, window.innerWidth - 540)) + "px";
  panel.style.top = Math.round(r.bottom + 4) + "px";

  // ---- search box ----
  const sbar = document.createElement("div");
  sbar.style.cssText = `display:flex;align-items:center;gap:6px;padding:7px 8px;border-bottom:1px solid ${SV.border2};flex:none;`;
  const sin = document.createElement("input");
  sin.type = "text"; sin.placeholder = "Type to search folders…";
  sin.style.cssText = `flex:1;min-width:0;background:${SV.panel};border:1px solid ${SV.btnBorder};color:${SV.text};border-radius:5px;padding:4px 8px;font:12px Arial,sans-serif;outline:none;`;
  sin.addEventListener("pointerdown", e => e.stopPropagation());
  sbar.appendChild(sin);
  const allBtn = document.createElement("span");
  allBtn.textContent = "all"; allBtn.title = "Select every folder (clears the filter)";
  allBtn.style.cssText = `flex:none;font-size:11px;color:${SV.mut};cursor:pointer;text-decoration:underline;`;
  allBtn.addEventListener("pointerdown", e => e.stopPropagation());
  allBtn.addEventListener("click", (e) => { e.stopPropagation(); setEnabledFolders(node, null); node.__plffUpdateFolderBtn?.(); node.__lflCommit?.(); rebuild(); });
  sbar.appendChild(allBtn);
  // Expand / collapse every branch at once.
  const foldBtn = document.createElement("span");
  foldBtn.style.cssText = `flex:none;font-size:11px;color:${SV.mut};cursor:pointer;`;
  const branches = () => {
    const set = new Set();
    for (const u of units) {
      const parts = u.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const pre = parts.slice(0, i).join("/");
        if (units.some(x => x.startsWith(pre + "/"))) set.add(pre);
      }
    }
    return set;
  };
  const paintFold = () => {
    const all = branches();
    const anyOpen = [...all].some(b => !collapsedSet.has(b));
    foldBtn.textContent = anyOpen ? "collapse all" : "expand all";
    foldBtn.title = anyOpen ? "Collapse every folder" : "Expand every folder";
    foldBtn.dataset.act = anyOpen ? "collapse" : "expand";
  };
  foldBtn.addEventListener("pointerdown", e => e.stopPropagation());
  foldBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const all = branches();
    if (foldBtn.dataset.act === "collapse") all.forEach(b => collapsedSet.add(b));
    else all.forEach(b => collapsedSet.delete(b));
    saveCollapsed(collapsedSet); paintFold(); rebuild();
  });
  const noneBtn = document.createElement("span");
  noneBtn.textContent = "none"; noneBtn.title = "Deselect every folder";
  noneBtn.style.cssText = `flex:none;font-size:11px;color:${SV.mut};cursor:pointer;text-decoration:underline;`;
  noneBtn.addEventListener("pointerdown", e => e.stopPropagation());
  noneBtn.addEventListener("click", (e) => { e.stopPropagation(); setEnabledFolders(node, new Set()); node.__plffUpdateFolderBtn?.(); node.__lflCommit?.(); rebuild(); });
  sbar.appendChild(noneBtn);
  sbar.appendChild(foldBtn);
  panel.appendChild(sbar);

  const list = document.createElement("div");
  list.style.cssText = "overflow:auto;flex:1;";
  panel.appendChild(list);

  let query = "";
  const collapsedSet = loadCollapsed();
  const rebuild = () => {
    list.textContent = "";
    const eff = getEffectiveEnabledSet(node, units); // null => all enabled
    const q = query.trim().toLowerCase();
    const matches = units.filter(u => !q || (u || ROOT_LABEL).toLowerCase().includes(q));
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.textContent = "No folders match “" + query + "”";
      empty.style.cssText = `padding:10px;font-size:11px;color:${SV.ghost};font-style:italic;`;
      list.appendChild(empty);
      return;
    }
    const fav = matches.filter(u => favs.has(u));
    const rest = matches.filter(u => !favs.has(u));

    const addRow = (u, depth, leafOnly) => {
      const onIt = eff == null || eff.has(u);
      const pad = 10 + (depth || 0) * 14 + (depth ? 19 : 0);   // clear the expander column
      const row = document.createElement("div");
      row.style.cssText = `display:flex;align-items:center;gap:8px;padding:5px 10px 5px ${pad}px;cursor:pointer;border-bottom:1px solid ${SV.border2};color:${onIt ? SV.text : SV.mut};${onIt ? `background:${SV.rowOn};` : ""}`;
      const star = document.createElement("span");
      star.textContent = favs.has(u) ? "★" : "☆";
      star.title = favs.has(u) ? "Unfavorite this folder" : "Favorite this folder (pins it to the top)";
      star.style.cssText = `flex:none;font-size:12px;color:${favs.has(u) ? "#e0c04c" : SV.ghost};cursor:pointer;`;
      star.addEventListener("pointerdown", e => e.stopPropagation());
      star.addEventListener("click", (e) => {
        e.stopPropagation();
        favs.has(u) ? favs.delete(u) : favs.add(u);
        saveFolderFavs(favs); rebuild();
      });
      row.appendChild(star);
      // Show the full path, but style the leading parent like the group
      // heading above it and give the final segment the emphasis — that's the
      // part you're actually picking.
      const lbl = document.createElement("span");
      lbl.title = u === "" ? ROOT_LABEL : u;      // full path on hover
      if (u === "") {
        lbl.style.cssText = "flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
        lbl.textContent = ROOT_LABEL;
      } else {
        const cut = u.lastIndexOf("/");
        if (cut < 0 || leafOnly) {
          lbl.style.cssText = `flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:${onIt ? SV.text : SV.mut};`;
          lbl.textContent = leafOnly ? u.slice(cut + 1) : u;
        } else {
          // Flex row so the PARENT truncates when space runs short, not the
          // final segment — the tail is the part being selected, so it must
          // stay readable. The parent shrinks first (tail has flex-shrink 0).
          lbl.style.cssText = "flex:1;min-width:0;display:flex;align-items:baseline;white-space:nowrap;overflow:hidden;";
          const lead = document.createElement("span");
          lead.textContent = u.slice(0, cut + 1);
          lead.style.cssText = `flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;` +
            `font-size:10px;letter-spacing:.06em;color:${SV.faint};`;
          lbl.appendChild(lead);
          const tail = document.createElement("span");
          tail.textContent = u.slice(cut + 1);
          tail.style.cssText = `flex:0 0 auto;max-width:100%;overflow:hidden;text-overflow:ellipsis;` +
            `font-size:12px;color:${onIt ? SV.text : SV.mut};`;
          lbl.appendChild(tail);
        }
      }
      row.appendChild(lbl);
      if (onIt) { const ck = document.createElement("span"); ck.textContent = "✓"; ck.style.cssText = "color:#4cc3e0;font-size:11px;flex:none;"; row.appendChild(ck); }
      row.addEventListener("mouseenter", () => row.style.background = SV.rowHover);
      row.addEventListener("mouseleave", () => row.style.background = onIt ? SV.rowOn : "");
      row.addEventListener("pointerdown", e => e.stopPropagation());
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        const cur = getEffectiveEnabledSet(node, units);
        let next;
        if (cur == null) next = new Set([u]);                                  // All -> just this one
        else { next = new Set(cur); if (next.has(u)) next.delete(u); else next.add(u); }
        if (next.size === units.length) setEnabledFolders(node, null);         // everything -> back to All
        else setEnabledFolders(node, next);
        node.__plffUpdateFolderBtn?.(); node.__lflCommit?.(); rebuild();
      });
      list.appendChild(row);
    };

    const hdr = (t) => {
      const h = document.createElement("div"); h.textContent = t;
      h.style.cssText = `padding:5px 10px 3px;font-size:10px;letter-spacing:.06em;color:${SV.faint};border-bottom:1px solid ${SV.border2};position:sticky;top:0;background:${SV.inset};`;
      list.appendChild(h);
    };

    // A group header stands for a whole branch of the tree — including parent
    // folders that hold no loras themselves and so never appear as a row.
    // Clicking it selects (or clears) everything beneath.
    const branchRow = (prefix, depth, isUnit) => {
      const below = units.filter(u => u === prefix || u.startsWith(prefix + "/"));
      const kids = below.filter(u => u !== prefix);
      const isOn = (u) => eff == null || eff.has(u);
      const onCount = below.filter(isOn).length;
      const selfOn = isUnit && isOn(prefix);
      const kidsOn = kids.filter(isOn).length;

      // Three states, cycled by clicking: the whole branch, just this folder
      // (only where the folder holds loras itself), then off.
      const state = (onCount === below.length && below.length > 0) ? "all"
        : (isUnit && selfOn && kidsOn === 0) ? "self"
        : (onCount === 0) ? "none" : "mixed";
      const nextState = state === "all" ? (isUnit ? "self" : "none")
        : state === "self" ? "none"
        : "all";

      const pad = 10 + depth * 14;
      const h = document.createElement("div");
      h.style.cssText = `display:flex;align-items:center;gap:7px;padding:5px 10px 5px ${pad}px;cursor:pointer;` +
        `border-bottom:1px solid ${SV.border2};background:${SV.inset};`;

      const apply = (to) => {
        const cur = getEffectiveEnabledSet(node, units);
        const next = new Set(cur == null ? units : cur);
        below.forEach(u => next.delete(u));
        if (to === "all") below.forEach(u => next.add(u));
        else if (to === "self") next.add(prefix);
        setEnabledFolders(node, next.size === units.length ? null : next);
        node.__plffUpdateFolderBtn?.(); node.__lflCommit?.(); rebuild();
      };

      // Expander — its own target, so it never competes with the row's cycle.
      const collapsed = collapsedSet.has(prefix);
      const exp = document.createElement("span"); exp.dataset.stop = "1";
      exp.textContent = collapsed ? "▸" : "▾";
      exp.title = collapsed ? `Show what's inside ${prefix}` : `Collapse ${prefix}`;
      exp.style.cssText = `flex:none;width:12px;text-align:center;font-size:10px;cursor:pointer;color:${SV.mut};`;
      exp.addEventListener("mouseenter", () => exp.style.color = SV.text);
      exp.addEventListener("mouseleave", () => exp.style.color = SV.mut);
      exp.addEventListener("pointerdown", ev => ev.stopPropagation());
      exp.addEventListener("click", (ev) => {
        ev.stopPropagation();
        collapsed ? collapsedSet.delete(prefix) : collapsedSet.add(prefix);
        saveCollapsed(collapsedSet); paintFold(); rebuild();
      });
      h.appendChild(exp);

      const glyph = { all: "▣", self: "◧", mixed: "▨", none: "▢" }[state];
      const colour = { all: SV.accent, self: SV.badgeFg, mixed: SV.dim, none: SV.ghost }[state];
      const box = document.createElement("span");
      box.textContent = glyph;
      box.style.cssText = `flex:none;font-size:12px;color:${colour};`;
      h.appendChild(box);

      const lb = document.createElement("span");
      lb.textContent = prefix.slice(prefix.lastIndexOf("/") + 1);
      lb.style.cssText = `flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;` +
        (isUnit ? `color:${selfOn ? SV.text : SV.mut};` : `color:${SV.faint};font-style:italic;`);
      h.appendChild(lb);

      const now = { all: "this folder and all beneath it", self: "just this folder",
                    mixed: "some folders beneath", none: "nothing here" }[state];
      const then = { all: `enable ${prefix} and all ${kids.length} beneath`,
                     self: `enable only ${prefix}`, none: "turn everything here off" }[nextState];
      h.title = `${prefix} — ${now}. Click to ${then}.`;
      h.addEventListener("mouseenter", () => h.style.background = SV.rowHover);
      h.addEventListener("mouseleave", () => h.style.background = SV.inset);
      h.addEventListener("pointerdown", ev => ev.stopPropagation());
      h.addEventListener("click", (ev) => { ev.stopPropagation(); apply(nextState); });

      const cnt = document.createElement("span");
      cnt.textContent = `${onCount}/${below.length}`;
      cnt.style.cssText = `flex:none;font:10px ui-monospace,monospace;color:${SV.ghost};`;
      h.appendChild(cnt);
      list.appendChild(h);
    };

    if (fav.length) { hdr("★ FAVORITES"); fav.forEach(u => addRow(u, 0, false)); }

    if (q) {
      // Searching: flat list, full paths, so matches are unambiguous.
      if (fav.length) hdr("ALL FOLDERS");
      rest.forEach(u => addRow(u, 0, false));
    } else if (matches.length) {
      // Not searching: a real tree. Every level that has children gets its own
      // branch toggle, including intermediate folders that hold no loras of
      // their own and so never appear as a selectable row.
      if (fav.length) hdr("ALL FOLDERS");
      const tree = new Set();
      for (const u of matches) {
        if (u === "") continue;
        tree.add(u);
        const parts = u.split("/");
        for (let i = 1; i < parts.length; i++) tree.add(parts.slice(0, i).join("/"));
      }
      if (matches.includes("")) addRow("", 0, false);            // (root)
      // Case-insensitive, segment-aware: keeps a branch's children directly
      // under it and stops uppercase names sorting above lowercase ones.
      const treeSorted = [...tree].sort((a, b) => {
        const A = a.split("/"), B = b.split("/");
        for (let i = 0; i < Math.max(A.length, B.length); i++) {
          const x = (A[i] || "").toLowerCase(), y = (B[i] || "").toLowerCase();
          if (x !== y) return x < y ? -1 : 1;
        }
        return 0;
      });
      for (const pathStr of treeSorted) {
        // Hidden if any ancestor is collapsed.
        const parts = pathStr.split("/");
        let buried = false;
        for (let i = 1; i < parts.length; i++) {
          if (collapsedSet.has(parts.slice(0, i).join("/"))) { buried = true; break; }
        }
        if (buried) continue;
        const depth = parts.length - 1;
        const isUnit = units.includes(pathStr);
        const hasKids = units.some(u => u.startsWith(pathStr + "/"));
        if (hasKids) branchRow(pathStr, depth, isUnit);
        else addRow(pathStr, depth, true);
      }
    }
  };
  sin.addEventListener("input", () => { query = sin.value; rebuild(); });
  sin.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") closeFolderCombo();
  });
  paintFold();
  rebuild();
  document.body.appendChild(panel);
  setTimeout(() => sin.focus(), 0);
  const away = (ev) => { if (!panel.contains(ev.target) && !anchor.contains(ev.target)) closeFolderCombo(); };
  setTimeout(() => window.addEventListener("pointerdown", away, true), 0);
  openFolderCombo = { dispose: () => { window.removeEventListener("pointerdown", away, true); panel.remove(); } };
}

function svFolderBar(node) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;align-items:center;gap:6px;";
  const tag = document.createElement("span");
  tag.textContent = "FOLDERS";
  tag.style.cssText = `font-size:10px;letter-spacing:.08em;color:${SV.faint};flex:none;`;
  wrap.appendChild(tag);

  const box = document.createElement("div"); box.dataset.ctl = "1";
  box.style.cssText = `flex:1;display:flex;align-items:center;flex-wrap:wrap;gap:4px;background:${SV.inset};border:1px solid ${SV.border2};border-radius:6px;padding:4px 8px;cursor:pointer;min-height:24px;`;
  box.title = "Choose which lora folders this node can see";

  const mkChip = (label, title, onRemove, accent) => {
    const chip = document.createElement("span"); chip.dataset.ctl = "1";
    chip.style.cssText = `display:inline-flex;align-items:center;gap:5px;background:${SV.btn};border:1px solid ${accent || SV.btnBorder};color:${accent || SV.text};border-radius:4px;padding:1px 7px;font-size:11px;`;
    const t = document.createElement("span"); t.textContent = label; chip.appendChild(t);
    const x = document.createElement("span"); x.textContent = "✕";
    x.style.cssText = `color:${SV.mut};cursor:pointer;font-size:10px;`;
    x.title = title;
    x.addEventListener("pointerdown", e => e.stopPropagation());
    x.addEventListener("click", (e) => { e.stopPropagation(); onRemove(); });
    chip.appendChild(x);
    return chip;
  };

  const enabled = effectiveEnabledFoldersArray(node); // null => all folders
  const rawProp = node.properties?.[PROP_ENABLED_FOLDERS];

  if (enabled == null && rawProp == null) {
    // Default state: a single "All Folders" chip. Its ✕ deselects everything.
    box.appendChild(mkChip("All Folders", "Deselect all folders", () => {
      setEnabledFolders(node, new Set()); node.__plffUpdateFolderBtn?.(); node.__lflCommit?.();
    }));
  } else if (enabled != null && enabled.length === 0) {
    const none = document.createElement("span");
    none.textContent = "No folders selected";
    none.style.cssText = `font-size:11px;color:${SV.danger};font-style:italic;`;
    box.appendChild(none);
    const back = document.createElement("span");
    back.textContent = "select all";
    back.dataset.ctl = "1";
    back.title = "Go back to all folders";
    back.style.cssText = `margin-left:auto;font-size:11px;color:${SV.mut};cursor:pointer;text-decoration:underline;`;
    back.addEventListener("pointerdown", e => e.stopPropagation());
    back.addEventListener("click", (e) => { e.stopPropagation(); setEnabledFolders(node, null); node.__plffUpdateFolderBtn?.(); node.__lflCommit?.(); });
    box.appendChild(back);
  } else {
    const all = [...(enabled || [])].sort();
    const shown = all.slice(0, 6);
    for (const u of shown) {
      box.appendChild(mkChip(u === "" ? ROOT_LABEL : u, "Remove this folder from the filter", async () => {
        const files = await getLoraFiles();
        const units = [...collectUnits(files).keys()].map(normPath);
        const cur = getEffectiveEnabledSet(node, units) ?? new Set(units);
        cur.delete(normPath(u));
        setEnabledFolders(node, cur);   // empty set stays empty (explicit "none")
        node.__plffUpdateFolderBtn?.(); node.__lflCommit?.();
      }));
    }
    if (all.length > shown.length) {
      const more = document.createElement("span");
      more.textContent = "+" + (all.length - shown.length) + " more";
      more.style.cssText = `font-size:11px;color:${SV.mut};`;
      box.appendChild(more);
    }
    const clr = document.createElement("span"); clr.textContent = "✕";
    clr.dataset.ctl = "1";
    clr.title = "Clear filter (back to all folders)";
    clr.style.cssText = `margin-left:auto;color:${SV.mut};cursor:pointer;font-size:12px;padding:0 2px;`;
    clr.addEventListener("pointerdown", e => e.stopPropagation());
    clr.addEventListener("click", (e) => { e.stopPropagation(); setEnabledFolders(node, null); node.__plffUpdateFolderBtn?.(); node.__lflCommit?.(); });
    box.appendChild(clr);
  }
  box.addEventListener("pointerdown", e => e.stopPropagation());
  box.addEventListener("click", (e) => { e.stopPropagation(); hideTip(); svOpenFolderDropdown(node, box); });
  wrap.appendChild(box);
  return wrap;
}

// ---------------------------------------------------------------------------
// Advanced modal: model routing + per-chain strengths + randomizer + remove
// ---------------------------------------------------------------------------
let openLoraModal = null;
function closeLoraModal() { if (openLoraModal) { openLoraModal.dispose(); openLoraModal = null; } }

function svShowLoraModal(node, entry) {
  closeLoraModal(); closeFolderCombo(); closeChooserPanel(); closeLinePanel();
  const chains = flgChainCount(node);
  const over = document.createElement("div");
  over.style.cssText = "position:fixed;inset:0;z-index:10002;background:rgba(8,10,14,.6);display:flex;align-items:center;justify-content:center;";
  const box = document.createElement("div");
  box.style.cssText = `width:min(360px,92vw);background:${SV.panel};border:1px solid ${SV.border};border-radius:10px;font:12px Arial,sans-serif;color:${SV.text};box-shadow:0 14px 40px rgba(0,0,0,.6);`;
  over.appendChild(box);

  const rebuild = () => {
    box.textContent = "";
    // -- header --
    const hd = document.createElement("div");
    hd.style.cssText = `display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid ${SV.border};background:${SV.header};border-radius:10px 10px 0 0;`;
    const dot = document.createElement("span"); dot.textContent = "●";
    dot.title = entry.on !== false ? "Enabled — click to disable" : "Disabled — click to enable";
    dot.style.cssText = `cursor:pointer;font-size:11px;color:${entry.on !== false ? SV.green : SV.ghost};`;
    dot.addEventListener("click", () => { entry.on = entry.on === false; node.__lflCommit(); rebuild(); });
    hd.appendChild(dot);
    const nm = document.createElement("div"); nm.style.cssText = "flex:1;min-width:0;line-height:1.25;";
    const fol = (entry.name || "").includes("/") ? entry.name.slice(0, entry.name.lastIndexOf("/") + 1) : "";
    const fil = entry.name ? svFileLabel(entry.name) : "(random — not rolled yet)";
    nm.innerHTML = (fol ? `<div style="font-size:10px;color:${SV.faint};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${flgEscape(fol)}</div>` : "") +
      `<div style="font-size:12px;color:${SV.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${entry.random ? "🎲 " : ""}${flgEscape(fil)}</div>`;
    hd.appendChild(nm);
    const cx = document.createElement("span"); cx.textContent = "✕";
    cx.style.cssText = `cursor:pointer;color:${SV.mut};font-size:14px;padding:0 2px;`;
    cx.addEventListener("click", closeLoraModal);
    hd.appendChild(cx);
    box.appendChild(hd);

    const body = document.createElement("div"); body.style.cssText = "padding:10px 12px;";
    const sec = (t) => { const s = document.createElement("div"); s.textContent = t; s.style.cssText = `font-size:10px;letter-spacing:.08em;color:${SV.faint};margin:0 0 6px;`; return s; };

    // -- model routing (loader only: the plotter has no per-lora routing) --
    if (node.__isPlotter) {
      // The plotter has no per-lora routing — every lora is tested against
      // every connected model base — so show what those bases are, plus the
      // strength that applies when the sweep is in Per-line mode.
      body.appendChild(sec("APPLIED TO"));
      for (let c = 1; c <= chains; c++) {
        const row = document.createElement("div");
        row.style.cssText = `display:flex;align-items:center;gap:8px;padding:5px 8px;margin-bottom:5px;border:1px solid ${SV.border2};border-radius:6px;background:${SV.inset};`;
        const tag = document.createElement("span"); tag.textContent = "M" + c;
        tag.style.cssText = `flex:none;font:10px ui-monospace,monospace;color:${SV_CHAIN_TEXT[c] || SV.dim};border:1px solid ${SV_CHAIN_BORDER[c] || SV.border2};border-radius:3px;padding:0 4px;`;
        row.appendChild(tag);
        const nm2 = document.createElement("span");
        const resolved = flgModelLabel(node, c);
        nm2.textContent = resolved || "— unconnected —";
        nm2.style.cssText = `flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:${resolved ? SV.text : SV.ghost};${resolved ? "" : "font-style:italic;"}`;
        row.appendChild(nm2);
        body.appendChild(row);
      }
      const note = document.createElement("div");
      note.textContent = "Every lora is swept against each connected model.";
      note.style.cssText = `font-size:11px;color:${SV.faint};margin:-1px 0 10px;`;
      body.appendChild(note);

      const globalMode = node.__plotMode === "global";
      body.appendChild(sec("STRENGTH"));
      const srow = document.createElement("div");
      srow.style.cssText = `display:flex;align-items:center;gap:8px;padding:5px 8px;margin-bottom:10px;border:1px solid ${SV.border2};border-radius:6px;background:${SV.inset};`;
      const slab = document.createElement("span");
      slab.textContent = globalMode ? "Set by the sweep's Global strengths" : "This line's sweep strength";
      slab.style.cssText = `flex:1;min-width:0;font-size:12px;color:${globalMode ? SV.ghost : SV.dim};${globalMode ? "font-style:italic;" : ""}`;
      srow.appendChild(slab);
      const sctl = svStrengthInput(Number(entry.model ?? 1), (v) => {
        svSetBaseStrength(entry, v); node.__lflCommit();
      }, true, globalMode);
      if (globalMode) { if (sctl.__input) sctl.__input.disabled = true; sctl.style.opacity = ".35"; }
      srow.appendChild(sctl);
      body.appendChild(srow);
    }

    if (!node.__isPlotter) {
    body.appendChild(sec("MODEL ROUTING"));
    for (let c = 1; c <= chains; c++) {
      const routed = svChainStrength(entry, c) != null;
      const row = document.createElement("div");
      row.style.cssText = `display:flex;align-items:center;gap:8px;border-radius:6px;padding:5px 9px;margin-bottom:5px;` +
        (routed ? `background:${SV.inset};border:1px solid ${SV_CHAIN_BORDER[c] || SV.border2};`
                : `background:${SV.slotEmpty};border:1px dashed ${SV.dashed};opacity:.6;`);
      const d = document.createElement("span"); d.textContent = "●";
      d.title = routed ? `Routed to Model ${c} — click to disconnect` : `Not routed — click to route to Model ${c}`;
      d.style.cssText = `cursor:pointer;font-size:11px;color:${routed ? SV.green : SV.ghost};flex:none;`;
      d.addEventListener("click", () => {
        if (routed) { const t = flgEnsureTargets(entry, chains); delete t[c]; }
        else { const t = flgEnsureTargets(entry, chains); t[c] = Number(entry.model ?? 1); }
        node.__lflCommit(); rebuild();
      });
      row.appendChild(d);
      const mc = document.createElement("span"); mc.textContent = "M" + c;
      mc.style.cssText = `font:11px ui-monospace,monospace;color:${SV_CHAIN_TEXT[c] || SV.dim};flex:none;`;
      row.appendChild(mc);
      const mn = document.createElement("span");
      const lbl = flgModelLabel(node, c);
      mn.textContent = lbl || "— unconnected —";
      mn.style.cssText = `flex:1;min-width:0;font-size:11px;color:${lbl ? SV.dim : SV.ghost};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${lbl ? "" : "font-style:italic;"}`;
      row.appendChild(mn);
      if (routed) {
        row.appendChild(svStrengthInput(svChainStrength(entry, c), (v) => {
          flgEnsureTargets(entry, chains)[c] = v; node.__lflCommit();
        }));
      } else {
        const dash = document.createElement("span"); dash.textContent = "—";
        dash.style.cssText = `color:${SV.ghost};padding:0 18px;`; row.appendChild(dash);
      }
      body.appendChild(row);
    }
    }

    // -- randomizer --
    if (entry.random) {
      body.appendChild(sec("RANDOMIZER"));
      const rr = document.createElement("div");
      rr.style.cssText = `display:flex;align-items:center;gap:12px;background:${SV.inset};border:1px solid ${SV.border2};border-radius:6px;padding:6px 9px;margin-bottom:5px;`;
      const mk = (txt, title, active, fn) => {
        const s = document.createElement("span"); s.textContent = txt; s.title = title;
        s.style.cssText = `cursor:pointer;font-size:13px;line-height:1;user-select:none;opacity:${active ? "1" : ".55"};${active ? "" : "filter:grayscale(.6);"}`;
        s.addEventListener("click", fn); return s;
      };
      rr.appendChild(mk("🎲", entry.locked ? "Locked — unlock to reroll" : "Roll a new pick now", !entry.locked, async () => {
        if (entry.locked) return;
        const p = await pickRandomLora(node, entry); if (p != null) { entry.name = p; node.__lflCommit(); rebuild(); }
      }));
      rr.appendChild(mk(entry.locked ? "🔒" : "🔓", entry.locked ? "Locked — won't re-roll" : "Unlocked", !!entry.locked, () => { entry.locked = !entry.locked; node.__lflCommit(); rebuild(); }));
      rr.appendChild(mk("🔄", entry.autoRoll ? "Auto-roll each queue: ON" : "Auto-roll each queue: OFF", !!entry.autoRoll, () => { entry.autoRoll = !entry.autoRoll; node.__lflCommit(); rebuild(); }));
      const fsc = document.createElement("span");
      fsc.textContent = "📂 " + (Array.isArray(entry.folders) ? entry.folders.length + " folders" : "all enabled");
      fsc.title = "Choose which folders this randomizer draws from";
      fsc.style.cssText = `cursor:pointer;font-size:11px;color:${SV.dim};margin-left:auto;`;
      fsc.addEventListener("click", (ev) => showLineFolderPanel(node, entry, ev));
      rr.appendChild(fsc);
      body.appendChild(rr);
    }

    // -- footer --
    const ft = document.createElement("div"); ft.style.cssText = "display:flex;gap:8px;margin-top:10px;";
    const done = svBtn("Done", "", closeLoraModal); done.style.flex = "1";
    ft.appendChild(done);
    const rm = svBtn("Remove lora", "Remove this lora from the node", () => {
      const i = (node.__loraStack || []).indexOf(entry);
      if (i >= 0) { node.__loraStack.splice(i, 1); node.__lflCommit(); }
      closeLoraModal();
    });
    rm.style.borderColor = "#4a2a2a"; rm.style.color = SV.danger;
    ft.appendChild(rm);
    body.appendChild(ft);
    box.appendChild(body);
  };
  rebuild();

  over.addEventListener("pointerdown", (e) => { if (e.target === over) closeLoraModal(); });
  document.body.appendChild(over);
  openLoraModal = { dispose: () => over.remove(), rebuild };
}

// ---------------------------------------------------------------------------
// The slot view
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Presets: named snapshots of the lora stack + folder filter, stored server
// side under ComfyUI/user/fantastic-loras/presets/.
// ---------------------------------------------------------------------------
let svPresets = null;   // [{name, category}] cached, refreshed on save/delete

async function svPresetApi(path, body) {
  const opts = body
    ? { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
    : {};
  const resp = await api.fetchApi("/fantastic_loras/presets" + path, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const e = new Error(data.message || data.error || `request failed (${resp.status})`);
    e.code = data.error; e.status = resp.status;
    throw e;
  }
  return data;
}

function svToast(msg, bad) {
  const t = document.createElement("div");
  t.textContent = msg;
  t.style.cssText = `position:fixed;z-index:10005;left:50%;bottom:70px;transform:translateX(-50%);background:${SV.panel};` +
    `border:1px solid ${bad ? "#6b3a3a" : SV.btnBorder};color:${bad ? SV.danger : SV.text};border-radius:6px;` +
    `padding:8px 14px;font:12px Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);max-width:70vw;`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 5000 : 2600);
}

function svApplyPreset(node, data) {
  const stack = (data.loras || []).slice(0, SLOT_MAX).map(e => ({
    on: e.on !== false, name: e.name || "", model: Number(e.model ?? 1), clip: Number(e.clip ?? e.model ?? 1),
    ...(e.targets ? { targets: e.targets } : {}),
    ...(e.random ? { random: true, locked: !!e.locked, autoRoll: !!e.autoRoll, folders: e.folders ?? null } : {}),
  }));
  node.__loraStack = stack;
  if (data.enabledFolders !== undefined) {
    setEnabledFolders(node, data.enabledFolders == null ? null : new Set(data.enabledFolders.map(normPath)));
  }
  // Load applies everything the preset stored, including chain count.
  if (typeof data.chains === "number") {
    const want = Math.max(1, Math.min(1 + MAX_EXTRA_MODELS, Math.round(data.chains)));
    let guard = 0;
    while (flgChainCount(node) < want && guard++ < 8) addModelPair(node);
    guard = 0;
    while (flgChainCount(node) > want && guard++ < 8) removeModelPair(node);
  }
  node.__plffUpdateFolderBtn?.();
  // Mark clean BEFORE committing: commit is what re-renders the bar, so
  // setting the signature afterwards left it drawn in the dirty state.
  svMarkClean(node, data.name, data.category || "");
  node.__lflCommit();
  if (data.missing && data.missing.length) {
    svToast(`Loaded “${data.name}” — ${data.missing.length} lora${data.missing.length > 1 ? "s" : ""} no longer on disk were skipped`, true);
  } else {
    svToast(`Loaded preset “${data.name}”`);
  }
}

const SV_UNCAT = "(uncategorized)";

function svSmallInput(placeholder, value) {
  const i = document.createElement("input");
  i.type = "text"; i.placeholder = placeholder; i.value = value || "";
  i.dataset.ctl = "1";
  i.style.cssText = `flex:1;min-width:0;background:${SV.inset};border:1px solid ${SV.btnBorder};color:${SV.text};border-radius:5px;padding:3px 7px;font:12px Arial,sans-serif;outline:none;`;
  i.addEventListener("pointerdown", e => e.stopPropagation());
  i.addEventListener("keydown", e => e.stopPropagation());
  return i;
}

// Category picker for the save form: a dropdown of existing categories plus a
// "＋ New category…" entry that swaps the control for a text field in place
// (swapping in place, not re-rendering, so the name field keeps what's typed).
function svCategoryField(cats, initial, hooks) {
  const box = document.createElement("span");
  box.style.cssText = "flex:none;width:170px;display:inline-flex;align-items:center;gap:4px;";
  let mode = (initial && !cats.includes(initial)) ? "new" : "pick";
  let current = initial || "";

  const paint = () => {
    box.textContent = "";
    if (mode === "pick") {
      const sel = document.createElement("select"); sel.dataset.ctl = "1";
      sel.style.cssText = `flex:1;min-width:0;background:${SV.inset};border:1px solid ${SV.border2};color:${SV.text};border-radius:5px;padding:3px 6px;font:12px Arial,sans-serif;outline:none;cursor:pointer;`;
      sel.title = "Category for this preset";
      const none = document.createElement("option"); none.value = ""; none.textContent = "(uncategorized)";
      sel.appendChild(none);
      for (const c of cats) { const o = document.createElement("option"); o.value = c; o.textContent = c; sel.appendChild(o); }
      const nw = document.createElement("option"); nw.value = "\u0000new"; nw.textContent = "＋ New category…";
      sel.appendChild(nw);
      sel.value = cats.includes(current) ? current : "";
      sel.addEventListener("pointerdown", e => e.stopPropagation());
      sel.addEventListener("change", () => {
        if (sel.value === "\u0000new") { current = ""; mode = "new"; paint(); }
        else current = sel.value;
      });
      box.appendChild(sel);
    } else {
      const inp = svSmallInput("new category…", current);
      inp.style.cssText += "flex:1;min-width:0;";
      inp.addEventListener("input", () => { current = inp.value; });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") hooks?.submit?.();
        else if (e.key === "Escape") hooks?.cancel?.();
      });
      box.appendChild(inp);
      const back = document.createElement("span"); back.dataset.ctl = "1";
      back.textContent = "▾"; back.title = "Pick an existing category instead";
      back.style.cssText = `flex:none;cursor:pointer;color:${SV.mut};font-size:12px;padding:0 2px;`;
      back.addEventListener("mouseenter", () => back.style.color = SV.text);
      back.addEventListener("mouseleave", () => back.style.color = SV.mut);
      back.addEventListener("pointerdown", e => e.stopPropagation());
      back.addEventListener("click", (e) => { e.stopPropagation(); current = ""; mode = "pick"; paint(); });
      box.appendChild(back);
      setTimeout(() => inp.focus(), 0);
    }
  };
  paint();
  return { el: box, value: () => current.trim() };
}

let openThemeMenu = null;
function closeThemeMenu() { if (openThemeMenu) { openThemeMenu.dispose(); openThemeMenu = null; } }

function svExtButton() {
  const on = svShowExt();
  const b = document.createElement("button"); b.dataset.ctl = "1";
  b.title = on ? "Filenames show their extension — click to hide it"
               : "Filenames hide their extension — click to show it";
  b.style.cssText = `background:${on ? SV.btnBorder : SV.btn};border:1px solid ${on ? SV.accent : SV.btnBorder};` +
    `color:${on ? SV.text : SV.mut};border-radius:6px;padding:3px 8px;font:12px ui-monospace,monospace;` +
    `cursor:pointer;flex:none;display:inline-flex;align-items:center;gap:5px;`;
  // A dot, matching the power dial elsewhere — colour alone on a small label
  // was too subtle to read at a glance.
  const dot = document.createElement("span"); dot.textContent = "●";
  dot.style.cssText = `font-size:9px;line-height:1;color:${on ? SV.green : SV.mut};`;
  b.appendChild(dot);
  const lb = document.createElement("span"); lb.textContent = ".ext";
  b.appendChild(lb);
  b.addEventListener("mouseenter", () => { if (!on) b.style.background = SV.btnHover; });
  b.addEventListener("mouseleave", () => { b.style.background = on ? SV.btnBorder : SV.btn; });
  b.addEventListener("pointerdown", e => e.stopPropagation());
  b.addEventListener("click", (e) => { e.stopPropagation(); svSetShowExt(!svShowExt()); });
  return b;
}

function svThemeButton() {
  const b = document.createElement("button"); b.dataset.ctl = "1";
  b.title = "Panel theme";
  b.style.cssText = `background:${SV.btn};border:1px solid ${SV.btnBorder};color:${SV.btnText};border-radius:6px;` +
    `padding:3px 8px;font:12px Arial,sans-serif;cursor:pointer;flex:none;display:inline-flex;align-items:center;gap:6px;`;
  const sw = document.createElement("span");
  sw.style.cssText = `width:11px;height:11px;border-radius:3px;flex:none;background:${(SV_THEMES[svThemeName()] || SV_THEMES[SV_THEME_DEFAULT]).swatch};border:1px solid ${SV.text};display:inline-block;`;
  b.appendChild(sw);
  const lb = document.createElement("span"); lb.textContent = "Theme"; b.appendChild(lb);
  b.addEventListener("mouseenter", () => b.style.background = SV.btnHover);
  b.addEventListener("mouseleave", () => b.style.background = SV.btn);
  b.addEventListener("pointerdown", e => e.stopPropagation());
  b.addEventListener("click", (e) => {
    e.stopPropagation(); hideTip();
    if (openThemeMenu) { closeThemeMenu(); return; }
    const cur = svThemeName();
    const menu = document.createElement("div");
    menu.style.cssText = `position:fixed;z-index:10004;background:${SV.inset};border:1px solid ${SV.border2};border-radius:6px;` +
      `padding:4px;font:12px Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);min-width:150px;`;
    const r = b.getBoundingClientRect();
    menu.style.left = Math.round(Math.min(r.left, window.innerWidth - 170)) + "px";
    menu.style.top = Math.round(r.bottom + 5) + "px";
    for (const [key, t] of Object.entries(SV_THEMES)) {
      const row = document.createElement("div");
      const on = key === cur;
      row.style.cssText = `display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;cursor:pointer;color:${on ? SV.text : SV.dim};${on ? `background:${SV.rowOn};` : ""}`;
      const sw = document.createElement("span");
      sw.style.cssText = `flex:none;width:14px;height:14px;border-radius:3px;background:${t.swatch};border:1px solid ${SV.btnBorder};`;
      row.appendChild(sw);
      const lb = document.createElement("span"); lb.textContent = t.label; lb.style.flex = "1";
      row.appendChild(lb);
      if (on) { const ck = document.createElement("span"); ck.textContent = "✓"; ck.style.cssText = `color:${SV.accent};font-size:11px;`; row.appendChild(ck); }
      row.addEventListener("mouseenter", () => row.style.background = SV.rowHover);
      row.addEventListener("mouseleave", () => row.style.background = on ? SV.rowOn : "");
      row.addEventListener("pointerdown", ev => ev.stopPropagation());
      row.addEventListener("click", (ev) => { ev.stopPropagation(); closeThemeMenu(); svSetTheme(key); });
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    const away = (ev) => { if (!menu.contains(ev.target) && !b.contains(ev.target)) closeThemeMenu(); };
    setTimeout(() => window.addEventListener("pointerdown", away, true), 0);
    openThemeMenu = { dispose: () => { window.removeEventListener("pointerdown", away, true); menu.remove(); } };
  });
  return b;
}

// --- preset dropdown: favourites pinned, stars, lora counts ----------------
let openPresetMenu = null;
function closePresetMenu() { if (openPresetMenu) { openPresetMenu.dispose(); openPresetMenu = null; } }

function svPresetFavs() { return new Set(FLL_PREFS.favoritePresets || []); }
function svTogglePresetFav(name) {
  const f = svPresetFavs();
  f.has(name) ? f.delete(name) : f.add(name);
  savePrefs({ favoritePresets: [...f] });
}

function svOpenPresetDropdown(node, anchor, catFilter) {
  closePresetMenu();
  const list = svPresets || [];
  const menu = document.createElement("div");
  menu.style.cssText = `position:fixed;z-index:10004;background:${SV.inset};border:1px solid ${SV.border2};border-radius:6px;` +
    `min-width:260px;max-width:380px;max-height:320px;overflow:auto;font:12px Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);`;
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.round(Math.min(r.left, window.innerWidth - 390)) + "px";
  menu.style.top = Math.round(r.bottom + 4) + "px";

  const build = () => {
    menu.textContent = "";
    const favs = svPresetFavs();
    const shown = list.filter(p => catFilter == null || (p.category || "") === catFilter);
    if (!shown.length) {
      const em = document.createElement("div");
      em.textContent = list.length ? "No presets in this category" : "No presets saved yet";
      em.style.cssText = `padding:10px;font-size:11px;color:${SV.ghost};font-style:italic;`;
      menu.appendChild(em); return;
    }
    const hdr = (t) => {
      const h = document.createElement("div"); h.textContent = t;
      h.style.cssText = `padding:5px 10px 3px;font-size:10px;letter-spacing:.06em;color:${SV.faint};position:sticky;top:0;background:${SV.inset};border-bottom:1px solid ${SV.border2};`;
      menu.appendChild(h);
    };
    const row = (p) => {
      const sel = p.name === node.__svPresetName;
      const el = document.createElement("div");
      el.style.cssText = `display:flex;align-items:center;gap:8px;padding:5px 10px;cursor:pointer;border-bottom:1px solid ${SV.border2};` +
        (sel ? `background:${SV.rowOn};` : "");
      const star = document.createElement("span");
      const isFav = favs.has(p.name);
      star.textContent = isFav ? "★" : "☆";
      star.title = isFav ? "Unfavorite" : "Favorite (pins to the top)";
      star.style.cssText = `flex:none;font-size:12px;cursor:pointer;color:${isFav ? "#e0c04c" : SV.ghost};`;
      star.addEventListener("pointerdown", e => e.stopPropagation());
      star.addEventListener("click", (e) => { e.stopPropagation(); svTogglePresetFav(p.name); build(); node.__lflRender?.(); });
      el.appendChild(star);
      const nm = document.createElement("span"); nm.textContent = p.name;
      nm.style.cssText = `flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${sel ? SV.text : SV.dim};`;
      el.appendChild(nm);
      if (p.count != null) {
        const c = document.createElement("span"); c.textContent = String(p.count);
        c.style.cssText = `flex:none;font:10px ui-monospace,monospace;color:${SV.faint};`;
        el.appendChild(c);
      }
      if (sel) { const ck = document.createElement("span"); ck.textContent = "✓"; ck.style.cssText = `flex:none;color:${SV.accent};font-size:11px;`; el.appendChild(ck); }
      el.addEventListener("mouseenter", () => el.style.background = SV.rowHover);
      el.addEventListener("mouseleave", () => el.style.background = sel ? SV.rowOn : "");
      el.addEventListener("pointerdown", e => e.stopPropagation());
      el.addEventListener("click", (e) => {
        e.stopPropagation(); closePresetMenu();
        node.__svPresetName = p.name; node.__svPresetCat = p.category || "";
        node.__svCleanSig = null;          // nothing loaded yet — not "clean"
        node.__lflRender?.();
      });
      menu.appendChild(el);
    };
    const fav = shown.filter(p => favs.has(p.name));
    const rest = shown.filter(p => !favs.has(p.name));
    if (fav.length) { hdr("★ FAVORITES"); fav.forEach(row); }
    if (rest.length) {
      if (catFilter == null) {
        let lastCat = null;
        if (fav.length) { /* section headers below carry the labels */ }
        for (const p of rest) {
          const c = p.category || "(uncategorized)";
          if (c !== lastCat) { lastCat = c; hdr(c.toUpperCase()); }
          row(p);
        }
      } else { if (fav.length) hdr("ALL"); rest.forEach(row); }
    }
  };
  build();
  document.body.appendChild(menu);
  const away = (ev) => { if (!menu.contains(ev.target) && !anchor.contains(ev.target)) closePresetMenu(); };
  setTimeout(() => window.addEventListener("pointerdown", away, true), 0);
  openPresetMenu = { dispose: () => { window.removeEventListener("pointerdown", away, true); menu.remove(); } };
}

// --- the bar ---------------------------------------------------------------
function svPresetRow(node) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;";

  if (node.__svPresetMode === "save")   return svPresetSaveForm(node, wrap);
  if (node.__svPresetMode === "rename") return svPresetRenameForm(node, wrap);
  if (node.__svPresetMode === "delete") return svPresetDeleteForm(node, wrap);
  if (node.__svPresetMode === "overwrite") return svPresetOverwriteForm(node, wrap);
  if (node.__svPresetMode === "duplicate") return svPresetDuplicateForm(node, wrap);

  const tag = document.createElement("span"); tag.textContent = "PRESET";
  tag.style.cssText = `font-size:10px;letter-spacing:.08em;color:${SV.faint};flex:none;`;
  wrap.appendChild(tag);

  if (svPresets == null) {
    svPresetApi("").then(d => { svPresets = d.presets || []; node.__lflRender?.(); }).catch(() => { svPresets = []; });
  }
  const list = svPresets || [];
  const cats = [...new Set(list.map(p => p.category || ""))].sort();

  // category filter (native select — no extra affordances needed)
  const catSel = document.createElement("select"); catSel.dataset.ctl = "1";
  catSel.style.cssText = `flex:none;width:150px;background:${SV.inset};border:1px solid ${SV.border2};color:${SV.text};border-radius:5px;padding:3px 6px;font:12px Arial,sans-serif;outline:none;cursor:pointer;`;
  catSel.title = "Filter presets by category";
  const oAll = document.createElement("option"); oAll.value = "*"; oAll.textContent = "all categories"; catSel.appendChild(oAll);
  for (const c of cats) { const o = document.createElement("option"); o.value = c; o.textContent = c || "(uncategorized)"; catSel.appendChild(o); }
  catSel.value = (node.__svPresetCatFilter != null && cats.includes(node.__svPresetCatFilter)) ? node.__svPresetCatFilter : "*";
  catSel.addEventListener("pointerdown", e => e.stopPropagation());
  catSel.addEventListener("change", () => { node.__svPresetCatFilter = catSel.value === "*" ? null : catSel.value; node.__lflRender?.(); });
  wrap.appendChild(catSel);

  // preset picker (custom, so favourites + stars fit inside)
  const dirty = svIsDirty(node);
  const pick = document.createElement("div"); pick.dataset.ctl = "1";
  pick.style.cssText = `flex:1;min-width:150px;display:flex;align-items:center;gap:6px;background:${SV.inset};border:1px solid ${SV.border2};border-radius:5px;padding:3px 7px;cursor:pointer;`;
  const pn = document.createElement("span");
  pn.textContent = node.__svPresetName ? (node.__svPresetName + (dirty ? " (modified)" : "")) : "load preset…";
  pn.style.cssText = `flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;` +
    (node.__svPresetName
      ? (dirty ? `color:#e0a94c;font-style:italic;` : `color:${SV.text};`)
      : `color:${SV.ghost};`);
  pick.appendChild(pn);
  const car = document.createElement("span"); car.textContent = "▾";
  car.style.cssText = `flex:none;color:${SV.mut};font-size:11px;`; pick.appendChild(car);
  pick.title = dirty
    ? "The stack has changed since this preset was loaded — Save to update it"
    : "Choose a preset, then Load or + Add to stack";
  pick.addEventListener("pointerdown", e => e.stopPropagation());
  pick.addEventListener("click", (e) => { e.stopPropagation(); hideTip(); svOpenPresetDropdown(node, pick, node.__svPresetCatFilter); });
  wrap.appendChild(pick);

  // favourite toggle for the selected preset
  if (node.__svPresetName) {
    const isFav = svPresetFavs().has(node.__svPresetName);
    const st = document.createElement("span"); st.dataset.ctl = "1";
    st.textContent = isFav ? "★" : "☆";
    st.title = isFav ? "Unfavorite this preset" : "Favorite this preset";
    st.style.cssText = `flex:none;cursor:pointer;font-size:15px;line-height:1;padding:0 2px;color:${isFav ? "#e0c04c" : SV.mut};`;
    st.addEventListener("pointerdown", e => e.stopPropagation());
    st.addEventListener("click", (e) => { e.stopPropagation(); svTogglePresetFav(node.__svPresetName); node.__lflRender?.(); });
    wrap.appendChild(st);
  }

  const hasSel = !!node.__svPresetName;
  const load = svBtn("Load", hasSel ? "Replace the stack (and folder filter + chains) with this preset" : "Choose a preset first", async () => {
    if (!hasSel) { svToast("Choose a preset first.", true); return; }
    try {
      const d = await svPresetApi("/load", { name: node.__svPresetName });
      svApplyPreset(node, d);
    } catch (err) { svToast(String(err.message || err), true); }
  });
  load.style.padding = "3px 10px";
  if (!hasSel) { load.style.opacity = ".4"; }
  wrap.appendChild(load);

  const add = svBtn("+ Add to stack", hasSel ? "Merge this preset's loras into the current stack" : "Choose a preset first", async () => {
    if (!hasSel) { svToast("Choose a preset first.", true); return; }
    try {
      const d = await svPresetApi("/load", { name: node.__svPresetName });
      const res = svMergeIntoStack(node, d.loras || []);
      node.__lflCommit();
      const bits = [`Added ${res.added} lora${res.added === 1 ? "" : "s"}`];
      if (res.dupes) bits.push(`${res.dupes} already in stack`);
      if (res.dropped) bits.push(`${res.dropped} didn't fit (12 slot limit)`);
      if ((d.missing || []).length) bits.push(`${d.missing.length} missing from disk`);
      svToast(bits.join(" · "), !!(res.dropped || (d.missing || []).length));
    } catch (err) { svToast(String(err.message || err), true); }
  });
  add.style.padding = "3px 10px";
  if (hasSel) { add.style.borderColor = SV.accent; add.style.color = SV.badgeFg; } else { add.style.opacity = ".4"; }
  wrap.appendChild(add);

  const save = svBtn("Save", dirty ? "Save the changed stack" : "Save the current stack as a preset", () => {
    node.__svPresetMode = "save"; node.__lflRender?.();
  });
  save.style.padding = "3px 10px";
  if (dirty) { save.style.borderColor = "#e0a94c"; save.style.color = "#e0a94c"; }
  wrap.appendChild(save);

  // ⋮ menu — the things you do TO a preset
  const dots = svBtn("⋮", "Preset actions", (e) => {
    if (!hasSel) { svToast("Choose a preset first.", true); return; }
    svOpenPresetActions(node, e.currentTarget);
  });
  dots.style.padding = "3px 7px";
  if (!hasSel) dots.style.opacity = ".4";
  wrap.appendChild(dots);
  return wrap;
}

let openPresetActions = null;
function closePresetActions() { if (openPresetActions) { openPresetActions.dispose(); openPresetActions = null; } }

function svOpenPresetActions(node, anchor) {
  closePresetActions();
  const menu = document.createElement("div");
  menu.style.cssText = `position:fixed;z-index:10004;background:${SV.inset};border:1px solid ${SV.border2};border-radius:6px;` +
    `padding:4px;min-width:210px;font:12px Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);`;
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.round(Math.min(r.left - 150, window.innerWidth - 230)) + "px";
  menu.style.top = Math.round(r.bottom + 4) + "px";
  const item = (label, title, danger, fn) => {
    const el = document.createElement("div");
    el.textContent = label; el.title = title || "";
    el.style.cssText = `padding:5px 8px;border-radius:4px;cursor:pointer;color:${danger ? SV.danger : SV.text};` +
      (danger ? `border-top:1px solid ${SV.border2};margin-top:3px;padding-top:7px;` : "");
    el.addEventListener("mouseenter", () => el.style.background = SV.rowHover);
    el.addEventListener("mouseleave", () => el.style.background = "");
    el.addEventListener("pointerdown", e => e.stopPropagation());
    el.addEventListener("click", (e) => { e.stopPropagation(); closePresetActions(); fn(); });
    menu.appendChild(el);
  };
  item("Overwrite with current stack", "Update this preset to match what's on the node now", false, async () => {
    try {
      const d = await svPresetApi("/save", {
        name: node.__svPresetName, category: node.__svPresetCat || "",
        overwrite: true,
        loras: svPresetLoras(node), enabledFolders: effectiveEnabledFoldersArray(node),
        chains: flgChainCount(node),
      });
      svPresets = d.presets || svPresets;
      svMarkClean(node, d.name, node.__svPresetCat);
      svToast(`Updated “${d.name}”`);
      node.__lflRender?.();
    } catch (err) { svToast(String(err.message || err), true); }
  });
  item("Duplicate…", "Save a copy of this preset under a new name", false, () => {
    node.__svDupSource = node.__svPresetName;
    node.__svPresetMode = "duplicate"; node.__lflRender?.();
  });
  item("Rename…", "", false, () => { node.__svPresetMode = "rename"; node.__lflRender?.(); });
  item("Delete preset", "", true, () => { node.__svPresetMode = "delete"; node.__lflRender?.(); });
  document.body.appendChild(menu);
  const away = (ev) => { if (!menu.contains(ev.target)) closePresetActions(); };
  setTimeout(() => window.addEventListener("pointerdown", away, true), 0);
  openPresetActions = { dispose: () => { window.removeEventListener("pointerdown", away, true); menu.remove(); } };
}

// The stack as it should be stored, honouring any pending "freeze randomizers"
// choice made in the save form.
function svPresetLoras(node, freezeRandom) {
  return (node.__loraStack || []).map(e => {
    const out = { on: e.on !== false, name: e.name || "", model: Number(e.model ?? 1), clip: Number(e.clip ?? e.model ?? 1) };
    if (e.targets && typeof e.targets === "object") out.targets = e.targets;
    if (e.random && !freezeRandom) {
      out.random = true; out.locked = !!e.locked; out.autoRoll = !!e.autoRoll;
      out.folders = Array.isArray(e.folders) ? e.folders : null;
    }
    return out;
  });
}

function svPresetSaveForm(node, wrap) {
  const tag = document.createElement("span"); tag.textContent = "SAVE AS";
  tag.style.cssText = `font-size:10px;letter-spacing:.08em;color:${SV.faint};flex:none;`;
  wrap.appendChild(tag);
  const cats = [...new Set((svPresets || []).map(p => p.category).filter(Boolean))].sort();
  const catHooks = {};
  const catField = svCategoryField(cats, node.__svPresetCat || "", catHooks);
  wrap.appendChild(catField.el);
  const nameIn = svSmallInput("preset name…", node.__svPresetName || "");
  nameIn.style.cssText += "flex:1;min-width:170px;";
  wrap.appendChild(nameIn);

  const randCount = (node.__loraStack || []).filter(e => e.random).length;
  let freeze = !!node.__svFreezeRandom;

  const cancelSave = () => { node.__svPresetMode = null; node.__svFreezeRandom = false; node.__lflRender?.(); };
  const doSave = async (overwrite) => {
    const name = nameIn.value.trim();
    if (!name) { svToast("Give the preset a name.", true); nameIn.focus(); return; }
    try {
      const d = await svPresetApi("/save", {
        name, category: catField.value(), overwrite: !!overwrite,
        loras: svPresetLoras(node, freeze),
        enabledFolders: effectiveEnabledFoldersArray(node),
        chains: flgChainCount(node),
      });
      svPresets = d.presets || svPresets;
      svMarkClean(node, d.name, catField.value());
      node.__svPresetMode = null; node.__svFreezeRandom = false;
      svToast(`Saved “${d.name}” (${d.count} lora${d.count === 1 ? "" : "s"})`);
      node.__lflRender?.();
    } catch (err) {
      const msg = String(err.message || err);
      if (err.code === "exists") {
        node.__svOverwritePrompt = nameIn.value.trim();
        node.__svPresetCat = catField.value();
        node.__svPresetMode = "overwrite"; node.__lflRender?.();
      } else svToast(msg, true);
    }
  };
  catHooks.submit = () => doSave(false); catHooks.cancel = cancelSave;
  nameIn.addEventListener("keydown", e => { if (e.key === "Enter") doSave(false); if (e.key === "Escape") cancelSave(); });

  const ok = svBtn("Save", "Save this preset", () => doSave(false)); ok.style.padding = "3px 10px";
  wrap.appendChild(ok);
  const cancel = svBtn("Cancel", "", cancelSave); cancel.style.padding = "3px 10px";
  wrap.appendChild(cancel);

  if (randCount) {
    const line = document.createElement("div");
    line.style.cssText = `flex-basis:100%;display:flex;align-items:center;gap:7px;margin-top:6px;padding:5px 8px;background:${SV.inset};border:1px solid ${SV.purpleBorder};border-radius:5px;`;
    const txt = document.createElement("span");
    txt.textContent = `🎲 ${randCount} randomizer slot${randCount === 1 ? "" : "s"} — convert to static for this preset?`;
    txt.style.cssText = `flex:1;min-width:0;font-size:11px;color:${SV.dim};`;
    line.appendChild(txt);
    const mk = (label, val, title) => {
      const b = document.createElement("span"); b.dataset.ctl = "1";
      b.textContent = label; b.title = title;
      const on = freeze === val;
      b.style.cssText = `flex:none;cursor:pointer;font-size:11px;border-radius:4px;padding:2px 9px;` +
        (on ? `background:${SV.btnBorder};border:1px solid ${SV.accent};color:${SV.text};`
            : `background:${SV.btn};border:1px solid ${SV.btnBorder};color:${SV.mut};`);
      b.addEventListener("pointerdown", e => e.stopPropagation());
      b.addEventListener("click", (e) => { e.stopPropagation(); freeze = val; node.__svFreezeRandom = val; node.__lflRender?.(); });
      return b;
    };
    line.appendChild(mk("Keep random", false, "Store them as randomizer slots that re-roll"));
    line.appendChild(mk("Yes, convert", true, "Store the currently selected lora as a normal lora, at the same strength"));
    wrap.appendChild(line);
  }
  setTimeout(() => nameIn.focus(), 0);
  return wrap;
}

function svPresetOverwriteForm(node, wrap) {
  const name = node.__svOverwritePrompt || "";
  const q = document.createElement("span");
  q.textContent = `“${name}” already exists — overwrite it?`;
  q.style.cssText = `font-size:12px;color:#e0a94c;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
  wrap.appendChild(q);
  const yes = svBtn("Overwrite", "Replace the saved preset with the current stack", async () => {
    try {
      const d = await svPresetApi("/save", {
        name, category: node.__svPresetCat || "", overwrite: true,
        loras: svPresetLoras(node, !!node.__svFreezeRandom),
        enabledFolders: effectiveEnabledFoldersArray(node),
        chains: flgChainCount(node),
      });
      svPresets = d.presets || svPresets;
      svMarkClean(node, d.name, node.__svPresetCat);
      node.__svPresetMode = null; node.__svFreezeRandom = false;
      svToast(`Updated “${d.name}”`);
      node.__lflRender?.();
    } catch (err) { svToast(String(err.message || err), true); }
  });
  yes.style.padding = "3px 10px"; yes.style.borderColor = "#e0a94c"; yes.style.color = "#e0a94c";
  wrap.appendChild(yes);
  const back = svBtn("Rename", "Go back and pick a different name", () => { node.__svPresetMode = "save"; node.__lflRender?.(); });
  back.style.padding = "3px 10px"; wrap.appendChild(back);
  const no = svBtn("Cancel", "", () => { node.__svPresetMode = null; node.__svFreezeRandom = false; node.__lflRender?.(); });
  no.style.padding = "3px 10px"; wrap.appendChild(no);
  return wrap;
}

function svPresetDuplicateForm(node, wrap) {
  const src = node.__svDupSource || node.__svPresetName || "";
  const tag = document.createElement("span"); tag.textContent = "COPY OF";
  tag.style.cssText = `font-size:10px;letter-spacing:.08em;color:${SV.faint};flex:none;`;
  wrap.appendChild(tag);
  const from = document.createElement("span"); from.textContent = src;
  from.style.cssText = `flex:none;max-width:130px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:${SV.dim};`;
  wrap.appendChild(from);

  const cats = [...new Set((svPresets || []).map(p => p.category).filter(Boolean))].sort();
  const hooks = {};
  const catField = svCategoryField(cats, node.__svPresetCat || "", hooks);
  wrap.appendChild(catField.el);

  // Pre-fill with a name that won't collide, so Enter just works.
  const taken = new Set((svPresets || []).map(p => p.name));
  let suggestion = `${src} copy`;
  for (let i = 2; taken.has(suggestion); i++) suggestion = `${src} copy ${i}`;
  const nameIn = svSmallInput("name for the copy…", suggestion);
  nameIn.style.cssText += "flex:1;min-width:170px;";
  wrap.appendChild(nameIn);

  const cancel = () => { node.__svPresetMode = null; node.__svDupSource = null; node.__lflRender?.(); };
  const apply = async () => {
    const nn = nameIn.value.trim();
    if (!nn) { svToast("Give the copy a name.", true); nameIn.focus(); return; }
    if (nn === src) { svToast("Pick a different name for the copy.", true); nameIn.focus(); return; }
    try {
      const d = await svPresetApi("/duplicate", { name: src, newName: nn, category: catField.value() });
      svPresets = d.presets || svPresets;
      // Select the copy. The stack is untouched, so its clean/dirty state
      // carries over unchanged — the copy has identical contents.
      node.__svPresetName = d.name; node.__svPresetCat = catField.value();
      node.__svPresetMode = null; node.__svDupSource = null;
      svToast(`Duplicated as “${d.name}”`);
      node.__lflRender?.();
    } catch (err) {
      svToast(err.code === "exists" ? `“${nn}” already exists — pick another name.` : String(err.message || err), true);
      nameIn.focus();
    }
  };
  hooks.submit = apply; hooks.cancel = cancel;
  nameIn.addEventListener("keydown", e => { if (e.key === "Enter") apply(); if (e.key === "Escape") cancel(); });
  const ok = svBtn("Duplicate", "Save the copy", apply); ok.style.padding = "3px 10px"; wrap.appendChild(ok);
  const no = svBtn("Cancel", "", cancel); no.style.padding = "3px 10px"; wrap.appendChild(no);
  setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
  return wrap;
}

function svPresetRenameForm(node, wrap) {
  const tag = document.createElement("span"); tag.textContent = "RENAME";
  tag.style.cssText = `font-size:10px;letter-spacing:.08em;color:${SV.faint};flex:none;`;
  wrap.appendChild(tag);
  const cats = [...new Set((svPresets || []).map(p => p.category).filter(Boolean))].sort();
  const hooks = {};
  const catField = svCategoryField(cats, node.__svPresetCat || "", hooks);
  wrap.appendChild(catField.el);
  const nameIn = svSmallInput("preset name…", node.__svPresetName || "");
  nameIn.style.cssText += "flex:1;min-width:170px;";
  wrap.appendChild(nameIn);
  const cancel = () => { node.__svPresetMode = null; node.__lflRender?.(); };
  const apply = async () => {
    const nn = nameIn.value.trim();
    if (!nn) { svToast("Give the preset a name.", true); return; }
    try {
      const d = await svPresetApi("/update", { name: node.__svPresetName, newName: nn, category: catField.value() });
      svPresets = d.presets || svPresets;
      // carry the favourite across a rename
      const f = svPresetFavs();
      if (f.has(node.__svPresetName) && d.name !== node.__svPresetName) {
        f.delete(node.__svPresetName); f.add(d.name); savePrefs({ favoritePresets: [...f] });
      }
      node.__svPresetName = d.name; node.__svPresetCat = catField.value();
      node.__svPresetMode = null;
      svToast(`Renamed to “${d.name}”`);
      node.__lflRender?.();
    } catch (err) { svToast(String(err.message || err), true); }
  };
  hooks.submit = apply; hooks.cancel = cancel;
  nameIn.addEventListener("keydown", e => { if (e.key === "Enter") apply(); if (e.key === "Escape") cancel(); });
  const ok = svBtn("Rename", "", apply); ok.style.padding = "3px 10px"; wrap.appendChild(ok);
  const no = svBtn("Cancel", "", cancel); no.style.padding = "3px 10px"; wrap.appendChild(no);
  setTimeout(() => nameIn.focus(), 0);
  return wrap;
}

function svPresetDeleteForm(node, wrap) {
  const q = document.createElement("span");
  q.textContent = `Delete preset “${node.__svPresetName}”?`;
  q.style.cssText = `font-size:12px;color:${SV.danger};flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
  wrap.appendChild(q);
  const yes = svBtn("Delete", "Delete permanently", async () => {
    const name = node.__svPresetName;
    try {
      const d = await svPresetApi("/delete", { name });
      svPresets = d.presets || [];
      const f = svPresetFavs(); if (f.delete(name)) savePrefs({ favoritePresets: [...f] });
      node.__svPresetName = ""; node.__svCleanSig = null; node.__svPresetMode = null;
      svToast(`Deleted “${name}”`);
      node.__lflRender?.();
    } catch (err) { svToast(String(err.message || err), true); node.__svPresetMode = null; node.__lflRender?.(); }
  });
  yes.style.padding = "3px 10px"; yes.style.color = SV.danger; yes.style.borderColor = "#4a2a2a";
  wrap.appendChild(yes);
  const no = svBtn("Cancel", "", () => { node.__svPresetMode = null; node.__lflRender?.(); });
  no.style.padding = "3px 10px"; wrap.appendChild(no);
  return wrap;
}

// Plotter controls row: strength-mode segment, global-strengths editor, the
// control-image toggle, and the Global Lora node spawn/connected state.
function svPlotControlsRow(node, globalMode) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;align-items:center;gap:7px;flex-wrap:wrap;";

  const tag = document.createElement("span"); tag.textContent = "SWEEP";
  tag.style.cssText = `font-size:10px;letter-spacing:.08em;color:${SV.faint};flex:none;`;
  wrap.appendChild(tag);

  // -- mode segment: Per-line | Global --
  const seg = document.createElement("span"); seg.dataset.ctl = "1";
  seg.style.cssText = `flex:none;display:inline-flex;border:1px solid ${SV.btnBorder};border-radius:6px;overflow:hidden;`;
  const mkSeg = (label, mode, title) => {
    const b = document.createElement("span");
    const on = (node.__plotMode === "global") === (mode === "global");
    b.textContent = label; b.title = title;
    b.style.cssText = `padding:3px 10px;font-size:12px;cursor:pointer;user-select:none;` +
      (on ? `background:${SV.btnBorder};color:${SV.text};` : `background:${SV.btn};color:${SV.mut};`);
    b.addEventListener("pointerdown", e => e.stopPropagation());
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if ((node.__plotMode === "global") === (mode === "global")) return;
      node.__plotMode = mode;
      syncData(node); node.__lflRender?.(); node.setDirtyCanvas(true, true);
    });
    return b;
  };
  seg.appendChild(mkSeg("Per-line", "perline", "Each lora line sweeps at its own strength"));
  seg.appendChild(mkSeg("Global", "global", "Every lora line runs once at each global strength"));
  wrap.appendChild(seg);

  // -- global strengths editor (only meaningful in global mode) --
  const gs = node.__globalStrengths || [];
  const gsBtn = svBtn(
    "🎚 " + (gs.length ? gs.join(", ") : "set strengths…"),
    globalMode ? "The strengths every lora is tested at (loras × strengths = images)" : "Switch to Global mode to use shared strengths",
    (e) => { if (globalMode) showGlobalStrengthsPanel(node, e); }
  );
  gsBtn.style.padding = "3px 10px";
  if (!globalMode) { gsBtn.style.opacity = ".4"; gsBtn.style.cursor = "default"; }
  wrap.appendChild(gsBtn);

  const sp = document.createElement("span"); sp.style.flex = "1"; wrap.appendChild(sp);

  // -- control image toggle (disabled while a Global Lora node drives it) --
  const glConnected = !!node.__globalLoraConnected;
  const ctrl = document.createElement("span"); ctrl.dataset.ctl = "1";
  const ctrlOn = !!node.__controlImage && !glConnected;
  ctrl.style.cssText = `flex:none;display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:6px;font-size:12px;user-select:none;` +
    (glConnected
      ? `border:1px dashed ${SV.dashed};color:${SV.ghost};cursor:default;`
      : `border:1px solid ${ctrlOn ? SV.accent : SV.btnBorder};background:${SV.btn};color:${ctrlOn ? SV.text : SV.mut};cursor:pointer;`);
  const cd = document.createElement("span"); cd.textContent = "●";
  cd.style.cssText = `font-size:11px;color:${glConnected ? SV.ghost : (ctrlOn ? SV.green : SV.mut)};`;
  ctrl.appendChild(cd);
  const cl = document.createElement("span");
  cl.textContent = glConnected ? "Control via Global node" : "Control image";
  ctrl.appendChild(cl);
  ctrl.title = glConnected
    ? "The connected Global Lora node decides the control images"
    : "Adds one baseline image with no loras applied (the raw base model)";
  if (!glConnected) {
    ctrl.addEventListener("pointerdown", e => e.stopPropagation());
    ctrl.addEventListener("click", (e) => {
      e.stopPropagation();
      node.__controlImage = !node.__controlImage;
      syncData(node); node.__lflRender?.(); node.setDirtyCanvas(true, true);
    });
  }
  wrap.appendChild(ctrl);

  // -- global lora spawn / status --
  const gl = svBtn(
    glConnected ? "🌐 Global Lora connected" : "🌐 Add Global Lora",
    glConnected
      ? "A Global Lora node is wired into global_loras — its loras apply on top of every image"
      : "Adds a Global Lora node and wires it in; its loras apply on top of every plotted image",
    () => { if (!glConnected) { try { spawnConnectedGlobalLora(node); } catch (err) { console.warn("[FantasticLoraLoader] add global lora failed", err); } } }
  );
  gl.style.padding = "3px 10px";
  if (glConnected) { gl.style.opacity = ".55"; gl.style.cursor = "default"; }
  wrap.appendChild(gl);

  return wrap;
}

// Whether lora filenames keep their .safetensors/.ckpt/etc extension on screen.
// Browser preference, shared by every node, like the theme.
function svShowExt() { return !!FLL_PREFS.showExt; }
function svSetShowExt(on) { savePrefs({ showExt: !!on }); repaintSlotNodes(); }
// A lora's display filename, honouring the extension preference.
function svFileLabel(name) {
  const i = (name || "").lastIndexOf("/");
  const file = i >= 0 ? name.slice(i + 1) : (name || "");
  return svShowExt() ? file : file.replace(/\.(safetensors|ckpt|sft|pt|pth|gguf|bin)$/i, "");
}

// A strict fingerprint of everything a preset stores: the lora list (order,
// strengths, enable states, routing, randomizer flags), the folder filter, and
// the chain count. Load applies all three, so all three have to count towards
// "modified" — otherwise changing the folder filter after loading would be
// written silently on the next Save with no warning.
function svStackSignature(stack) {
  return JSON.stringify((stack || []).map(e => [
    e.name || "", e.on !== false, Number(e.model ?? 1),
    e.targets && typeof e.targets === "object"
      ? Object.keys(e.targets).sort().map(k => [k, Number(e.targets[k])])
      : null,
    !!e.random, !!e.locked, !!e.autoRoll,
  ]));
}

function svStateSignature(node) {
  let folders = null;
  try {
    const arr = effectiveEnabledFoldersArray(node);
    folders = arr == null ? null : [...arr].map(normPath).sort();
  } catch (_) {}
  let chains = 1;
  try { chains = flgChainCount(node); } catch (_) {}
  return JSON.stringify([svStackSignature(node.__loraStack), folders, chains]);
}

function svMarkClean(node, name, category) {
  node.__svPresetName = name || "";
  node.__svPresetCat = category || "";
  node.__svCleanSig = svStateSignature(node);
}
function svIsDirty(node) {
  // No preset selected, or one selected but never loaded/saved: there's no
  // baseline to differ from, so nothing is "modified".
  if (!node.__svPresetName || node.__svCleanSig == null) return false;
  return node.__svCleanSig !== svStateSignature(node);
}

// Merge a preset's loras into the current stack without disturbing anything
// else. Skips loras already present, clamps routing to the chains that exist,
// and stops at the slot cap.
function svMergeIntoStack(node, loras) {
  const stack = node.__loraStack || (node.__loraStack = []);
  const chains = flgChainCount(node);
  const have = new Set(stack.filter(e => !e.random && e.name).map(e => e.name));
  let added = 0, dupes = 0, dropped = 0, retargeted = 0;

  for (const src of (loras || [])) {
    if (!src || typeof src !== "object") continue;
    if (stack.length >= SLOT_MAX) { dropped++; continue; }
    if (!src.random && src.name && have.has(src.name)) { dupes++; continue; }

    const strength = Number(src.model ?? 1);
    const e = { on: src.on !== false, name: src.name || "", model: strength, clip: strength };

    // Routing: keep only chains that exist here. Chains the preset never
    // mentioned default to 1.0 rather than being left unrouted.
    if (src.targets && typeof src.targets === "object") {
      const t = {};
      let kept = 0;
      for (const k of Object.keys(src.targets)) {
        const c = Number(k);
        if (c >= 1 && c <= chains) { t[c] = Number(src.targets[k]); kept++; }
      }
      if (!kept) { retargeted++; }        // nothing survived -> uniform
      else {
        for (let c = 1; c <= chains; c++) if (t[c] == null) { t[c] = 1.0; retargeted++; }
        e.targets = t;
      }
    }

    if (src.random) {
      e.random = true; e.locked = !!src.locked; e.autoRoll = !!src.autoRoll;
      e.folders = Array.isArray(src.folders) ? src.folders : null;
    } else if (src.name) {
      have.add(src.name);
    }
    stack.push(e); added++;
  }
  return { added, dupes, dropped, retargeted };
}

function svSlotRows(node) { return Math.ceil(SLOT_MAX / SLOT_COLS); }
const SV_SLOT_H = 60, SV_GAP = 7;

// The DOM widget's height. A static estimate can't account for fonts/wrapping,
// so renderSlotView measures the real panel after paint and stores it here;
// the estimate is only used for the very first layout pass.
function svViewHeight(node) {
  if (node.__svMeasuredH) return node.__svMeasuredH;
  const chains = flgChainCount(node);
  const rows = svSlotRows(node);
  const grid = rows * SV_SLOT_H + (rows - 1) * SV_GAP;
  const isPlot = !!node.__isPlotter;
  const strip = 34, second = 33, folders = 35, header = 19, chrome = 24;
  const extra = isPlot ? 33 : 0;                 // plotter has sweep AND preset rows
  const footer = 24 + 14 + chains * 15 + (isPlot ? 15 : 0);   // plotter adds the sweep-count line
  return strip + second + extra + folders + header + grid + footer + chrome;
}

function renderSlotView(node, root) {
  root.textContent = "";
  root.style.cssText = "display:flex;flex-direction:column;gap:0;font:12px Arial,sans-serif;color:#ddd;width:100%;box-sizing:border-box;padding:2px 0;";
  const stack = node.__loraStack || (node.__loraStack = []);
  const chains = flgChainCount(node);
  const maxChains = 1 + MAX_EXTRA_MODELS;
  const isPlot = !!node.__isPlotter;
  const globalMode = isPlot && node.__plotMode === "global";

  const panel = document.createElement("div");
  panel.style.cssText = `background:${SV.panel};border:1px solid ${SV.border};border-radius:8px;padding:9px;box-sizing:border-box;`;
  root.appendChild(panel);

  // ---- top strip ----
  const strip = document.createElement("div");
  strip.style.cssText = "display:flex;align-items:center;gap:7px;margin-bottom:8px;";
  const addBtn = svBtn("Add lora…", stack.length >= SLOT_MAX ? "All 12 slots are full" : "Pick a lora from the enabled folders", (e) => {
    if (stack.length >= SLOT_MAX) return;
    showLoraChooser(node, e, value => { stack.push({ on: true, name: value, model: 1.0, clip: 1.0 }); node.__lflCommit(); });
  });
  if (stack.length >= SLOT_MAX) { addBtn.style.opacity = ".4"; addBtn.style.cursor = "default"; }
  strip.appendChild(addBtn);
  const rndBtn = svBtn("🎲 Add random", stack.length >= SLOT_MAX ? "All 12 slots are full" : "Add a randomizer slot", async () => {
    if (stack.length >= SLOT_MAX) return;
    const ne = { on: true, name: "", model: 1.0, clip: 1.0, random: true, locked: false, autoRoll: false, folders: null };
    const pick = await pickRandomLora(node, ne); if (pick != null) ne.name = pick;
    stack.push(ne); node.__lflCommit();
  });
  if (stack.length >= SLOT_MAX) { rndBtn.style.opacity = ".4"; rndBtn.style.cursor = "default"; }
  strip.appendChild(rndBtn);
  const sp = document.createElement("span"); sp.style.flex = "1"; strip.appendChild(sp);
  const cnt = document.createElement("span");
  cnt.textContent = `${stack.length} / ${SLOT_MAX}`;
  cnt.style.cssText = `font:11px ui-monospace,monospace;color:${SV.mut};flex:none;`;
  strip.appendChild(cnt);
  const sdot = document.createElement("span"); sdot.textContent = "·"; sdot.style.cssText = `color:${SV.mut};flex:none;`; strip.appendChild(sdot);
  const ch = document.createElement("span");
  ch.innerHTML = `chains <span style="font-family:ui-monospace,monospace;color:${SV.dim}">${chains}/${maxChains}</span>`;
  ch.style.cssText = `font-size:11px;color:${SV.mut};flex:none;`;
  strip.appendChild(ch);
  const minus = svBtn("−", "Remove last chain", () => { if (chains > 1) removeModelPair(node); });
  minus.style.padding = "1px 7px"; if (chains <= 1) { minus.style.opacity = ".35"; minus.style.cursor = "default"; }
  strip.appendChild(minus);
  const plus = svBtn("+", "Add a model chain", () => { if (chains < maxChains) addModelPair(node); });
  plus.style.padding = "1px 7px"; if (chains >= maxChains) { plus.style.opacity = ".35"; plus.style.cursor = "default"; }
  strip.appendChild(plus);
  strip.appendChild(svExtButton());
  strip.appendChild(svThemeButton());
  panel.appendChild(strip);

  // ---- folder chip bar ----
  // ---- preset row (loader) / plot controls (plotter) ----
  if (!isPlot) {
    const pr = svPresetRow(node);
    pr.style.marginBottom = "7px";
    panel.appendChild(pr);
  } else {
    const pc = svPlotControlsRow(node, globalMode);
    pc.style.marginBottom = "6px";
    panel.appendChild(pc);
    const pr = svPresetRow(node);
    pr.style.marginBottom = "7px";
    panel.appendChild(pr);
  }

  const fb = svFolderBar(node);
  fb.style.marginBottom = "9px";
  panel.appendChild(fb);

  // ---- section header ----
  const sh = document.createElement("div");
  sh.style.cssText = "display:flex;align-items:baseline;gap:8px;margin:0 2px 5px;";
  const st = document.createElement("span"); st.textContent = "LORAS";
  st.style.cssText = `font-size:10px;letter-spacing:.08em;color:${SV.faint};`;
  sh.appendChild(st);
  const ss = document.createElement("span"); ss.style.flex = "1"; sh.appendChild(ss);
  const sc = document.createElement("span"); sc.textContent = `${stack.length}/${SLOT_MAX}`;
  sc.style.cssText = `font:11px ui-monospace,monospace;color:${SV.faint};`;
  sh.appendChild(sc);
  panel.appendChild(sh);

  // ---- slot grid ----
  const grid = document.createElement("div");
  grid.style.cssText = `display:grid;grid-template-columns:repeat(${SLOT_COLS},minmax(0,1fr));gap:${SV_GAP}px;`;
  panel.appendChild(grid);
  const slotEls = [];

  const fillChip = (e, idx) => {
    const isOn = e.on !== false;
    const cell = document.createElement("div");
    cell.dataset.slot = String(idx);
    cell.style.cssText = `border:1px ${isOn ? "solid" : "dashed"} ${e.random ? SV.purpleBorder : SV.border2};border-radius:6px;background:${SV.inset};` +
      `height:${SV_SLOT_H}px;box-sizing:border-box;padding:5px 8px;display:flex;flex-direction:column;justify-content:center;gap:3px;${isOn ? "" : "opacity:.45;"}`;

    const fol = (e.name || "").includes("/") ? e.name.slice(0, e.name.lastIndexOf("/") + 1) : "";
    const fil = e.name ? svFileLabel(e.name) : "random";
    const routed = svChainsRouted(e, chains);

    // ---- row 1: power · order · folder path · M-tags · ⋮ ----
    const r1 = document.createElement("div");
    r1.style.cssText = "display:flex;align-items:center;gap:6px;min-width:0;";
    const dot = document.createElement("span"); dot.dataset.ctl = "1"; dot.textContent = "●";
    dot.title = isOn ? "Enabled — click to disable" : "Disabled — click to enable";
    dot.style.cssText = `cursor:pointer;font-size:17px;line-height:1;color:${isOn ? SV.green : SV.mut};flex:none;user-select:none;padding:0 1px;`;
    dot.addEventListener("mouseenter", () => dot.style.color = isOn ? SV.greenHov : SV.dim);
    dot.addEventListener("mouseleave", () => dot.style.color = isOn ? SV.green : SV.mut);
    dot.addEventListener("pointerdown", ev => ev.stopPropagation());
    dot.addEventListener("click", (ev) => { ev.stopPropagation(); e.on = !isOn; node.__lflCommit(); });
    r1.appendChild(dot);

    const ob = document.createElement("span"); ob.textContent = String(idx + 1);
    ob.title = "Apply order (slot order) — drag the chip to reorder";
    ob.style.cssText = `flex:none;width:16px;height:16px;border-radius:4px;background:${SV.badgeBg};color:${SV.badgeFg};font:10px ui-monospace,monospace;display:inline-flex;align-items:center;justify-content:center;`;
    r1.appendChild(ob);

    const fp = document.createElement("span");
    fp.textContent = e.random ? ("🎲 random" + (fol ? " · " + fol : "")) : (fol || "—");
    fp.title = e.name || "";
    fp.style.cssText = `flex:1;min-width:0;font-size:10px;color:${e.random ? SV.purple : SV.faint};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
    r1.appendChild(fp);

    const tags = document.createElement("span");
    tags.style.cssText = "flex:none;display:flex;gap:3px;align-items:center;";
    // The plotter applies every lora to every connected model, so its tags show
    // the chains rather than a per-lora routing choice.
    const tagChains = isPlot ? Array.from({ length: chains }, (_, i) => i + 1) : routed;
    tags.innerHTML = tagChains.map(c => `<span style="font:10px ui-monospace,monospace;color:${SV_CHAIN_TEXT[c] || SV.dim};border:1px solid ${SV_CHAIN_BORDER[c] || SV.border2};border-radius:3px;padding:0 3px;">M${c}</span>`).join("") +
      (!isPlot && routed.length === 0 ? `<span style="font-size:10px;color:${SV.ghost};font-style:italic;">off</span>` : "") +
      (e.random && e.autoRoll ? `<span style="font-size:10px;color:${SV.purple};border:1px solid ${SV.purpleBorder};border-radius:3px;padding:0 3px;">auto</span>` : "");
    if (isPlot) tags.title = "Swept against every connected model";
    r1.appendChild(tags);

    // Randomizer chips get a dice + lock right on the chip — no need to open
    // the modal just to reroll. Locked slots never re-roll, by dice or auto.
    if (e.random) {
      const dice = document.createElement("span"); dice.dataset.ctl = "1";
      dice.textContent = "🎲";
      dice.title = e.locked ? "Locked — unlock to reroll" : "Roll a new random lora now";
      dice.style.cssText = `flex:none;cursor:${e.locked ? "default" : "pointer"};font-size:13px;line-height:1;padding:0 1px;user-select:none;` +
        (e.locked ? "opacity:.3;" : "opacity:.8;");
      if (!e.locked) {
        dice.addEventListener("mouseenter", () => dice.style.opacity = "1");
        dice.addEventListener("mouseleave", () => dice.style.opacity = ".8");
        dice.addEventListener("pointerdown", ev => ev.stopPropagation());
        dice.addEventListener("click", async (ev) => {
          ev.stopPropagation(); hideTip();
          if (e.locked) return;
          const pick = await pickRandomLora(node, e);
          if (pick != null) { e.name = pick; node.__lflCommit(); }
          else svToast("No loras available in this slot's folder scope.", true);
        });
      }
      r1.appendChild(dice);

      const lk = document.createElement("span"); lk.dataset.ctl = "1";
      lk.textContent = e.locked ? "🔒" : "🔓";
      lk.title = e.locked ? "Locked — won't re-roll. Click to unlock." : "Unlocked — click to lock this pick.";
      lk.style.cssText = `flex:none;cursor:pointer;font-size:12px;line-height:1;padding:0 1px;user-select:none;` +
        (e.locked ? "" : "opacity:.45;");
      lk.addEventListener("mouseenter", () => { if (!e.locked) lk.style.opacity = ".8"; });
      lk.addEventListener("mouseleave", () => { if (!e.locked) lk.style.opacity = ".45"; });
      lk.addEventListener("pointerdown", ev => ev.stopPropagation());
      lk.addEventListener("click", (ev) => {
        ev.stopPropagation();
        e.locked = !e.locked;
        if (e.locked) e.autoRoll = false;   // a frozen line can't auto-roll
        node.__lflCommit();
      });
      r1.appendChild(lk);
    }
    const cog = document.createElement("span"); cog.dataset.ctl = "1"; cog.textContent = "⚙";
    cog.title = "Options" + (node.__isPlotter ? "" : ": model routing, per-chain strengths") + (e.random ? ", randomizer" : "");
    cog.style.cssText = `cursor:pointer;color:${SV.cog};font-size:16px;line-height:1;padding:0 1px;flex:none;user-select:none;`;
    cog.addEventListener("mouseenter", () => cog.style.color = SV.cogHov);
    cog.addEventListener("mouseleave", () => cog.style.color = SV.cog);
    cog.addEventListener("pointerdown", ev => ev.stopPropagation());
    cog.addEventListener("click", (ev) => { ev.stopPropagation(); hideTip(); svShowLoraModal(node, e); });
    r1.appendChild(cog);
    const grip = document.createElement("span"); grip.dataset.grip = "1"; grip.textContent = "☰";
    grip.title = "Drag to reorder";
    grip.style.cssText = `cursor:grab;color:${SV.mut};font-size:13px;line-height:1;padding:0 1px;flex:none;user-select:none;`;
    grip.addEventListener("mouseenter", () => grip.style.color = SV.text);
    grip.addEventListener("mouseleave", () => grip.style.color = SV.mut);
    r1.appendChild(grip);
    const rm = document.createElement("span"); rm.dataset.ctl = "1"; rm.textContent = "✕";
    rm.title = "Remove this lora";
    rm.style.cssText = `cursor:pointer;color:${SV.danger};font-size:13px;line-height:1;padding:0 2px;flex:none;user-select:none;`;
    rm.addEventListener("mouseenter", () => rm.style.color = SV.dangerHov);
    rm.addEventListener("mouseleave", () => rm.style.color = SV.danger);
    rm.addEventListener("pointerdown", ev => ev.stopPropagation());
    rm.addEventListener("click", (ev) => {
      ev.stopPropagation(); hideTip();
      const i = stack.indexOf(e);
      if (i >= 0) { stack.splice(i, 1); node.__lflCommit(); }
    });
    r1.appendChild(rm);
    // Strength sits last on the top row: pinned to the right edge, so adding
    // M-tags or other icons never moves it, and the whole bottom row is free
    // for the lora name.
    const sIn = svStrengthInput(Number(e.model ?? 1), (v) => { svSetBaseStrength(e, v); node.__lflCommit(); }, true, globalMode);
    if (globalMode) {
      if (sIn.__input) sIn.__input.disabled = true;
      sIn.style.opacity = ".35";
      sIn.title = "Per-line strength ignored — Global strengths are in use";
    }
    r1.appendChild(sIn);
    cell.appendChild(r1);

    // ---- row 2: lora name (full width) · strength ----
    const r2 = document.createElement("div");
    r2.style.cssText = "display:flex;align-items:center;gap:8px;min-width:0;";
    const nm = document.createElement("div"); nm.dataset.ctl = "1";
    nm.textContent = fil;
    nm.style.cssText = `flex:1;min-width:0;font-size:12.5px;color:${isOn ? SV.text : SV.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;${isOn ? "" : "text-decoration:line-through;"}`;
    nm.title = e.random ? (e.name || "not rolled yet") + " — click for randomizer options" : (e.name || "") + " — click to swap";
    nm.addEventListener("pointerdown", ev => ev.stopPropagation());
    nm.addEventListener("click", (ev) => {
      ev.stopPropagation(); hideTip();
      if (e.random) svShowLoraModal(node, e);
      else showLoraChooser(node, ev, value => { e.name = value; node.__lflCommit(); });
    });
    r2.appendChild(nm);
    cell.appendChild(r2);

    // Drag to reorder — only from the ☰ grip.
    grip.addEventListener("pointerdown", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const fromIdx = idx;
      let moved = false, targetIdx = fromIdx;
      grip.style.cursor = "grabbing";
      cell.style.opacity = ".75"; cell.style.outline = `1px solid ${SV.accent}`;
      const clear = () => slotEls.forEach(s => { if (s !== cell) s.style.outline = ""; });
      const mv = (e2) => {
        moved = true;
        clear(); targetIdx = fromIdx;
        for (let i = 0; i < slotEls.length; i++) {
          const rct = slotEls[i].getBoundingClientRect();
          if (e2.clientX >= rct.left && e2.clientX <= rct.right && e2.clientY >= rct.top && e2.clientY <= rct.bottom) {
            targetIdx = Math.min(i, stack.length - 1);
            if (i !== fromIdx) slotEls[i].style.outline = `1px dashed ${SV.accent}`;
            break;
          }
        }
      };
      const up = () => {
        window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
        clear();
        if (moved && targetIdx !== fromIdx) {
          const [it] = stack.splice(fromIdx, 1);
          stack.splice(targetIdx, 0, it);
        }
        node.__lflCommit();
      };
      window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
    });

    // The chip body is inert: options live on the ⚙, reordering on the ☰ grip.
    // Clicking the body used to open the modal, which fired on every stray
    // click while aiming for a control.
    cell.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest("[data-ctl],[data-grip]")) return;
      ev.stopPropagation();
    });
    return cell;
  };

  for (let i = 0; i < SLOT_MAX; i++) {
    let cell;
    if (i < stack.length) cell = fillChip(stack[i], i);
    else {
      cell = document.createElement("div");
      cell.dataset.slot = String(i);
      cell.style.cssText = `border:1px dashed ${SV.dashed};border-radius:6px;background:${SV.slotEmpty};height:${SV_SLOT_H}px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;cursor:pointer;`;
      const lb = document.createElement("span"); lb.textContent = "lora " + (i + 1);
      lb.style.cssText = `font-size:11px;color:${SV.ghost};`;
      cell.appendChild(lb);
      cell.title = "Click to add a lora in this slot";
      cell.addEventListener("mouseenter", () => { cell.style.borderColor = SV.accent; lb.style.color = SV.badgeFg; });
      cell.addEventListener("mouseleave", () => { cell.style.borderColor = SV.dashed; lb.style.color = SV.ghost; });
      cell.addEventListener("pointerdown", ev => ev.stopPropagation());
      cell.addEventListener("click", (ev) => {
        ev.stopPropagation(); hideTip();
        showLoraChooser(node, ev, value => { stack.push({ on: true, name: value, model: 1.0, clip: 1.0 }); node.__lflCommit(); });
      });
    }
    slotEls.push(cell);
    grid.appendChild(cell);
  }

  // ---- footer: sweep summary (plotter) / load order (loader) ----
  const foot = document.createElement("div");
  foot.style.cssText = `margin-top:9px;background:${SV.inset};border:1px solid ${SV.border2};border-radius:6px;padding:7px 10px;`;
  const fh = document.createElement("div");
  fh.style.cssText = `display:flex;align-items:baseline;gap:10px;margin-bottom:3px;`;
  const fhl = document.createElement("span");
  fhl.textContent = isPlot ? "SWEEP" : "LOAD ORDER SENT TO EACH CHAIN";
  fhl.style.cssText = `flex:1;min-width:0;font-size:10px;letter-spacing:.08em;color:${SV.faint};` +
    `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
  fh.appendChild(fhl);

  // Library counters, right-aligned: how many loras the folder filter is
  // letting through, out of everything on disk.
  const tally = document.createElement("span");
  tally.style.cssText = `flex:none;font:10px ui-monospace,monospace;color:${SV.ghost};white-space:nowrap;`;
  tally.textContent = "…";
  fh.appendChild(tally);
  getLoraFiles().then((files) => {
    try {
      if (!tally.isConnected) return;
      const total = files.length;
      const units = [...collectUnits(files).keys()].map(normPath);
      const en = getEffectiveEnabledSet(node, units);
      const inFolders = en == null ? total : files.filter(f => en.has(folderOf(f))).length;
      tally.innerHTML = en == null
        ? `<span style="color:${SV.faint}">${total}</span> total loras available`
        : `<span style="color:${SV.dim}">${inFolders}</span> of <span style="color:${SV.faint}">${total}</span> total loras in your selected folders`;
      tally.title = en == null
        ? `All ${total} loras are available — no folder filter set`
        : `${inFolders} of ${total} loras pass the current folder filter`;
    } catch (_) { tally.textContent = ""; }
  }).catch(() => { tally.textContent = ""; });

  foot.appendChild(fh);
  if (isPlot) {
    const lines = stack.filter(e => e.on !== false).length;
    const gs = node.__globalStrengths || [];
    const perLora = globalMode ? gs.length : 1;
    const cells = lines * perLora;
    const ctrl = (!node.__globalLoraConnected && node.__controlImage) ? 1 : 0;
    const l1 = document.createElement("div");
    l1.style.cssText = `font:11px ui-monospace,monospace;color:${SV.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
    if (!lines) l1.innerHTML = `<span style="color:${SV.ghost}">no lora lines yet</span>`;
    else if (globalMode && !gs.length) l1.innerHTML = `${lines} lora line${lines === 1 ? "" : "s"} × <span style="color:${SV.danger}">no global strengths set</span>`;
    else l1.textContent = `${lines} lora line${lines === 1 ? "" : "s"} × ${perLora} strength${perLora === 1 ? "" : "s"}` +
      ` = ${cells} image${cells === 1 ? "" : "s"}` + (ctrl ? " + 1 control" : "") +
      (chains > 1 ? `  ·  ×${chains} model chains` : "");
    foot.appendChild(l1);
    // Which models the sweep runs against — the plotter has no per-lora
    // routing, so this belongs on the panel rather than on every chip.
    for (let c = 1; c <= chains; c++) {
      const ml = document.createElement("div");
      ml.style.cssText = `font:11px ui-monospace,monospace;color:${SV.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;`;
      const resolved = flgModelLabel(node, c);
      ml.innerHTML = `<span style="color:${SV_CHAIN_TEXT[c] || SV.dim}">M${c}:</span> ` +
        (resolved ? flgEscape(resolved) : `<span style="color:${SV.ghost};font-style:italic">not connected</span>`);
      foot.appendChild(ml);
    }
    panel.appendChild(foot);
    svMeasurePanel(node, panel);
    return;
  }
  for (let c = 1; c <= chains; c++) {
    const names = stack.filter(e => e.on !== false && svChainStrength(e, c) != null)
      .map(e => (e.random ? "🎲" : "") + (e.name ? svFileLabel(e.name) : "random"));
    const line = document.createElement("div");
    line.style.cssText = `font:11px ui-monospace,monospace;color:${SV.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
    line.innerHTML = `<span style="color:${SV_CHAIN_TEXT[c] || SV.dim}">M${c}:</span> ` + (names.length ? names.map(flgEscape).join(" → ") : `<span style="color:${SV.ghost}">nothing routed</span>`);
    foot.appendChild(line);
  }
  panel.appendChild(foot);
  svMeasurePanel(node, panel);
}

// Measure what actually rendered and correct the node height. Static estimates
// drift with fonts/wrapping (which is what made the panel overflow the node's
// bottom edge). offsetHeight, NOT getBoundingClientRect: both renderers
// CSS-transform the DOM-widget container by the canvas zoom, so a rect
// measurement returns zoom-scaled pixels; offsetHeight is layout px.
function svMeasurePanel(node, panel) {
  requestAnimationFrame(() => {
    try {
      if (!panel.isConnected) return;
      const h = panel.offsetHeight + 8;
      if (h <= 8) return;                       // not laid out yet
      const needW = node.size[0] < SV_MIN_W;
      const needH = Math.abs((node.__svMeasuredH || 0) - h) > 2;
      if (!needW && !needH) return;
      if (needH) node.__svMeasuredH = h;
      const want = node.computeSize();
      node.setSize([Math.max(node.size[0], SV_MIN_W), want[1]]);
      node.setDirtyCanvas(true, true);
    } catch (_) {}
  });
}

function buildCoreUI(node) {
  hideWidget(node, getDataWidget(node));
  loadStackFromData(node);
  const cls = node.comfyClass || node.type;
  const isLoader = cls === MULTI_NODE_NAME;
  const isPlotterNode = cls === PLOT_NODE_NAME;
  const isSlotNode = isLoader || isPlotterNode;   // both use the slot panel
  // Nodes that get the chip folder bar as their own DOM widget above the rows.
  // (Slot-panel nodes host the same bar inside their panel instead.)
  const isBarNode = cls === GLOBAL_NODE_NAME;
  if (isSlotNode) node.__lflView = "slots";

  // Every node now uses the chip combobox, so the old node-wide folder tree
  // button is never created. Creating-then-hiding it is not enough under
  // Nodes 2.0, where a hidden widget can still occupy layout and intercept
  // clicks meant for the UI underneath.
  let addBtn = null;

  if (isBarNode) {
    const fbDom = document.createElement("div");
    fbDom.style.cssText = "padding:2px 0 4px;box-sizing:border-box;width:100%;";
    node.__lflFolderBarEl = fbDom;
    const fbW = node.addDOMWidget("lfl_folderbar", "div", fbDom, { serialize: false });
    fbW.serializeValue = () => undefined;
    fbW.computeSize = function (width) { return [width, 30]; };
    node.__lflRenderFolderBar = () => {
      if (!node.__lflFolderBarEl) return;
      node.__lflFolderBarEl.textContent = "";
      node.__lflFolderBarEl.appendChild(svFolderBar(node));
    };
    node.__lflRenderFolderBar();
  }

  node.__plffUpdateFolderBtn = () => {
    if (isSlotNode) node.__lflRender?.();
    if (isBarNode) node.__lflRenderFolderBar?.();
    node.setDirtyCanvas(true, false);
  };
  node.__plffUpdateFolderBtn(); getLoraFiles().then(() => node.__plffUpdateFolderBtn());

  const dom = buildRowDOM(node);
  const domWidget = node.addDOMWidget("lfl_rows", "div", dom, { serialize: false });
  domWidget.serializeValue = () => undefined;
  domWidget.computeSize = function (width) {
    if (node.__lflView === "slots") {
      return [width, svViewHeight(node)];
    }
    const rows = node.__loraStack?.length || 0;
    return [width, rows === 0 ? 28 : rows * 26 + 6];
  };

  if (!isSlotNode) {
    addBtn = node.addWidget("button", "lfl_add", null, (_v, _c, _n, _p, event) => {
      showLoraChooser(node, event, value => { node.__loraStack.push({ on: true, name: value, model: 1.0, clip: 1.0 }); node.__lflCommit(); });
    });
    addBtn.label = "➕ Add Lora"; addBtn.serialize = false;
    if (addBtn.options) addBtn.options.serialize = false; addBtn.serializeValue = () => undefined;
  } else {
    if (!node.size || node.size[0] < SV_MIN_W) node.size = [Math.max(node.size?.[0] || 0, SV_MIN_W), node.size?.[1] || 0];
  }
}

// ===========================================================================
// Single-model node UI
// ===========================================================================

// ===========================================================================
// Global Lora node UI — stack (no randomizer) + two control toggles
// ===========================================================================

function addGlobalLoraUI(node) {
  if (node.__lflBuilt) return;
  node.__lflBuilt = true;
  node.__isGlobalLora = true;
  if (node.__ctrlNone == null) node.__ctrlNone = false;
  if (node.__ctrlGlobal == null) node.__ctrlGlobal = false;

  buildCoreUI(node);   // folder filter + rows + Add Lora (no randomizer)

  const t1 = node.addWidget("toggle", "lfl_g_ctrl_none", !!node.__ctrlNone, (v) => {
    node.__ctrlNone = !!v; syncData(node); node.setDirtyCanvas(true, true);
  }, { on: "On", off: "Off" });
  t1.label = "Control Image (no loras applied)";
  t1.tooltip = "Adds one baseline image with no loras applied at all — neither the plotter's "
    + "swept loras nor these global loras (the raw base model).";
  t1.serialize = false; if (t1.options) t1.options.serialize = false; t1.serializeValue = () => undefined;
  node.__lflGCtrlNoneW = t1;

  const t2 = node.addWidget("toggle", "lfl_g_ctrl_global", !!node.__ctrlGlobal, (v) => {
    node.__ctrlGlobal = !!v; syncData(node); node.setDirtyCanvas(true, true);
  }, { on: "On", off: "Off" });
  t2.label = "Control Image (global loras applied)";
  t2.tooltip = "Adds one baseline image with only these global loras applied — none of the "
    + "plotter's swept stack loras — so you can see what the global loras contribute on their own.";
  t2.serialize = false; if (t2.options) t2.options.serialize = false; t2.serializeValue = () => undefined;
  node.__lflGCtrlGlobalW = t2;

  snapHeight(node);
}

// Disable the Plotter's own Control Image toggle while a Global Lora node is
// attached (control is driven from that node instead).
function updatePlotterControlState(node) {
  const gIn = (node.inputs || []).find(i => i?.name === "global_loras");
  const connected = !!(gIn && gIn.link != null);
  const changed = node.__globalLoraConnected !== connected;
  node.__globalLoraConnected = connected;
  if (connected) node.__controlImage = false;   // control is driven from the Global node
  syncData(node);
  if (changed) node.__lflRender?.();            // panel shows connected/disabled states
  node.setDirtyCanvas(true, true);
}

// ===========================================================================
// Multi-model slot management
// ===========================================================================

function stripAutoExtraSlots(node) {
  for (let i = node.inputs.length - 1; i >= 0; i--)
    if (/^model_[2-5]$/.test(node.inputs[i]?.name)) node.removeInput(i);
  for (let i = node.outputs.length - 1; i >= 0; i--)
    if (/^(MODEL|CLIP) [2-5]$/.test(node.outputs[i]?.name)) node.removeOutput(i);
}

function countExtraModelInputs(node) {
  return node.inputs.filter(i => /^model_[2-5]$/.test(i?.name)).length;
}

// The loader emits a patched CLIP per chain (all from the single CLIP input);
// the plotter (shares this UI) is model-only on the extra outputs.
const nodeUsesClipChains = (node) => (node?.comfyClass || node?.type) === MULTI_NODE_NAME;

function addModelPair(node) {
  const count = countExtraModelInputs(node);
  if (count >= MAX_EXTRA_MODELS) return;
  const n = count + 2;
  node.addInput(`model_${n}`, "MODEL");
  node.addOutput(`MODEL ${n}`, "MODEL");
  if (nodeUsesClipChains(node)) node.addOutput(`CLIP ${n}`, "CLIP");
  node.properties.extra_model_count = count + 1;
  updateModelBar(node); node.__lflRender?.(); snapHeight(node); node.setDirtyCanvas(true, true);
}

function removeModelPair(node) {
  const count = countExtraModelInputs(node);
  if (count <= 0) return;
  const dropInput = (re) => { for (let i = node.inputs.length - 1; i >= 0; i--) { if (re.test(node.inputs[i]?.name)) { node.removeInput(i); return; } } };
  const dropOutput = (re) => { for (let i = node.outputs.length - 1; i >= 0; i--) { if (re.test(node.outputs[i]?.name)) { node.removeOutput(i); return; } } };
  dropInput(/^model_[2-5]$/);
  dropOutput(/^CLIP [2-5]$/);
  dropOutput(/^MODEL [2-5]$/);
  node.properties.extra_model_count = count - 1;
  updateModelBar(node); node.__lflRender?.(); snapHeight(node); node.setDirtyCanvas(true, true);
}

function updateModelBar(node) {
  if (!node.__lflModelBarEl) return;
  const count = countExtraModelInputs(node);
  node.__lflModelBarEl.querySelector(".lfl-mbar-count").textContent = `Chains: ${count + 1} / ${MAX_EXTRA_MODELS + 1}`;
  node.__lflModelBarEl.querySelector(".lfl-mbar-add").style.opacity = count >= MAX_EXTRA_MODELS ? ".3" : ".8";
  node.__lflModelBarEl.querySelector(".lfl-mbar-rem").style.opacity = count <= 0 ? ".3" : ".8";
}

function buildModelBar(node) {
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;gap:6px;padding:2px 4px;font:12px Arial,sans-serif;color:var(--fg-color,#ddd);";
  const label = document.createElement("span"); label.className = "lfl-mbar-count"; label.style.cssText = "flex:1;opacity:.75;";
  bar.appendChild(label);
  const mkBtn = (cls, txt, title, fn) => {
    const b = document.createElement("span"); b.className = cls; b.textContent = txt; b.title = title;
    b.style.cssText = "cursor:pointer;font-size:16px;line-height:1;padding:0 3px;flex:none;user-select:none;opacity:.8;";
    b.addEventListener("mouseenter", () => { if (b.style.opacity !== ".3") b.style.opacity = "1"; });
    b.addEventListener("mouseleave", () => { if (b.style.opacity !== ".3") b.style.opacity = ".8"; });
    b.addEventListener("click", fn); b.addEventListener("pointerdown", e => e.stopPropagation());
    bar.appendChild(b); return b;
  };
  mkBtn("lfl-mbar-add", "➕", "Add a model + clip chain", () => addModelPair(node));
  mkBtn("lfl-mbar-rem", "➖", "Remove last chain", () => removeModelPair(node));
  node.__lflModelBarEl = bar; return bar;
}

// ===========================================================================
// Multi-model node UI
// ===========================================================================

// ===========================================================================
// Fantastic Plotter Image Saver — custom width, constrain group UI
// ===========================================================================

const SAVER_WIDTH = DEFAULT_WIDTH;  // same width as the Fantastic Lora Plotter

// Canonical order of the saver's serializable widgets (matches INPUT_TYPES).
// Used to re-apply saved values by NAME so widget positions can't desync them.
const SAVER_WIDGET_ORDER = [
  "constrain_size", "max_cell_size", "text_color", "background_color",
  "font_size", "padding", "opacity", "images_per_row", "classic_grid",
];

function updateClassicGridLabel(node) {
  if (!node.__lflClassicGridBtn) return;
  node.__lflClassicGridBtn.label = node.__classicGrid
    ? "🖼 Grid mode: Classic (border labels)"
    : "🖼 Grid mode: Overlay (on image)";
  node.setDirtyCanvas?.(true, false);
}

// Drop a Grid Viewer node into the graph and wire the Saver's three passthrough
// outputs (images / metadata / global_loras_info) straight into it.
function spawnConnectedViewer(saverNode) {
  const LG = (typeof LiteGraph !== "undefined") ? LiteGraph : window.LiteGraph;
  const graph = saverNode.graph;
  if (!LG || !graph) { console.warn("[FantasticLoraLoader] cannot add viewer — graph unavailable"); return; }

  const viewer = LG.createNode("FantasticPlotterGridViewer");
  if (!viewer) { console.warn("[FantasticLoraLoader] Grid Viewer node type not registered"); return; }
  graph.add(viewer);

  // Place it just to the right of the saver, top-aligned.
  const sw = (saverNode.size && saverNode.size[0]) || 400;
  viewer.pos = [saverNode.pos[0] + sw + 60, saverNode.pos[1]];

  const outIdx = (name) => (saverNode.outputs || []).findIndex((o) => o.name === name);
  const inIdx  = (name) => (viewer.inputs || []).findIndex((i) => i.name === name);
  const wire = (outName, inName) => {
    const o = outIdx(outName), i = inIdx(inName);
    if (o >= 0 && i >= 0) saverNode.connect(o, viewer, i);
    else console.warn(`[FantasticLoraLoader] could not wire ${outName} → ${inName}`,
                      "(re-add the Saver node if it predates the passthrough outputs)");
  };
  wire("images", "images");
  wire("metadata", "metadata");
  wire("global_loras_info", "global_loras_info");

  try { updateSaverViewerBtn(saverNode); } catch (_) {}
  graph.setDirtyCanvas(true, true);
}

// True if any of the Saver's outputs links to a Grid Viewer node.
function isViewerConnected(saverNode) {
  const graph = saverNode.graph;
  if (!graph) return false;
  for (const out of (saverNode.outputs || [])) {
    if (!out || !out.links) continue;
    for (const lid of out.links) {
      const link = graph.links?.[lid];
      if (!link) continue;
      const tgt = graph.getNodeById?.(link.target_id);
      if (tgt && tgt.type === VIEWER_NODE_NAME) return true;
    }
  }
  return false;
}

// Grey out / relabel the Saver's "Add Grid Viewer" button based on whether one
// is already connected downstream.
function updateSaverViewerBtn(node) {
  const btn = node.__lflAddViewerBtn;
  if (!btn) return;
  const connected = isViewerConnected(node);
  btn.disabled = connected;
  btn.label = connected
    ? "\uD83D\uDD0D Grid Viewer connected"
    : "\uD83D\uDD0D Add Grid Viewer";
  node.setDirtyCanvas(true, false);
}

// Drop a Global Lora node into the graph (to the left of the Plotter) and wire
// its global_loras output into the Plotter's global_loras input.
function spawnConnectedGlobalLora(plotterNode) {
  const LG = (typeof LiteGraph !== "undefined") ? LiteGraph : window.LiteGraph;
  const graph = plotterNode.graph;
  if (!LG || !graph) { console.warn("[FantasticLoraLoader] cannot add global lora — graph unavailable"); return; }
  // Already fed? Don't add a second one.
  const gIn = (plotterNode.inputs || []).find((i) => i?.name === "global_loras");
  if (gIn && gIn.link != null) { console.warn("[FantasticLoraLoader] a Global Lora node is already connected"); return; }

  const gnode = LG.createNode(GLOBAL_NODE_NAME);
  if (!gnode) { console.warn("[FantasticLoraLoader] Global Lora node type not registered"); return; }
  graph.add(gnode);

  const gw = (gnode.size && gnode.size[0]) || 360;
  gnode.pos = [plotterNode.pos[0] - gw - 60, plotterNode.pos[1]];

  const o = (gnode.outputs || []).findIndex((x) => x.name === "global_loras");
  const i = (plotterNode.inputs || []).findIndex((x) => x.name === "global_loras");
  if (o >= 0 && i >= 0) gnode.connect(o, plotterNode, i);
  else console.warn("[FantasticLoraLoader] could not wire global_loras (re-add the Plotter if it predates this input)");

  try { updatePlotterControlState(plotterNode); } catch (_) {}
  graph.setDirtyCanvas(true, true);
}

function _setupSaverUI(node) {
  if (node.__lflSaverBuilt) return;
  node.__lflSaverBuilt = true;

  const constrainW = node.widgets?.find(w => w.name === "constrain_size");
  const maxSideW   = node.widgets?.find(w => w.name === "max_cell_size");
  const classicW   = node.widgets?.find(w => w.name === "classic_grid");
  if (!constrainW || !maxSideW) return;

  // ── Grey-out: toggle max_cell_size disabled based on constrain_size ──
  const applyDisabled = (val) => {
    maxSideW.disabled = !val;
    node.setDirtyCanvas(true, false);
  };
  applyDisabled(constrainW.value);

  const origCB = constrainW.callback;
  constrainW.callback = function (value, ...rest) {
    origCB?.call(this, value, ...rest);
    applyDisabled(value);
  };

  // ── Gap between the constrain group and the style options ──
  // Done via max_cell_size's height (NOT a separate widget): inserting a
  // non-serializing DOM widget here would desync ComfyUI's positional
  // widgets_values restore and shift every value below it.
  const WH = (window.LiteGraph && window.LiteGraph.NODE_WIDGET_HEIGHT) || 20;
  maxSideW.computeSize = function (w) { return [w, WH + 10]; };

  // ── Classic grid toggle button — same style as the Strength Mode button ──
  if (classicW) {
    node.__classicGrid = !!classicW.value;
    hideWidget(node, classicW);

    const classicBtn = node.addWidget("button", "lfl_classic_grid_btn", null, () => {
      node.__classicGrid = !node.__classicGrid;
      classicW.value = node.__classicGrid;
      updateClassicGridLabel(node);
      node.setDirtyCanvas(true, true);
    });
    classicBtn.serialize = false;
    if (classicBtn.options) classicBtn.options.serialize = false;
    classicBtn.serializeValue = () => undefined;
    node.__lflClassicGridBtn = classicBtn;
    updateClassicGridLabel(node);
  }

  // ── One-click: drop a connected Grid Viewer ──
  const viewerBtn = node.addWidget("button", "lfl_add_viewer", null, () => {
    if (isViewerConnected(node)) return;   // already has one
    try { spawnConnectedViewer(node); }
    catch (err) { console.warn("[FantasticLoraLoader] add viewer failed", err); }
  });
  viewerBtn.label = "\uD83D\uDD0D Add Grid Viewer";
  viewerBtn.tooltip = "Adds a Fantastic Plotter Grid Viewer node and connects it here — "
    + "an interactive board showing every generated image laid out as a grid, with zoom, "
    + "row/column filtering, favourites and side-by-side comparison.";
  viewerBtn.serialize = false;
  if (viewerBtn.options) viewerBtn.options.serialize = false;
  viewerBtn.serializeValue = () => undefined;
  node.__lflAddViewerBtn = viewerBtn;
  updateSaverViewerBtn(node);
}

function addMultiUI(node, { autoAddPair = true, isPlotter = false } = {}) {
  if (node.__lflBuilt) return;
  node.__lflBuilt = true;
  node.properties = node.properties || {};
  if (isPlotter) {
    node.__isPlotter = true;
    if (node.__plotMode == null) node.__plotMode = "perline";
    if (node.__globalStrengths == null) node.__globalStrengths = [];
    if (node.__controlImage == null) node.__controlImage = false;
  }
  if (node.properties.extra_model_count == null) node.properties.extra_model_count = 0;
  stripAutoExtraSlots(node);
  buildCoreUI(node);

  // Slot-panel nodes (loader + plotter) host these controls inside the panel.
  const isSlotLoader = ((node.comfyClass || node.type) === MULTI_NODE_NAME) || isPlotter;

  // 🎲 Add Lora Randomizer (same as single-model node). The slot-grid loader has
  // its own in-panel button, so it never creates this widget — see buildCoreUI.
  let randBtn = null;
  if (!isSlotLoader) {
    randBtn = node.addWidget("button", "lfl_add_rand", null, async () => {
      const entry = { on: true, name: "", model: 1.0, clip: 1.0, random: true, locked: false, autoRoll: false, folders: null };
      const pick = await pickRandomLora(node, entry);
      if (pick != null) entry.name = pick;
      node.__loraStack.push(entry);
      node.__lflCommit();
    });
    randBtn.label = "🎲 Add Lora Randomizer"; randBtn.serialize = false;
    if (randBtn.options) randBtn.options.serialize = false; randBtn.serializeValue = () => undefined;
  }

  // Plotter state defaults (its controls render inside the slot panel now).
  if (isPlotter && node.__globalStrengths == null) node.__globalStrengths = [];

  let barWidget = null;
  if (!isSlotLoader) {
    const barDom = buildModelBar(node);
    barWidget = node.addDOMWidget("lfl_modelbar", "div", barDom, { serialize: false });
    barWidget.serializeValue = () => undefined;
    barWidget.computeSize = function (width) { return [width, 26]; };
  }

  // On fresh creation the loader and plotter both start with zero extra paths
  // (autoAddPair=false), so this just draws the model bar. The autoAddPair hook
  // is kept for callers that want a path pre-added. Workflow loads skip the add
  // because onConfigure syncs extra_model_count from restored slots.
  if (autoAddPair && node.properties.extra_model_count === 0) addModelPair(node);
  else updateModelBar(node);

  node.__lflLastRandCount = (node.__loraStack || []).filter(e => e.random).length;
  snapHeight(node);
}

// ===========================================================================
// Plotter controls — strength-mode toggle + global-strengths popup
// ===========================================================================

let openStrengthsPanel = null;
function closeStrengthsPanel() { if (openStrengthsPanel) { openStrengthsPanel.dispose(); openStrengthsPanel = null; } }

function showGlobalStrengthsPanel(node, event) {
  if (openStrengthsPanel?.node === node) { closeStrengthsPanel(); return; }
  closeStrengthsPanel();
  injectStyles();

  const panel = document.createElement("div"); panel.className = "lfl-panel";
  const header = document.createElement("div"); header.className = "lfl-header";
  header.innerHTML = `<span class="lfl-title">Global strengths</span>`;
  const close = document.createElement("span"); close.className = "lfl-close"; close.textContent = "✕";
  header.appendChild(close); panel.appendChild(header);

  const hint = document.createElement("div");
  hint.style.cssText = "padding:5px 8px;opacity:.6;font-size:11px;border-bottom:1px solid var(--border-color,#444);";
  hint.textContent = "Up to 10 values. Blank lines are skipped. Each enabled lora is swept across these (Global mode only).";
  panel.appendChild(hint);

  const body = document.createElement("div");
  body.style.cssText = "padding:6px 8px;display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center;overflow:auto;";
  const cur = node.__globalStrengths || [];
  const inputs = [];
  for (let i = 0; i < 10; i++) {
    const lab = document.createElement("span"); lab.textContent = String(i + 1); lab.style.cssText = "opacity:.5;text-align:right;";
    const inp = document.createElement("input"); inp.type = "number"; inp.step = "0.05";
    inp.value = cur[i] != null ? String(cur[i]) : "";
    inp.placeholder = "—";
    inp.style.cssText = "width:100%;box-sizing:border-box;background:var(--comfy-input-bg,#2a2a2a);color:inherit;border:1px solid var(--border-color,#555);border-radius:3px;font:inherit;padding:2px 5px;";
    inp.addEventListener("pointerdown", e => e.stopPropagation());
    inp.addEventListener("keydown", e => { if (e.key === "Enter") apply(); });
    inputs.push(inp);
    body.appendChild(lab); body.appendChild(inp);
  }
  panel.appendChild(body);

  const collect = () => inputs.map(i => i.value.trim()).filter(v => v !== "").map(Number).filter(n => !isNaN(n));
  const apply = () => {
    node.__globalStrengths = collect();
    syncData(node);
    node.__lflRender?.();
    closeStrengthsPanel();
  };

  const actions = document.createElement("div"); actions.className = "lfl-actions";
  const mkBtn = (label, fn) => { const b = document.createElement("button"); b.className = "lfl-btn"; b.textContent = label; b.addEventListener("click", fn); actions.appendChild(b); };
  mkBtn("Apply", apply);
  mkBtn("Clear", () => { inputs.forEach(i => (i.value = "")); });
  panel.appendChild(actions);

  // ✕ and Escape discard; clicking away keeps what's typed (applies).
  close.addEventListener("click", closeStrengthsPanel);

  document.body.appendChild(panel);
  const x = event?.clientX ?? window.innerWidth / 2, y = event?.clientY ?? window.innerHeight / 3;
  const rect = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  panel.style.top  = `${Math.max(8, Math.min(y + 6, window.innerHeight - rect.height - 8))}px`;

  const onPD = e => { if (!panel.contains(e.target)) apply(); };
  const onKD = e => { if (e.key === "Escape") closeStrengthsPanel(); };
  setTimeout(() => { document.addEventListener("pointerdown", onPD, true); document.addEventListener("keydown", onKD, true); }, 0);
  openStrengthsPanel = { el: panel, node, dispose: () => { document.removeEventListener("pointerdown", onPD, true); document.removeEventListener("keydown", onKD, true); panel.remove(); } };
}

// ===========================================================================
// Extension registration
// ===========================================================================

app.registerExtension({
  name: "lfl.FantasticLoraLoader",

  async setup() {
    // Roll every active auto-roll line just before each prompt is queued, and
    // bake the chosen lora into lora_data. This makes auto-roll lines identical
    // to normal lora lines at execution time (same code path, same result) and
    // updates the node face to show what WILL be used this run.
    const origQueuePrompt = app.queuePrompt;
    app.queuePrompt = async function (...args) {
      try {
        const nodes = app.graph?._nodes || [];
        for (const node of nodes) {
          if (!node.__loraStack) continue;
          let changed = false;
          for (const entry of node.__loraStack) {
            if (entry.random && entry.autoRoll && !entry.locked) {
              const pick = await pickRandomLora(node, entry);
              if (pick != null) { entry.name = pick; changed = true; }
            }
          }
          if (changed) {
            syncData(node);
            node.__lflRender?.();
            node.setDirtyCanvas(true, false);
          }
        }
      } catch (err) {
        console.warn("[FantasticLoraLoader] auto-roll on queue failed", err);
      }
      return origQueuePrompt.apply(this, args);
    };
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    const nm = nodeData?.name;
    const isSaver = nm === SAVER_NODE_NAME;
    const isGlobal = nm === GLOBAL_NODE_NAME;
    if (!ALL_NODE_NAMES.includes(nm) && !isSaver && !isGlobal) return;

    nodeType.color   = NODE_COLOR;
    nodeType.bgcolor = NODE_BGCOLOR;

    // ...and on the instance, which is the only place the Vue renderer looks.
    const origColorONC = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = origColorONC?.apply(this, arguments);
      try { svApplyNodeColors(this); } catch (_) {}
      return r;
    };
    const origColorCfg = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = origColorCfg?.apply(this, arguments);
      // A saved workflow restores whatever colour it stored; only restyle if
      // that colour is one of ours (i.e. the user hasn't picked a custom one).
      try { svApplyNodeColors(this); } catch (_) {}
      return r;
    };

    // Global Lora node: stack UI (no randomizer) + two control toggles.
    if (isGlobal) {
      const origONC = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        origONC?.apply(this, arguments);
        this.size = [DEFAULT_WIDTH, 200];
        try { addGlobalLoraUI(this); } catch (err) { console.warn("[FantasticLoraLoader] global UI build failed", err); }
      };
      const origOCC = nodeType.prototype.onConnectionsChange;
      nodeType.prototype.onConnectionsChange = function () {
        origOCC?.apply(this, arguments);
        setTimeout(() => this.__lflRender?.(), 0);
      };
      const origOConf = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function (info) {
        origOConf?.apply(this, arguments);
        try {
          if (!this.__lflBuilt) addGlobalLoraUI(this);
          loadStackFromData(this);
          if (this.__lflGCtrlNoneW)   this.__lflGCtrlNoneW.value   = !!this.__ctrlNone;
          if (this.__lflGCtrlGlobalW) this.__lflGCtrlGlobalW.value = !!this.__ctrlGlobal;
          this.__lflRender?.();
          this.__plffUpdateFolderBtn?.();
          snapHeight(this);
        } catch (err) { console.warn("[FantasticLoraLoader] global onConfigure failed", err); }
      };
      return;
    }

    // Saver node: set wider width, wire the constrain group UI, then exit.
    if (isSaver) {
      const origOnNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        origOnNodeCreated?.apply(this, arguments);
        this.size = [SAVER_WIDTH, this.size?.[1] ?? 320];
        try { _setupSaverUI(this); } catch (err) { console.warn("[FantasticLoraLoader] saver UI build failed", err); }
      };

      const origSaverOCC = nodeType.prototype.onConnectionsChange;
      nodeType.prototype.onConnectionsChange = function () {
        origSaverOCC?.apply(this, arguments);
        setTimeout(() => { try { updateSaverViewerBtn(this); } catch (_) {} }, 0);
      };

      const origOnConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function (info) {
        origOnConfigure?.apply(this, arguments);
        try {
          // Re-apply saved values BY NAME. ComfyUI restores widgets_values by
          // position; any non-serializing widget we add can shift that mapping,
          // so we map the saved array back onto widgets by their canonical order.
          const vals = info?.widgets_values;
          if (Array.isArray(vals) && vals.length === SAVER_WIDGET_ORDER.length) {
            SAVER_WIDGET_ORDER.forEach((nm, i) => {
              if (vals[i] === undefined) return;
              const w = this.widgets?.find(x => x.name === nm);
              if (w) w.value = vals[i];
            });
          }
          // Restore grey-out and classic grid button state.
          const constrainW = this.widgets?.find(w => w.name === "constrain_size");
          const maxSideW   = this.widgets?.find(w => w.name === "max_cell_size");
          const classicW   = this.widgets?.find(w => w.name === "classic_grid");
          if (constrainW && maxSideW) maxSideW.disabled = !constrainW.value;
          if (classicW) {
            this.__classicGrid = !!classicW.value;
            updateClassicGridLabel(this);
          }
          updateSaverViewerBtn(this);
          this.setDirtyCanvas(true, false);
        } catch (err) { console.warn("[FantasticLoraLoader] saver onConfigure failed", err); }
      };
      return;
    }

    const isPlotter = nm === PLOT_NODE_NAME;

    const origOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      origOnNodeCreated?.apply(this, arguments);
      this.size = [DEFAULT_WIDTH, 180];
      // Loader and plotter both use the multi-model UI and start with zero
      // extra model paths — pixel-identical to a plain single-model loader
      // until the user adds paths via the ➕ bar.
      try { addMultiUI(this, { autoAddPair: false, isPlotter }); }
      catch (err) { console.warn("[FantasticLoraLoader] UI build failed", err); }
    };

    const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      origOnConnectionsChange?.apply(this, arguments);
      setTimeout(() => {
        this.__lflRender?.();
        if (isPlotter) { try { updatePlotterControlState(this); } catch (_) {} }
      }, 0);
    };

    const origOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      origOnConfigure?.apply(this, arguments);
      try {
        if (!this.__lflBuilt) addMultiUI(this, { autoAddPair: false, isPlotter });
        this.properties.extra_model_count = countExtraModelInputs(this);
        updateModelBar(this);
        loadStackFromData(this);
        if (isPlotter) updatePlotterControlState(this);
        // Serialized node width already reflects any randomizer bump — sync the
        // counter so the next commit doesn't add it again.
        this.__lflLastRandCount = (this.__loraStack || []).filter(e => e.random).length;
        const svCls = this.comfyClass || this.type;
        if (svCls === MULTI_NODE_NAME || svCls === PLOT_NODE_NAME) this.__lflView = "slots";
        this.__lflRender?.();
        this.__plffUpdateFolderBtn?.();
        snapHeight(this);
      } catch (err) { console.warn("[FantasticLoraLoader] onConfigure failed", err); }
    };
  },
});

// Exported for unit tests
export { folderOf, baseName, collectUnits, buildTree, subtreeUnits, subtreeFileTotal, sortedChildren, getEffectiveEnabledSet, normPath, ROOT_LABEL };

// ===========================================================================
// Fantastic Any Selector 🎯
// A filename picker that adopts the category of whatever loader it's wired
// into. Single-link: connecting elsewhere moves the wire rather than adding a
// second, so the category is never ambiguous.
// ===========================================================================

const AS_NODE_NAME = "FantasticAnySelector";
const AS_PROP_FOLDERS = "Enabled Folders";

// input-name → folder_paths category, for the common loaders. Falls back to
// fingerprinting the target's own option list when the name isn't known.
const AS_NAME_MAP = {
  ckpt_name: "checkpoints", unet_name: "diffusion_models", vae_name: "vae",
  clip_name: "text_encoders", clip_name1: "text_encoders", clip_name2: "text_encoders",
  clip_name3: "text_encoders", lora_name: "loras", control_net_name: "controlnet",
  style_model_name: "style_models", upscale_model_name: "upscale_models",
  gligen_name: "gligen", model_name: "upscale_models", clip_vision_name: "clip_vision",
};

const asFileCache = new Map();          // category -> string[]
async function asFilesFor(category) {
  if (!category) return [];
  if (asFileCache.has(category)) return asFileCache.get(category);
  try {
    const r = await api.fetchApi("/fantastic_loras/files?category=" + encodeURIComponent(category));
    const d = await r.json();
    const files = d.files || [];
    asFileCache.set(category, files);
    return files;
  } catch (_) { return []; }
}

function asFolderOf(path) {
  const p = normPath(path || "");
  const i = p.lastIndexOf("/");
  return i < 0 ? ROOT_LABEL : p.slice(0, i);
}
function asFoldersIn(files) {
  const m = new Map();
  for (const f of files) {
    const k = asFolderOf(f);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.keys()].sort();
}

function asEnabled(node) {
  const v = node.properties?.[AS_PROP_FOLDERS];
  if (v == null) return null;                       // null = all
  if (Array.isArray(v)) return new Set(v.map(normPath));
  if (v && Array.isArray(v.folders)) return new Set(v.folders.map(normPath));
  return null;
}
function asSetEnabled(node, setOrNull) {
  node.properties = node.properties || {};
  node.properties[AS_PROP_FOLDERS] = setOrNull == null ? null : { version: 2, folders: [...setOrNull].sort() };
  node.__asRender?.();
  node.setDirtyCanvas(true, true);
}
function asVisibleFiles(node, files) {
  const en = asEnabled(node);
  if (en == null) return files;
  if (!en.size) return [];
  return files.filter(f => en.has(asFolderOf(f)));
}

function asWidget(node, name) { return (node.widgets || []).find(w => w.name === name); }
function asGet(node, name) { const w = asWidget(node, name); return w ? String(w.value ?? "") : ""; }
function asSet(node, name, val) {
  const w = asWidget(node, name);
  if (w) { w.value = val; }
}

// ---- category detection from the connected target -------------------------
async function asDetectCategory(node) {
  const links = (node.outputs?.[0]?.links) || [];
  if (!links.length) return "";
  try {
    const lk = app.graph.links[links[0]];
    if (!lk) return "";
    const target = app.graph.getNodeById(lk.target_id);
    if (!target) return "";
    const inp = target.inputs?.[lk.target_slot];
    const iname = inp?.name || "";
    if (AS_NAME_MAP[iname]) return AS_NAME_MAP[iname];
    // Unknown input name: fingerprint the target's original option list.
    const def = (await asObjectInfo(target.comfyClass || target.type)) || {};
    const req = def.input?.required || {};
    const spec = req[iname];
    const opts = Array.isArray(spec) && Array.isArray(spec[0]) ? spec[0] : null;
    if (opts && opts.length) {
      for (const cat of await asCategories()) {
        const files = await asFilesFor(cat);
        if (files.length && files.length === opts.length && files[0] === opts[0]) return cat;
      }
    }
  } catch (_) {}
  return "";
}

let asCatsCache = null;
async function asCategories() {
  if (asCatsCache) return asCatsCache;
  try {
    const r = await api.fetchApi("/fantastic_loras/categories");
    const d = await r.json();
    asCatsCache = d.categories || [];
  } catch (_) { asCatsCache = []; }
  return asCatsCache;
}
const asDefCache = new Map();
async function asObjectInfo(cls) {
  if (!cls) return null;
  if (asDefCache.has(cls)) return asDefCache.get(cls);
  try {
    const r = await api.fetchApi("/object_info/" + encodeURIComponent(cls));
    const d = await r.json();
    const def = d[cls] || null;
    asDefCache.set(cls, def);
    return def;
  } catch (_) { return null; }
}

// ---- file chooser ---------------------------------------------------------
let asOpenChooser = null;
function asCloseChooser() { if (asOpenChooser) { asOpenChooser.dispose(); asOpenChooser = null; } }

async function asShowChooser(node, anchor) {
  asCloseChooser();
  const cat = asGet(node, "category");
  if (!cat) { svToast("Wire this into a loader first.", true); return; }
  const files = asVisibleFiles(node, await asFilesFor(cat));
  const favKey = "as:" + cat;

  const panel = document.createElement("div");
  panel.style.cssText = `position:fixed;z-index:10002;background:${SV.inset};border:1px solid ${SV.border2};border-radius:8px;` +
    `display:flex;flex-direction:column;max-height:60vh;min-width:380px;max-width:560px;font:12px Arial,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.55);`;
  const r = anchor.getBoundingClientRect();
  panel.style.left = Math.round(Math.min(r.left, window.innerWidth - 580)) + "px";
  panel.style.top = Math.round(r.bottom + 5) + "px";

  const head = document.createElement("div");
  head.style.cssText = `display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid ${SV.border2};`;
  const sin = document.createElement("input");
  sin.type = "text"; sin.placeholder = `Filter ${cat}…`;
  sin.style.cssText = `flex:1;min-width:0;background:${SV.panel};border:1px solid ${SV.btnBorder};color:${SV.text};border-radius:5px;padding:4px 8px;font:12px Arial,sans-serif;outline:none;`;
  sin.addEventListener("pointerdown", e => e.stopPropagation());
  head.appendChild(sin);
  panel.appendChild(head);

  const list = document.createElement("div");
  list.style.cssText = "overflow:auto;flex:1;";
  panel.appendChild(list);

  const build = () => {
    list.textContent = "";
    const favs = new Set((FLL_PREFS.favoriteLoras || []).filter(f => f.startsWith(favKey + "|")).map(f => f.slice(favKey.length + 1)));
    const q = sin.value.trim().toLowerCase();
    const shown = files.filter(f => !q || f.toLowerCase().includes(q));
    if (!shown.length) {
      const em = document.createElement("div");
      em.textContent = files.length ? "Nothing matches" : "No files in the enabled folders";
      em.style.cssText = `padding:12px;font-size:11px;color:${SV.ghost};font-style:italic;`;
      list.appendChild(em); return;
    }
    const fav = shown.filter(f => favs.has(f)), rest = shown.filter(f => !favs.has(f));
    const row = (f) => {
      const el = document.createElement("div");
      const sel = f === asGet(node, "selection");
      el.style.cssText = `display:flex;align-items:center;gap:8px;padding:5px 10px;cursor:pointer;border-bottom:1px solid ${SV.border2};${sel ? `background:${SV.rowOn};` : ""}`;
      const st = document.createElement("span");
      const isFav = favs.has(f);
      st.textContent = isFav ? "★" : "☆";
      st.style.cssText = `flex:none;font-size:12px;color:${isFav ? "#e0c04c" : SV.ghost};cursor:pointer;`;
      st.addEventListener("pointerdown", e => e.stopPropagation());
      st.addEventListener("click", (e) => {
        e.stopPropagation();
        const all = new Set(FLL_PREFS.favoriteLoras || []);
        const key = favKey + "|" + f;
        all.has(key) ? all.delete(key) : all.add(key);
        savePrefs({ favoriteLoras: [...all] });
        build();
      });
      el.appendChild(st);
      const folder = asFolderOf(f);
      const base = f.slice(f.lastIndexOf("/") + 1);
      const lbl = document.createElement("span");
      lbl.innerHTML = (folder !== ROOT_LABEL ? `<span style="color:${SV.faint}">${flgEscape(folder)}/</span>` : "") +
        `<span style="color:${sel ? SV.text : SV.dim}">${flgEscape(svShowExt() ? base : base.replace(/\.[^.]+$/, ""))}</span>`;
      lbl.style.cssText = "flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      el.appendChild(lbl);
      if (sel) { const ck = document.createElement("span"); ck.textContent = "✓"; ck.style.cssText = `flex:none;color:${SV.accent};font-size:11px;`; el.appendChild(ck); }
      el.addEventListener("mouseenter", () => el.style.background = SV.rowHover);
      el.addEventListener("mouseleave", () => el.style.background = sel ? SV.rowOn : "");
      el.addEventListener("pointerdown", e => e.stopPropagation());
      el.addEventListener("click", (e) => {
        e.stopPropagation(); asCloseChooser();
        asSet(node, "selection", f);
        node.__asRender?.(); node.setDirtyCanvas(true, true);
      });
      list.appendChild(el);
    };
    if (fav.length) {
      const h = document.createElement("div"); h.textContent = "★ FAVORITES";
      h.style.cssText = `padding:5px 10px 3px;font-size:10px;letter-spacing:.06em;color:${SV.faint};position:sticky;top:0;background:${SV.inset};border-bottom:1px solid ${SV.border2};`;
      list.appendChild(h);
      fav.forEach(row);
    }
    rest.forEach(row);
  };
  sin.addEventListener("input", build);
  sin.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") asCloseChooser(); });
  build();
  document.body.appendChild(panel);
  setTimeout(() => sin.focus(), 0);
  const away = (ev) => { if (!panel.contains(ev.target) && !anchor.contains(ev.target)) asCloseChooser(); };
  setTimeout(() => window.addEventListener("pointerdown", away, true), 0);
  asOpenChooser = { dispose: () => { window.removeEventListener("pointerdown", away, true); panel.remove(); } };
}

// ---- folder chip bar (category-aware) -------------------------------------
let asOpenFolders = null;
function asCloseFolders() { if (asOpenFolders) { asOpenFolders.dispose(); asOpenFolders = null; } }

async function asShowFolderDropdown(node, anchor) {
  asCloseFolders();
  const cat = asGet(node, "category");
  const units = asFoldersIn(await asFilesFor(cat));
  const panel = document.createElement("div");
  panel.style.cssText = `position:fixed;z-index:10002;background:${SV.inset};border:1px solid ${SV.border2};border-radius:6px;` +
    `display:flex;flex-direction:column;max-height:320px;min-width:280px;max-width:420px;font:12px Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);`;
  const r = anchor.getBoundingClientRect();
  panel.style.left = Math.round(Math.min(r.left, window.innerWidth - 440)) + "px";
  panel.style.top = Math.round(r.bottom + 4) + "px";

  const bar = document.createElement("div");
  bar.style.cssText = `display:flex;align-items:center;gap:6px;padding:7px 8px;border-bottom:1px solid ${SV.border2};flex:none;`;
  const sin = document.createElement("input");
  sin.type = "text"; sin.placeholder = "Type to search folders…";
  sin.style.cssText = `flex:1;min-width:0;background:${SV.panel};border:1px solid ${SV.btnBorder};color:${SV.text};border-radius:5px;padding:4px 8px;font:12px Arial,sans-serif;outline:none;`;
  sin.addEventListener("pointerdown", e => e.stopPropagation());
  bar.appendChild(sin);
  for (const [label, fn] of [["all", () => asSetEnabled(node, null)], ["none", () => asSetEnabled(node, new Set())]]) {
    const b = document.createElement("span"); b.textContent = label;
    b.style.cssText = `flex:none;font-size:11px;color:${SV.mut};cursor:pointer;text-decoration:underline;`;
    b.addEventListener("pointerdown", e => e.stopPropagation());
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); build(); });
    bar.appendChild(b);
  }
  panel.appendChild(bar);
  const list = document.createElement("div");
  list.style.cssText = "overflow:auto;flex:1;";
  panel.appendChild(list);

  const build = () => {
    list.textContent = "";
    const en = asEnabled(node);
    const favs = new Set(FLL_PREFS.favoriteFolders || []);
    const q = sin.value.trim().toLowerCase();
    const shown = units.filter(u => !q || u.toLowerCase().includes(q));
    if (!shown.length) {
      const em = document.createElement("div"); em.textContent = "No folders match";
      em.style.cssText = `padding:10px;font-size:11px;color:${SV.ghost};font-style:italic;`;
      list.appendChild(em); return;
    }
    const mk = (u) => {
      const on = en == null || en.has(u);
      const el = document.createElement("div");
      el.style.cssText = `display:flex;align-items:center;gap:8px;padding:5px 10px;cursor:pointer;border-bottom:1px solid ${SV.border2};color:${on ? SV.text : SV.mut};${on ? `background:${SV.rowOn};` : ""}`;
      const st = document.createElement("span");
      const key = "as:" + cat + "|" + u;
      const isFav = favs.has(key);
      st.textContent = isFav ? "★" : "☆";
      st.style.cssText = `flex:none;font-size:12px;color:${isFav ? "#e0c04c" : SV.ghost};cursor:pointer;`;
      st.addEventListener("pointerdown", e => e.stopPropagation());
      st.addEventListener("click", (e) => {
        e.stopPropagation();
        const all = new Set(FLL_PREFS.favoriteFolders || []);
        all.has(key) ? all.delete(key) : all.add(key);
        savePrefs({ favoriteFolders: [...all] });
        build();
      });
      el.appendChild(st);
      const lbl = document.createElement("span"); lbl.textContent = u;
      lbl.style.cssText = "flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      el.appendChild(lbl);
      if (on) { const ck = document.createElement("span"); ck.textContent = "✓"; ck.style.cssText = `color:${SV.accent};font-size:11px;flex:none;`; el.appendChild(ck); }
      el.addEventListener("mouseenter", () => el.style.background = SV.rowHover);
      el.addEventListener("mouseleave", () => el.style.background = on ? SV.rowOn : "");
      el.addEventListener("pointerdown", e => e.stopPropagation());
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const cur = asEnabled(node);
        let next;
        if (cur == null) next = new Set([u]);
        else { next = new Set(cur); next.has(u) ? next.delete(u) : next.add(u); }
        asSetEnabled(node, next.size === units.length ? null : next);
        build();
      });
      list.appendChild(el);
    };
    const fav = shown.filter(u => favs.has("as:" + cat + "|" + u));
    const rest = shown.filter(u => !favs.has("as:" + cat + "|" + u));
    if (fav.length) {
      const h = document.createElement("div"); h.textContent = "★ FAVORITES";
      h.style.cssText = `padding:5px 10px 3px;font-size:10px;letter-spacing:.06em;color:${SV.faint};position:sticky;top:0;background:${SV.inset};`;
      list.appendChild(h); fav.forEach(mk);
    }
    rest.forEach(mk);
  };
  sin.addEventListener("input", build);
  sin.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") asCloseFolders(); });
  build();
  document.body.appendChild(panel);
  setTimeout(() => sin.focus(), 0);
  const away = (ev) => { if (!panel.contains(ev.target) && !anchor.contains(ev.target)) asCloseFolders(); };
  setTimeout(() => window.addEventListener("pointerdown", away, true), 0);
  asOpenFolders = { dispose: () => { window.removeEventListener("pointerdown", away, true); panel.remove(); } };
}

// ---- selector presets (per category) --------------------------------------
const asPresetCache = new Map();          // category -> [{name, selection, enabledFolders}]

async function asPresetApi(path, body) {
  const opts = body
    ? { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
    : {};
  const resp = await api.fetchApi("/fantastic_loras/sel_presets" + path, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) { const e = new Error(data.message || data.error || `failed (${resp.status})`); e.code = data.error; throw e; }
  return data;
}

async function asLoadPresets(node, category) {
  if (!category) return [];
  if (asPresetCache.has(category)) return asPresetCache.get(category);
  try {
    const d = await asPresetApi("?category=" + encodeURIComponent(category));
    asPresetCache.set(category, d.presets || []);
  } catch (_) { asPresetCache.set(category, []); }
  node.__asRender?.();
  return asPresetCache.get(category);
}

let asOpenPresetMenu = null;
function asClosePresetMenu() { if (asOpenPresetMenu) { asOpenPresetMenu.dispose(); asOpenPresetMenu = null; } }

function asShowPresetMenu(node, anchor, list) {
  asClosePresetMenu();
  const menu = document.createElement("div");
  menu.style.cssText = `position:fixed;z-index:10004;background:${SV.inset};border:1px solid ${SV.border2};border-radius:6px;` +
    `min-width:240px;max-width:380px;max-height:300px;overflow:auto;font:12px Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);`;
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.round(Math.min(r.left, window.innerWidth - 400)) + "px";
  menu.style.top = Math.round(r.bottom + 4) + "px";
  if (!list.length) {
    const em = document.createElement("div");
    em.textContent = "No presets saved for this folder yet";
    em.style.cssText = `padding:10px;font-size:11px;color:${SV.ghost};font-style:italic;`;
    menu.appendChild(em);
  }
  for (const pr of list) {
    const row = document.createElement("div");
    const sel = pr.name === node.__asPresetName;
    row.style.cssText = `display:flex;align-items:center;gap:8px;padding:5px 10px;cursor:pointer;border-bottom:1px solid ${SV.border2};${sel ? `background:${SV.rowOn};` : ""}`;
    const nm = document.createElement("span"); nm.textContent = pr.name;
    nm.style.cssText = `flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${SV.text};`;
    row.appendChild(nm);
    const sub = document.createElement("span");
    sub.textContent = svFileLabel(pr.selection || "");
    sub.style.cssText = `flex:none;max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:10px;color:${SV.faint};`;
    row.appendChild(sub);
    const del = document.createElement("span"); del.dataset.stop = "1"; del.textContent = "✕";
    del.title = "Delete this preset";
    del.style.cssText = `flex:none;cursor:pointer;color:${SV.mut};font-size:11px;`;
    del.addEventListener("mouseenter", () => del.style.color = SV.danger);
    del.addEventListener("mouseleave", () => del.style.color = SV.mut);
    del.addEventListener("pointerdown", e => e.stopPropagation());
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const cat = asGet(node, "category");
      try {
        const d = await asPresetApi("/delete", { category: cat, name: pr.name });
        asPresetCache.set(cat, d.presets || []);
        if (node.__asPresetName === pr.name) node.__asPresetName = "";
        asClosePresetMenu(); node.__asRender?.();
        svToast(`Deleted “${pr.name}”`);
      } catch (err) { svToast(String(err.message || err), true); }
    });
    row.appendChild(del);
    row.addEventListener("mouseenter", () => row.style.background = SV.rowHover);
    row.addEventListener("mouseleave", () => row.style.background = sel ? SV.rowOn : "");
    row.addEventListener("pointerdown", e => e.stopPropagation());
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-stop]")) return;
      e.stopPropagation(); asClosePresetMenu();
      asSet(node, "selection", pr.selection || "");
      if (pr.enabledFolders !== undefined) {
        asSetEnabled(node, pr.enabledFolders == null ? null : new Set(pr.enabledFolders.map(normPath)));
      }
      node.__asPresetName = pr.name;
      node.__asRender?.(); node.setDirtyCanvas(true, true);
      svToast(`Loaded “${pr.name}”`);
    });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  const away = (ev) => { if (!menu.contains(ev.target) && !anchor.contains(ev.target)) asClosePresetMenu(); };
  setTimeout(() => window.addEventListener("pointerdown", away, true), 0);
  asOpenPresetMenu = { dispose: () => { window.removeEventListener("pointerdown", away, true); menu.remove(); } };
}

// ---- the node panel -------------------------------------------------------
function asRenderPanel(node, root) {
  root.textContent = "";
  root.style.cssText = "display:flex;flex-direction:column;font:12px Arial,sans-serif;width:100%;box-sizing:border-box;padding:2px 0;";
  const panel = document.createElement("div");
  panel.style.cssText = `background:${SV.panel};border:1px solid ${SV.border};border-radius:8px;padding:9px;` +
    `box-sizing:border-box;width:100%;max-width:100%;min-width:0;`;
  root.appendChild(panel);

  const cat = asGet(node, "category");
  const sel = asGet(node, "selection");

  if (!cat) {
    const hint = document.createElement("div");
    hint.innerHTML = `<div style="font-size:12px;color:${SV.dim};margin-bottom:3px;">Wire me into a loader</div>` +
      `<div style="font-size:11px;color:${SV.faint};line-height:1.45;">Drag the <b>name</b> output onto a loader's model / clip / vae input. ` +
      `I'll work out which folder to search and show a filtered picker.</div>`;
    hint.style.cssText = `border:1px dashed ${SV.dashed};border-radius:6px;padding:10px 12px;background:${SV.inset};` +
      `box-sizing:border-box;width:100%;min-width:0;overflow-wrap:anywhere;`;
    panel.appendChild(hint);
    svMeasureAsPanel(node, panel);
    return;
  }

  // category strip
  const strip = document.createElement("div");
  strip.style.cssText = "display:flex;align-items:center;gap:7px;margin-bottom:8px;";
  const tag = document.createElement("span"); tag.textContent = cat;
  tag.style.cssText = `flex:none;font:10px ui-monospace,monospace;color:${SV.badgeFg};background:${SV.badgeBg};border-radius:3px;padding:2px 7px;`;
  tag.title = "Detected from the loader this is wired into";
  strip.appendChild(tag);
  const sp = document.createElement("span"); sp.style.flex = "1"; strip.appendChild(sp);
  strip.appendChild(svExtButton());
  strip.appendChild(svThemeButton());
  panel.appendChild(strip);

  // ---- preset row (per category) ----
  const presets = asPresetCache.get(cat);
  if (presets === undefined) asLoadPresets(node, cat);

  if (node.__asPresetMode === "save") {
    const pr = document.createElement("div");
    pr.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:8px;";
    const tg = document.createElement("span"); tg.textContent = "SAVE AS";
    tg.style.cssText = `flex:none;font-size:10px;letter-spacing:.08em;color:${SV.faint};`;
    pr.appendChild(tg);
    const inp = svSmallInput("preset name…", node.__asPresetName || "");
    inp.style.cssText += "flex:1;min-width:0;";
    pr.appendChild(inp);
    const cancel = () => { node.__asPresetMode = null; node.__asOverwrite = null; node.__asRender?.(); };
    const doSave = async (overwrite) => {
      const nm = inp.value.trim();
      if (!nm) { svToast("Give the preset a name.", true); inp.focus(); return; }
      try {
        const d = await asPresetApi("/save", {
          category: cat, name: nm, overwrite: !!overwrite,
          selection: asGet(node, "selection"),
          enabledFolders: (() => { const e2 = asEnabled(node); return e2 == null ? null : [...e2]; })(),
        });
        asPresetCache.set(cat, d.presets || []);
        node.__asPresetName = d.name; node.__asPresetMode = null; node.__asOverwrite = null;
        svToast(`Saved “${d.name}” for ${cat}`);
        node.__asRender?.();
      } catch (err) {
        if (err.code === "exists") { node.__asOverwrite = nm; node.__asPresetMode = "overwrite"; node.__asRender?.(); }
        else svToast(String(err.message || err), true);
      }
    };
    inp.addEventListener("keydown", e => { if (e.key === "Enter") doSave(false); if (e.key === "Escape") cancel(); });
    const ok = svBtn("Save", "", () => doSave(false)); ok.style.padding = "3px 10px"; pr.appendChild(ok);
    const no = svBtn("Cancel", "", cancel); no.style.padding = "3px 10px"; pr.appendChild(no);
    panel.appendChild(pr);
    setTimeout(() => inp.focus(), 0);
  } else if (node.__asPresetMode === "overwrite") {
    const pr = document.createElement("div");
    pr.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:8px;";
    const q = document.createElement("span");
    q.textContent = `“${node.__asOverwrite}” exists — overwrite?`;
    q.style.cssText = `flex:1;min-width:0;font-size:12px;color:#e0a94c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
    pr.appendChild(q);
    const yes = svBtn("Overwrite", "", async () => {
      try {
        const d = await asPresetApi("/save", {
          category: cat, name: node.__asOverwrite, overwrite: true,
          selection: asGet(node, "selection"),
          enabledFolders: (() => { const e2 = asEnabled(node); return e2 == null ? null : [...e2]; })(),
        });
        asPresetCache.set(cat, d.presets || []);
        node.__asPresetName = d.name; node.__asPresetMode = null; node.__asOverwrite = null;
        svToast(`Updated “${d.name}”`); node.__asRender?.();
      } catch (err) { svToast(String(err.message || err), true); }
    });
    yes.style.padding = "3px 10px"; yes.style.borderColor = "#e0a94c"; yes.style.color = "#e0a94c";
    pr.appendChild(yes);
    const back = svBtn("Rename", "", () => { node.__asPresetMode = "save"; node.__asRender?.(); });
    back.style.padding = "3px 10px"; pr.appendChild(back);
    panel.appendChild(pr);
  } else {
    const pr = document.createElement("div");
    pr.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:8px;";
    const tg = document.createElement("span"); tg.textContent = "PRESET";
    tg.style.cssText = `flex:none;font-size:10px;letter-spacing:.08em;color:${SV.faint};`;
    pr.appendChild(tg);
    const list = presets || [];
    const pick = document.createElement("button"); pick.dataset.stop = "1";
    pick.style.cssText = `flex:none;background:${SV.btn};border:1px solid ${SV.btnBorder};color:${SV.btnText};` +
      `border-radius:6px;padding:3px 10px;font:12px Arial,sans-serif;cursor:pointer;` +
      `display:inline-flex;align-items:center;gap:6px;`;
    const pl = document.createElement("span");
    pl.textContent = list.length ? `Presets (${list.length})` : "Presets";
    pick.appendChild(pl);
    const car = document.createElement("span"); car.textContent = "▾";
    car.style.cssText = `color:${SV.mut};font-size:10px;`; pick.appendChild(car);
    pick.title = `Presets saved for the ${cat} folder`;
    pick.addEventListener("mouseenter", () => pick.style.background = SV.btnHover);
    pick.addEventListener("mouseleave", () => pick.style.background = SV.btn);
    pick.addEventListener("pointerdown", e => e.stopPropagation());
    pick.addEventListener("click", (e) => { e.stopPropagation(); asShowPresetMenu(node, pick, list); });
    pr.appendChild(pick);

    // Loaded preset name sits beside the button, so the row still says what's active.
    const active = document.createElement("span");
    active.textContent = node.__asPresetName || "";
    active.style.cssText = `flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;` +
      `font-size:11px;color:${SV.dim};`;
    pr.appendChild(active);
    const save = svBtn("Save", "Save this pick and folder filter as a preset for " + cat, () => {
      node.__asPresetMode = "save"; node.__asRender?.();
    });
    save.style.padding = "3px 10px"; pr.appendChild(save);
    panel.appendChild(pr);
  }

  // folders chip bar
  const fb = document.createElement("div");
  fb.style.cssText = "display:flex;align-items:center;gap:7px;margin-bottom:8px;";
  const flabel = document.createElement("span"); flabel.textContent = "FOLDERS";
  flabel.style.cssText = `flex:none;font-size:10px;letter-spacing:.08em;color:${SV.faint};`;
  fb.appendChild(flabel);
  const fbox = document.createElement("div"); fbox.dataset.ctl = "1";
  fbox.style.cssText = `flex:1;min-width:0;min-height:24px;display:flex;flex-wrap:wrap;align-items:center;gap:5px;background:${SV.inset};border:1px solid ${SV.border2};border-radius:6px;padding:3px 7px;cursor:pointer;`;
  const en = asEnabled(node);
  const chip = (text, onX, accent) => {
    const c = document.createElement("span");
    c.style.cssText = `display:inline-flex;align-items:center;gap:5px;background:${SV.btn};border:1px solid ${accent || SV.btnBorder};color:${accent || SV.text};border-radius:4px;padding:1px 7px;font-size:11px;`;
    c.appendChild(document.createTextNode(text));
    if (onX) {
      const x = document.createElement("span"); x.dataset.ctl = "1"; x.dataset.stop = "1"; x.textContent = "✕";
      x.style.cssText = `cursor:pointer;color:${SV.mut};font-size:10px;`;
      x.addEventListener("mouseenter", () => x.style.color = SV.danger);
      x.addEventListener("mouseleave", () => x.style.color = SV.mut);
      x.addEventListener("pointerdown", e => e.stopPropagation());
      x.addEventListener("click", (e) => { e.stopPropagation(); onX(); });
      c.appendChild(x);
    }
    return c;
  };
  if (en == null) fbox.appendChild(chip("All Folders", () => asSetEnabled(node, new Set())));
  else if (!en.size) {
    const none = document.createElement("span");
    none.innerHTML = `<span style="color:${SV.ghost};font-style:italic;font-size:11px;">No folders selected</span>`;
    fbox.appendChild(none);
    const link = document.createElement("span"); link.textContent = "select all";
    link.dataset.ctl = "1"; link.dataset.stop = "1";
    link.style.cssText = `font-size:11px;color:${SV.mut};cursor:pointer;text-decoration:underline;margin-left:6px;`;
    link.addEventListener("pointerdown", e => e.stopPropagation());
    link.addEventListener("click", (e) => { e.stopPropagation(); asSetEnabled(node, null); });
    fbox.appendChild(link);
  } else {
    for (const f of [...en].sort()) {
      fbox.appendChild(chip(f, () => { const n2 = new Set(en); n2.delete(f); asSetEnabled(node, n2); }));
    }
  }
  fbox.addEventListener("pointerdown", e => e.stopPropagation());
  fbox.addEventListener("click", (e) => {
    if (e.target.closest("[data-stop]")) return;   // a chip ✕ or link, not the box
    e.stopPropagation(); asShowFolderDropdown(node, fbox);
  });
  fb.appendChild(fbox);
  panel.appendChild(fb);

  // selection row
  const row = document.createElement("div");
  row.dataset.ctl = "1";
  row.style.cssText = `display:flex;align-items:center;gap:8px;border:1px solid ${sel ? SV.border2 : SV.dashed};border-radius:6px;` +
    `background:${sel ? SV.inset : SV.slotEmpty};padding:8px 10px;cursor:pointer;min-height:34px;box-sizing:border-box;`;
  if (sel) {
    const folder = asFolderOf(sel);
    const base = sel.slice(sel.lastIndexOf("/") + 1);
    const txt = document.createElement("div");
    txt.innerHTML = (folder !== ROOT_LABEL ? `<div style="font-size:10px;color:${SV.faint};">${flgEscape(folder)}/</div>` : "") +
      `<div style="font-size:12px;color:${SV.text};">${flgEscape(svShowExt() ? base : base.replace(/\.[^.]+$/, ""))}</div>`;
    txt.style.cssText = "flex:1;min-width:0;overflow:hidden;";
    row.appendChild(txt);
    const clr = document.createElement("span"); clr.dataset.ctl = "1"; clr.dataset.stop = "1"; clr.textContent = "✕";
    clr.title = "Clear the selection";
    clr.style.cssText = `flex:none;cursor:pointer;color:${SV.danger};font-size:13px;`;
    clr.addEventListener("mouseenter", () => clr.style.color = SV.dangerHov);
    clr.addEventListener("mouseleave", () => clr.style.color = SV.danger);
    clr.addEventListener("pointerdown", e => e.stopPropagation());
    clr.addEventListener("click", (e) => { e.stopPropagation(); asSet(node, "selection", ""); node.__asRender?.(); node.setDirtyCanvas(true, true); });
    row.appendChild(clr);
  } else {
    const ph = document.createElement("span");
    ph.textContent = "Choose a file…";
    ph.style.cssText = `flex:1;font-size:12px;color:${SV.ghost};font-style:italic;`;
    row.appendChild(ph);
  }
  row.addEventListener("pointerdown", e => e.stopPropagation());
  row.addEventListener("click", (e) => {
    if (e.target.closest("[data-stop]")) return;   // the clear ✕, not the row
    e.stopPropagation(); asShowChooser(node, row);
  });
  panel.appendChild(row);
  svMeasureAsPanel(node, panel);
}

const AS_MIN_W = 380;
// Fit the node to the panel. Runs once per content change, not per redraw:
// dragging the node re-renders it, and re-measuring on every frame made the
// node resize while being dragged.
function svMeasureAsPanel(node, panel) {
  const sig = panel.textContent.length + "|" + (node.widgets || []).length;
  if (node.__asFitSig === sig && node.__asMeasuredH && node.size[0] >= AS_MIN_W) return;

  // Width first: the panel wraps text, so its height is only meaningful once
  // the node is at its final width.
  if (node.size[0] < AS_MIN_W) {
    node.setSize([AS_MIN_W, node.size[1]]);
    node.setDirtyCanvas(true, true);
  }
  requestAnimationFrame(() => {
    try {
      if (!panel.isConnected) return;
      const h = panel.offsetHeight;          // layout px, immune to canvas zoom
      if (h <= 0) return;
      node.__asFitSig = sig;
      node.__asMeasuredH = h + 14;           // slack for the node's own chrome
      const want = node.computeSize();
      if (Math.abs(node.size[1] - want[1]) > 2) {
        node.setSize([node.size[0], want[1]]);
        node.setDirtyCanvas(true, true);
      }
    } catch (_) {}
  });
}

app.registerExtension({
  name: "fantastic.any.selector",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== AS_NODE_NAME) return;
    nodeType.color = NODE_COLOR;
    nodeType.bgcolor = NODE_BGCOLOR;

    const origONC = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = origONC?.apply(this, arguments);
      try {
        svApplyNodeColors(this);
        hideWidget(this, asWidget(this, "selection"));
        hideWidget(this, asWidget(this, "category"));
        const dom = document.createElement("div");
        this.__asRender = () => asRenderPanel(this, dom);
        const w = this.addDOMWidget("as_panel", "div", dom, { serialize: false });
        w.serializeValue = () => undefined;
        w.computeSize = (width) => [width, node_asHeight(this)];
        if (!this.size || this.size[0] < AS_MIN_W) this.size = [Math.max(this.size?.[0] || 0, AS_MIN_W), this.size?.[1] || 0];
        this.__asRender();
      } catch (err) { console.warn("[FantasticAnySelector] init failed", err); }
      return r;
    };

    const origCfg = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = origCfg?.apply(this, arguments);
      try { svApplyNodeColors(this); hideWidget(this, asWidget(this, "selection")); hideWidget(this, asWidget(this, "category")); this.__asRender?.(); } catch (_) {}
      return r;
    };

    // Single-link: a new connection replaces the old one, so the category is
    // never ambiguous. Detect the category from whatever we're now attached to.
    const origConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (type, index, connected, link_info) {
      const r = origConn?.apply(this, arguments);
      try {
        if (type === 2 /* output */) {
          const links = (this.outputs?.[0]?.links) || [];
          if (connected && links.length > 1) {
            // Drop everything except the newest — done next tick, since the
            // graph is mid-update inside this callback.
            const keep = link_info?.id ?? links[links.length - 1];
            const drop = links.filter(l => l !== keep);
            setTimeout(() => {
              try {
                for (const id of drop) {
                  const lk = app.graph.links[id];
                  if (!lk) continue;
                  const tgt = app.graph.getNodeById(lk.target_id);
                  tgt?.disconnectInput(lk.target_slot);
                }
                this.setDirtyCanvas(true, true);
              } catch (_) {}
            }, 0);
          }
          setTimeout(async () => {
            const cat = await asDetectCategory(this);
            const prev = asGet(this, "category");
            if (cat !== prev) {
              asSet(this, "category", cat);
              asSet(this, "selection", "");     // stale value would fail validation
              this.__asPresetName = "";         // presets belong to the old category
              this.__asPresetMode = null;
            }
            this.__asRender?.();
            this.setDirtyCanvas(true, true);
          }, 0);
        }
      } catch (_) {}
      return r;
    };
  },
});

function node_asHeight(node) {
  if (node.__asMeasuredH) return node.__asMeasuredH;
  return asGet(node, "category") ? 168 : 96;
}

// ---- "Add Fantastic Any Selector" on any loader's right-click menu --------
// getExtraMenuOptions is a documented, renderer-agnostic hook, so this works
// without depending on how the drag-release search box filters slot types.

// Which of a node's widgets/inputs we can serve, as [name, category] pairs.
function asServableSlots(node) {
  const out = [];
  const seen = new Set();
  for (const w of (node.widgets || [])) {
    const cat = AS_NAME_MAP[w.name];
    if (!cat || seen.has(w.name)) continue;
    // Skip ones already fed by a wire.
    const inp = (node.inputs || []).find(i => i?.name === w.name);
    if (inp && inp.link != null) continue;
    seen.add(w.name);
    out.push([w.name, cat]);
  }
  // Widgets already converted to inputs still count, if unconnected.
  for (const i of (node.inputs || [])) {
    const cat = AS_NAME_MAP[i?.name];
    if (!cat || seen.has(i.name) || i.link != null) continue;
    seen.add(i.name);
    out.push([i.name, cat]);
  }
  return out;
}

// Convert a widget to an input if it isn't one already, and return its index.
function asEnsureInput(node, name) {
  let idx = (node.inputs || []).findIndex(i => i?.name === name);
  if (idx >= 0) return idx;
  const w = (node.widgets || []).find(x => x.name === name);
  if (!w) return -1;
  try {
    if (typeof node.convertWidgetToInput === "function") {
      node.convertWidgetToInput(w);                    // classic path
    } else {
      // Newer frontends expose widget inputs directly; adding the input by the
      // widget's own type keeps the socket compatible with the widget values.
      node.addInput(name, w.type === "combo" ? (w.options?.values || "*") : w.type);
    }
  } catch (err) {
    console.warn("[FantasticAnySelector] could not convert widget to input", err);
  }
  idx = (node.inputs || []).findIndex(i => i?.name === name);
  return idx;
}

function asSpawnFor(node, inputName, category) {
  const LG = (typeof LiteGraph !== "undefined") ? LiteGraph : window.LiteGraph;
  const graph = node.graph;
  if (!LG || !graph) { svToast("Can't add the selector — graph unavailable.", true); return; }
  const sel = LG.createNode(AS_NODE_NAME);
  if (!sel) { svToast("Fantastic Any Selector isn't registered — restart ComfyUI.", true); return; }
  graph.add(sel);

  const w = (sel.size && sel.size[0]) || AS_MIN_W;
  // Offset each new one so several selectors on the same loader don't stack
  // invisibly on top of each other.
  const existing = (node.graph?._nodes || []).filter(n => (n.comfyClass || n.type) === AS_NODE_NAME && n !== sel).length;
  sel.pos = [node.pos[0] - w - 60, node.pos[1] + (existing % 6) * 30];

  const slot = asEnsureInput(node, inputName);
  if (slot < 0) { svToast(`Couldn't open an input for ${inputName}.`, true); return; }
  try {
    sel.connect(0, node, slot);
  } catch (err) {
    console.warn("[FantasticAnySelector] wiring failed", err);
    svToast("Added the selector, but wiring failed — connect it by hand.", true);
  }
  // Category is normally detected on connect; set it now so the panel is
  // usable immediately even if detection is still in flight.
  try { asSet(sel, "category", category); sel.__asRender?.(); } catch (_) {}
  graph.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "fantastic.any.selector.menu",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name === AS_NODE_NAME) return;      // don't offer it on itself
    const orig = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      const r = orig?.apply(this, arguments);
      try {
        const slots = asServableSlots(this);
        if (!slots.length) return r;
        // One flat entry per servable input rather than a submenu — submenus
        // need LiteGraph.ContextMenu, which the Vue renderer doesn't provide.
        // Loaders have one or two of these, so the list stays short.
        for (const [name, cat] of slots) {
          options.push({
            content: slots.length === 1
              ? `🎯 Add Fantastic Any Selector (${cat})`
              : `🎯 Add Fantastic Any Selector — ${name}`,
            callback: () => asSpawnFor(this, name, cat),
          });
        }
      } catch (err) { console.warn("[FantasticAnySelector] menu hook failed", err); }
      return r;
    };
  },
});

// ===========================================================================
// DOM widget stacking
// ---------------------------------------------------------------------------
// DOM widgets live in an overlay layer whose paint order follows the order the
// elements were created, not the graph's node order. With two overlapping
// nodes that both render DOM panels, the one behind can paint over the one in
// front, and clicks can land on the wrong node. Our nodes are almost entirely
// DOM, so this shows up badly — raise a node's elements whenever it's touched.
// ===========================================================================

let flZTop = 1000;

// z-index only applies to POSITIONED elements. ComfyUI wraps a DOM widget in
// one or more containers, and the widget element itself is usually static —
// setting z-index on it does nothing. Walk up to the nearest positioned
// ancestor (stopping before the shared overlay root) and raise that instead.
function flPositionedHost(el) {
  let cur = el, hops = 0;
  while (cur && hops++ < 6) {
    const pos = getComputedStyle(cur).position;
    if (pos === "absolute" || pos === "fixed" || pos === "relative") return cur;
    cur = cur.parentElement;
  }
  return el;
}

function flDomEls(node) {
  const out = new Set();
  for (const w of (node.widgets || [])) {
    if (!w.element) continue;
    out.add(flPositionedHost(w.element));
  }
  return [...out];
}

// Other packs' DOM widgets (Markdown notes, preview overrides) sit in the same
// overlay with z-index values we don't control, so a fixed counter can lose to
// them. Read what's actually in the layer and go one above the highest.
function flHighestZIn(el) {
  let top = 0;
  try {
    const root = el.closest(".comfy-menu, .graph-canvas-container, body") || document.body;
    for (const n of root.querySelectorAll("*")) {
      const z = parseInt(getComputedStyle(n).zIndex, 10);
      if (!isNaN(z) && z < 100000 && z > top) top = z;   // ignore modal layers
    }
  } catch (_) {}
  return top;
}

function flRaiseNode(node) {
  try {
    const els = flDomEls(node);
    if (!els.length) return;
    if (node.__flZ && node.__flZ === flZTop) return;     // already on top
    flZTop = Math.max(flZTop, flHighestZIn(els[0])) + 1;
    node.__flZ = flZTop;
    for (const el of els) {
      // z-index is ignored on statically positioned elements.
      if (getComputedStyle(el).position === "static") el.style.position = "relative";
      el.style.zIndex = String(node.__flZ);
    }
  } catch (_) {}
}

// Any pointer press inside one of our panels raises that node first, so the
// click lands where it looks like it should.
function flBindRaise(node, el) {
  if (!el || el.__flBound) return;
  el.__flBound = true;
  el.addEventListener("pointerdown", () => flRaiseNode(node), true);
}

// Console helper: window.flStackDebug() prints what each pack node's panel is
// actually stacked at, so a layering problem can be diagnosed from a paste.
try {
  window.flStackDebug = () => {
    const rows = [];
    for (const n of (app.graph?._nodes || [])) {
      const cls = n.comfyClass || n.type;
      for (const el of flDomEls(n)) {
        const cs = getComputedStyle(el);
        rows.push(`${String(cls).padEnd(28)} id=${String(n.id).padEnd(5)} ` +
          `tag=${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0] || "-"} ` +
          `pos=${cs.position} z=${cs.zIndex}`);
      }
    }
    console.log(rows.join("\n") || "(no DOM-widget nodes found)");
    return rows.length + " element(s)";
  };
} catch (_) {}

app.registerExtension({
  name: "fantastic.dom.stacking",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const nm = nodeData?.name;
    if (!nm || (!SV_THEMED_NODES.has(nm) && nm !== AS_NODE_NAME)) return;

    // Selecting a node in the graph should bring its panel forward too.
    const origSel = nodeType.prototype.onSelected;
    nodeType.prototype.onSelected = function () {
      const r = origSel?.apply(this, arguments);
      flRaiseNode(this);
      return r;
    };

    // Clicking the node's title bar also raises it — the way out when another
    // node's panel is covering ours and swallowing clicks.
    const origMD = nodeType.prototype.onMouseDown;
    nodeType.prototype.onMouseDown = function () {
      flRaiseNode(this);
      return origMD?.apply(this, arguments);
    };

    // Bind after creation, once the DOM widgets exist.
    const origONC = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = origONC?.apply(this, arguments);
      setTimeout(() => {
        try { for (const el of flDomEls(this)) flBindRaise(this, el); } catch (_) {}
      }, 0);
      return r;
    };
  },
});

// ===========================================================================
// Fantastic Seeds 🌱
// ---------------------------------------------------------------------------
// Three modes plus a history of the last five seeds actually queued. Rolling
// happens here at queue time — the same reason the lora randomiser does: a
// value generated during execution takes a different code path, and what the
// node shows must match what was submitted.
// ===========================================================================

const SEED_NODE_NAME = "FantasticSeeds";
const SEED_MAX = 1125899906842624;      // 2^50 — inside JS's safe integer range
const SEED_HISTORY_MAX = 10;

function sdWidget(node, name) { return (node.widgets || []).find(w => w.name === name); }
function sdGet(node, name, dflt) { const w = sdWidget(node, name); return w ? w.value : dflt; }
function sdSet(node, name, v) { const w = sdWidget(node, name); if (w) w.value = v; }

function sdMode(node) {
  const m = String(sdGet(node, "mode", "fixed") || "fixed");
  return (m === "randomize" || m === "locked") ? m : "fixed";
}
function sdNewSeed() { return Math.floor(Math.random() * (SEED_MAX + 1)); }

function sdHistory(node) {
  try {
    const h = JSON.parse(String(sdGet(node, "history", "[]") || "[]"));
    return Array.isArray(h) ? h.filter(n => Number.isFinite(n)) : [];
  } catch (_) { return []; }
}
function sdPushHistory(node, seed) {
  const h = sdHistory(node).filter(n => n !== seed);
  h.unshift(seed);
  sdSet(node, "history", JSON.stringify(h.slice(0, SEED_HISTORY_MAX)));
}

// Called from the queue wrapper: roll if the mode says so, then record.
function sdOnQueue(node) {
  try {
    if (sdMode(node) === "randomize") sdSet(node, "seed", sdNewSeed());
    const cur = Number(sdGet(node, "seed", 0)) || 0;
    sdPushHistory(node, cur);
    node.__sdRender?.();
  } catch (_) {}
}

function sdPanel(node, root) {
  root.textContent = "";
  root.style.cssText = "display:flex;flex-direction:column;font:12px Arial,sans-serif;width:100%;box-sizing:border-box;padding:2px 0;";
  const panel = document.createElement("div");
  panel.style.cssText = `background:${SV.panel};border:1px solid ${SV.border};border-radius:8px;padding:9px;` +
    `box-sizing:border-box;width:100%;max-width:100%;min-width:0;`;
  root.appendChild(panel);

  const mode = sdMode(node);
  const seed = Number(sdGet(node, "seed", 0)) || 0;

  // ---- seed field ----
  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:8px;";
  const lab = document.createElement("span"); lab.textContent = "SEED";
  lab.style.cssText = `flex:none;font-size:10px;letter-spacing:.08em;color:${SV.faint};`;
  row.appendChild(lab);

  const inp = document.createElement("input");
  inp.type = "text"; inp.inputMode = "numeric"; inp.dataset.stop = "1";
  inp.value = mode === "randomize" ? "random each queue" : String(seed);
  inp.readOnly = mode === "randomize";
  inp.style.cssText = `flex:1;min-width:0;background:${SV.field};border:1px solid ${SV.border2};` +
    `color:${mode === "randomize" ? SV.ghost : SV.text};border-radius:5px;padding:4px 8px;` +
    `font:12px ui-monospace,monospace;outline:none;${mode === "randomize" ? "font-style:italic;" : ""}`;
  inp.addEventListener("pointerdown", e => e.stopPropagation());
  inp.addEventListener("focus", () => { if (!inp.readOnly) { inp.style.borderColor = SV.accent; inp.select(); } });
  inp.addEventListener("blur", () => { inp.style.borderColor = SV.border2; });
  inp.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") inp.blur(); });
  inp.addEventListener("change", () => {
    const v = parseInt(inp.value.replace(/[^0-9]/g, ""), 10);
    if (!isNaN(v)) {
      sdSet(node, "seed", Math.max(0, Math.min(SEED_MAX, v)));
      if (mode === "randomize") sdSet(node, "mode", "fixed");   // typing means you want it
    }
    node.__sdRender?.(); node.setDirtyCanvas(true, true);
  });
  row.appendChild(inp);

  const copy = document.createElement("span"); copy.dataset.stop = "1"; copy.textContent = "⧉";
  copy.title = "Copy this seed";
  copy.style.cssText = `flex:none;cursor:pointer;color:${SV.mut};font-size:13px;padding:0 2px;`;
  copy.addEventListener("mouseenter", () => copy.style.color = SV.text);
  copy.addEventListener("mouseleave", () => copy.style.color = SV.mut);
  copy.addEventListener("pointerdown", e => e.stopPropagation());
  copy.addEventListener("click", (e) => {
    e.stopPropagation();
    try { navigator.clipboard?.writeText(String(seed)); svToast("Seed copied"); } catch (_) {}
  });
  row.appendChild(copy);
  panel.appendChild(row);

  // ---- mode segment ----
  const seg = document.createElement("div");
  seg.style.cssText = `display:flex;border:1px solid ${SV.btnBorder};border-radius:6px;overflow:hidden;margin-bottom:8px;`;
  const mk = (label, key, title) => {
    const b = document.createElement("span"); b.dataset.stop = "1";
    const on = mode === key;
    b.textContent = label; b.title = title;
    b.style.cssText = `flex:1;text-align:center;padding:4px 6px;font-size:12px;cursor:pointer;user-select:none;` +
      (on ? `background:${SV.btnBorder};color:${SV.text};` : `background:${SV.btn};color:${SV.mut};`);
    b.addEventListener("pointerdown", e => e.stopPropagation());
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      sdSet(node, "mode", key);
      if (key === "locked") sdSet(node, "seed", sdNewSeed());   // a fresh one to lock
      node.__sdRender?.(); node.setDirtyCanvas(true, true);
    });
    return b;
  };
  seg.appendChild(mk("Fixed", "fixed", "Always use the seed shown"));
  seg.appendChild(mk("Randomize", "randomize", "A new seed every time you queue"));
  seg.appendChild(mk("Locked random", "locked", "Roll once, then keep it until you roll again"));
  panel.appendChild(seg);

  // ---- roll button ----
  const roll = svBtn("🎲 New random seed", "Roll a new seed now and keep it", () => {
    sdSet(node, "seed", sdNewSeed());
    if (sdMode(node) === "randomize") sdSet(node, "mode", "locked");
    node.__sdRender?.(); node.setDirtyCanvas(true, true);
  });
  roll.style.cssText += "width:100%;justify-content:center;margin-bottom:8px;";
  panel.appendChild(roll);

  // ---- bottom row: history (takes the space) + theme ----
  const bottom = document.createElement("div");
  bottom.style.cssText = "display:flex;align-items:center;gap:6px;";
  const hist = sdHistory(node);
  const hb = svBtn(`🕘 History${hist.length ? ` (${hist.length})` : ""}`,
    hist.length ? "The last seeds you queued" : "Seeds you queue will be listed here",
    (e) => sdShowHistory(node, e.currentTarget));
  hb.dataset.stop = "1";
  hb.style.cssText += "flex:1;justify-content:center;";
  if (!hist.length) { hb.style.opacity = ".5"; }
  const theme = svThemeButton();
  theme.dataset.stop = "1";
  theme.style.padding = "3px 8px";
  bottom.appendChild(theme);
  bottom.appendChild(hb);
  panel.appendChild(bottom);

  sdMeasure(node, panel);
}

// ---- history modal --------------------------------------------------------
let sdOpenHistory = null;
function sdCloseHistory() { if (sdOpenHistory) { sdOpenHistory.dispose(); sdOpenHistory = null; } }

function sdShowHistory(node, anchor) {
  sdCloseHistory();
  const hist = sdHistory(node);
  const cur = Number(sdGet(node, "seed", 0)) || 0;
  const mode = sdMode(node);

  const panel = document.createElement("div");
  panel.style.cssText = `position:fixed;z-index:10004;background:${SV.inset};border:1px solid ${SV.border};` +
    `border-radius:8px;min-width:280px;max-width:380px;font:12px Arial,sans-serif;` +
    `box-shadow:0 10px 30px rgba(0,0,0,.55);display:flex;flex-direction:column;max-height:60vh;`;
  const r = anchor.getBoundingClientRect();
  panel.style.left = Math.round(Math.min(r.left, window.innerWidth - 400)) + "px";
  panel.style.top = Math.round(Math.min(r.bottom + 5, window.innerHeight - 260)) + "px";

  const head = document.createElement("div");
  head.style.cssText = `display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid ${SV.border2};background:${SV.header};border-radius:8px 8px 0 0;`;
  const ttl = document.createElement("span"); ttl.textContent = "Recent seeds";
  ttl.style.cssText = `flex:1;font-size:12px;color:${SV.text};`;
  head.appendChild(ttl);
  const x = document.createElement("span"); x.textContent = "✕";
  x.style.cssText = `cursor:pointer;color:${SV.mut};font-size:12px;`;
  x.addEventListener("click", (e) => { e.stopPropagation(); sdCloseHistory(); });
  head.appendChild(x);
  panel.appendChild(head);

  const list = document.createElement("div");
  list.style.cssText = "overflow:auto;flex:1;padding:5px;";
  if (!hist.length) {
    const em = document.createElement("div");
    em.textContent = "Nothing queued yet — seeds appear here after you run.";
    em.style.cssText = `padding:12px;font-size:11px;color:${SV.ghost};font-style:italic;`;
    list.appendChild(em);
  }
  for (const h of hist) {
    const isCur = h === cur && mode !== "randomize";
    const row = document.createElement("div");
    row.style.cssText = `display:flex;align-items:center;gap:7px;padding:5px 7px;border-radius:5px;margin-bottom:3px;` +
      `${isCur ? `background:${SV.rowOn};` : ""}`;
    const n = document.createElement("span"); n.textContent = String(h);
    n.style.cssText = `flex:1;min-width:0;font:12px ui-monospace,monospace;color:${isCur ? SV.text : SV.dim};overflow:hidden;text-overflow:ellipsis;`;
    row.appendChild(n);
    if (isCur) {
      const tag = document.createElement("span"); tag.textContent = "current";
      tag.style.cssText = `flex:none;font-size:10px;color:${SV.accent};`;
      row.appendChild(tag);
    }
    const use = svBtn("Use", "Use this seed (switches to Locked random)", (e) => {
      e.stopPropagation();
      sdSet(node, "seed", h); sdSet(node, "mode", "locked");
      sdCloseHistory(); node.__sdRender?.(); node.setDirtyCanvas(true, true);
    });
    use.style.padding = "2px 9px"; use.style.fontSize = "11px";
    row.appendChild(use);
    const cp = svBtn("Copy", "Copy this seed to the clipboard", (e) => {
      e.stopPropagation();
      try { navigator.clipboard?.writeText(String(h)); svToast("Seed copied"); } catch (_) {}
    });
    cp.style.padding = "2px 9px"; cp.style.fontSize = "11px";
    row.appendChild(cp);
    list.appendChild(row);
  }
  panel.appendChild(list);

  document.body.appendChild(panel);
  const away = (ev) => { if (!panel.contains(ev.target) && !anchor.contains(ev.target)) sdCloseHistory(); };
  const onKey = (ev) => { if (ev.key === "Escape") sdCloseHistory(); };
  setTimeout(() => { window.addEventListener("pointerdown", away, true); window.addEventListener("keydown", onKey, true); }, 0);
  sdOpenHistory = { dispose: () => {
    window.removeEventListener("pointerdown", away, true);
    window.removeEventListener("keydown", onKey, true);
    panel.remove();
  } };
}

const SD_MIN_W = 320;
function sdMeasure(node, panel) {
  const sig = panel.textContent.length;
  if (node.__sdFitSig === sig && node.__sdMeasuredH && node.size[0] >= SD_MIN_W) return;
  if (node.size[0] < SD_MIN_W) { node.setSize([SD_MIN_W, node.size[1]]); node.setDirtyCanvas(true, true); }
  requestAnimationFrame(() => {
    try {
      if (!panel.isConnected) return;
      const h = panel.offsetHeight;
      if (h <= 0) return;
      node.__sdFitSig = sig;
      node.__sdMeasuredH = h + 14;
      const want = node.computeSize();
      if (Math.abs(node.size[1] - want[1]) > 2) { node.setSize([node.size[0], want[1]]); node.setDirtyCanvas(true, true); }
    } catch (_) {}
  });
}

app.registerExtension({
  name: "fantastic.seeds",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== SEED_NODE_NAME) return;
    nodeType.color = NODE_COLOR;
    nodeType.bgcolor = NODE_BGCOLOR;

    const build = function () {
      try {
        svApplyNodeColors(this);
        // ComfyUI auto-attaches a control_after_generate widget to any INT
        // widget called "seed". It would fight our own modes (and re-roll
        // behind our back), so pin it to fixed and drop it from the node.
        const cag = (this.widgets || []).find(w => /control_after_generate/i.test(w.name || ""));
        if (cag) {
          try { cag.value = "fixed"; } catch (_) {}
          const i = this.widgets.indexOf(cag);
          if (i >= 0) this.widgets.splice(i, 1);
        }
        for (const n of ["seed", "mode", "history"]) hideWidget(this, sdWidget(this, n));
        if (!this.__sdEl) {
          const dom = document.createElement("div");
          this.__sdEl = dom;
          this.__sdRender = () => sdPanel(this, dom);
          const w = this.addDOMWidget("sd_panel", "div", dom, { serialize: false });
          w.serializeValue = () => undefined;
          w.computeSize = (width) => [width, this.__sdMeasuredH || 190];
          if (!this.size || this.size[0] < SD_MIN_W) this.size = [Math.max(this.size?.[0] || 0, SD_MIN_W), this.size?.[1] || 0];
        }
        if (!Number(sdGet(this, "seed", 0))) sdSet(this, "seed", sdNewSeed());
        this.__sdRender();
      } catch (err) { console.warn("[FantasticSeeds] init failed", err); }
    };

    const origONC = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = origONC?.apply(this, arguments); build.call(this); return r;
    };
    const origCfg = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = origCfg?.apply(this, arguments); build.call(this); return r;
    };
  },

  async setup() {
    // Roll + record at queue time, before the prompt is serialised.
    const origQueue = app.queuePrompt;
    app.queuePrompt = async function (...args) {
      try {
        for (const n of (app.graph?._nodes || [])) {
          if ((n.comfyClass || n.type) === SEED_NODE_NAME) sdOnQueue(n);
        }
      } catch (_) {}
      return origQueue.apply(this, args);
    };
  },
});
