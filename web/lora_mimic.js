// =============================================================================
// Fantastic Lora Mimic — multi-source picker with per-lora link/unlink
// (web/lora_mimic.js)
// -----------------------------------------------------------------------------
// Pick one or more source nodes (checkbox list); the Mimic mirrors their loras,
// grouped per source. Each lora row has a chain toggle:
//   • linked (🔗)  — strength is pulled live from the source; row is locked.
//   • unlinked (🔗/) — values are frozen; you can change the strength or bypass it.
// If a lora disappears from its source it's shown red + struck through and
// disabled. A connected LORA_STACK wire overrides the whole picker (Python side).
// Everything is read live from the graph, before execution; the reconciled list
// is written to the hidden lora_data widget for Python.
// =============================================================================

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const MIMIC_NODE_NAME = "FantasticLoraMimic";
const SNIFFER_NODE_NAME = "FantasticLoraMimicSubgraphCompanion";
const NODE_COLOR   = "#114f54";
const NODE_BGCOLOR = "#1a4a4e";
const ACCENT       = "#2dd4bf";
const BORDER       = "#2b6e72";
const RED          = "#ff6b6b";
const TEXT_COL     = "#e7fbf6";

const STOCK_LORA_TYPES = ["LoraLoader", "LoraLoaderModelOnly"];

const ICON_LINK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">' +
  '<path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>';
const ICON_LINK_OFF = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">' +
  '<path d="M17 7h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1 0 1.27-.77 2.37-1.87 2.84l1.4 1.4C21.05 15.36 22 13.79 22 12c0-2.76-2.24-5-5-5zm-1 4h-1.19l1.99 2H16zM2 4.27l3.11 3.11C3.29 8.12 2 9.91 2 12c0 2.76 2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1 0-1.59 1.21-2.9 2.76-3.07L8.73 11H8v2h.73L11 15.27V17h1.73l4.01 4.01 1.41-1.41L3.41 2.86 2 4.27z"/></svg>';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function el(tag, css, props) {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (props) for (const [k, v] of Object.entries(props)) {
    if (k.includes("-")) e.setAttribute(k, v); else e[k] = v;
  }
  return e;
}

// --- rgthree Power Lora Loader support --------------------------------------
// Its loras aren't in a lora_data blob or lora_name widgets; instead each lora
// is its own custom widget whose .value is an object:
//   { on: bool, lora: "name.safetensors", strength: <model>, strengthTwo: <clip|null> }
// (strengthTwo is the separate CLIP strength when "Show Strengths" = two; null = same)
const POWER_LORA_TYPES = ["Power Lora Loader (rgthree)"];

function widgetLoraObj(w) {
  const v = w && w.value;
  return (v && typeof v === "object" && !Array.isArray(v) && "lora" in v) ? v : null;
}

// True if this looks like a Power Lora Loader (by type, or by having lora-object widgets).
function isPowerLora(node) {
  if (POWER_LORA_TYPES.includes(node.type) || POWER_LORA_TYPES.includes(node.comfyClass)) return true;
  return (node.widgets || []).some((w) => widgetLoraObj(w));
}

// Enabled, named loras from a Power Lora Loader, as {name, model, clip}.
function powerLoraEntries(node) {
  const out = [];
  for (const w of (node.widgets || [])) {
    const v = widgetLoraObj(w);
    if (!v) continue;
    const name = v.lora;
    if (!name || name === "None" || v.on === false) continue;
    const model = v.strength != null ? +v.strength : 1;
    const clip = (v.strengthTwo != null && v.strengthTwo !== "") ? +v.strengthTwo : model;
    out.push({ name, model, clip });
  }
  return out;
}

function widgetVal(node, name) {
  const w = (node.widgets || []).find((x) => x.name === name);
  return w ? w.value : undefined;
}

function shortName(name) {
  return String(name).split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
}

// --- stock-style loader (incl. pysssss) by widget shape, not just by type -----
function isStockLora(node) {
  if (STOCK_LORA_TYPES.includes(node.type)) return true;
  const names = (node.widgets || []).map((w) => w && w.name);
  return names.includes("lora_name") &&
    (names.includes("strength_model") || names.includes("strength_clip"));
}

// --- numbered-widget stackers (Efficiency "LoRA Stacker", Comfyroll "CR LoRA Stack") ---
// Both lay loras out as lora_name_1, lora_name_2, ... with per-index strength widgets
// under various names. One adapter covers both by probing the known aliases.
function isNumberedStacker(node) {
  return (node.widgets || []).some((w) => w && /^lora_name_\d+$/.test(String(w.name || "")));
}

function numberedStackEntries(node) {
  const wmap = {};
  for (const w of (node.widgets || [])) if (w && w.name != null) wmap[w.name] = w.value;
  const idxs = [];
  for (const k of Object.keys(wmap)) {
    const m = /^lora_name_(\d+)$/.exec(k);
    if (m) idxs.push(parseInt(m[1], 10));
  }
  if (!idxs.length) return null;
  idxs.sort((a, b) => a - b);

  // Efficiency: lora_count caps how many rows are active
  const loraCount = (typeof wmap["lora_count"] === "number") ? wmap["lora_count"] : null;
  const pick = (keys) => { for (const k of keys) if (wmap[k] !== undefined) return wmap[k]; return undefined; };
  const num = (v, dflt) => {
    if (v == null || v === "") return dflt;
    const n = +v; return Number.isNaN(n) ? dflt : n;
  };

  const out = [];
  for (const i of idxs) {
    if (loraCount != null && i > loraCount) continue;
    const name = wmap[`lora_name_${i}`];
    if (!name || name === "None") continue;
    // per-row on/off (Comfyroll: switch_i = "On"/"Off"; others: enable_i / on_i booleans)
    const sw = pick([`switch_${i}`, `enable_${i}`, `on_${i}`]);
    if (sw !== undefined) {
      const off = sw === false || (typeof sw === "string" && /^(off|disabled?|false|no)$/i.test(sw.trim()));
      if (off) continue;
    }
    const model = num(pick([`model_str_${i}`, `model_weight_${i}`, `strength_model_${i}`,
                            `lora_wt_${i}`, `strength_${i}`, `weight_${i}`]), 1);
    const clip = num(pick([`clip_str_${i}`, `clip_weight_${i}`, `strength_clip_${i}`]), model);
    out.push({ name, model, clip });
  }
  return out;
}

