"""
Static file-effect analysis for a Python script.

Runs inside the user's own interpreter, so it needs no dependencies: `ast` is in
the standard library and is an exact parser. That matters here. The question is
"which files does this script read or write", and answering it by matching text
gets it wrong in both directions: `f.write(...)` looks like a file write, and
`np.load(path)` built from a variable looks like nothing at all.

Output is a single JSON object on stdout, so the caller never has to parse
prose. Anything that cannot be resolved statically is reported as `unknown`
rather than guessed: a path assembled from a loop variable has no single answer,
and inventing one would put a fabricated file in a provenance record.

Adapted from the upstream notebook-analysis contracts (Apache-2.0): the read/write
effect vocabulary and the rule that an unresolvable argument is `unknown` rather
than absent come from there.
"""

import ast
import json
import sys

# Functions whose first argument names a file they write.
# Only calls whose FIRST argument is a path belong here.
#
# `write`, `writelines`, `dump`, `dumps` are deliberately absent: their first
# argument is content or an object, not a destination. A file handle's effect is
# already reported by the `open` that produced it, with the mode that decided
# read versus write. Including them here would claim that `f.write("x")` wrote
# a file called "x".
WRITE_CALLS = {
    "savefig": {},
    "savetxt": {},
    "save": {},
    "to_csv": {},
    "to_excel": {},
    "to_json": {},
    "to_parquet": {},
    "to_pickle": {},
    "to_hdf": {},
    "to_sql": {},
    "to_latex": {},
    "to_html": {},
    "write_file": {},
    "write_csv": {},
    "writestr": {},
    "add_paragraph": {},
    "add_heading": {},
    "add_table": {},
    "add_picture": {},
    "mkdir": {},
    "makedirs": {},
    "rename": {},
    "move": {},
    "copy": {},
    "copyfile": {},
    "rmtree": {},
    "remove": {},
    "unlink": {},
}

# Functions whose first argument names a file they read.
READ_CALLS = {
    "load": {},
    "loadtxt": {},
    "genfromtxt": {},
    "read_csv": {},
    "read_excel": {},
    "read_json": {},
    "read_parquet": {},
    "read_pickle": {},
    "read_table": {},
    "read_html": {},
    "read_stata": {},
    "read_sas": {},
    "read_fwf": {},
    "imread": {},
    "fromfile": {},
    "memmap": {},
    "read": {},
    "readlines": {},
    "readline": {},
    "image": {},
    "fits": {},
    "fits.open": {},
    "read_text": {},
    "read_bytes": {},
    "glob": {},
    "iglob": {},
    "listdir": {},
    "walk": {},
    "exists": {},
    "isfile": {},
    "isdir": {},
    "getsize": {},
    "stat": {},
}

# No separate receiver table is needed. A method call reaches these tables by
# its final name, so `df.to_csv(...)` and `pd.to_csv(...)` are both matched by
# the bare `to_csv` entry. Distinguishing them by receiver would add a table
# that never fires: every name in it is already handled above.

# Writers that take the object before the path when called at module level.
# `pd.to_csv(df, "out.csv")` puts the dataframe first; the method form
# `df.to_csv("out.csv")` puts the path first. Both are ordinary usage, so the
# second argument is tried when the first is not a resolvable path.
OBJECT_FIRST = {
    "to_csv", "to_excel", "to_json", "to_parquet", "to_hdf",
    "to_sql", "to_latex", "to_html", "to_pickle",
}

class Effect:
    def __init__(self):
        self.writes = []
        self.reads = []
        self.unknown = []
        self.networks = []
        self.subprocesses = []
        self.dynamic_calls = []


def literal(node):
    """Returns the value of a literal node, or None if it is not constant."""
    try:
        return ast.literal_eval(node)
    except Exception:
        return None


def dotted(node):
    """Renders an attribute/call chain as text: `df.to_csv` -> 'df.to_csv'."""
    parts = []
    current = node
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if isinstance(current, ast.Name):
        parts.append(current.id)
        return ".".join(reversed(parts))
    if isinstance(current, ast.Call) and isinstance(current.func, ast.Name):
        parts.append(current.func.id + "()")
        return ".".join(reversed(parts))
    return None


