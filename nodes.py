"""
Fantastic Lora Loader — standalone ComfyUI custom nodes.

Two nodes:
  FantasticLoraLoader          — single model + optional CLIP
                                  (+ randomizer / auto-roll lines)
  FantasticLoraLoaderMulti     — primary model + optional CLIP
                                  + up to 4 additional optional models

The lora stack lives in a hidden "lora_data" STRING widget managed by the
frontend.  Its JSON shape is:

  {
    "loras": [
      {"on": true, "name": "...", "strength": 1.0},          # normal line
      {"on": true, "name": "...", "strength": 1.0,
       "random": true, "autoRoll": true, "locked": false,
       "folders": ["flux/styles", ...] | null}               # randomizer line
    ],
    "enabledFolders": ["flux/styles", ...] | null            # node folder filter
  }

Auto-roll lines (random + autoRoll + not locked) are rolled in the frontend at
queue time, which bakes a concrete lora name into lora_data before the prompt is
built. At execution the backend applies every entry by its concrete name, so a
randomizer line is identical to a normal lora line.
"""

import json
import os
import re
import math
import random
import time
import shutil

import folder_paths
import comfy.utils
import comfy.sd

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont


_LORA_SD_CACHE: dict = {}
_ROOT_LABEL = "(root)"


def _load_lora_sd(path: str):
    """Return the lora state dict for `path`.

    IMPORTANT: returns a *shallow copy* of the cached dict, never the cached
    object itself. comfy.lora.load_lora() may remove keys from the dict it is
    handed; if we returned the cached original, a second application (which only
    happens when the node re-executes — i.e. under auto-roll) would receive a
    drained dict and patch the model incompletely, degrading output quality.
    A shallow copy is cheap (it copies tensor references, not tensor data) and
    keeps the cached original pristine for every run.
    """
    sd = _LORA_SD_CACHE.get(path)
    if sd is None:
        sd = comfy.utils.load_torch_file(path, safe_load=True)
        _LORA_SD_CACHE[path] = sd
    return dict(sd)


def _folder_of(f: str) -> str:
    f = str(f).replace("\\", "/")
    return f.rsplit("/", 1)[0] if "/" in f else _ROOT_LABEL


def _parse_payload(lora_data: str):
    """Return (entries, enabled_folders). enabled_folders is a list or None (=all)."""
    if not lora_data:
        return [], None
    try:
        data = json.loads(lora_data)
    except (ValueError, TypeError):
        return [], None

    if isinstance(data, list):
        raw, enabled = data, None
    elif isinstance(data, dict):
        raw = data.get("loras", [])
        enabled = data.get("enabledFolders", None)
    else:
        return [], None

    if not isinstance(raw, list):
        raw = []
    if enabled is not None and not isinstance(enabled, list):
        enabled = None

    entries = []
    for e in raw:
        if not isinstance(e, dict):
            continue
        name = e.get("name") or e.get("lora") or ""
        is_random = bool(e.get("random"))
        # Non-random lines still need a name; random lines may be empty (rolled later)
        if not is_random and (not name or name in ("None", "NONE")):
            continue
        s = e.get("strength")
        if s is not None:
            model_s = clip_s = float(s)
        else:
            model_s = float(e.get("model", 1.0))
            clip_s = float(e.get("clip", 1.0))
        item = {"on": bool(e.get("on", True)), "name": name,
                "model": model_s, "clip": clip_s}
        if is_random:
            item["random"] = True
            item["autoRoll"] = bool(e.get("autoRoll"))
            item["locked"] = bool(e.get("locked"))
            item["folders"] = e.get("folders") if isinstance(e.get("folders"), list) else None
        entries.append(item)
    return entries, enabled


def _parse_stack(lora_data: str) -> list:
    """Back-compat helper: entries only."""
    return _parse_payload(lora_data)[0]


def _all_lora_files():
    try:
        return [str(f).replace(os.sep, "/") for f in folder_paths.get_filename_list("loras")]
    except Exception as err:  # noqa: BLE001
        print(f"[FantasticLoraLoader] Failed to list loras: {err}")
        return []


def _apply_stack_collect(model, clip, lora_data: str):
    """Apply the lora stack to (model, clip) and report what was applied.

    Returns (model, clip, applied) where `applied` is a list of
    (name, model_strength, clip_strength) in application order — exactly the
    loras that were patched in (post dedup / not-found skips). The plotter uses
    this to build metadata that reflects the real stack, including auto-rolled
    picks (which the frontend has already baked into `name` at queue time).

    Every entry — normal or randomizer — is applied by its concrete `name`.
    Randomizer/auto-roll lines are rolled in the frontend at queue time and
    arrive here with a concrete name already baked in, so they traverse the
    exact same code path as a normal lora line. Each resolved path is applied
    at most once per call.
    """
    entries, _enabled = _parse_payload(lora_data)
    applied_paths: set[str] = set()   # dedup guard
    applied: list = []

    for e in entries:
        if not e["on"]:
            continue

        name = e["name"]
        if not name or name in ("None", "NONE"):
            continue

        # Clamp strengths to a sane range to avoid runaway values.
        model_s = max(-10.0, min(10.0, float(e.get("model", 1.0))))
        clip_s  = max(-10.0, min(10.0, float(e.get("clip",  1.0))))

        if model_s == 0 and (clip is None or clip_s == 0):
            continue

        path = folder_paths.get_full_path("loras", name)
        if path is None:
            print(f"[FantasticLoraLoader] WARNING: lora not found, skipping: {name}")
            continue

        # Deduplication: skip if this exact file was already applied this run.
        if path in applied_paths:
            print(f"[FantasticLoraLoader] WARNING: duplicate lora entry skipped: {name}")
            continue
        applied_paths.add(path)

        print(f"[FantasticLoraLoader] applying {name}  M={model_s} C={clip_s}")
        model, clip = comfy.sd.load_lora_for_models(
            model, clip, _load_lora_sd(path), model_s, clip_s
        )
        applied.append((name, model_s, clip_s))

    return model, clip, applied


def _apply_stack(model, clip, lora_data: str):
    """Apply the lora stack to (model, clip). Returns (model, clip)."""
    model, clip, _applied = _apply_stack_collect(model, clip, lora_data)
    return model, clip


# ---------------------------------------------------------------------------
# Metadata (LoRA Plot Node convention: "<sanitized_lora>_<strength>")
# ---------------------------------------------------------------------------

def _sanitize_lora_name(filename: str) -> str:
    basename = os.path.basename(str(filename))
    name = os.path.splitext(basename)[0]
    name = re.sub(r'[<>:"/\\|?*]', "_", name).strip(". ")
    return name or "lora"


def _format_strength(value: float) -> str:
    # Mirror the LoRA Plot Node, which embeds the raw float (e.g. 0.8, 1.0).
    v = round(float(value), 4)
    return repr(int(v)) + ".0" if v == int(v) else repr(v)


def _build_metadata(applied) -> str:
    """Single metadata string from the loras applied to the primary path.

    Format per lora: "<sanitized_name>_<model_strength>", joined by ", ".
    Matches the token shape the LoRA Plot Image Saver parses (rsplit on '_').
    """
    parts = [f"{_sanitize_lora_name(name)}_{_format_strength(m)}" for name, m, _c in applied]
    return ", ".join(parts) if parts else "no_lora"


# ---------------------------------------------------------------------------
# Plotter sweep helpers
# ---------------------------------------------------------------------------

def _apply_one(model, clip, name, model_s, clip_s):
    """Apply a SINGLE lora to a base (model, clip). Returns (model, clip) or None.

    Unlike _apply_stack this never accumulates — each sweep cell starts from the
    untouched base model/clip, exactly like the original LoRA Plot Node.
    """
    path = folder_paths.get_full_path("loras", name)
    if path is None:
        print(f"[FantasticLoraPlotter] WARNING: lora not found, skipping: {name}")
        return None
    model_s = max(-10.0, min(10.0, float(model_s)))
    clip_s  = max(-10.0, min(10.0, float(clip_s)))
    return comfy.sd.load_lora_for_models(model, clip, _load_lora_sd(path), model_s, clip_s)


def _parse_plot_config(lora_data: str):
    """Read plotter-only fields from the payload.

    Returns (mode, global_strengths, control_image) where mode is
    "perline" | "global", global_strengths is a list of floats (blanks already
    dropped by the frontend), and control_image is a bool.
    """
    mode, gstr, control = "perline", [], False
    try:
        data = json.loads(lora_data) if lora_data else {}
    except (ValueError, TypeError):
        data = {}
    if isinstance(data, dict):
        if data.get("plotMode") == "global":
            mode = "global"
        gs = data.get("globalStrengths")
        if isinstance(gs, list):
            for v in gs:
                try:
                    gstr.append(float(v))
                except (ValueError, TypeError):
                    pass
        control = bool(data.get("controlImage", False))
    return mode, gstr, control


