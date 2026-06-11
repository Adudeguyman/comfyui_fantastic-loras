// Fantastic Lora Loader — frontend UI
// ------------------------------------
// Handles two nodes:
//   FantasticLoraLoader          — single model + optional CLIP
//   FantasticLoraLoaderMulti     — same UI + dynamic extra MODEL paths
//
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

const NODE_NAME       = "FantasticLoraLoader";
const MULTI_NODE_NAME = "FantasticLoraLoaderMulti";
const PLOT_NODE_NAME  = "FantasticLoraPlotter";
const ALL_NODE_NAMES  = [NODE_NAME, MULTI_NODE_NAME, PLOT_NODE_NAME];

// Nodes that use the multi-model UI (stack + dynamic model-path bar).
const isMultiLike = (name) => name === MULTI_NODE_NAME || name === PLOT_NODE_NAME;

const DATA_WIDGET          = "lora_data";
const NODE_COLOR           = "#0f848a";
const NODE_BGCOLOR         = "#0a6166";
const DEFAULT_WIDTH        = 560;
const MAX_EXTRA_MODELS     = 4;
const PROP_ENABLED_FOLDERS = "Enabled Lora Folders";
const ROOT_LABEL           = "(root)";
const FAVORITES_KEY        = "fll_favorites";   // localStorage key

// ===========================================================================
// Favourites — persisted in localStorage
// ===========================================================================

function loadFavorites() {
  try { return new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]")); }
  catch (_) { return new Set(); }
}

function saveFavorites(set) {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...set])); } catch (_) {}
}

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