def resolve_path(node):
    """
    Resolves a node to a path string.

    Returns ("path", value) when it is a literal, or ("unknown", None) when the
    value depends on something computed. An f-string is resolved when every
    interpolated part is itself a literal, which covers the common
    f"out_{n}.csv" shape without pretending to evaluate arbitrary code.
    """
    value = literal(node)
    if isinstance(value, str):
        return ("path", value)
    if isinstance(value, (int, float)):
        return ("path", str(value))

    if isinstance(node, ast.JoinedStr):
        parts = []
        for piece in node.values:
            if isinstance(piece, ast.Constant):
                parts.append(str(piece.value))
            elif isinstance(piece, ast.FormattedValue):
                inner = literal(piece.value)
                if inner is None:
                    return ("unknown", None)
                parts.append(str(inner))
            else:
                return ("unknown", None)
        return ("path", "".join(parts))

    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = resolve_path(node.left)
        right = resolve_path(node.right)
        if left[0] == "path" and right[0] == "path":
            return ("path", left[1] + right[1])
        return ("unknown", None)

    # `Path("x") / "y"` and `os.path.join("a", "b")` are common enough to be worth
    # resolving, and both are unambiguous when every part is a literal.
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
        left = resolve_path(node.left)
        right = resolve_path(node.right)
        if left[0] == "path" and right[0] == "path":
            return ("path", f"{left[1]}/{right[1]}")

    if isinstance(node, ast.Call):
        name = dotted(node.func) or ""
        # `Path('a').mkdir()` addresses the path through the receiver, so the
        # literal is an argument to the constructor and the path is that
        # constructor's argument rather than anything passed to mkdir.
        if name in ("Path", "pathlib.Path") and node.args:
            return resolve_path(node.args[0])
        if name in ("os.path.join", "join") and node.args:
            pieces = []
            for arg in node.args:
                resolved = resolve_path(arg)
                if resolved[0] != "path":
                    return ("unknown", None)
                pieces.append(resolved[1])
            return ("path", "/".join(pieces))
        if name in ("Path", "pathlib.Path") and node.args:
            return resolve_path(node.args[0])

    return ("unknown", None)


def arg_of(call, index):
    if index < len(call.args):
        return call.args[index]
    return None


def walk(node, effect):
    if isinstance(node, ast.Call):
        name = dotted(node.func) or ""
        simple = name.split(".")[-1]

        # open() with an explicit mode decides read vs write.
        if simple == "open" and name == "open":
            mode_node = arg_of(node, 1)
            mode = literal(mode_node) if mode_node is not None else "r"
            path_node = arg_of(node, 0)
            if path_node is None:
                pass
            else:
                kind, value = resolve_path(path_node)
                if kind == "path":
                    (effect.writes if any(ch in str(mode) for ch in "wax+") else effect.reads).append(
                        {"path": value, "call": name, "mode": mode}
                    )
                else:
                    effect.unknown.append({"call": name, "reason": "path is computed at run time"})

        elif name in ("requests.get", "requests.post", "urlopen", "urllib.request.urlopen",
                      "httpx.get", "httpx.post", "aiohttp.request", "socket.create_connection"):
            effect.networks.append({"call": name, "line": node.lineno})

        elif simple in ("system", "popen", "run", "check_call", "check_output", "Popen"):
            effect.subprocesses.append({"call": name, "line": node.lineno})

        elif simple in ("eval", "exec", "compile", "__import__", "getattr", "globals", "locals", "vars"):
            effect.dynamic_calls.append({"call": name, "line": node.lineno})

        elif simple in WRITE_CALLS or name in WRITE_CALLS:
            # The path is not always the first argument. `df.to_csv("out.csv")`
            # takes the path first, but `pd.to_csv(df, "out.csv")` takes the
            # dataframe first, and both spellings are common. So: try the first
            # argument, and when it is not a resolvable path and the call is one
            # of the object-first writers, try the second.
            kind, value = ("unknown", None)
            first = arg_of(node, 0)
            if first is not None:
                kind, value = resolve_path(first)
            if kind != "path" and simple in OBJECT_FIRST:
                second = arg_of(node, 1)
                if second is not None:
                    kind, value = resolve_path(second)
            # `Path('x').mkdir(...)` addresses the path through the receiver
            # rather than through any argument.
            if kind != "path" and isinstance(node.func, ast.Attribute):
                kind, value = resolve_path(node.func.value)

            if kind == "path":
                effect.writes.append({"path": value, "call": name, "line": node.lineno})
            elif first is None and not node.args:
                effect.unknown.append({"call": name, "line": node.lineno, "reason": "no path argument"})
            else:
                effect.unknown.append({"call": name, "line": node.lineno, "reason": "path is computed at run time"})

        elif simple in READ_CALLS or name in READ_CALLS:
            path_node = arg_of(node, 0)
            if path_node is not None:
                kind, value = resolve_path(path_node)
                if kind == "path":
                    effect.reads.append({"path": value, "call": name, "line": node.lineno})
                else:
                    effect.unknown.append({"call": name, "line": node.lineno, "reason": "path is computed at run time"})

    for child in ast.iter_child_nodes(node):
        walk(child, effect)


def main():
    source = sys.stdin.read()
    effect = Effect()
    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        # A script that will not parse will not run either, so there are no
        # effects to report. The caller gets the interpreter's own error.
        json.dump({"ok": False, "error": f"syntax error: {error}"}, sys.stdout)
        return

    walk(tree, effect)

    # `open(...)` used as a context manager assigns the handle to a name; the
    # bare write calls on that handle (`f.write`) are covered by WRITE_CALLS,
    # but the mode-bearing open above is the authoritative signal, so nothing
    # extra is needed here.

    def dedupe(items):
        seen = set()
        out = []
        for item in items:
            key = (item.get("path"), item.get("call"))
            if key in seen:
                continue
            seen.add(key)
            out.append(item)
        return out

    json.dump(
        {
            "ok": True,
            "language": "python",
            "writes": dedupe(effect.writes),
            "reads": dedupe(effect.reads),
            "unknown": dedupe(effect.unknown),
            "networks": effect.networks,
            "subprocesses": effect.subprocesses,
            "dynamicCalls": effect.dynamic_calls,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()