def _parse_global_loras(global_loras):
    """Normalize the payload from a Fantastic Plotter Global Lora node.

    Returns (loras, control_none, control_global) where loras is a list of
    (name, model_strength, clip_strength) tuples.
    """
    if not isinstance(global_loras, dict):
        return [], False, False
    loras = []
    for g in (global_loras.get("loras") or []):
        if not isinstance(g, dict):
            continue
        name = g.get("name")
        if not name or name in ("None", "NONE"):
            continue
        try:
            ms = float(g.get("model", 1.0))
        except (ValueError, TypeError):
            ms = 1.0
        try:
            cs = float(g.get("clip", ms))
        except (ValueError, TypeError):
            cs = ms
        loras.append((name, ms, cs))
    return (loras,
            bool(global_loras.get("control_none")),
            bool(global_loras.get("control_global")))


def _apply_global_chain(model, clip, globals_list):
    """Apply every global lora in sequence on top of (model, clip)."""
    m, c = model, clip
    for (name, ms, cs) in globals_list:
        r = _apply_one(m, c, name, ms, cs)
        if r is not None:
            m, c = r
    return m, c


def _stack_list_from_data(lora_data):
    """Build a LORA_STACK [(name, model_s, clip_s), ...] from a lora_data payload.

    Only enabled, concretely-named lines are included. This is the format the
    wider ComfyUI ecosystem (Efficiency Nodes etc.) uses for LORA_STACK, so it
    lets our loaders feed a Mimic — or anything else that consumes LORA_STACK."""
    entries, _ = _parse_payload(lora_data)
    out = []
    for e in entries:
        if e["on"] and e["name"] and e["name"] not in ("None", "NONE"):
            out.append((e["name"], float(e["model"]), float(e["clip"])))
    return out


def _expand_mimic_payload(lora_data):
    """Expand the Mimic's picker payload into [(name, model_s, clip_s), ...].

    Like _stack_list_from_data, but understands High/Low Model Mode: when the
    payload has highLow=true and a line has a companion lora, the companion is
    applied in place of the original (and the original too, if keepOriginal)."""
    try:
        data = json.loads(lora_data) if lora_data else {}
    except (ValueError, TypeError):
        return []
    if isinstance(data, list):
        loras, high_low = data, False
    elif isinstance(data, dict):
        loras, high_low = data.get("loras", []), bool(data.get("highLow"))
    else:
        return []

    def _f(v, dflt):
        try:
            return float(v)
        except (TypeError, ValueError):
            return dflt

    out = []
    for e in loras:
        if not isinstance(e, dict) or not e.get("on", True):
            continue
        name = e.get("name")
        comp = e.get("companion") if isinstance(e.get("companion"), dict) else None
        # useOriginal forces the source lora as-is, even if a companion is stored
        if high_low and comp and comp.get("name") and not e.get("removed") and not e.get("useOriginal"):
            cn = comp.get("name")
            if cn and cn not in ("None", "NONE"):
                cm = _f(comp.get("model"), 1.0)
                out.append((cn, cm, _f(comp.get("clip"), cm)))
            if e.get("keepOriginal") and name and name not in ("None", "NONE"):
                out.append((name, _f(e.get("model"), 1.0), _f(e.get("clip"), 1.0)))
        elif name and name not in ("None", "NONE"):
            out.append((name, _f(e.get("model"), 1.0), _f(e.get("clip"), 1.0)))
    return out


def _normalize_stack(lora_stack):
    """Coerce an incoming LORA_STACK into [(name, model_s, clip_s), ...].

    Accepts the common tuple form (name, model_s, clip_s) used by Efficiency-style
    stackers, the 2-tuple (name, strength), and a few dict shapes, so the Mimic is
    tolerant of whatever a cooperating node emits."""
    out = []
    for item in (lora_stack or []):
        name = None; ms = 1.0; cs = None
        try:
            if isinstance(item, (list, tuple)):
                if not item:
                    continue
                name = item[0]
                ms = float(item[1]) if len(item) > 1 and item[1] is not None else 1.0
                cs = float(item[2]) if len(item) > 2 and item[2] is not None else ms
            elif isinstance(item, dict):
                name = item.get("name") or item.get("lora") or item.get("lora_name")
                ms = float(item.get("model", item.get("strength_model", 1.0)))
                cs = float(item.get("clip", item.get("strength_clip", ms)))
            else:
                continue
        except (ValueError, TypeError, IndexError):
            continue
        if cs is None:
            cs = ms
        if name and name not in ("None", "NONE"):
            out.append((name, ms, cs))
    return out


_LORA_DATA_INPUT = (
    "STRING",
    {"default": "{}", "multiline": False,
     "tooltip": "Managed by the Fantastic Lora Loader UI."},
)


# ---------------------------------------------------------------------------
# Node: Fantastic Lora Loader (single model)
# ---------------------------------------------------------------------------

class FantasticLoraLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"model": ("MODEL",), "lora_data": _LORA_DATA_INPUT},
            "optional": {"clip": ("CLIP",)},
        }

    RETURN_TYPES = ("MODEL", "CLIP", "LORA_STACK")
    RETURN_NAMES = ("MODEL", "CLIP", "lora_stack")
    FUNCTION = "load"
    CATEGORY = "loaders"
    TITLE = "Fantastic Lora Loader"

    @classmethod
    def IS_CHANGED(cls, model=None, lora_data="{}", clip=None, **kwargs):
        # The frontend bakes a fresh random pick into lora_data on every queue,
        # so the data itself changes when auto-roll lines re-roll — no need to
        # force a random token. Re-execution happens naturally.
        return lora_data

    def load(self, model, lora_data, clip=None):
        model, clip = _apply_stack(model, clip, lora_data)
        return (model, clip, _stack_list_from_data(lora_data))


# ---------------------------------------------------------------------------
# Node: Fantastic Lora Loader (Multi-Model)
# ---------------------------------------------------------------------------

class FantasticLoraLoaderMulti:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"model": ("MODEL",), "lora_data": _LORA_DATA_INPUT},
            "optional": {
                "clip":    ("CLIP",),
                "model_2": ("MODEL",),
                "model_3": ("MODEL",),
                "model_4": ("MODEL",),
                "model_5": ("MODEL",),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "LORA_STACK", "MODEL", "MODEL", "MODEL", "MODEL")
    RETURN_NAMES = ("MODEL", "CLIP", "lora_stack", "MODEL 2", "MODEL 3", "MODEL 4", "MODEL 5")
    FUNCTION = "load"
    CATEGORY = "loaders"
    TITLE = "Fantastic Lora Loader (Multi-Model)"

    @classmethod
    def IS_CHANGED(cls, model=None, lora_data="{}", clip=None, **kwargs):
        return lora_data

    def load(self, model, lora_data, clip=None,
             model_2=None, model_3=None, model_4=None, model_5=None):
        primary_m, patched_clip = _apply_stack(model, clip, lora_data)
        extras = []
        for m in (model_2, model_3, model_4, model_5):
            extras.append(_apply_stack(m, None, lora_data)[0] if m is not None else None)
        return (primary_m, patched_clip, _stack_list_from_data(lora_data), *extras)


# ---------------------------------------------------------------------------
# Node: Fantastic Lora Plotter  (step 1 — loader stage)
# ---------------------------------------------------------------------------
#
# ---------------------------------------------------------------------------
# Node: Fantastic Lora Plotter  (step 2 — sweep)
# ---------------------------------------------------------------------------
#
# Emits LISTS (OUTPUT_IS_LIST): one model/clip/metadata cell per generation.
# ComfyUI runs the downstream graph once per cell, so a grid fills one cell
# each. Each enabled lora line is applied ALONE to the base model (never
# stacked), matching the original LoRA Plot Node.
#
# Two strength modes (set in the node UI, stored in lora_data):
#   * per-line  — each enabled lora is ONE cell at its own strength.
#                 2 loras -> 2 cells.
#   * global    — per-line strengths are ignored; every enabled lora is swept
#                 across the global strength list. 2 loras x 3 strengths -> 6
#                 cells, ordered lora-major (lora1 @ each strength, then lora2).
#
# Output order is deliberate: metadata sits at a FIXED index (2) BEFORE the
# dynamic MODEL 2-5 slots, because the frontend strips/re-adds those extra
# model outputs at the end of the list. Keeping metadata ahead of them means
# ComfyUI's slot-index -> return-value mapping stays aligned no matter how many
# model paths the user adds. Extra MODEL 2-5 outputs are parallel sweep lists
# (same lora/strength per cell, applied to that base model); unconnected extra
# paths emit an empty list.

