"""
Fantastic Lora Loader — standalone ComfyUI custom nodes.

Two nodes:
  FantasticLoraLoader          — single model + optional CLIP
  FantasticLoraLoaderMulti     — primary model + optional CLIP
                                  + up to 4 additional optional models
                                  (each patched with the same lora stack)

The lora stack (files, enable flags, strengths) lives in a hidden "lora_data"
STRING widget managed by the frontend.  The folder filter is frontend-only.

CLIP is optional in both nodes.  In the multi-model node, the CLIP input is
patched once via the primary path only; the extra model inputs receive model-
strength patching and return updated MODEL tensors without touching CLIP.
"""

import json
import os

import folder_paths
import comfy.utils
import comfy.sd


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

_LORA_SD_CACHE: dict = {}


def _load_lora_sd(path: str):
    sd = _LORA_SD_CACHE.get(path)
    if sd is None:
        sd = comfy.utils.load_torch_file(path, safe_load=True)
        _LORA_SD_CACHE[path] = sd
    return sd


def _parse_stack(lora_data: str) -> list:
    if not lora_data:
        return []
    try:
        data = json.loads(lora_data)
    except (ValueError, TypeError):
        return []
    entries = data.get("loras", []) if isinstance(data, dict) else data
    if not isinstance(entries, list):
        return []
    out = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        name = e.get("name") or e.get("lora")
        if not name or name in ("None", "NONE"):
            continue
        s = e.get("strength")
        if s is not None:
            model_s = clip_s = float(s)
        else:
            model_s = float(e.get("model", 1.0))
            clip_s  = float(e.get("clip",  1.0))
        out.append({"on": bool(e.get("on", True)), "name": name,
                    "model": model_s, "clip": clip_s})
    return out


def _apply_stack(model, clip, lora_data: str):
    """Apply every enabled lora in the stack to (model, clip). Returns (model, clip)."""
    for e in _parse_stack(lora_data):
        if not e["on"]:
            continue
        if e["model"] == 0 and (clip is None or e["clip"] == 0):
            continue
        path = folder_paths.get_full_path("loras", e["name"])
        if path is None:
            print(f"[FantasticLoraLoader] WARNING: lora not found, skipping: {e['name']}")
            continue
        model, clip = comfy.sd.load_lora_for_models(
            model, clip, _load_lora_sd(path), e["model"], e["clip"]
        )
    return model, clip


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
            "required": {
                "model": ("MODEL",),
                "lora_data": _LORA_DATA_INPUT,
            },
            "optional": {
                "clip": ("CLIP",),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("MODEL", "CLIP")
    FUNCTION = "load"
    CATEGORY = "loaders"
    TITLE = "Fantastic Lora Loader"

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
            "required": {
                "model": ("MODEL",),
                "lora_data": _LORA_DATA_INPUT,
            },
            "optional": {
                "clip":    ("CLIP",),
                "model_2": ("MODEL",),
                "model_3": ("MODEL",),
                "model_4": ("MODEL",),
                "model_5": ("MODEL",),
            },
        }

    # Always return 6 slots; unused extra-model slots return None.
    RETURN_TYPES  = ("MODEL", "CLIP", "MODEL", "MODEL", "MODEL", "MODEL")
    RETURN_NAMES  = ("MODEL", "CLIP", "MODEL 2", "MODEL 3", "MODEL 4", "MODEL 5")
    FUNCTION      = "load"
    CATEGORY      = "loaders"
    TITLE         = "Fantastic Lora Loader (Multi-Model)"

    def load(self, model, lora_data, clip=None,
             model_2=None, model_3=None, model_4=None, model_5=None):

        # Primary path: patches both model and CLIP (if connected).
        primary_m, patched_clip = _apply_stack(model, clip, lora_data)

        # Extra paths: patch only the model tensor; CLIP is not touched here
        # to avoid double-patching the shared CLIP.
        extras = []
        for m in (model_2, model_3, model_4, model_5):
            if m is not None:
                patched_m, _ = _apply_stack(m, None, lora_data)
                extras.append(patched_m)
            else:
                extras.append(None)

        return (primary_m, patched_clip, *extras)


# ---------------------------------------------------------------------------
# Mappings
# ---------------------------------------------------------------------------

NODE_CLASS_MAPPINGS = {
    "FantasticLoraLoader":      FantasticLoraLoader,
    "FantasticLoraLoaderMulti": FantasticLoraLoaderMulti,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "FantasticLoraLoader":      "Fantastic Lora Loader 📁",
    "FantasticLoraLoaderMulti": "Fantastic Lora Loader (Multi-Model) 📁",
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
        try:
            files = [str(f).replace(os.sep, "/")
                     for f in folder_paths.get_filename_list("loras")]
        except Exception as err:
            print(f"[FantasticLoraLoader] Failed to list loras: {err}")
            files = []
        from aiohttp import web as _web
        return _web.json_response(files)


_register_routes()