async function showFolderFilterPanel(node, event) {
  if (openPanel?.node === node) { closeFolderPanel(); return; }
  closeFolderPanel();
  injectStyles();
  const files = await getLoraFiles(true);
  const units = collectUnits(files);
  const allUnits = [...units.keys()];
  const tree = buildTree(units);
  node.__plffUpdateFolderBtn?.();

  const panel = document.createElement("div"); panel.className = "lfl-panel";
  const header = document.createElement("div"); header.className = "lfl-header";
  header.innerHTML = `<span class="lfl-title">Lora folder filter</span>`;
  const close = document.createElement("span"); close.className = "lfl-close"; close.textContent = "✕";
  close.addEventListener("click", closeFolderPanel); header.appendChild(close); panel.appendChild(header);

  const actions = document.createElement("div"); actions.className = "lfl-actions";
  const mkBtn = (label, fn) => { const b = document.createElement("button"); b.className = "lfl-btn"; b.textContent = label; b.addEventListener("click", fn); actions.appendChild(b); };
  mkBtn("All (no filter)", () => { setEnabledFolders(node, null); renderTree(); });
  mkBtn("None", () => { setEnabledFolders(node, new Set()); renderTree(); });
  panel.appendChild(actions);

  const treeEl = document.createElement("div"); treeEl.className = "lfl-tree"; panel.appendChild(treeEl);
  const expanded = new Set();
  if (allUnits.length <= 30) { const ex = n => { for (const c of n.children.values()) { expanded.add(c.path); ex(c); } }; ex(tree); }
  else { for (const c of tree.children.values()) expanded.add(c.path); }

  const effSet = () => { const e = getEffectiveEnabledSet(node, allUnits); return e == null ? new Set(allUnits) : e; };
  const toggleUnits = paths => {
    const set = effSet(); const allOn = paths.every(u => set.has(u));
    for (const u of paths) allOn ? set.delete(u) : set.add(u);
    setEnabledFolders(node, set); renderTree();
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
    if (!allUnits.length) { const e = document.createElement("div"); e.className = "lfl-empty"; e.textContent = "No loras found in models/loras."; treeEl.appendChild(e); return; }
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
  openPanel = { el: panel, node, dispose: () => { document.removeEventListener("pointerdown", onPD, true); document.removeEventListener("keydown", onKD, true); panel.remove(); } };
}

// ===========================================================================
// Lora chooser panel  (custom DOM — enables star toggle without closing)
// ===========================================================================

let openChooserPanel = null;
function closeChooserPanel() { if (openChooserPanel) { openChooserPanel.dispose(); openChooserPanel = null; } }

async function showLoraChooser(node, event, onChoose) {
  closeChooserPanel();
  injectStyles();

  const files = await getLoraFiles(true);
  const units = collectUnits(files);
  const enabledSet = getEffectiveEnabledSet(node, units.keys());

  let loras = files.slice();
  if (enabledSet != null) loras = loras.filter(l => enabledSet.has(folderOf(l)));

  if (!loras.length) {
    new LiteGraph.ContextMenu(
      [{ content: "No loras in enabled folders — click 📁 Folders to adjust", disabled: true }],
      { event, title: "Choose a lora", className: "dark", scale: Math.max(1, app.canvas?.ds?.scale ?? 1) }
    );
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
  w.computeSize = () => [0, -4]; w.type = "lfl_hidden"; w.hidden = true;
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
  if (w) w.value = JSON.stringify({ loras: node.__loraStack || [], enabledFolders: effectiveEnabledFoldersArray(node) });
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
    root.textContent = "";
    const stack = node.__loraStack || [], hasClip = clipConnected(node);
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
      sLabel.title = hasClip ? "Strength (model + clip)" : "Strength (model — CLIP not connected)";
      sLabel.style.cssText = "opacity:.6;flex:none;font-size:11px;"; row.appendChild(sLabel);
      row.appendChild(numInput(entry.model, false, v => { const val = isNaN(v) ? 0 : v; entry.model = val; entry.clip = val; syncData(node); }));
      if (!hasClip) {
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
// Core UI builder (shared between both nodes)
// ===========================================================================

function buildCoreUI(node) {
  hideWidget(node, getDataWidget(node));
  loadStackFromData(node);

  const folderBtn = node.addWidget("button", "lfl_folders", null, (_v, _c, _n, _p, event) => showFolderFilterPanel(node, event));
  folderBtn.serialize = false; if (folderBtn.options) folderBtn.options.serialize = false; folderBtn.serializeValue = () => undefined;
  node.__plffUpdateFolderBtn = () => { folderBtn.label = `📁 Folders: ${folderButtonSuffix(node)}`; node.setDirtyCanvas(true, false); };
  node.__plffUpdateFolderBtn(); getLoraFiles().then(() => node.__plffUpdateFolderBtn());

  const dom = buildRowDOM(node);
  const domWidget = node.addDOMWidget("lfl_rows", "div", dom, { serialize: false });
  domWidget.serializeValue = () => undefined;
  domWidget.computeSize = function (width) {
    const rows = node.__loraStack?.length || 0;
    return [width, rows === 0 ? 28 : rows * 26 + 6];
  };

  const addBtn = node.addWidget("button", "lfl_add", null, (_v, _c, _n, _p, event) => {
    showLoraChooser(node, event, value => { node.__loraStack.push({ on: true, name: value, model: 1.0, clip: 1.0 }); node.__lflCommit(); });
  });
  addBtn.label = "➕ Add Lora"; addBtn.serialize = false;
  if (addBtn.options) addBtn.options.serialize = false; addBtn.serializeValue = () => undefined;
}

// ===========================================================================
// Single-model node UI
// ===========================================================================

function addUI(node) {
  if (node.__lflBuilt) return;
  node.__lflBuilt = true;
  buildCoreUI(node);

  // 🎲 Add Lora Randomizer — single-model node only (for now)
  const randBtn = node.addWidget("button", "lfl_add_rand", null, async () => {
    const entry = { on: true, name: "", model: 1.0, clip: 1.0, random: true, locked: false, folders: null };
    const pick = await pickRandomLora(node, entry);
    if (pick != null) entry.name = pick;
    node.__loraStack.push(entry);
    node.__lflCommit();
  });
  randBtn.label = "🎲 Add Lora Randomizer"; randBtn.serialize = false;
  if (randBtn.options) randBtn.options.serialize = false; randBtn.serializeValue = () => undefined;

  node.__lflLastRandCount = (node.__loraStack || []).filter(e => e.random).length;
  snapHeight(node);
}

// ===========================================================================
// Multi-model slot management
// ===========================================================================

function stripAutoExtraSlots(node) {
  for (let i = node.inputs.length - 1; i >= 0; i--)
    if (/^model_[2-5]$/.test(node.inputs[i]?.name)) node.removeInput(i);
  for (let i = node.outputs.length - 1; i >= 0; i--)
    if (/^MODEL [2-5]$/.test(node.outputs[i]?.name)) node.removeOutput(i);
}

function countExtraModelInputs(node) {
  return node.inputs.filter(i => /^model_[2-5]$/.test(i?.name)).length;
}

function addModelPair(node) {
  const count = countExtraModelInputs(node);
  if (count >= MAX_EXTRA_MODELS) return;
  const n = count + 2;
  node.addInput(`model_${n}`, "MODEL");
  node.addOutput(`MODEL ${n}`, "MODEL");
  node.properties.extra_model_count = count + 1;
  updateModelBar(node); snapHeight(node); node.setDirtyCanvas(true, true);
}

function removeModelPair(node) {
  const count = countExtraModelInputs(node);
  if (count <= 0) return;
  let li = -1; for (let i = node.inputs.length - 1; i >= 0; i--) { if (/^model_[2-5]$/.test(node.inputs[i]?.name)) { li = i; break; } }
  if (li !== -1) node.removeInput(li);
  let lo = -1; for (let i = node.outputs.length - 1; i >= 0; i--) { if (/^MODEL [2-5]$/.test(node.outputs[i]?.name)) { lo = i; break; } }
  if (lo !== -1) node.removeOutput(lo);
  node.properties.extra_model_count = count - 1;
  updateModelBar(node); snapHeight(node); node.setDirtyCanvas(true, true);
}

function updateModelBar(node) {
  if (!node.__lflModelBarEl) return;
  const count = countExtraModelInputs(node);
  node.__lflModelBarEl.querySelector(".lfl-mbar-count").textContent = `Model paths: ${count + 1} / ${MAX_EXTRA_MODELS + 1}`;
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
  mkBtn("lfl-mbar-add", "➕", "Add a model path", () => addModelPair(node));
  mkBtn("lfl-mbar-rem", "➖", "Remove last model path", () => removeModelPair(node));
  node.__lflModelBarEl = bar; return bar;
}

// ===========================================================================
// Multi-model node UI
// ===========================================================================

function addMultiUI(node, { autoAddPair = true } = {}) {
  if (node.__lflBuilt) return;
  node.__lflBuilt = true;
  node.properties = node.properties || {};
  if (node.properties.extra_model_count == null) node.properties.extra_model_count = 0;
  stripAutoExtraSlots(node);
  buildCoreUI(node);

  // 🎲 Add Lora Randomizer (same as single-model node)
  const randBtn = node.addWidget("button", "lfl_add_rand", null, async () => {
    const entry = { on: true, name: "", model: 1.0, clip: 1.0, random: true, locked: false, autoRoll: false, folders: null };
    const pick = await pickRandomLora(node, entry);
    if (pick != null) entry.name = pick;
    node.__loraStack.push(entry);
    node.__lflCommit();
  });
  randBtn.label = "🎲 Add Lora Randomizer"; randBtn.serialize = false;
  if (randBtn.options) randBtn.options.serialize = false; randBtn.serializeValue = () => undefined;

  const barDom = buildModelBar(node);
  const barWidget = node.addDOMWidget("lfl_modelbar", "div", barDom, { serialize: false });
  barWidget.serializeValue = () => undefined;
  barWidget.computeSize = function (width) { return [width, 26]; };

  // On fresh creation (count still 0 after stripAutoExtraSlots) optionally add
  // one pair. The Multi-Model node starts with 2 paths (autoAddPair=true); the
  // Plotter starts with a single path (autoAddPair=false). Workflow loads skip
  // this because onConfigure syncs extra_model_count from restored slots.
  if (autoAddPair && node.properties.extra_model_count === 0) addModelPair(node);
  else updateModelBar(node);

  node.__lflLastRandCount = (node.__loraStack || []).filter(e => e.random).length;
  snapHeight(node);
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
    if (!ALL_NODE_NAMES.includes(nodeData?.name)) return;
    const isMulti   = isMultiLike(nodeData.name);
    const isPlotter = nodeData.name === PLOT_NODE_NAME;

    nodeType.color   = NODE_COLOR;
    nodeType.bgcolor = NODE_BGCOLOR;

    const origOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      origOnNodeCreated?.apply(this, arguments);
      this.size = [DEFAULT_WIDTH, 180];
      // Plotter uses the multi-model UI but starts with a single model path.
      try { isMulti ? addMultiUI(this, { autoAddPair: !isPlotter }) : addUI(this); }
      catch (err) { console.warn("[FantasticLoraLoader] UI build failed", err); }
    };

    const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      origOnConnectionsChange?.apply(this, arguments);
      setTimeout(() => this.__lflRender?.(), 0);
    };

    const origOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      origOnConfigure?.apply(this, arguments);
      try {
        if (isMulti) {
          if (!this.__lflBuilt) addMultiUI(this, { autoAddPair: !isPlotter });
          this.properties.extra_model_count = countExtraModelInputs(this);
          updateModelBar(this);
        } else {
          if (!this.__lflBuilt) addUI(this);
        }
        loadStackFromData(this);
        // Serialized node width already reflects any randomizer bump — sync the
        // counter so the next commit doesn't add it again.
        this.__lflLastRandCount = (this.__loraStack || []).filter(e => e.random).length;
        this.__lflRender?.();
        this.__plffUpdateFolderBtn?.();
        snapHeight(this);
      } catch (err) { console.warn("[FantasticLoraLoader] onConfigure failed", err); }
    };
  },
});

// Exported for unit tests
export { folderOf, baseName, collectUnits, buildTree, subtreeUnits, subtreeFileTotal, sortedChildren, getEffectiveEnabledSet, normPath, ROOT_LABEL };