class FantasticLoraPlotter:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"model": ("MODEL",), "lora_data": _LORA_DATA_INPUT},
            "optional": {
                "clip":    ("CLIP",),
                "global_loras": ("FL_GLOBAL_LORAS",),
                "model_2": ("MODEL",),
                "model_3": ("MODEL",),
                "model_4": ("MODEL",),
                "model_5": ("MODEL",),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "STRING", "STRING", "MODEL", "MODEL", "MODEL", "MODEL")
    RETURN_NAMES = ("MODEL", "CLIP", "metadata", "global_loras_info", "MODEL 2", "MODEL 3", "MODEL 4", "MODEL 5")
    OUTPUT_IS_LIST = (True, True, True, False, True, True, True, True)
    FUNCTION = "load"
    CATEGORY = "loaders"
    TITLE = "Fantastic Lora Plotter"

    @classmethod
    def IS_CHANGED(cls, model=None, lora_data="{}", clip=None, global_loras=None, **kwargs):
        # plotMode / globalStrengths / controlImage live inside lora_data, and the
        # frontend bakes auto-roll picks into it too. The global_loras payload is
        # folded in so a change to the attached Global Lora node re-triggers too.
        return f"{lora_data}|{global_loras}"

    def load(self, model, lora_data, clip=None, global_loras=None,
             model_2=None, model_3=None, model_4=None, model_5=None):
        entries, _enabled = _parse_payload(lora_data)
        mode, global_strengths, control_image = _parse_plot_config(lora_data)
        g_loras, g_ctrl_none, g_ctrl_global = _parse_global_loras(global_loras)
        has_global_node = global_loras is not None

        # Only enabled, concretely-named lines become cells. Randomizer lines
        # already carry a baked name from the frontend at queue time.
        lines = [e for e in entries
                 if e["on"] and e["name"] and e["name"] not in ("None", "NONE")]

        models, clips, metas = [], [], []
        extra_bases = (model_2, model_3, model_4, model_5)
        extras = [[], [], [], []]  # parallel lists for MODEL 2-5

        for e in lines:
            name = e["name"]
            if mode == "global" and global_strengths:
                strengths = global_strengths
            else:
                # per-line (or global with no strengths entered → fall back)
                if mode == "global" and not global_strengths:
                    print("[FantasticLoraPlotter] global mode but no strengths set "
                          f"— using line strength for {name}")
                strengths = [e["model"]]

            for s in strengths:
                primary = _apply_one(model, clip, name, s, s)
                if primary is None:
                    continue   # lora not found — skip this cell entirely
                pm, pc = primary
                # Global loras apply on top of every swept cell.
                pm, pc = _apply_global_chain(pm, pc, g_loras)
                models.append(pm)
                clips.append(pc)   # None when CLIP isn't connected — that's fine
                metas.append(f"{_sanitize_lora_name(name)}_{_format_strength(s)}")

                # Extra model paths: same lora/strength (+ globals) per base.
                for i, base in enumerate(extra_bases):
                    if base is None:
                        continue
                    r = _apply_one(base, None, name, s, s)
                    bm = r[0] if r is not None else base
                    bm, _ = _apply_global_chain(bm, None, g_loras)
                    extras[i].append(bm)

        # Control cells. When a Global Lora node is attached it drives control
        # (the plotter's own Control Image toggle is disabled in the UI); we then
        # honour its two flags. Otherwise the plotter's own Control Image is used.
        def _append_control(prim_model, prim_clip, label, extra_fn):
            models.append(prim_model)
            clips.append(prim_clip)
            metas.append(label)
            for i, base in enumerate(extra_bases):
                if base is not None:
                    extras[i].append(extra_fn(base))

        if has_global_node:
            if g_ctrl_none:
                # Pure base model — no sweep loras, no globals.
                _append_control(model, clip, "control", lambda b: b)
            if g_ctrl_global:
                # Base model + global loras only (none of the stack loras).
                gm, gc = _apply_global_chain(model, clip, g_loras)
                _append_control(gm, gc, "control_global",
                                lambda b: _apply_global_chain(b, None, g_loras)[0])
        elif control_image:
            _append_control(model, clip, "control", lambda b: b)

        # Nothing applied (no lines, or all not-found): emit one passthrough cell
        # so the downstream graph still runs once instead of hard-failing.
        if not models:
            models = [model]
            clips = [clip]
            metas = ["no_lora"]
            extras = [([b] if b is not None else []) for b in extra_bases]

        # Human-readable summary of the global loras for the saver to display
        # (e.g. "painterly_0.8\ntexture_0.5"). Empty string if none are set.
        global_loras_info = "\n".join(
            f"{_sanitize_lora_name(name)}_{_format_strength(ms)}" for (name, ms, _cs) in g_loras
        )

        return (models, clips, metas, global_loras_info, extras[0], extras[1], extras[2], extras[3])


# ===========================================================================
# Fantastic Plotter Image Saver
# ===========================================================================
# Merges three nodes into one so a plot can feed any Save Image node directly:
#   1. LoRA Plot Image Saver  (text overlay per cell)
#   2. Image List to Image Batch  (impact-pack — resize + stack into a batch)
#   3. FL Image Batch To Grid (fill-nodes — compose grid, N images per row)
#
# Columns are auto-derived from the metadata: each token is "<name>_<strength>",
# so the number of DISTINCT strengths becomes images_per_row. The plotter emits
# cells lora-major (each lora swept across the same strengths), so this lays
# loras out as rows and strengths as columns — the XY grid. Set images_per_row
# > 0 to override the automatic value.

_PLOT_COLOR_OPTIONS = [
    "white", "black", "red", "green", "blue", "yellow",
    "cyan", "magenta", "orange", "gray", "lightgray", "darkgray",
]

_PLOT_COLOR_MAP = {
    "white": (255, 255, 255), "black": (0, 0, 0), "red": (255, 0, 0),
    "green": (0, 255, 0), "blue": (0, 0, 255), "yellow": (255, 255, 0),
    "cyan": (0, 255, 255), "magenta": (255, 0, 255), "orange": (255, 165, 0),
    "gray": (128, 128, 128), "lightgray": (211, 211, 211), "darkgray": (169, 169, 169),
}

_PLOT_FONT_CACHE: dict = {}


def _plot_color_to_rgba(color_str, alpha):
    color_str = str(color_str).strip().lower()
    if color_str in _PLOT_COLOR_MAP:
        r, g, b = _PLOT_COLOR_MAP[color_str]
    elif color_str.startswith("#"):
        h = color_str[1:]
        if len(h) == 6:
            r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        elif len(h) == 8:
            r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
            alpha = int(h[6:8], 16) / 255.0
        else:
            r, g, b = 255, 255, 255
    else:
        r, g, b = 255, 255, 255
    return (r, g, b, int(max(0.0, min(1.0, alpha)) * 255))


def _plot_get_font(font_size):
    if font_size not in _PLOT_FONT_CACHE:
        font = None
        for path in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                     "/System/Library/Fonts/Helvetica.ttc",
                     "C:\\Windows\\Fonts\\arialbd.ttf"):
            try:
                font = ImageFont.truetype(path, font_size)
                break
            except Exception:
                continue
        if font is None:
            font = ImageFont.load_default()
        _PLOT_FONT_CACHE[font_size] = font
    return _PLOT_FONT_CACHE[font_size]


def _plot_overlay_text(meta: str) -> str:
    """Turn a metadata token into the displayed label (matches LoRA Plot saver)."""
    parts = str(meta).rsplit("_", 1)
    if len(parts) == 2:
        name, strength = parts
        return f"{name}\nStrength: {strength}"
    return str(meta)


def _plot_add_overlay(pil_image, text, text_color, bg_color, font_size, padding, opacity):
    """Draw a semi-transparent label box in the top-right corner."""
    img = pil_image.copy()
    draw = ImageDraw.Draw(img, "RGBA")
    font = _plot_get_font(font_size)

    lines = text.split("\n")
    bboxes = [draw.textbbox((0, 0), ln, font=font) for ln in lines]
    max_w = max((b[2] - b[0]) for b in bboxes) if bboxes else 0
    total_h = sum((b[3] - b[1]) for b in bboxes) + (len(lines) - 1) * 5

    iw, _ih = img.size
    box_w = max_w + padding * 2
    box_h = total_h + padding * 2
    x = iw - box_w - padding
    y = padding

    draw.rectangle([(x, y), (x + box_w, y + box_h)], fill=_plot_color_to_rgba(bg_color, opacity))
    text_rgba = _plot_color_to_rgba(text_color, 1.0)
    yo = y + padding
    for ln in lines:
        b = draw.textbbox((0, 0), ln, font=font)
        draw.text((x + padding, yo), ln, fill=text_rgba, font=font)
        yo += (b[3] - b[1]) + 5
    return img


def _plot_tensor_to_pil(img):
    arr = img.detach().cpu().numpy()
    if arr.ndim == 4:
        arr = arr[0]
    arr = (np.clip(arr, 0.0, 1.0) * 255).astype(np.uint8)
    if arr.shape[-1] == 1:
        arr = np.repeat(arr, 3, axis=-1)
    return Image.fromarray(arr[..., :3])


