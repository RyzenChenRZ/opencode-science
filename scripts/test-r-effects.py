"""Check the R effect analyzer against scripts with known answers."""

import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ANALYZER = os.path.join(ROOT, "src", "notebook-analysis", "r-effects.R")

RSCRIPT = "Rscript"

# R is not installed everywhere, and a contributor without it should not get a
# stack trace from subprocess. The skip is announced rather than silent: a
# green run that quietly tested nothing is worse than a loud one.
if shutil.which(RSCRIPT) is None:
    print("SKIPPED: Rscript was not found on PATH, so the R effect analyser was not tested.")
    print("Install R to run these tests; CI installs it.")
    sys.exit(0)

CASES = [
    # (name, script, expected paths or None to skip the path assertion, extra)
    ("literal csv write", "write.csv(df, 'out/result.csv')\n", ["out/result.csv"], {}),
    ("literal csv read", "df <- read.csv('data/input.csv')\n", ["data/input.csv"], {}),
    ("ggsave", "ggsave('figures/plot.pdf')\n", ["figures/plot.pdf"], {}),
    ("saveRDS", "saveRDS(model, 'model.rds')\n", ["model.rds"], {}),
    ("readRDS", "model <- readRDS('model.rds')\n", ["model.rds"], {}),
    ("writeLines", "writeLines('hello', 'notes.txt')\n", ["notes.txt"], {}),
    ("file.path construction", "x <- file.path('a', 'b.npy')\n", None, {}),
    ("a loop variable is unknown, not guessed", "for (n in names) saveRDS(m, n)\n", [], {"unknownAtLeast": 1}),
    ("dir.create writes a directory", "dir.create('output')\n", ["output"], {}),
    ("a computed path is unknown", "saveRDS(m, paste0('m', i, '.rds'))\n", [], {"unknownAtLeast": 1}),
    ("a read nested in a call argument", "x <- nrow(read.csv('data/input.csv'))\n", ["data/input.csv"], {}),
    ("a string concatenated into the path is not resolved", "write.csv(df, 'out/' + name)\n", [], {"unknownAtLeast": 1}),
    ("a subprocess call is reported", "system('ls -l')\n", None, {"subprocesses": 1}),
    ("a dynamic call is reported", "eval(parse(text = 'x <- 1'))\n", None, {"dynamicCallsAtLeast": 1}),
]

failures = []
for name, script, expected_paths, extra in CASES:
    proc = subprocess.run(
        [RSCRIPT, ANALYZER],
        input=script,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if proc.returncode != 0:
        failures.append(f"{name}: Rscript exited {proc.returncode}\n  {proc.stderr[:300]}")
        continue
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError:
        failures.append(f"{name}: output is not JSON\n  stdout={proc.stdout[:200]}\n  stderr={proc.stderr[:200]}")
        continue
    if not result.get("ok"):
        failures.append(f"{name}: {result.get('error')}")
        continue

    if expected_paths is not None:
        # Reads and writes are reported separately; a case may expect either or
        # both, so the assertion is over the union rather than over one field.
        actual = sorted(item.get("path") for item in result.get("writes", []) + result.get("reads", []))
        if actual != sorted(expected_paths):
            failures.append(f"{name}\n    expected {sorted(expected_paths)}\n    actual   {actual}")

    if "unknownAtLeast" in extra and len(result.get("unknown", [])) < extra["unknownAtLeast"]:
        failures.append(f"{name}: expected at least {extra['unknownAtLeast']} unknown, got {len(result.get('unknown', []))}")

    if "dynamicCallsAtLeast" in extra:
        actual = len(result.get("dynamicCalls", []))
        if actual < extra["dynamicCallsAtLeast"]:
            failures.append(f"{name}: expected at least {extra['dynamicCallsAtLeast']} dynamic calls, got {actual}")

    # Count-only checks for the effect categories that carry no path.
    for key in ("networks", "subprocesses"):
        if key in extra:
            actual = len(result.get(key, []))
            if actual != extra[key]:
                failures.append(f"{name}: {key}\n    expected {extra[key]}\n    actual   {actual}")

passed = len(CASES) - len({f.split(":")[0] for f in failures})
print(f"{passed} passed, {len(failures)} failed")
for failure in failures:
    print("FAIL " + failure)
sys.exit(1 if failures else 0)