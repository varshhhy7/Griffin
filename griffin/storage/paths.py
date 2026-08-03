from __future__ import annotations

import os
from pathlib import Path

def resolve_data_dir() -> Path:
    """
    Resolve Griffin's data directory matching global/index.ts resolveDataDir().
    """
    if "GRIFFIN_DATA_DIR" in os.environ:
        return Path(os.environ["GRIFFIN_DATA_DIR"])
    
    # Check pointer file in config directory
    config_dir = resolve_config_dir()
    pointer_file = config_dir / "data-location"
    if pointer_file.is_file():
        try:
            target = pointer_file.read_text("utf-8").strip()
            if target:
                return Path(target)
        except Exception:
            pass

    home = Path.home()
    if os.name == "nt":
        app_data = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        if app_data:
            return Path(app_data) / "griffin" / "data"
        return home / "AppData" / "Local" / "griffin" / "data"
    
    xdg_data = os.environ.get("XDG_DATA_HOME")
    if xdg_data:
        return Path(xdg_data) / "griffin"
    return home / ".local" / "share" / "griffin"

def resolve_config_dir() -> Path:
    if "GRIFFIN_CONFIG_DIR" in os.environ:
        return Path(os.environ["GRIFFIN_CONFIG_DIR"])
    home = Path.home()
    if os.name == "nt":
        app_data = os.environ.get("APPDATA")
        if app_data:
            return Path(app_data) / "griffin" / "config"
        return home / "AppData" / "Roaming" / "griffin" / "config"
    xdg_config = os.environ.get("XDG_CONFIG_HOME")
    if xdg_config:
        return Path(xdg_config) / "griffin"
    return home / ".config" / "griffin"

def resolve_db_path() -> Path:
    return resolve_data_dir() / "griffin.db"