def _plot_pil_to_tensor(pil):
    arr = np.array(pil).astype(np.float32) / 255.0
    if arr.ndim == 2:
        arr = arr[..., None]
    return torch.from_numpy(arr)[None, ...]  # [1, H, W, C]


def _plot_auto_per_row(metadata) -> int:
    """images_per_row = number of distinct strengths in the metadata."""
    n = len(metadata)
    if n <= 1:
        return 1
    strengths = []
    for m in metadata:
        parts = str(m).rsplit("_", 1)
        if len(parts) == 2:
            try:
                strengths.append(round(float(parts[1]), 4))
            except ValueError:
                pass
    uniq = list(dict.fromkeys(strengths))   # order-preserving unique
    if uniq:
        return max(1, len(uniq))
    # Couldn't parse strengths — fall back to a near-square layout.
    return max(1, math.ceil(math.sqrt(n)))


def _plot_list_to_batch(tensors):
    """Resize every image to the first and concat into one [N, H, W, C] batch."""
    first = tensors[0]
    if first.ndim == 3:
        first = first.unsqueeze(0)
    out = first
    H, W = out.shape[1], out.shape[2]
    for t in tensors[1:]:
        if t.ndim == 3:
            t = t.unsqueeze(0)
        if t.device != out.device:
            t = t.to(out.device)
        if t.shape[1] != H or t.shape[2] != W:
            t = comfy.utils.common_upscale(t.movedim(-1, 1), W, H, "lanczos", "center").movedim(1, -1)
        if t.shape[3] != out.shape[3]:
            c = min(t.shape[3], out.shape[3])
            out, t = out[:, :, :, :c], t[:, :, :, :c]
        out = torch.cat((out, t), dim=0)
    return out


def _plot_batch_to_grid(batch, per_row):
    n, h, w, c = batch.shape
    per_row = max(1, int(per_row))
    rows = math.ceil(n / per_row)
    grid = torch.zeros((rows * h, per_row * w, c), dtype=batch.dtype, device=batch.device)
    for i in range(n):
        r, col = divmod(i, per_row)
        grid[r * h:(r + 1) * h, col * w:(col + 1) * w, :] = batch[i]
    return grid.unsqueeze(0)  # [1, rows*h, per_row*w, c]


# Control cell tokens emitted by the plotter → the label drawn on their row.
_CONTROL_LABELS = {
    "control": "control",
    "control_global": "Control (with global loras)",
}

def _is_control_meta(meta):
    return str(meta) in _CONTROL_LABELS

def _control_label(meta):
    return _CONTROL_LABELS.get(str(meta), "control")


def _plot_parse_name_strength(meta):
    """Split a metadata token into (name, strength_float). strength None if absent."""
    parts = str(meta).rsplit("_", 1)
    if len(parts) == 2:
        try:
            return parts[0], round(float(parts[1]), 4)
        except ValueError:
            return str(meta), None
    return str(meta), None