// All loras a source currently exposes, as {name, model, clip} (enabled only).
function readSourceLoras(node) {
  if (!node) return null;
  const ld = widgetVal(node, "lora_data");
  if (typeof ld === "string" && ld.trim()) {
    try {
      const p = JSON.parse(ld);
      const arr = Array.isArray(p) ? p : p.loras;
      if (Array.isArray(arr)) {
        return arr
          .filter((e) => e && e.on !== false && e.name && e.name !== "None" && e.name !== "NONE")
          .map((e) => ({
            name: e.name,
            model: e.strength != null ? +e.strength : (e.model != null ? +e.model : 1),
            clip: e.strength != null ? +e.strength : (e.clip != null ? +e.clip : 1),
          }));
      }
    } catch (_) { /* fall through */ }
  }
  if (isStockLora(node)) {
    const name = widgetVal(node, "lora_name");
    if (name && name !== "None") {
      const sm = +(widgetVal(node, "strength_model") ?? 1);
      const sc = +(widgetVal(node, "strength_clip") ?? sm);
      return [{ name, model: sm, clip: sc }];
    }
    return [];
  }
  if (isPowerLora(node)) return powerLoraEntries(node);
  if (isNumberedStacker(node)) return numberedStackEntries(node);
  return null;
}

function isCompatibleSource(node, selfId) {
  if (!node || node.id === selfId || node.type === MIMIC_NODE_NAME || node.type === SNIFFER_NODE_NAME) return false;
  if (isStockLora(node)) return true;
  if (isPowerLora(node)) return true;
  if (isNumberedStacker(node)) return true;
  return (node.widgets || []).some((w) => w.name === "lora_data");
}

function sourceLabel(node) {
  return `#${node.id} ${node.title || node.type || "node"}`;
}

function compatibleSources(graph, selfId) {
  return (graph?._nodes || []).filter((n) => isCompatibleSource(n, selfId));
}

function stackConnected(node) {
  const inp = (node.inputs || []).find((i) => i?.name === "lora_stack");
  return !!(inp && inp.link != null);
}

// ---------------------------------------------------------------------------
// High/Low companion matching
// ---------------------------------------------------------------------------

let _loraFilesCache = null;
async function getAllLoraFiles(force) {
  if (_loraFilesCache && !force) return _loraFilesCache;
  try {
    const res = await api.fetchApi("/lora_folder_loader/loras");
    const json = await res.json();
    _loraFilesCache = (json || [])
      .map((e) => (typeof e === "string" ? e : e?.name))
      .filter(Boolean)
      .map((s) => String(s).replace(/\\/g, "/"));
  } catch (err) {
    console.warn("[FantasticLoraMimic] failed to fetch lora list", err);
    _loraFilesCache = _loraFilesCache || [];
  }
  return _loraFilesCache;
}

function baseTokens(name) {
  let s = String(name).replace(/\\/g, "/");
  s = s.slice(s.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "").toLowerCase();
  return s.split(/[^a-z0-9]+/).filter(Boolean);
}

// "high" | "low" | null — which noise half a lora name refers to (Wan 2.2 etc.)
function noiseSide(name) {
  const set = new Set(baseTokens(name));
  const high = set.has("high") || set.has("hi") || set.has("highnoise") || set.has("hn");
  const low = set.has("low") || set.has("lo") || set.has("lownoise") || set.has("ln");
  if (high && !low) return "high";
  if (low && !high) return "low";
  const h = set.has("h"), l = set.has("l");
  if (h && !l) return "high";
  if (l && !h) return "low";
  return null;
}

const _NOISE_TOK = new Set(["high", "low", "highnoise", "lownoise", "noise", "hi", "lo", "hn", "ln", "h", "l"]);
const _VOLATILE = /^(e|ep|epoch|epochs|step|steps|s|v|ver|version|it|iter|iters)?\d+$/;

// stable "stem" tokens — drops the noise side and volatile epoch/step/version numbers
function stemTokens(name) {
  const out = [];
  for (const t of baseTokens(name)) {
    if (_NOISE_TOK.has(t)) continue;
    if (_VOLATILE.test(t)) continue;
    out.push(t);
  }
  return out;
}

