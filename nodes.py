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

import folder_paths
import comfy.utils
import comfy.sd


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

    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("MODEL", "CLIP")
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
        return (model, clip)


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

    RETURN_TYPES = ("MODEL", "CLIP", "MODEL", "MODEL", "MODEL", "MODEL")
    RETURN_NAMES = ("MODEL", "CLIP", "MODEL 2", "MODEL 3", "MODEL 4", "MODEL 5")
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
        return (primary_m, patched_clip, *extras)


# ---------------------------------------------------------------------------
# Node: Fantastic Lora Plotter  (step 1 — loader stage)
# ---------------------------------------------------------------------------
#
# Combines the Multi-Model loader's stack + multi-model paths with the LoRA
# Plot Node's `metadata` output. Defaults to a single model path (the frontend
# starts extra_model_count at 0 and does NOT auto-add a pair for this node).
#
# Output order is deliberate: metadata sits at a FIXED index (2) BEFORE the
# dynamic MODEL 2-5 slots, because the frontend strips/re-adds those extra
# model outputs at the end of the list. Keeping metadata ahead of them means
# ComfyUI's slot-index → return-value mapping stays aligned no matter how many
# model paths the user adds.

class FantasticLoraPlotter:
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

    RETURN_TYPES = ("MODEL", "CLIP", "STRING", "MODEL", "MODEL", "MODEL", "MODEL")
    RETURN_NAMES = ("MODEL", "CLIP", "metadata", "MODEL 2", "MODEL 3", "MODEL 4", "MODEL 5")
    FUNCTION = "load"
    CATEGORY = "loaders"
    TITLE = "Fantastic Lora Plotter"

    @classmethod
    def IS_CHANGED(cls, model=None, lora_data="{}", clip=None, **kwargs):
        return lora_data

    def load(self, model, lora_data, clip=None,
             model_2=None, model_3=None, model_4=None, model_5=None):
        # Primary path patches model (+ CLIP if connected) and reports what was
        # applied so metadata reflects the real picks.
        primary_m, patched_clip, applied = _apply_stack_collect(model, clip, lora_data)

        # Extra paths: patch only the model tensor (shared CLIP patched once).
        extras = []
        for m in (model_2, model_3, model_4, model_5):
            extras.append(_apply_stack(m, None, lora_data)[0] if m is not None else None)

        metadata = _build_metadata(applied)
        return (primary_m, patched_clip, metadata, *extras)


NODE_CLASS_MAPPINGS = {
    "FantasticLoraLoader":      FantasticLoraLoader,
    "FantasticLoraLoaderMulti": FantasticLoraLoaderMulti,
    "FantasticLoraPlotter":     FantasticLoraPlotter,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "FantasticLoraLoader":      "Fantastic Lora Loader 📁",
    "FantasticLoraLoaderMulti": "Fantastic Lora Loader (Multi-Model) 📁",
    "FantasticLoraPlotter":     "Fantastic Lora Plotter 📊",
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


_register_routes()