def _plot_classic_grid(images, metadata, text_color, bg_color, font_size, padding, control_rows=None, global_lines=None):
    """Classic XY plot: clean cells with labels OUTSIDE on the top/left border.

    Rows = loras (Y axis), columns = strengths (X axis). control_rows is an
    optional list of (label, pil) — each becomes a full row at the top, repeated
    across every strength column. global_lines is an optional list of strings
    ("name_strength" per global lora) drawn in the top-left corner box. Returns
    a [1,H,W,C] tensor, or None if the metadata isn't a clean lora x strength
    rectangle (caller falls back to overlay).
    """
    control_rows = control_rows or []
    global_lines = global_lines or []
    pils = [_plot_tensor_to_pil(im) for im in images]
    W, Hh = pils[0].size
    pils = [p if p.size == (W, Hh) else p.resize((W, Hh)) for p in pils]

    parsed = [_plot_parse_name_strength(m) for m in metadata]
    names = list(dict.fromkeys(p[0] for p in parsed))
    strengths = list(dict.fromkeys(p[1] for p in parsed if p[1] is not None))
    if not strengths or len(names) * len(strengths) != len(pils):
        return None  # not a clean grid → caller falls back to overlay

    cell = {(nm, st): pil for (nm, st), pil in zip(parsed, pils)}

    text_rgb = _plot_color_to_rgba(text_color, 1.0)[:3]
    bg_rgb = _plot_color_to_rgba(bg_color, 1.0)[:3]

    probe = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    def measure(s, f):
        b = probe.textbbox((0, 0), s, font=f)
        return b[2] - b[0], b[3] - b[1]

    ctrl_rows = [(lab, (p if p.size == (W, Hh) else p.resize((W, Hh)))) for lab, p in control_rows]
    n_ctrl = len(ctrl_rows)

    col_labels = [f"Strength: {_format_strength(s)}" for s in strengths]
    row_labels = [lab for lab, _ in ctrl_rows] + [str(n) for n in names]

    # Column headers sit above a cell of width W — shrink the header font until
    # the widest one fits, so adjacent headers never overlap on small cells.
    col_font_size = max(8, int(font_size))
    while col_font_size > 8:
        f = _plot_get_font(col_font_size)
        widest = max((measure(l, f)[0] for l in col_labels), default=0)
        if widest <= W - padding:
            break
        col_font_size -= 1
    col_font = _plot_get_font(col_font_size)
    row_font = _plot_get_font(max(8, int(font_size)))

    left_margin = (max((measure(l, row_font)[0] for l in row_labels), default=0)) + padding * 2
    top_margin = (max((measure(l, col_font)[1] for l in col_labels), default=0)) + padding * 2

    # Global loras box in the top-left corner — expand margins to fit it.
    global_font = _plot_get_font(max(8, int(font_size)))
    global_block = (["Global Loras:"] + global_lines) if global_lines else []
    if global_block:
        gw = max((measure(l, global_font)[0] for l in global_block), default=0) + padding * 2
        gh = sum(measure(l, global_font)[1] + 2 for l in global_block) + padding * 2
        left_margin = max(left_margin, gw)
        top_margin = max(top_margin, gh)

    cols = len(strengths)
    rows = len(names) + n_ctrl
    canvas = Image.new("RGB", (left_margin + cols * W, top_margin + rows * Hh), bg_rgb)
    draw = ImageDraw.Draw(canvas)

    # Column headers — centered above each column.
    for c, lab in enumerate(col_labels):
        w_, h_ = measure(lab, col_font)
        draw.text((left_margin + c * W + (W - w_) // 2, max(padding, (top_margin - h_) // 2)),
                  lab, fill=text_rgb, font=col_font)
    # Row headers — centered vertically in the left margin.
    for r, lab in enumerate(row_labels):
        w_, h_ = measure(lab, row_font)
        draw.text((max(padding, (left_margin - w_) // 2), top_margin + r * Hh + (Hh - h_) // 2),
                  lab, fill=text_rgb, font=row_font)
    # Global loras box — top-left corner, left-aligned.
    if global_block:
        cy = padding
        for l in global_block:
            draw.text((padding, cy), l, fill=text_rgb, font=global_font)
            cy += measure(l, global_font)[1] + 2

    # Control rows at the top — each image repeated across every strength column.
    for r, (_lab, cpil) in enumerate(ctrl_rows):
        for c in range(cols):
            canvas.paste(cpil, (left_margin + c * W, top_margin + r * Hh))
    # Lora cells.
    for r, nm in enumerate(names):
        for c, st in enumerate(strengths):
            pil = cell.get((nm, st))
            if pil is not None:
                canvas.paste(pil, (left_margin + c * W, top_margin + (r + n_ctrl) * Hh))

    return _plot_pil_to_tensor(canvas)


def _plot_add_global_strip(grid, global_lines, text_color, bg_color, font_size, padding):
    """Prepend a thin full-width strip above the grid listing global loras.

    grid is a [1,H,W,C] tensor; global_lines is a list of "name_strength"
    strings, joined into "Global Loras: a, b, c" and word-wrapped to the
    grid's width (shrinking the font first if even a single word overflows).
    Returns a new [1,H',W,C] tensor with the strip on top.
    """
    if not global_lines:
        return grid

    pil = _plot_tensor_to_pil(grid)
    W, H = pil.size

    text_rgb = _plot_color_to_rgba(text_color, 1.0)[:3]
    bg_rgb = _plot_color_to_rgba(bg_color, 1.0)[:3]

    probe = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    def measure(s, f):
        b = probe.textbbox((0, 0), s, font=f)
        return b[2] - b[0], b[3] - b[1]

    header = "Global Loras: " + ", ".join(global_lines)
    max_w = max(1, W - padding * 2)

    def wrap(text, font):
        words = text.split(" ")
        lines, cur = [], ""
        for w in words:
            trial = f"{cur} {w}".strip()
            if measure(trial, font)[0] <= max_w or not cur:
                cur = trial
            else:
                lines.append(cur)
                cur = w
        if cur:
            lines.append(cur)
        return lines

    # Shrink the font until every wrapped line fits, then wrap at that size.
    fsize = max(8, int(font_size))
    f = _plot_get_font(fsize)
    lines = wrap(header, f)
    while fsize > 8 and any(measure(l, f)[0] > max_w for l in lines):
        fsize -= 1
        f = _plot_get_font(fsize)
        lines = wrap(header, f)

    line_h = measure("Ag", f)[1]
    strip_h = len(lines) * (line_h + 2) + padding * 2 - 2

    canvas = Image.new("RGB", (W, H + strip_h), bg_rgb)
    canvas.paste(pil, (0, strip_h))
    draw = ImageDraw.Draw(canvas)
    cy = padding
    for l in lines:
        draw.text((padding, cy), l, fill=text_rgb, font=f)
        cy += line_h + 2

    return _plot_pil_to_tensor(canvas)


class FantasticPlotterImageSaver:
    # Receive the full image/metadata lists (and widgets as 1-element lists).
    INPUT_IS_LIST = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "metadata": ("STRING", {"forceInput": True}),
                "constrain_size": ("BOOLEAN", {
                    "default": False,
                    "label_on": "Constrain Image Output Size: On",
                    "label_off": "Constrain Image Output Size: Off",
                    "tooltip": (
                        "When on, each cell image is scaled down so its longest side equals "
                        "Max Cell Size before the grid is assembled. Use this to keep the "
                        "overall output manageable when rendering many large images — e.g. "
                        "a 4x4 grid of 1024px images becomes a 4x4 grid of smaller cells "
                        "instead of a giant ~4096px-wide output. Has no effect when off."
                    ),
                }),
                "max_cell_size": ("INT", {
                    "default": 768, "min": 64, "max": 2048, "step": 8,
                    "tooltip": "Longest side of each cell image in pixels. Only used when Constrain Image Output Size is on.",
                }),
                "text_color": (_PLOT_COLOR_OPTIONS, {"default": "white"}),
                "background_color": (_PLOT_COLOR_OPTIONS, {"default": "black"}),
                "font_size": ("INT", {"default": 20, "min": 8, "max": 256, "step": 1}),
                "padding": ("INT", {"default": 10, "min": 0, "max": 100, "step": 1}),
                "opacity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "images_per_row": ("INT", {
                    "default": 0, "min": 0, "max": 64, "step": 1,
                    "tooltip": "0 = auto (one column per distinct strength). >0 overrides. Ignored in classic grid.",
                }),
                "classic_grid": ("BOOLEAN", {
                    "default": False,
                    "label_on": "Classic (border labels)",
                    "label_off": "Overlay (on image)",
                    "tooltip": (
                        "Off (default): overlays each image's metadata as a label box drawn ON the image.\n"
                        "On: classic XY plot — images are padded and the labels are drawn OUTSIDE along the "
                        "border, loras down the left (rows) and strengths across the top (columns). "
                        "Needs a full lora x strength grid; otherwise it falls back to overlay."
                    ),
                }),
            },
            "optional": {
                "global_loras_info": ("STRING", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("grid", "images", "metadata", "global_loras_info")
    # grid is the single composed image; images/metadata are the per-cell lists
    # passed straight through (so the Grid Viewer can hang off this node), and
    # global_loras_info is the same newline-joined summary string it received.
    OUTPUT_IS_LIST = (False, True, True, False)
    FUNCTION = "compose"
    CATEGORY = "loaders"
    TITLE = "Fantastic Plotter Image Saver"

    @staticmethod
    def _first(v, default=None):
        # With INPUT_IS_LIST, scalar widgets arrive as 1-element lists.
        if isinstance(v, list):
            return v[0] if v else default
        return v

    def compose(self, images, metadata, text_color, background_color,
                font_size, padding, opacity, images_per_row, classic_grid=False,
                constrain_size=False, max_cell_size=512, global_loras_info=None):
        text_color = self._first(text_color, "white")
        background_color = self._first(background_color, "black")
        font_size = int(self._first(font_size, 38))
        padding = int(self._first(padding, 10))
        opacity = float(self._first(opacity, 1.0))
        per_row_override = int(self._first(images_per_row, 0))
        classic = bool(self._first(classic_grid, False))
        constrain = bool(self._first(constrain_size, False))
        max_side = max(64, min(2048, int(self._first(max_cell_size, 512))))

        # Global loras summary (from the Plotter's global_loras_info output, if
        # connected) — one "name_strength" entry per line, blanks dropped.
        gli = self._first(global_loras_info, "")
        global_lines = [ln for ln in str(gli or "").split("\n") if ln.strip()]

        # images: list of [1,H,W,C] (or [H,W,C]) tensors; metadata: list of str.
        if not isinstance(images, list):
            images = [images]
        if not isinstance(metadata, list):
            metadata = [metadata]

        if not images:
            # Nothing to compose — hand back a 1x1 black pixel so nothing crashes.
            return (torch.zeros((1, 1, 1, 3), dtype=torch.float32), [], [], str(gli or ""))

        # Align metadata to images: broadcast a single string, else pad/truncate.
        if len(metadata) == 1 and len(images) > 1:
            metadata = metadata * len(images)
        if len(metadata) < len(images):
            metadata = metadata + [""] * (len(images) - len(metadata))
        elif len(metadata) > len(images):
            print(f"[FantasticPlotterImageSaver] metadata ({len(metadata)}) > images "
                  f"({len(images)}); extra labels ignored.")
            metadata = metadata[:len(images)]

        # Passthrough copies — the clean, pre-constrain per-cell images and their
        # aligned metadata, so a downstream Grid Viewer gets full-quality cells
        # regardless of how the grid itself is composed below.
        passthrough_images = list(images)
        passthrough_meta = list(metadata)
        passthrough_global = str(gli or "")

        # Constrain: scale each cell so its longest side = max_side (only when on).
        if constrain:
            resized = []
            for img in images:
                t = img if img.ndim == 4 else img.unsqueeze(0)
                _, H, W, _ = t.shape
                longest = max(H, W)
                if longest > max_side:
                    scale = max_side / longest
                    nH, nW = max(1, int(H * scale)), max(1, int(W * scale))
                    t = comfy.utils.common_upscale(
                        t.movedim(-1, 1), nW, nH, "lanczos", "center"
                    ).movedim(1, -1)
                resized.append(t)
            images = resized
            print(f"[FantasticPlotterImageSaver] constrained cells to max_side={max_side}px")

        # Separate control cell(s) from the main grid cells. The plotter emits at
        # most one of each control kind ("control", "control_global"); each becomes
        # its own full top row, the single image repeated across every column.
        control_pairs = [(im, m) for im, m in zip(images, metadata) if _is_control_meta(m)]
        main_pairs    = [(im, m) for im, m in zip(images, metadata) if not _is_control_meta(m)]

        if main_pairs:
            main_images = [p[0] for p in main_pairs]
            main_meta = [p[1] for p in main_pairs]
        else:
            # Only control cells (or nothing else) — show what we have, no repeat.
            main_images, main_meta, control_pairs = images, metadata, []

        # Classic XY grid: clean cells, labels outside on the border.
        if classic:
            ctrl_rows = [(_control_label(m), _plot_tensor_to_pil(im)) for im, m in control_pairs]
            grid = _plot_classic_grid(main_images, main_meta, text_color, background_color,
                                      font_size, padding, control_rows=ctrl_rows,
                                      global_lines=global_lines)
            if grid is not None:
                print(f"[FantasticPlotterImageSaver] classic grid {tuple(grid.shape)}")
                return (grid, passthrough_images, passthrough_meta, passthrough_global)
            print("[FantasticPlotterImageSaver] classic grid needs a full lora x strength "
                  "rectangle — falling back to overlay.")

        # 1) Overlay label on each main cell.
        labelled = []
        for img, meta in zip(main_images, main_meta):
            text = _plot_overlay_text(meta)
            pil = _plot_add_overlay(_plot_tensor_to_pil(img), text,
                                    text_color, background_color, font_size, padding, opacity)
            labelled.append(_plot_pil_to_tensor(pil))

        # 2) Columns: override if set, else auto from the main metadata.
        per_row = per_row_override if per_row_override > 0 else _plot_auto_per_row(main_meta)
        per_row = max(1, min(per_row, len(labelled)))  # never wider than the cell count

        # 3) Control rows: each control image repeated across a full top row.
        top_rows = []
        for img, meta in control_pairs:
            cpil = _plot_add_overlay(_plot_tensor_to_pil(img), _control_label(meta),
                                     text_color, background_color, font_size, padding, opacity)
            top_rows += [_plot_pil_to_tensor(cpil)] * per_row
        labelled = top_rows + labelled

        # 4) Resize + batch, then compose grid → single image.
        batch = _plot_list_to_batch(labelled)
        grid = _plot_batch_to_grid(batch, per_row)
        grid = _plot_add_global_strip(grid, global_lines, text_color, background_color, font_size, padding)
        print(f"[FantasticPlotterImageSaver] {batch.shape[0]} cells -> "
              f"{per_row} per row -> grid {tuple(grid.shape)}"
              + (f" (+{len(control_pairs)} control row(s))" if control_pairs else "")
              + (" (+global loras strip)" if global_lines else ""))
        return (grid, passthrough_images, passthrough_meta, passthrough_global)


# ===========================================================================
# Fantastic Plotter Global Lora
# ===========================================================================
# A mini lora-stack collector (same chooser/folder-filter UI as the loaders, no
# randomizer) that feeds a set of "global" loras into the Plotter. Those loras
# are applied to EVERY swept cell on top of the cell's own lora. It also carries
# the two control-image flags, so when this node is attached the Plotter's own
# Control Image toggle is disabled and control is driven from here instead.

class FantasticPlotterGlobalLora:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"lora_data": _LORA_DATA_INPUT}}

    RETURN_TYPES = ("FL_GLOBAL_LORAS",)
    RETURN_NAMES = ("global_loras",)
    FUNCTION = "collect"
    CATEGORY = "loaders"
    TITLE = "Fantastic Plotter Global Lora"
    DESCRIPTION = ("Loras selected here apply globally — they are added on top of every "
                   "image the Fantastic Lora Plotter generates, in addition to each swept "
                   "cell's own lora. Connect this node's output to the Plotter's "
                   "global_loras input (or use the Plotter's 'Add Global Lora node' button).")

    @classmethod
    def IS_CHANGED(cls, lora_data="{}"):
        return lora_data

    def collect(self, lora_data):
        entries, _enabled = _parse_payload(lora_data)
        loras = [{"name": e["name"], "model": e["model"], "clip": e["clip"]}
                 for e in entries
                 if e["on"] and e["name"] and e["name"] not in ("None", "NONE")]
        try:
            cfg = json.loads(lora_data) if lora_data else {}
        except (ValueError, TypeError):
            cfg = {}
        payload = {
            "loras": loras,
            "control_none": bool(cfg.get("controlNone")) if isinstance(cfg, dict) else False,
            "control_global": bool(cfg.get("controlGlobal")) if isinstance(cfg, dict) else False,
        }
        return (payload,)


