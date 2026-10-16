#!/usr/bin/env python3
"""Shows where a contract's WASM bytes go (#128).

    python scripts/spec-sizes.py [path/to/contract.wasm] [--top N]

Prints the size of each WASM section, then the largest entries of the
contract spec (`contractspecv0`): every function, type, event and error the
contract exports, with how many of their bytes are doc comments. soroban-sdk
copies `///` comments on exported items into the spec, so long ones cost
bytes on-chain; keep them to a sentence and put the rest in `//` comments or
docs/. Needs the `stellar` CLI. Defaults to the registry.
"""
import argparse
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT = ROOT / "target" / "wasm32v1-none" / "release" / "sorocron_registry.wasm"
NAMES = {1: "type", 2: "import", 3: "function", 5: "memory", 6: "global", 7: "export", 10: "code", 11: "data", 12: "data count"}


def leb128(data: bytes, i: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        byte = data[i]
        i += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if byte < 0x80:
            return value, i


def sections(data: bytes):
    i = 8
    while i < len(data):
        sid = data[i]
        size, i = leb128(data, i + 1)
        if sid == 0:
            name_len, j = leb128(data, i)
            yield f"custom {data[j:j + name_len].decode()}", size
        else:
            yield NAMES.get(sid, f"section {sid}"), size
        i += size


def xdr_string(text: str) -> int:
    """Bytes an XDR string takes: a 4-byte length, then the text padded to 4."""
    return 4 + (len(text.encode()) + 3) // 4 * 4


def doc_bytes(node) -> int:
    if isinstance(node, dict):
        return sum(xdr_string(v) if k == "doc" and isinstance(v, str) else doc_bytes(v) for k, v in node.items())
    if isinstance(node, list):
        return sum(doc_bytes(v) for v in node)
    return 0


def main():
    parser = argparse.ArgumentParser(description="Where a contract's WASM bytes go")
    parser.add_argument("wasm", nargs="?", type=Path, default=DEFAULT)
    parser.add_argument("--top", type=int, default=20, help="spec entries to list")
    args = parser.parse_args()
    wasm, top = args.wasm, args.top
    data = wasm.read_bytes()
    print(f"{wasm.name}: {len(data):,} bytes")
    for name, size in sections(data):
        print(f"  {name:<28} {size:>7,}")

    out = subprocess.run(
        ["stellar", "contract", "info", "interface", "--wasm", str(wasm), "--output", "json"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", check=True,
    ).stdout
    spec = json.loads(out)
    rows = []
    for entry in spec:
        kind = next(iter(entry))
        body = entry[kind]
        rows.append((len(json.dumps(entry)), doc_bytes(entry), kind.replace("_v0", ""), body.get("name", "?")))
    total_docs = sum(r[1] for r in rows)
    print(f"\nspec: {len(rows)} entries, about {total_docs:,} bytes of doc comments")
    print(f"  {'docs':>6}  {'kind':<16} name")
    for _, docs, kind, name in sorted(rows, key=lambda r: -r[1])[:top]:
        print(f"  {docs:>6}  {kind:<16} {name}")


if __name__ == "__main__":
    main()
