"""Turns a cargo llvm-cov JSON summary into the README's coverage badge (#53).

    cargo llvm-cov report --json --summary-only --output-path summary.json
    python3 scripts/coverage-badge.py summary.json coverage.json

The output is a shields.io endpoint (https://shields.io/badges/endpoint-badge).
The docs site serves it at /coverage.json and the README badge reads it there.
"""
import json
import sys

summary, output = sys.argv[1:3]
lines = json.load(open(summary))["data"][0]["totals"]["lines"]
percent = lines["percent"]
color = next(
    color
    for floor, color in [(90, "brightgreen"), (80, "green"), (70, "yellowgreen"), (60, "yellow"), (0, "orange")]
    if percent >= floor
)
with open(output, "w") as f:
    json.dump({"schemaVersion": 1, "label": "coverage", "message": f"{percent:.1f}%", "color": color}, f)
print(f"Line coverage {percent:.1f}% ({lines['covered']} of {lines['count']} lines)")