# ===========================================================================
# Fantastic Plotter Grid Viewer
# ===========================================================================
# ===========================================================================
# Grid archive — disk-backed run storage for the Grid Viewer
# ===========================================================================
# When the viewer's archive mode is on, each run is written to
#   output/fantastic-loras-grids/<run_id>/cells/*.png  +  manifest.json
# so the grid (and any saved comparisons) can be reloaded from disk later,
# independent of the workflow. A run_id is a sortable timestamp + short random
# token. Retention (max-age / keep-last-N) is enforced after each archived run.

_ARCHIVE_DIRNAME = "fantastic-loras-grids"
_RUN_ID_RE = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{6}$")


def _grid_archive_root():
    root = os.path.join(folder_paths.get_output_directory(), _ARCHIVE_DIRNAME)
    os.makedirs(root, exist_ok=True)
    return root


def _safe_run_id(rid):
    return bool(rid) and bool(_RUN_ID_RE.match(str(rid)))


def _run_dir(rid):
    return os.path.join(_grid_archive_root(), str(rid))


def _new_run_id():
    return time.strftime("%Y%m%d-%H%M%S") + "-" + "".join(
        random.choice("0123456789abcdef") for _ in range(6))


def _lora_from_token(token):
    """Pull a lora display name out of a 'name_strength' metadata token, dropping
    the trailing strength. Returns None for control/empty tokens."""
    s = str(token or "").strip()
    if not s or s in ("control", "control_global", "no_lora"):
        return None
    first = s.split(",")[0].strip()
    idx = first.rfind("_")
    if idx > 0:
        tail = first[idx + 1:]
        try:
            float(tail)
            first = first[:idx]
        except ValueError:
            pass
    return first or None


def _run_label(metadata_list, global_lines=None):
    """Name a run after the loras it swept, plus any global loras (tagged).
    Sweep loras are joined with ' / '; globals are appended as 'name (global)'.
    (This is display text in the manifest, not a path — the folder is the run_id —
    so the separator is purely cosmetic.)"""
    DELIM = " / "
    MAX_NAMES = 4

    names = []
    for m in (metadata_list or []):
        nm = _lora_from_token(m)
        if nm and nm not in names:
            names.append(nm)
    gnames = []
    for g in (global_lines or []):
        gn = _lora_from_token(g)
        if gn and gn not in gnames:
            gnames.append(gn)

    parts = []
    if names:
        shown = names[:MAX_NAMES]
        seg = DELIM.join(shown)
        if len(names) > MAX_NAMES:
            seg += DELIM + f"+{len(names) - MAX_NAMES} more"
        parts.append(seg)
    if gnames:
        gseg = ", ".join(gnames[:2])
        if len(gnames) > 2:
            gseg += f", +{len(gnames) - 2}"
        parts.append(f"{gseg} (global)")

    return DELIM.join(parts) if parts else "grid"


def _read_manifest(rid):
    if not _safe_run_id(rid):
        return None
    path = os.path.join(_run_dir(rid), "manifest.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _write_manifest(rid, data):
    if not _safe_run_id(rid):
        return False
    d = _run_dir(rid)
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, "manifest.json.tmp")
    final = os.path.join(d, "manifest.json")
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        os.replace(tmp, final)
        return True
    except Exception:
        return False


def _cells_as_refs(rid, cells):
    """Turn a manifest's cell list into frontend image refs."""
    sub = (_ARCHIVE_DIRNAME + "/" + str(rid) + "/cells").replace(os.sep, "/")
    return [{
        "filename": c.get("file", ""),
        "subfolder": sub,
        "type": "output",
        "metadata": c.get("metadata", ""),
    } for c in (cells or [])]


def _list_runs():
    root = _grid_archive_root()
    out = []
    try:
        entries = os.listdir(root)
    except Exception:
        return out
    for rid in entries:
        if not _safe_run_id(rid):
            continue
        man = _read_manifest(rid)
        if not man:
            continue
        out.append({
            "run_id": rid,
            "name": man.get("name", "grid"),
            "created": man.get("created", 0),
            "created_str": man.get("created_str", ""),
            "cell_count": len(man.get("cells", [])),
            "comparison_count": len(man.get("comparisons", [])),
            "pinned": bool(man.get("pinned", False)),
        })
    out.sort(key=lambda r: r.get("created", 0), reverse=True)
    return out


def _resolve_ref_path(ref):
    """Safely resolve a frontend image ref ({filename, subfolder, type}) to an
    on-disk path, guarding against path traversal outside the type's base dir."""
    try:
        rtype = str(ref.get("type", "temp"))
        if rtype == "output":
            base = folder_paths.get_output_directory()
        elif rtype == "input":
            base = folder_paths.get_input_directory()
        else:
            base = folder_paths.get_temp_directory()
        sub = str(ref.get("subfolder", "") or "")
        fn = str(ref.get("filename", "") or "")
        if not fn:
            return None
        path = os.path.normpath(os.path.join(base, sub, fn))
        base_real = os.path.realpath(base)
        if not os.path.realpath(path).startswith(base_real):
            return None
        return path if os.path.isfile(path) else None
    except Exception:
        return None


def _save_grid_from_refs(cells, global_lines, comparisons, favorites=None, pinned=True):
    """Create a new (pinned) archive run by copying already-rendered cell images
    from their current location into a fresh run folder. Used by the manual
    'Save Grid' action. Returns the manifest dict, or None on total failure."""
    rid = _new_run_id()
    cells_dir = os.path.join(_run_dir(rid), "cells")
    os.makedirs(cells_dir, exist_ok=True)

    manifest_cells = []
    copied = 0
    for i, ref in enumerate(cells or []):
        src = _resolve_ref_path(ref)
        meta = str(ref.get("metadata", "")) if isinstance(ref, dict) else ""
        if not src:
            continue
        dst_name = f"cell_{i:04}.png"
        try:
            shutil.copyfile(src, os.path.join(cells_dir, dst_name))
        except Exception:
            continue
        manifest_cells.append({
            "file": dst_name, "metadata": meta,
            "control": meta in ("control", "control_global"),
        })
        copied += 1

    if not copied:
        _delete_run(rid)   # nothing copied — don't leave an empty folder
        return None

    comps = []
    for c in (comparisons or []):
        if isinstance(c, dict) and c.get("name"):
            comps.append({"name": str(c["name"]),
                          "keys": [str(k) for k in (c.get("keys") or [])],
                          "created": time.time()})

    manifest = {
        "run_id": rid,
        "name": _run_label([c["metadata"] for c in manifest_cells], global_lines),
        "created": time.time(),
        "created_str": time.strftime("%Y-%m-%d %H:%M"),
        "global": [str(g) for g in (global_lines or [])],
        "cells": manifest_cells,
        "comparisons": comps,
        "favorites": [str(k) for k in (favorites or [])],
        "pinned": bool(pinned),
    }
    _write_manifest(rid, manifest)
    return manifest


