"""Validate options, manage transport configuration, and present SQL results."""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path

import matplotlib.pyplot as plt
import seaborn as sns
from IPython.display import Markdown, display


def configure(top_n: int, mode: str):
    if type(top_n) is not int or not 1 <= top_n <= 100:
        raise ValueError("TOP_N must be an integer from 1 through 100 holding rows")
    if mode not in ("recorded", "live"):
        raise ValueError("DATA_MODE must be recorded or live")
    keys = ("NOTEBOOK_INVESCO_DATA_MODE", "NOTEBOOK_INVESCO_RECORDINGS", "NOTEBOOK_INVESCO_AUDIT")
    previous = {key: os.environ.get(key) for key in keys}
    audit = Path("artifacts/request-audit.jsonl").resolve()
    audit.parent.mkdir(parents=True, exist_ok=True)
    audit.write_text("")
    os.environ[keys[0]] = mode
    os.environ[keys[1]] = str(Path("recordings").resolve())
    os.environ[keys[2]] = str(audit)
    return previous, audit, datetime.now(UTC).isoformat()


def verify_audit(mode, audit):
    if mode == "live":
        return "Live mode used the released client's official HTTPS transport; no recording fallback."
    expected = {r["url"] for r in json.loads(Path("recordings/manifest.json").read_text())["records"]}
    actual = [json.loads(line)["url"] for line in audit.read_text().splitlines()]
    if len(actual) != len(expected) or set(actual) != expected:
        raise ValueError(f"Expected exactly three recorded requests, got {actual!r}")
    return (
        "Recorded request audit passed: one catalog and exactly one holdings response for each selected fund."
    )


def cleanup(previous):
    for key, value in previous.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def prose(text: str) -> None:
    display(Markdown(text))


def theme() -> None:
    sns.set_theme(
        style="whitegrid",
        rc={
            "figure.dpi": 145,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "grid.color": "#E8EDE9",
            "text.color": "#243B2F",
            "axes.labelcolor": "#405047",
            "text.parse_math": False,
            "legend.frameon": False,
        },
    )


def chart(fig, title: str, subtitle: str, source: str) -> None:
    fig.text(0.08, 0.98, title, ha="left", va="top", fontsize=17, fontweight="semibold")
    fig.text(0.08, 0.90, subtitle, ha="left", va="top", fontsize=10, color="#58685F")
    fig.tight_layout(rect=(0.02, 0.11, 1, 0.82))
    fig.text(0.08, 0.03, source, fontsize=8, color="#6C7D73")
    plt.show()
