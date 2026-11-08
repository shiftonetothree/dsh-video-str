#!/usr/bin/env python3
"""Backward-compatible script entry point."""

from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from bili_ai_subtitle.cli import main  # type: ignore[import-not-found]


if __name__ == "__main__":
    raise SystemExit(main())