def _delete_run(rid):
    if not _safe_run_id(rid):
        return False
    d = _run_dir(rid)
    try:
        if os.path.isdir(d):
            shutil.rmtree(d)
        return True
    except Exception:
        return False


def _run_retention(cfg, keep_id=None):
    """Delete archived runs that violate the retention policy. A run is removed
    if (max-age is on AND it's older than the limit) OR (last-N is on AND it
    falls outside the newest N). The run just created (keep_id) is never touched.
    Returns the list of deleted run_ids."""
    age_on = bool(cfg.get("maxAgeOn"))
    n_on = bool(cfg.get("lastNOn"))
    if not age_on and not n_on:
        return []

    runs = _list_runs()  # newest first
    deleted = []
    now = time.time()

    try:
        max_age_days = float(cfg.get("maxAgeDays", 14))
    except (TypeError, ValueError):
        max_age_days = 14.0
    try:
        last_n = int(cfg.get("lastN", 20))
    except (TypeError, ValueError):
        last_n = 20

    for idx, r in enumerate(runs):
        rid = r["run_id"]
        if keep_id and rid == keep_id:
            continue
        if r.get("pinned"):
            continue   # pinned grids are exempt from automatic cleanup
        too_old = age_on and (now - float(r.get("created", now))) > max_age_days * 86400.0
        beyond_n = n_on and idx >= max(0, last_n)
        if too_old or beyond_n:
            if _delete_run(rid):
                deleted.append(rid)
    return deleted


def _default_archive_cfg():
    return {"archive": False, "maxAgeOn": True, "maxAgeDays": 14,
            "lastNOn": False, "lastN": 20}


def _parse_archive_cfg(raw):
    cfg = _default_archive_cfg()
    if raw:
        try:
            data = json.loads(raw) if isinstance(raw, str) else dict(raw)
            if isinstance(data, dict):
                cfg.update({k: data[k] for k in cfg if k in data})
        except Exception:
            pass
    return cfg


# An interactive, terminal (OUTPUT_NODE) display node — the interactive twin of
# the Image Saver. It taps the SAME per-cell wires the Saver receives (the
# decoded IMAGE list + the Plotter's metadata, and optionally global_loras_info)
# and saves each cell to the temp folder, then hands the frontend a parallel
# list of {image ref, metadata}. All the layout/zoom/filter/compare interaction
# happens in web/plotter_grid_viewer.js — Python only persists the cells.

class FantasticPlotterGridViewer:
    def __init__(self):
        self.temp_dir = folder_paths.get_temp_directory()
        self.prefix_append = "_flgrid_" + "".join(
            random.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(6))

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "metadata": ("STRING", {"forceInput": True}),
            },
            "optional": {
                "global_loras_info": ("STRING", {"forceInput": True}),
                # Archive config (managed by the frontend's Archive settings UI).
                # JSON: {archive, maxAgeOn, maxAgeDays, lastNOn, lastN}
                "fl_archive": ("STRING", {"default": ""}),
                # Frontend-managed grid state (cells/runId/comparisons/favorites)
                # so the viewer reliably restores on reload. Python ignores it.
                "fl_grid_ref": ("STRING", {"default": ""}),
            },
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = ()
    FUNCTION = "view"
    OUTPUT_NODE = True
    CATEGORY = "loaders"
    TITLE = "Fantastic Plotter Grid Viewer"

    @staticmethod
    def _first(v, default=None):
        if isinstance(v, list):
            return v[0] if v else default
        return v if v is not None else default

    def view(self, images, metadata, global_loras_info=None, fl_archive=None, fl_grid_ref=None):
        # Normalise inputs. With INPUT_IS_LIST every arg arrives as a list; the
        # plotter emits one [1,H,W,C] tensor per cell and one metadata string per
        # cell, already index-aligned.
        if images is None:
            images = []
        if not isinstance(metadata, list):
            metadata = [metadata] if metadata is not None else []

        cfg = _parse_archive_cfg(self._first(fl_archive, ""))
        archive = bool(cfg.get("archive"))

        ginfo = self._first(global_loras_info, "") or ""
        global_lines = [ln for ln in str(ginfo).split("\n") if ln.strip()]

        # Flatten any batched cells into individual frames, keeping metadata aligned.
        frames = []
        for idx, img in enumerate(images):
            meta = metadata[idx] if idx < len(metadata) else ""
            if img is None:
                continue
            arr = img
            if getattr(arr, "ndim", 0) == 4:
                for b in range(arr.shape[0]):
                    frames.append((arr[b], meta))
            else:
                frames.append((arr, meta))

        if archive:
            return self._view_archive(frames, global_lines, metadata, cfg)
        return self._view_temp(frames, global_lines)

    # --- ephemeral path: temp folder, restored from the workflow JSON ----------
    def _view_temp(self, frames, global_lines):
        results = []
        if frames:
            h = int(frames[0][0].shape[0])
            w = int(frames[0][0].shape[1])
            full_output_folder, filename, counter, subfolder, _pref = \
                folder_paths.get_save_image_path(
                    "ComfyUI" + self.prefix_append, self.temp_dir, w, h)
            for (tensor, meta) in frames:
                pil = self._to_pil(tensor)
                file = f"{filename}_{counter:05}_.png"
                pil.save(os.path.join(full_output_folder, file), compress_level=1)
                results.append({
                    "filename": file, "subfolder": subfolder,
                    "type": "temp", "metadata": str(meta),
                })
                counter += 1
        return {"ui": {"fl_cells": results, "fl_global": global_lines, "fl_run_id": [""]}}

    # --- archive path: per-run subfolder + manifest, with retention ------------
    def _view_archive(self, frames, global_lines, metadata, cfg):
        rid = _new_run_id()
        cells_dir = os.path.join(_run_dir(rid), "cells")
        os.makedirs(cells_dir, exist_ok=True)

        manifest_cells = []
        results = []
        for i, (tensor, meta) in enumerate(frames):
            pil = self._to_pil(tensor)
            file = f"cell_{i:04}.png"
            pil.save(os.path.join(cells_dir, file), compress_level=1)
            manifest_cells.append({
                "file": file, "metadata": str(meta),
                "control": str(meta) in ("control", "control_global"),
            })

        results = _cells_as_refs(rid, manifest_cells)

        manifest = {
            "run_id": rid,
            "name": _run_label([c["metadata"] for c in manifest_cells], global_lines),
            "created": time.time(),
            "created_str": time.strftime("%Y-%m-%d %H:%M"),
            "global": global_lines,
            "cells": manifest_cells,
            "comparisons": [],
            "favorites": [],
            "pinned": False,   # auto-saved runs start unpinned (retention applies)
        }
        _write_manifest(rid, manifest)

        # Enforce retention AFTER writing this run (never deletes this run).
        try:
            _run_retention(cfg, keep_id=rid)
        except Exception as exc:
            print(f"[FantasticGridViewer] retention cleanup failed: {exc}")

        return {"ui": {
            "fl_cells": results,
            "fl_global": global_lines,
            "fl_run_id": [rid],
        }}

    @staticmethod
    def _to_pil(tensor):
        a = 255.0 * tensor.cpu().numpy()
        return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


# ===========================================================================
# Fantastic Lora Mimic
# ===========================================================================
# Applies a set of loras (read from another node, or via a LORA_STACK wire) onto
# its OWN model/clip — without ever taking the source's MODEL path, so the
# source's patched model never interferes. Two ways to feed it:
#   • Wire: connect any LORA_STACK output (our loaders, or Efficiency-style
#     stackers) into the lora_stack input. A connected wire always wins.
#   • Pick: with nothing wired, the frontend mirrors a chosen source node's
#     configured loras into this node's hidden lora_data widget (see web/
#     lora_mimic.js), so Python just reads lora_data.