// Rank candidate companions for an original lora name. Returns sorted
// [{name, score, side}], with the original itself omitted and zero-overlap dropped.
function rankCompanions(originalName, allFiles) {
  const origSet = new Set(stemTokens(originalName));
  const origSide = noiseSide(originalName);
  const opp = origSide === "high" ? "low" : (origSide === "low" ? "high" : null);
  const origNorm = String(originalName).replace(/\\/g, "/");

  const scored = [];
  for (const f of allFiles) {
    const fn = String(f).replace(/\\/g, "/");
    if (fn === origNorm) continue;
    const sset = new Set(stemTokens(fn));
    if (!sset.size) continue;
    let inter = 0;
    for (const t of origSet) if (sset.has(t)) inter++;
    if (inter <= 0) continue;
    const uni = new Set([...origSet, ...sset]).size || 1;
    let score = inter / uni;
    const side = noiseSide(fn);
    if (opp) {
      if (side === opp) score += 0.6;       // exactly the opposite noise half
      else if (side === origSide) score -= 0.4;  // same half = not a companion
    }
    scored.push({ name: fn, score, side });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored;
}

// ---------------------------------------------------------------------------
// state model
//   node.__mimicSources : [sourceId, ...]   (selection order)
//   node.__mimicEntries : [{source,name,model,clip,linked,on,removed}, ...]
// ---------------------------------------------------------------------------

function ensureState(node) {
  if (!Array.isArray(node.__mimicSources)) node.__mimicSources = [];
  if (!Array.isArray(node.__mimicEntries)) node.__mimicEntries = [];
  if (!node.__mimicGroupForced || typeof node.__mimicGroupForced !== "object") node.__mimicGroupForced = {};
  if (typeof node.__mimicHighLow !== "boolean") node.__mimicHighLow = false;
}

// A source is "bypassed" if it's set to Bypass (mode 4) or Never/Mute (mode 2)
// in ComfyUI — its own loras wouldn't apply in its pipeline.
function isSourceBypassed(node, sid) {
  const src = node.graph?.getNodeById?.(sid);
  return !!src && (src.mode === 2 || src.mode === 4);
}
function groupForced(node, sid) {
  return !!(node.__mimicGroupForced && node.__mimicGroupForced[sid]);
}
function toggleGroupForced(node, sid) {
  ensureState(node);
  node.__mimicGroupForced[sid] = !node.__mimicGroupForced[sid];
  writeLoraData(node); renderMimic(node);
}

// Reconcile entries against the live graph. Returns true if anything changed.
function reconcile(node) {
  ensureState(node);
  const before = JSON.stringify(node.__mimicEntries);

  // Drop entries whose source is no longer selected.
  node.__mimicEntries = node.__mimicEntries.filter((e) => node.__mimicSources.includes(e.source));

  for (const sid of node.__mimicSources) {
    const src = node.graph?.getNodeById?.(sid);
    const loras = src ? (readSourceLoras(src) || []) : [];
    const byName = new Map(loras.map((l) => [l.name, l]));

    // update / add
    for (const l of loras) {
      let e = node.__mimicEntries.find((x) => x.source === sid && x.name === l.name);
      if (e) {
        e.removed = false;
        e.forced = false;                        // no longer "forced despite removal"
        if (e.linked) { e.model = l.model; e.clip = l.clip; }
      } else {
        node.__mimicEntries.push({
          source: sid, name: l.name, model: l.model, clip: l.clip,
          linked: true, on: true, removed: false,
        });
      }
    }
    // mark removed for entries this source no longer has
    for (const e of node.__mimicEntries) {
      if (e.source === sid && !byName.has(e.name)) { e.removed = true; }
    }
  }

  return JSON.stringify(node.__mimicEntries) !== before;
}

function effectiveOn(e) {
  if (e.removed) return !!e.forced;          // removed loras only apply if force-enabled
  return e.linked ? true : !!e.on;
}

function writeLoraData(node) {
  ensureState(node);
  const w = (node.widgets || []).find((x) => x.name === "lora_data");
  if (!w) return;
  const loras = node.__mimicEntries.map((e) => {
    const groupOff = isSourceBypassed(node, e.source) && !groupForced(node, e.source);
    return {
      on: groupOff ? false : effectiveOn(e), name: e.name, model: e.model, clip: e.clip,
      source: e.source, linked: e.linked, removed: e.removed, forced: !!e.forced,
      companion: e.companion || null, keepOriginal: !!e.keepOriginal, useOriginal: !!e.useOriginal,
    };
  });
  w.value = JSON.stringify({
    loras, mimicSources: node.__mimicSources, groupForced: node.__mimicGroupForced,
    highLow: !!node.__mimicHighLow,
  });
}

// rebuild state from a saved payload (onConfigure)
function restoreState(node) {
  const w = (node.widgets || []).find((x) => x.name === "lora_data");
  if (!w || !w.value) return;
  try {
    const p = JSON.parse(w.value);
    node.__mimicSources = Array.isArray(p.mimicSources) ? p.mimicSources.slice() : [];
    node.__mimicGroupForced = (p.groupForced && typeof p.groupForced === "object") ? { ...p.groupForced } : {};
    node.__mimicHighLow = !!p.highLow;
    node.__mimicEntries = (Array.isArray(p.loras) ? p.loras : []).map((e) => ({
      source: e.source, name: e.name, model: +e.model, clip: +e.clip,
      linked: e.linked !== false, removed: !!e.removed, forced: !!e.forced,
      on: e.linked ? true : (e.on !== false),
      companion: (e.companion && e.companion.name) ? {
        name: e.companion.name, model: +e.companion.model, clip: +e.companion.clip,
      } : null,
      keepOriginal: !!e.keepOriginal,
      useOriginal: !!e.useOriginal,
    })).filter((e) => e.source != null && e.name);
  } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// source-selection popup (checkbox list)
// ---------------------------------------------------------------------------

let _openPanel = null;
function closeSourcePanel() {
  if (_openPanel) {
    _openPanel.remove(); _openPanel = null;
    window.removeEventListener("pointerdown", _onDocDown, true);
    window.removeEventListener("wheel", _onWheel, true);
  }
}
function _onDocDown(e) { if (_openPanel && !_openPanel.contains(e.target)) closeSourcePanel(); }
function _onWheel() { closeSourcePanel(); }

function openSourcePanel(node, anchor) {
  closeSourcePanel();
  const panel = el("div",
    "position:fixed;z-index:10000;background:#0e2b2e;border:1px solid " + BORDER + ";border-radius:6px;" +
    "padding:6px;max-height:320px;overflow:auto;min-width:220px;box-shadow:0 6px 24px rgba(0,0,0,.5);" +
    "font-family:system-ui,sans-serif;font-size:12px;color:" + TEXT_COL + ";");
  panel.appendChild(el("div", "opacity:.6;padding:2px 4px 6px;", { textContent: "Pull loras from:" }));

  const list = compatibleSources(node.graph, node.id);
  if (!list.length) {
    panel.appendChild(el("div", "opacity:.6;padding:6px;", { textContent: "No compatible nodes found." }));
  }
  for (const src of list) {
    const row = el("label", "display:flex;align-items:center;gap:6px;padding:3px 4px;cursor:pointer;border-radius:4px;");
    row.onmouseenter = () => (row.style.background = "#14403f");
    row.onmouseleave = () => (row.style.background = "transparent");
    const cb = el("input", "cursor:pointer;flex:none;", { type: "checkbox", checked: node.__mimicSources.includes(src.id) });
    cb.onchange = () => toggleSource(node, src.id, cb.checked);
    row.appendChild(cb);
    row.appendChild(el("span", "", { textContent: sourceLabel(src) }));
    panel.appendChild(row);
  }

  const r = anchor.getBoundingClientRect();
  panel.style.left = r.left + "px";
  panel.style.top = (r.bottom + 4) + "px";
  document.body.appendChild(panel);
  _openPanel = panel;
  setTimeout(() => {
    window.addEventListener("pointerdown", _onDocDown, true);
    window.addEventListener("wheel", _onWheel, true);
  }, 0);
}

function toggleSource(node, id, on) {
  ensureState(node);
  if (on) { if (!node.__mimicSources.includes(id)) node.__mimicSources.push(id); }
  else {
    node.__mimicSources = node.__mimicSources.filter((x) => x !== id);
    node.__mimicEntries = node.__mimicEntries.filter((e) => e.source !== id);
    if (node.__mimicGroupForced) delete node.__mimicGroupForced[id];
  }
  reconcile(node); writeLoraData(node); renderMimic(node);
}

// ---------------------------------------------------------------------------
// companion picker popup (ranked, filterable)
// ---------------------------------------------------------------------------

async function openCompanionPanel(node, anchor, entry) {
  closeSourcePanel();
  const files = await getAllLoraFiles();
  const ranked = rankCompanions(entry.name, files);

  const panel = el("div",
    "position:fixed;z-index:10000;background:#0e2b2e;border:1px solid " + BORDER + ";border-radius:6px;" +
    "padding:6px;max-height:340px;overflow:auto;min-width:300px;max-width:440px;box-shadow:0 6px 24px rgba(0,0,0,.5);" +
    "font-family:system-ui,sans-serif;font-size:12px;color:" + TEXT_COL + ";");
  panel.appendChild(el("div", "opacity:.6;padding:2px 4px 4px;font-weight:600;",
    { textContent: "Companion for " + shortName(entry.name) + " — closest names first" }));

  const filter = el("input",
    "width:100%;box-sizing:border-box;background:#06181a;color:" + TEXT_COL + ";border:1px solid " + BORDER +
    ";border-radius:4px;padding:4px 6px;font-size:12px;margin-bottom:5px;", { type: "text", placeholder: "filter…" });
  panel.appendChild(filter);

  const listWrap = el("div", "");
  panel.appendChild(listWrap);

  const renderList = (q) => {
    listWrap.innerHTML = "";
    const ql = (q || "").trim().toLowerCase();
    let shown = ranked;
    if (ql) shown = files.map((f) => String(f).replace(/\\/g, "/"))
      .filter((f) => f !== entry.name && f.toLowerCase().includes(ql))
      .map((f) => ({ name: f, score: 0, side: noiseSide(f) }));
    shown = shown.slice(0, 40);
    if (!shown.length) {
      listWrap.appendChild(el("div", "opacity:.6;padding:6px;", { textContent: "No matches." }));
      return;
    }
    for (const cand of shown) {
      const row = el("div",
        "display:flex;align-items:center;gap:8px;padding:4px 5px;cursor:pointer;border-radius:4px;");
      row.onmouseenter = () => (row.style.background = "#14403f");
      row.onmouseleave = () => (row.style.background = "transparent");
      const sideTag = cand.side
        ? `<span style="flex:none;font-size:9.5px;font-weight:700;padding:0 5px;border-radius:7px;` +
          `color:${cand.side === "low" ? "#7fd6ff" : "#ffb454"};border:1px solid ${cand.side === "low" ? "#7fd6ff" : "#ffb454"}">` +
          cand.side + "</span>"
        : "";
      row.innerHTML = `<span style="flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${cand.name}">${shortName(cand.name)}</span>` + sideTag;
      row.onclick = (ev) => {
        ev.stopPropagation();
        entry.companion = { name: cand.name, model: entry.model, clip: entry.clip };
        closeSourcePanel();
        writeLoraData(node); renderMimic(node);
      };
      listWrap.appendChild(row);
    }
  };
  renderList("");
  filter.oninput = () => renderList(filter.value);

  const r = anchor.getBoundingClientRect();
  panel.style.left = Math.min(r.left, window.innerWidth - 460) + "px";
  panel.style.top = (r.bottom + 4) + "px";
  document.body.appendChild(panel);
  _openPanel = panel;
  setTimeout(() => {
    window.addEventListener("pointerdown", _onDocDown, true);
    window.addEventListener("wheel", _onWheel, true);
    filter.focus();
  }, 0);
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function renderMimic(node) {
  const root = node.__mimicRoot;
  if (!root) return;
  ensureState(node);
  root.innerHTML = "";

  // High/Low Model Mode — styled switch
  const hl = !!node.__mimicHighLow;
  const hlBar = el("div",
    "display:flex;align-items:center;gap:9px;margin-bottom:8px;padding:6px 9px;border-radius:7px;" +
    "background:" + (hl ? "#10333a" : "#0c2528") + ";border:1px solid " + (hl ? ACCENT : BORDER) + ";");
  const sw = el("div",
    "flex:none;width:40px;height:22px;border-radius:11px;cursor:pointer;position:relative;transition:background .15s;" +
    "background:" + (hl ? ACCENT : "#2b4a4d") + ";",
    { title: "Treat sources as one noise half (e.g. Wan 2.2 high) and apply the matching companion lora on this model (the other half). Off = mirror loras as-is." });
  sw.appendChild(el("div",
    "position:absolute;top:2px;left:" + (hl ? "20px" : "2px") + ";width:18px;height:18px;border-radius:50%;" +
    "background:#06181a;transition:left .15s;"));
  sw.onclick = (e) => {
    e.stopPropagation();
    node.__mimicHighLow = !node.__mimicHighLow;
    writeLoraData(node); renderMimic(node);
  };
  hlBar.appendChild(sw);
  const hlText = el("div", "flex:1 1 auto;line-height:1.25;");
  hlText.appendChild(el("div", "font-weight:700;font-size:12.5px;color:" + (hl ? ACCENT : TEXT_COL) + ";",
    { textContent: "High / Low Model Mode" }));
  hlText.appendChild(el("div", "font-size:10.5px;opacity:.65;",
    { textContent: hl ? "Applying companion loras (other noise half)" : "Mirroring loras as-is" }));
  hlBar.appendChild(hlText);
  root.appendChild(hlBar);

  // header: add/manage + clean unused
  const head = el("div", "display:flex;align-items:center;gap:6px;margin-bottom:7px;flex-wrap:wrap;");
  const mkHeadBtn = (label, title, onClick) => {
    const b = el("button",
      "background:#14403f;color:" + TEXT_COL + ";border:1px solid " + BORDER + ";border-radius:5px;" +
      "padding:4px 10px;cursor:pointer;font-size:12.5px;font-weight:600;white-space:nowrap;",
      { textContent: label, title: title || "" });
    b.onmouseenter = () => (b.style.background = "#1c5450");
    b.onmouseleave = () => (b.style.background = "#14403f");
    b.onclick = onClick;
    return b;
  };
  const addBtn = mkHeadBtn("\uFF0B Add / manage sources", "Choose which nodes to mimic loras from",
    (e) => { e.stopPropagation(); openSourcePanel(node, addBtn); });
  head.appendChild(addBtn);
  const cleanBtn = mkHeadBtn("\uD83E\uDDF9 Clean unused Loras",
    "Remove loras that were deleted from their source (red) — except ones you've force-enabled",
    (e) => { e.stopPropagation(); cleanUnused(node); });
  head.appendChild(cleanBtn);
  root.appendChild(head);

  if (stackConnected(node)) {
    root.appendChild(el("div",
      "padding:8px;background:#0a2326;border:1px solid " + BORDER + ";border-radius:5px;font-size:12.5px;",
      { innerHTML: `<span style="color:${ACCENT};font-weight:600">LORA_STACK wired</span> — picker overridden by the connected stack.` }));
    fitNode(node);
    return;
  }

  if (!node.__mimicSources.length) {
    root.appendChild(el("div", "opacity:.65;padding:8px;font-size:12.5px;",
      { textContent: "No sources yet — click ＋ Add / manage sources to pick nodes to mimic." }));
    fitNode(node);
    return;
  }

  for (const sid of node.__mimicSources) {
    const src = node.graph?.getNodeById?.(sid);
    const entries = node.__mimicEntries.filter((e) => e.source === sid);
    const bypassed = isSourceBypassed(node, sid);
    const gForced = groupForced(node, sid);
    const groupInactive = bypassed && !gForced;
    const AMBER = "#ffb454";

    const group = el("div",
      "margin-bottom:8px;border:1px solid " + (bypassed ? (gForced ? AMBER : "#6b5a2a") : BORDER) +
      ";border-radius:6px;overflow:hidden;background:#0a2326;");
    const gh = el("div",
      "display:flex;align-items:center;gap:6px;padding:5px 8px;background:#123b3e;font-weight:700;font-size:13px;flex-wrap:wrap;");
    gh.appendChild(el("span",
      "color:" + (groupInactive ? "#7f9b98" : ACCENT) + ";overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;" +
      (groupInactive ? "text-decoration:line-through;" : ""),
      { textContent: src ? sourceLabel(src) : `#${sid} (missing)` }));

    if (bypassed) {
      // badge
      gh.appendChild(el("span",
        "flex:none;font-size:10.5px;font-weight:700;padding:1px 6px;border-radius:8px;" +
        (gForced
          ? "color:#1a1206;background:" + AMBER + ";"
          : "color:" + AMBER + ";border:1px solid " + AMBER + ";"),
        { textContent: gForced ? "⚡ forced" : "⊘ source bypassed" }));
      // group-level force toggle
      const gfLabel = el("label", "display:flex;align-items:center;gap:4px;cursor:pointer;flex:none;font-weight:600;");
      const gfcb = el("input", "cursor:pointer;", { type: "checkbox", checked: gForced });
      gfcb.onchange = (ev) => { ev.stopPropagation(); toggleGroupForced(node, sid); };
      gfLabel.appendChild(gfcb);
      gfLabel.appendChild(el("span", "font-size:10.5px;", { textContent: "force enabled" }));
      gh.appendChild(gfLabel);
    }

    const x = el("span",
      "cursor:pointer;opacity:.6;font-size:14px;flex:none;padding:0 3px;", { textContent: "\u2715", title: "Unlink this source" });
    x.onmouseenter = () => (x.style.opacity = "1");
    x.onmouseleave = () => (x.style.opacity = ".6");
    x.onclick = (e) => { e.stopPropagation(); toggleSource(node, sid, false); };
    gh.appendChild(x);
    group.appendChild(gh);

    if (!entries.length) {
      group.appendChild(el("div", "opacity:.55;padding:6px 10px;font-size:12px;",
        { textContent: src ? "No enabled loras on this source." : "Source node not found." }));
    }
    for (const e of entries) group.appendChild(loraRow(node, e, groupInactive));
    root.appendChild(group);
  }

  fitNode(node);
}

function cleanUnused(node) {
  ensureState(node);
  node.__mimicEntries = node.__mimicEntries.filter((e) => !(e.removed && !e.forced));
  writeLoraData(node); renderMimic(node);
}

function removeEntry(node, entry) {
  node.__mimicEntries = node.__mimicEntries.filter((e) => e !== entry);
  writeLoraData(node); renderMimic(node);
}

function loraRow(node, e, groupInactive) {
  const AMBER = "#ffb454";
  const forced = e.removed && e.forced;
  const row = el("div",
    "display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-top:1px solid #103033;" +
    (groupInactive ? "opacity:.4;" : ""));

  // chain / status icon
  const iconColor = e.removed ? (forced ? AMBER : RED) : (e.linked ? ACCENT : "#9fb6b3");
  const chain = el("span",
    "cursor:" + (e.removed ? "default" : "pointer") + ";flex:none;display:flex;align-items:center;" +
    "margin-top:1px;color:" + iconColor + ";",
    { innerHTML: e.linked && !e.removed ? ICON_LINK : ICON_LINK_OFF,
      title: e.removed
        ? (forced ? "Forced on despite being removed from source" : "Removed from source")
        : (e.linked ? "Linked — click to unlink and edit" : "Unlinked — click to re-link to source") });
  if (!e.removed) {
    chain.onclick = (ev) => {
      ev.stopPropagation();
      e.linked = !e.linked;
      if (!e.linked && e.on == null) e.on = true;
      reconcile(node); writeLoraData(node); renderMimic(node);
    };
  }
  row.appendChild(chain);

  const content = el("div", "flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px;");

  // name line
  const locked = e.linked && !e.removed;
  let nameStyle = "font-weight:600;";
  if (e.removed && !forced) nameStyle += "color:" + RED + ";text-decoration:line-through;";
  else if (forced) nameStyle += "color:" + AMBER + ";";
  else if (locked) nameStyle += "opacity:.6;";
  const nameLine = el("div",
    "font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" + nameStyle,
    { textContent: shortName(e.name), title: e.name });
  content.appendChild(nameLine);

  const num = (v) => (Math.round(v * 100) / 100).toString();
  const LOW = "#7fd6ff";

  const editableStrength = (getset, color) => {
    const inp = el("input",
      "width:64px;background:#06181a;color:" + (color || TEXT_COL) + ";border:1px solid " +
      (color || BORDER) + ";border-radius:4px;padding:2px 4px;font-size:12px;font-weight:600;",
      { type: "number", step: "0.05", value: num(getset.get()) });
    inp.onfocus = () => { node.__mimicEditing = true; };
    inp.onblur = () => { node.__mimicEditing = false; };
    inp.onchange = () => {
      const v = parseFloat(inp.value);
      if (!Number.isNaN(v)) { getset.set(v); writeLoraData(node); }
    };
    return inp;
  };
  const origStrength = (color) => editableStrength({ get: () => e.model, set: (v) => { e.model = v; e.clip = v; } }, color);

  // ---- removed entries: red + force-enable + remove (no companion) ----
  if (e.removed) {
    const sline = el("div", "display:flex;align-items:center;gap:6px;font-size:12px;");
    sline.appendChild(el("span", "opacity:.7;flex:none;font-weight:600;", { textContent: "strength" }));
    if (forced) {
      sline.appendChild(origStrength(AMBER));
      sline.appendChild(el("span", "color:" + AMBER + ";font-style:italic;font-weight:600;font-size:11px;",
        { textContent: "⚡ forced" }));
    } else {
      sline.appendChild(el("span", "color:" + RED + ";opacity:.85;font-weight:600;", { textContent: num(e.model) }));
      sline.appendChild(el("span", "color:" + RED + ";opacity:.85;font-style:italic;font-size:11px;",
        { textContent: "removed from source" }));
    }
    const ctrls = el("div", "display:flex;align-items:center;gap:8px;margin-left:auto;flex:none;");
    const fLabel = el("label", "display:flex;align-items:center;gap:4px;cursor:pointer;");
    const fcb = el("input", "cursor:pointer;", { type: "checkbox", checked: !!e.forced });
    fcb.onchange = () => { e.forced = fcb.checked; writeLoraData(node); renderMimic(node); };
    fLabel.appendChild(fcb);
    fLabel.appendChild(el("span", "font-size:11px;font-weight:600;", { textContent: "force enabled" }));
    fLabel.title = "Apply this lora to the model even though it was removed from its source node.";
    ctrls.appendChild(fLabel);
    const rx = el("span",
      "cursor:pointer;opacity:.6;font-size:14px;color:" + RED + ";", { textContent: "\u2715", title: "Remove from list" });
    rx.onmouseenter = () => (rx.style.opacity = "1");
    rx.onmouseleave = () => (rx.style.opacity = ".6");
    rx.onclick = (ev) => { ev.stopPropagation(); removeEntry(node, e); };
    ctrls.appendChild(rx);
    sline.appendChild(ctrls);
    content.appendChild(sline);
    row.appendChild(content);
    return row;
  }

  // ---- High/Low mode: show original dimmed, pick a companion for this model ----
  if (node.__mimicHighLow) {
    const useOrig = !!e.useOriginal;
    const GREEN = "#86e08f";
    const setName = (tag, color, dim) => {
      nameLine.style.cssText = "font-size:" + (dim ? "11.5px" : "13px") + ";opacity:" + (dim ? ".5" : "1") +
        ";display:flex;gap:5px;align-items:center;overflow:hidden;font-weight:600;";
      nameLine.textContent = "";
      nameLine.appendChild(el("span", "flex:none;font-style:italic;color:" + color + ";", { textContent: tag }));
      nameLine.appendChild(el("span", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
        { textContent: shortName(e.name), title: e.name }));
    };

    const comp = el("div", "display:flex;flex-direction:column;gap:4px;");

    // control buttons: find companion + use source lora
    const btnRow = el("div", "display:flex;gap:6px;flex-wrap:wrap;align-items:center;");
    const showFind = !(e.companion && !useOrig);   // a chosen companion has its own ↻ change control
    if (showFind) {
      const findBtn = el("button",
        "border-radius:5px;padding:3px 9px;font-size:11.5px;font-weight:600;" +
        (useOrig
          ? "background:#10282b;color:#5b7a7d;border:1px solid #294a4d;cursor:default;"
          : "background:#13363b;color:" + LOW + ";border:1px solid " + LOW + ";cursor:pointer;"),
        { textContent: "\uD83D\uDD0E find companion" });
      if (useOrig) {
        findBtn.title = "Disabled — using the source lora as-is. Toggle off ‘use source lora’ to search for a companion.";
      } else {
        findBtn.title = "Search for the closest-matching lora on the other noise half (e.g. the _low for a _high) and apply it here.";
        findBtn.onclick = (ev) => { ev.stopPropagation(); openCompanionPanel(node, findBtn, e); };
      }
      btnRow.appendChild(findBtn);
    }
    const useBtn = el("button",
      "border-radius:5px;padding:3px 9px;font-size:11.5px;font-weight:600;cursor:pointer;" +
      (useOrig
        ? "background:" + GREEN + ";color:#06181a;border:1px solid " + GREEN + ";"
        : "background:#13302a;color:" + GREEN + ";border:1px solid " + GREEN + ";"),
      { textContent: useOrig ? "\u2713 using source lora" : "use source lora" });
    useBtn.title = "Apply the source (original) lora on this model as-is, without a companion. While on, the companion search is disabled.";
    useBtn.onclick = (ev) => { ev.stopPropagation(); e.useOriginal = !e.useOriginal; writeLoraData(node); renderMimic(node); };
    btnRow.appendChild(useBtn);
    comp.appendChild(btnRow);

    if (useOrig) {
      setName("source", GREEN, false);
      const sl = el("div", "display:flex;align-items:center;gap:6px;font-size:12px;");
      sl.appendChild(el("span", "opacity:.7;flex:none;font-weight:600;", { textContent: "strength" }));
      if (e.linked) {
        sl.appendChild(el("span", "opacity:.6;font-weight:600;", { textContent: num(e.model) }));
        sl.appendChild(el("span", "opacity:.35;margin-left:auto;font-style:italic;font-size:11px;", { textContent: "linked" }));
      } else {
        sl.appendChild(origStrength());
        const bypass = el("label", "display:flex;align-items:center;gap:4px;margin-left:auto;cursor:pointer;opacity:.9;");
        const cb = el("input", "cursor:pointer;", { type: "checkbox", checked: e.on !== false });
        cb.onchange = () => { e.on = cb.checked; writeLoraData(node); };
        bypass.appendChild(cb);
        bypass.appendChild(el("span", "font-size:11px;font-weight:600;", { textContent: "enabled" }));
        sl.appendChild(bypass);
      }
      comp.appendChild(sl);
      if (e.companion) comp.appendChild(el("div", "opacity:.5;font-size:10.5px;font-style:italic;",
        { textContent: "companion saved (" + shortName(e.companion.name) + ") — toggle off to use it" }));
    } else if (e.companion) {
      setName("original", "inherit", true);
      const cline = el("div", "display:flex;align-items:center;gap:6px;font-size:12.5px;");
      cline.appendChild(el("span", "flex:none;color:" + LOW + ";font-weight:700;", { textContent: "\u21B3" }));
      cline.appendChild(el("span", "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;color:" + LOW + ";",
        { textContent: shortName(e.companion.name), title: e.companion.name + "  (companion applied on this model)" }));
      const chg = el("span", "cursor:pointer;opacity:.65;flex:none;font-size:13px;", { textContent: "\u21BB", title: "Pick a different companion" });
      chg.onmouseenter = () => (chg.style.opacity = "1"); chg.onmouseleave = () => (chg.style.opacity = ".65");
      chg.onclick = (ev) => { ev.stopPropagation(); openCompanionPanel(node, chg, e); };
      cline.appendChild(chg);
      const clr = el("span", "cursor:pointer;opacity:.6;flex:none;font-size:13px;color:" + RED + ";", { textContent: "\u2715", title: "Clear companion" });
      clr.onmouseenter = () => (clr.style.opacity = "1"); clr.onmouseleave = () => (clr.style.opacity = ".6");
      clr.onclick = (ev) => { ev.stopPropagation(); e.companion = null; writeLoraData(node); renderMimic(node); };
      cline.appendChild(clr);
      comp.appendChild(cline);

      const sl = el("div", "display:flex;align-items:center;gap:6px;font-size:12px;");
      sl.appendChild(el("span", "opacity:.7;flex:none;font-weight:600;", { textContent: "strength" }));
      sl.appendChild(editableStrength({
        get: () => e.companion.model,
        set: (v) => { e.companion.model = v; e.companion.clip = v; },
      }, LOW));
      const koLabel = el("label", "display:flex;align-items:center;gap:4px;margin-left:auto;cursor:pointer;");
      koLabel.title = "Also apply the original lora on this model (e.g. a speed-up lora that's identical on both halves).";
      const kocb = el("input", "cursor:pointer;", { type: "checkbox", checked: !!e.keepOriginal });
      kocb.onchange = () => { e.keepOriginal = kocb.checked; writeLoraData(node); renderMimic(node); };
      koLabel.appendChild(kocb);
      koLabel.appendChild(el("span", "font-size:10.5px;font-weight:600;", { textContent: "also apply original" }));
      sl.appendChild(koLabel);
      comp.appendChild(sl);

      if (e.keepOriginal) {
        const ol = el("div", "display:flex;align-items:center;gap:6px;font-size:11.5px;opacity:.85;");
        ol.appendChild(el("span", "opacity:.7;flex:none;", { textContent: "original strength" }));
        if (e.linked) ol.appendChild(el("span", "opacity:.7;font-weight:600;", { textContent: num(e.model) + " (linked)" }));
        else ol.appendChild(origStrength());
        comp.appendChild(ol);
      }
    } else {
      setName("original", "inherit", true);
      comp.appendChild(el("div", "opacity:.55;font-size:11px;font-style:italic;padding-top:1px;",
        { textContent: "no companion yet — find one, or use the source lora" }));
    }
    content.appendChild(comp);
    row.appendChild(content);
    return row;
  }

  // ---- normal mode ----
  const sline = el("div", "display:flex;align-items:center;gap:6px;font-size:12px;");
  sline.appendChild(el("span", "opacity:.7;flex:none;font-weight:600;", { textContent: "strength" }));
  const locked2 = e.linked;
  if (locked2) {
    sline.appendChild(el("span", "opacity:.6;font-weight:600;", { textContent: num(e.model) }));
    sline.appendChild(el("span", "opacity:.35;margin-left:auto;font-style:italic;font-size:11px;",
      { textContent: "linked" }));
  } else {
    sline.appendChild(origStrength());
    const bypass = el("label", "display:flex;align-items:center;gap:4px;margin-left:auto;cursor:pointer;opacity:.9;");
    bypass.title = "Apply this lora. Uncheck to bypass it without removing it.";
    const cb = el("input", "cursor:pointer;", { type: "checkbox", checked: e.on !== false });
    cb.onchange = () => { e.on = cb.checked; writeLoraData(node); nameLine.style.opacity = cb.checked ? "1" : ".4"; };
    bypass.appendChild(cb);
    bypass.appendChild(el("span", "font-size:11px;font-weight:600;", { textContent: "enabled" }));
    sline.appendChild(bypass);
    if (e.on === false) nameLine.style.opacity = ".4";
  }
  content.appendChild(sline);
  row.appendChild(content);
  return row;
}

// Make the node grow to fit the DOM content instead of clipping it.
function fitNode(node) {
  try {
    if (!node.__mimicWidget || !node.__mimicRoot) return;
    requestAnimationFrame(() => {
      try {
        const want = node.computeSize();
        if (want && want[1] && Math.abs(want[1] - node.size[1]) > 2) {
          node.setSize([node.size[0], want[1]]);
          node.setDirtyCanvas(true, true);
        }
      } catch (_) {}
    });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// live mirror + UI build
// ---------------------------------------------------------------------------

function tick(node) {
  if (node.__mimicLive === false) return;
  if (node.__mimicEditing) return;                 // don't yank focus while editing
  if (stackConnected(node)) return;
  let changed = reconcile(node);
  // also react to a source being bypassed/muted/un-bypassed (mode change)
  const modeSig = node.__mimicSources
    .map((sid) => sid + ":" + (node.graph?.getNodeById?.(sid)?.mode ?? 0)).join(",");
  if (modeSig !== node.__mimicModeSig) { node.__mimicModeSig = modeSig; changed = true; }
  if (changed) { writeLoraData(node); renderMimic(node); }
}

function buildMimicUI(node) {
  ensureState(node);
  const ld = (node.widgets || []).find((w) => w.name === "lora_data");
  if (ld) { ld.type = "hidden_mimic"; ld.computeSize = () => [0, -4]; ld.hidden = true; }

  const liveW = node.addWidget("toggle", "live_mirror", node.__mimicLive !== false, (v) => {
    node.__mimicLive = !!v;
  }, { on: "On", off: "Off" });
  liveW.tooltip = "When on, keeps mirroring each source's loras and strengths as you edit them. " +
    "Unlinked loras keep their own values regardless.";
  if (node.__mimicLive == null) node.__mimicLive = true;

  const pull = node.addWidget("button", "pull_now", null, () => {
    reconcile(node); writeLoraData(node); renderMimic(node);
  });
  pull.label = "\u21BB Pull now";
  pull.tooltip = "Re-read the selected sources right now.";

  // outer is the DOM-widget element (ComfyUI forces ITS height); inner holds the
  // content at natural height, so measuring inner lets the node shrink as well as grow.
  const outer = el("div", "width:100%;box-sizing:border-box;overflow:visible;");
  const inner = el("div",
    "width:100%;box-sizing:border-box;padding:6px;font-family:system-ui,sans-serif;" +
    "font-size:12.5px;color:" + TEXT_COL + ";");
  outer.appendChild(inner);
  node.__mimicOuter = outer;
  node.__mimicRoot = inner;                 // renderMimic writes here
  node.__mimicWidget = node.addDOMWidget("mimic_ui", "fl_mimic_ui", outer, {
    serialize: false, getValue: () => "", setValue: () => {},
  });
  // measure the INNER content (not the height-forced outer) so it can shrink too
  node.__mimicWidget.computeSize = function (width) {
    const h = node.__mimicRoot ? node.__mimicRoot.scrollHeight : 40;
    return [width, Math.max(40, h + 8)];
  };

  node.__mimicTimer = setInterval(() => { try { tick(node); } catch (_) {} }, 600);
  setTimeout(() => { try { reconcile(node); writeLoraData(node); renderMimic(node); } catch (_) {} }, 50);
}

// ===========================================================================
// Sniffer — Fantastic Lora Mimic Subgraph Companion
// Scans compatible lora nodes in its own graph scope and bakes their combined
// loras into lora_data; the Python side emits them as a LORA_STACK.
// ===========================================================================

function snifferGather(node) {
  const srcs = compatibleSources(node.graph, node.id);
  const groups = [];
  const loras = [];
  for (const s of srcs) {
    const r = readSourceLoras(s) || [];
    if (!r.length) continue;
    groups.push({ label: sourceLabel(s), loras: r });
    for (const l of r) loras.push({ on: true, name: l.name, model: l.model, clip: l.clip });
  }
  const w = (node.widgets || []).find((x) => x.name === "lora_data");
  if (w) {
    const next = JSON.stringify({ loras });
    if (w.value !== next) w.value = next;
  }
  return groups;
}

function renderSniffer(node) {
  const root = node.__snifRoot;
  if (!root) return;
  root.innerHTML = "";
  const groups = snifferGather(node);

  const total = groups.reduce((n, g) => n + g.loras.length, 0);
  root.appendChild(el("div",
    "padding:5px 8px;margin-bottom:6px;border-radius:6px;background:#0c2528;border:1px solid " + BORDER +
    ";font-size:11.5px;line-height:1.35;color:" + TEXT_COL + ";",
    { innerHTML: `<b style="color:${ACCENT}">Gathering ${total} lora${total === 1 ? "" : "s"}</b> from this graph scope. ` +
      `Wire the <b>lora_stack</b> output through the subgraph boundary into a Mimic.` }));

  if (!groups.length) {
    root.appendChild(el("div", "opacity:.6;padding:6px 8px;font-size:11.5px;",
      { textContent: "No lora loaders found in this scope yet. Place this beside (or inside the same subgraph as) the loras you want to forward." }));
  }
  for (const g of groups) {
    const box = el("div", "margin-bottom:6px;border:1px solid " + BORDER + ";border-radius:6px;overflow:hidden;background:#0a2326;");
    box.appendChild(el("div",
      "padding:4px 8px;background:#123b3e;font-weight:700;font-size:12px;color:" + ACCENT +
      ";overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", { textContent: g.label }));
    for (const l of g.loras) {
      const row = el("div", "display:flex;gap:8px;padding:3px 8px;border-top:1px solid #103033;font-size:11.5px;");
      row.appendChild(el("span", "flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;",
        { textContent: shortName(l.name), title: l.name }));
      row.appendChild(el("span", "flex:none;opacity:.7;", { textContent: (Math.round(l.model * 100) / 100).toString() }));
      box.appendChild(row);
    }
    root.appendChild(box);
  }

  // auto-fit
  try {
    if (node.__snifWidget) {
      requestAnimationFrame(() => {
        try {
          const want = node.computeSize();
          if (want && want[1] && Math.abs(want[1] - node.size[1]) > 2) {
            node.setSize([node.size[0], want[1]]); node.setDirtyCanvas(true, true);
          }
        } catch (_) {}
      });
    }
  } catch (_) {}
}

function buildSnifferUI(node) {
  const ld = (node.widgets || []).find((w) => w.name === "lora_data");
  if (ld) { ld.type = "hidden_mimic"; ld.computeSize = () => [0, -4]; ld.hidden = true; }

  const outer = el("div", "width:100%;box-sizing:border-box;overflow:visible;");
  const inner = el("div",
    "width:100%;box-sizing:border-box;padding:6px;font-family:system-ui,sans-serif;color:" + TEXT_COL + ";");
  outer.appendChild(inner);
  node.__snifRoot = inner;
  node.__snifWidget = node.addDOMWidget("snif_ui", "fl_snif_ui", outer, {
    serialize: false, getValue: () => "", setValue: () => {},
  });
  node.__snifWidget.computeSize = function (width) {
    const h = node.__snifRoot ? node.__snifRoot.scrollHeight : 40;
    return [width, Math.max(40, h + 8)];
  };

  node.__snifTimer = setInterval(() => { try { renderSniffer(node); } catch (_) {} }, 700);
  setTimeout(() => { try { renderSniffer(node); } catch (_) {} }, 50);
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "FantasticLoras.Mimic",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== MIMIC_NODE_NAME) return;

    nodeType.color = NODE_COLOR;
    nodeType.bgcolor = NODE_BGCOLOR;

    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      origCreated?.apply(this, arguments);
      this.size = [390, 410];   // ~50px larger; the node also auto-grows to fit content
      try { buildMimicUI(this); } catch (err) { console.warn("[FantasticLoraMimic] UI build failed", err); }
    };

    const origConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      origConfigure?.apply(this, arguments);
      try {
        if (!this.__mimicRoot) buildMimicUI(this);
        restoreState(this);
        reconcile(this); writeLoraData(this); renderMimic(this);
      } catch (err) { console.warn("[FantasticLoraMimic] configure failed", err); }
    };

    const origOCC = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      origOCC?.apply(this, arguments);
      setTimeout(() => { try { reconcile(this); writeLoraData(this); renderMimic(this); } catch (_) {} }, 0);
    };

    const origRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      if (this.__mimicTimer) { clearInterval(this.__mimicTimer); this.__mimicTimer = null; }
      closeSourcePanel();
      origRemoved?.apply(this, arguments);
    };
  },
});

app.registerExtension({
  name: "FantasticLoras.MimicSubgraphCompanion",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== SNIFFER_NODE_NAME) return;

    nodeType.color = "#143a3f";
    nodeType.bgcolor = "#163f44";

    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      origCreated?.apply(this, arguments);
      this.size = [320, 220];
      try { buildSnifferUI(this); } catch (err) { console.warn("[FantasticLoraSniffer] UI build failed", err); }
    };

    const origConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      origConfigure?.apply(this, arguments);
      try { if (!this.__snifRoot) buildSnifferUI(this); renderSniffer(this); } catch (_) {}
    };

    const origOCC = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      origOCC?.apply(this, arguments);
      setTimeout(() => { try { renderSniffer(this); } catch (_) {} }, 0);
    };

    const origRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      if (this.__snifTimer) { clearInterval(this.__snifTimer); this.__snifTimer = null; }
      origRemoved?.apply(this, arguments);
    };
  },
});
