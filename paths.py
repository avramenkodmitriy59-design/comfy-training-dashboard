"""Where the app finds its `static/` (frontend) and `data/` (SQLite DB, secrets) folders.

Normally they sit next to the source files. In a compiled single-file build
(PyInstaller, Nuitka) the code runs from a temporary unpack directory, so the
folders shipped next to the executable would never be found — and `data/`
would be wiped on every restart. For such builds we look next to the
executable first.

Overrides: STATIC_DIR and DATA_DIR environment variables.
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_COMPILED = bool(getattr(sys, "frozen", False)) or "__compiled__" in globals()


def _find_static_dir():
    if os.environ.get("STATIC_DIR"):
        return os.path.abspath(os.environ["STATIC_DIR"])
    if _COMPILED:
        candidates = [
            os.path.dirname(os.path.abspath(sys.executable)),
            os.path.dirname(os.path.abspath(sys.argv[0])),
            os.getcwd(),
            _HERE,
        ]
        for base in candidates:
            if os.path.isfile(os.path.join(base, "static", "index.html")):
                return os.path.join(base, "static")
    return os.path.join(_HERE, "static")


STATIC_DIR = _find_static_dir()
# `data/` lives beside `static/`, so a deploy that puts both next to the binary just works
DATA_DIR = os.path.abspath(os.environ.get("DATA_DIR") or os.path.join(os.path.dirname(STATIC_DIR), "data"))