class FantasticLoraMimic:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"model": ("MODEL",), "lora_data": _LORA_DATA_INPUT},
            "optional": {
                "clip": ("CLIP",),
                "lora_stack": ("LORA_STACK",),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "LORA_STACK", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "lora_stack", "mimicked")
    FUNCTION = "apply"
    CATEGORY = "loaders"
    TITLE = "Fantastic Lora Mimic"
    DESCRIPTION = ("Applies loras read from another node (or a LORA_STACK wire) onto this "
                   "node's own model/clip, without taking the source's model path — so the "
                   "source's patched model can't interfere. Connect a LORA_STACK, or pick a "
                   "source node in the UI and it mirrors that node's loras. It also re-emits "
                   "the resolved LORA_STACK for chaining.")

    @classmethod
    def IS_CHANGED(cls, model=None, lora_data="{}", clip=None, lora_stack=None, **kwargs):
        # Re-run when either the mirrored picker data or the wired stack changes.
        return f"{lora_data}|{lora_stack}"

    def apply(self, model, lora_data, clip=None, lora_stack=None):
        # A connected wire (even an empty one) wins; otherwise use the mirrored
        # picker data baked into lora_data by the frontend.
        if lora_stack is not None:
            entries = _normalize_stack(lora_stack)
            source = "wire"
        else:
            entries = _expand_mimic_payload(lora_data)
            source = "picker"

        m, c = model, clip
        applied = []
        for (name, ms, cs) in entries:
            r = _apply_one(m, c, name, ms, cs)
            if r is not None:
                m, c = r
                applied.append(f"{_sanitize_lora_name(name)}_{_format_strength(ms)}")
            else:
                print(f"[FantasticLoraMimic] lora not found, skipping: {name}")

        summary = ", ".join(applied) if applied else "(no loras applied)"
        print(f"[FantasticLoraMimic] mimicked {len(applied)} lora(s) via {source}: {summary}")
        return (m, c, [(n, ms, cs) for (n, ms, cs) in entries], summary)


# ===========================================================================
# Fantastic Lora Mimic Subgraph Companion  (the "sniffer")
# ===========================================================================
# A source-side aggregator: the frontend scans the lora loaders/stackers in this
# node's OWN graph scope (i.e. the subgraph it's placed in, or the top level),
# combines their enabled loras, and bakes them into lora_data; this node then
# emits them as a single LORA_STACK. Because LORA_STACK wires pass cleanly through
# subgraph input/output slots, this lets a Mimic on the other side of a subgraph
# boundary receive loras it otherwise couldn't see. An optional incoming
# lora_stack is merged in first, so sniffers can be chained or fed a passthrough.

class FantasticLoraMimicSubgraphCompanion:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"lora_data": _LORA_DATA_INPUT},
            "optional": {"lora_stack": ("LORA_STACK",)},
        }

    RETURN_TYPES = ("LORA_STACK",)
    RETURN_NAMES = ("lora_stack",)
    FUNCTION = "gather"
    CATEGORY = "loaders"
    TITLE = "Fantastic Lora Mimic Subgraph Companion"
    DESCRIPTION = ("Place this inside (or beside) a group of lora loaders — including ones "
                   "buried in a subgraph — and it gathers their loras into a single LORA_STACK "
                   "output. Wire that out through the subgraph boundary to a Fantastic Lora "
                   "Mimic's lora_stack input so the Mimic can read loras it otherwise couldn't "
                   "reach across the boundary. Note: the Mimic applies a wired stack flat, so "
                   "its per-source grouping and High/Low companion UI don't apply to this path.")

    @classmethod
    def IS_CHANGED(cls, lora_data="{}", lora_stack=None, **kwargs):
        return f"{lora_data}|{lora_stack}"

    def gather(self, lora_data, lora_stack=None):
        out = list(_normalize_stack(lora_stack)) if lora_stack is not None else []
        out.extend(_stack_list_from_data(lora_data))
        print(f"[FantasticLoraMimicSubgraphCompanion] emitting {len(out)} lora(s)")
        return (out,)


NODE_CLASS_MAPPINGS = {
    "FantasticLoraLoader":      FantasticLoraLoader,
    "FantasticLoraLoaderMulti": FantasticLoraLoaderMulti,
    "FantasticLoraPlotter":     FantasticLoraPlotter,
    "FantasticPlotterGlobalLora": FantasticPlotterGlobalLora,
    "FantasticPlotterImageSaver": FantasticPlotterImageSaver,
    "FantasticPlotterGridViewer": FantasticPlotterGridViewer,
    "FantasticLoraMimic":       FantasticLoraMimic,
    "FantasticLoraMimicSubgraphCompanion": FantasticLoraMimicSubgraphCompanion,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "FantasticLoraLoader":      "Fantastic Lora Loader 📁",
    "FantasticLoraLoaderMulti": "Fantastic Lora Loader (Multi-Model) 📁",
    "FantasticLoraPlotter":     "Fantastic Lora Plotter 📊",
    "FantasticPlotterGlobalLora": "Fantastic Plotter Global Lora 🌐",
    "FantasticPlotterImageSaver": "Fantastic Plotter Image Saver 📊",
    "FantasticPlotterGridViewer": "Fantastic Plotter Grid Viewer 🔍",
    "FantasticLoraMimic":       "Fantastic Lora Mimic 🪞",
    "FantasticLoraMimicSubgraphCompanion": "Fantastic Lora Mimic Subgraph Companion 🧩",
}


# ---------------------------------------------------------------------------
# API route: lora filename list
# ---------------------------------------------------------------------------

def _register_routes():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return

    @PromptServer.instance.routes.get("/lora_folder_loader/loras")
    async def _list_loras(_request):
        from aiohttp import web as _web
        return _web.json_response(_all_lora_files())

    # --- grid archive ---------------------------------------------------------
    @PromptServer.instance.routes.get("/fantastic_loras/runs")
    async def _runs(_request):
        from aiohttp import web as _web
        return _web.json_response({"runs": _list_runs()})

    @PromptServer.instance.routes.get("/fantastic_loras/run/{rid}")
    async def _run(request):
        from aiohttp import web as _web
        rid = request.match_info.get("rid", "")
        man = _read_manifest(rid)
        if not man:
            return _web.json_response({"error": "not found"}, status=404)
        return _web.json_response({
            "run_id": rid,
            "name": man.get("name", "grid"),
            "created_str": man.get("created_str", ""),
            "global": man.get("global", []),
            "cells": _cells_as_refs(rid, man.get("cells", [])),
            "comparisons": man.get("comparisons", []),
            "favorites": man.get("favorites", []),
            "pinned": bool(man.get("pinned", False)),
        })

    @PromptServer.instance.routes.post("/fantastic_loras/run/{rid}/favorites")
    async def _favorites(request):
        from aiohttp import web as _web
        rid = request.match_info.get("rid", "")
        man = _read_manifest(rid)
        if not man:
            return _web.json_response({"error": "not found"}, status=404)
        try:
            body = await request.json()
        except Exception:
            body = {}
        man["favorites"] = [str(k) for k in (body.get("favorites") or [])]
        ok = _write_manifest(rid, man)
        return _web.json_response({"ok": ok, "favorites": man["favorites"]})

    @PromptServer.instance.routes.post("/fantastic_loras/run/{rid}/pin")
    async def _pin(request):
        from aiohttp import web as _web
        rid = request.match_info.get("rid", "")
        man = _read_manifest(rid)
        if not man:
            return _web.json_response({"error": "not found"}, status=404)
        try:
            body = await request.json()
        except Exception:
            body = {}
        man["pinned"] = bool(body.get("pinned", True))
        ok = _write_manifest(rid, man)
        return _web.json_response({"ok": ok, "pinned": man["pinned"]})

    @PromptServer.instance.routes.post("/fantastic_loras/save_grid")
    async def _save_grid(request):
        from aiohttp import web as _web
        try:
            body = await request.json()
        except Exception:
            body = {}
        man = _save_grid_from_refs(
            body.get("cells") or [],
            body.get("global") or [],
            body.get("comparisons") or [],
            favorites=body.get("favorites") or [],
            pinned=bool(body.get("pinned", True)))
        if not man:
            return _web.json_response(
                {"error": "no images available to save (they may have been cleared)"},
                status=409)
        rid = man["run_id"]
        return _web.json_response({
            "ok": True,
            "run_id": rid,
            "name": man["name"],
            "cells": _cells_as_refs(rid, man["cells"]),
            "comparisons": man["comparisons"],
            "favorites": man.get("favorites", []),
            "pinned": man["pinned"],
        })

    @PromptServer.instance.routes.post("/fantastic_loras/run/{rid}/comparison")
    async def _comparison(request):
        from aiohttp import web as _web
        rid = request.match_info.get("rid", "")
        man = _read_manifest(rid)
        if not man:
            return _web.json_response({"error": "not found"}, status=404)
        try:
            body = await request.json()
        except Exception:
            body = {}
        action = body.get("action", "save")
        name = str(body.get("name", "")).strip()
        comps = man.get("comparisons", [])
        if action == "delete":
            comps = [c for c in comps if c.get("name") != name]
        else:  # save / replace by name
            keys = [str(k) for k in (body.get("keys") or [])]
            comps = [c for c in comps if c.get("name") != name]
            comps.append({"name": name, "keys": keys, "created": time.time()})
        man["comparisons"] = comps
        ok = _write_manifest(rid, man)
        return _web.json_response({"ok": ok, "comparisons": comps})

    @PromptServer.instance.routes.delete("/fantastic_loras/run/{rid}")
    async def _delete(request):
        from aiohttp import web as _web
        rid = request.match_info.get("rid", "")
        if not _safe_run_id(rid):
            return _web.json_response({"error": "bad id"}, status=400)
        return _web.json_response({"ok": _delete_run(rid)})


_register_routes()
