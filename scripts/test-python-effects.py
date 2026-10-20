"""Check the Python effect analyzer against scripts with known answers.

Run with: python src/notebook-analysis/python-effects.py
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ANALYZER = os.path.join(ROOT, "src", "notebook-analysis", "python-effects.py")

CASES = [
    (
        "literal write via open",
        "with open('out/result.csv', 'w') as f:\n    f.write('x')\n",
        {"writes": ["out/result.csv"], "reads": []},
    ),
    (
        "literal read via open",
        "with open('data/input.csv') as f:\n    rows = f.read()\n",
        {"writes": [], "reads": ["data/input.csv"]},
    ),
    (
        "pandas to_csv on a dataframe",
        "df.to_csv('summary.csv', index=False)\n",
        {"writes": ["summary.csv"], "reads": []},
    ),
    (
        "pandas read_csv",
        "df = pd.read_csv('cohort.csv')\n",
        {"writes": [], "reads": ["cohort.csv"]},
    ),
    (
        "numpy save",
        "np.save('array.npy', arr)\n",
        {"writes": ["array.npy"], "reads": []},
    ),
    (
        "numpy load",
        "arr = np.load('array.npy')\n",
        {"writes": [], "reads": ["array.npy"]},
    ),
    (
        "matplotlib savefig",
        "plt.savefig('figures/plot.pdf')\n",
        {"writes": ["figures/plot.pdf"], "reads": []},
    ),
    (
        "json dump",
        "with open('meta.json', 'w') as fh:\n    json.dump(d, fh)\n",
        {"writes": ["meta.json"], "reads": []},
    ),
    (
        "os.path.join literal",
        "np.save(os.path.join('a', 'b.npy'), arr)\n",
        {"writes": ["a/b.npy"], "reads": []},
    ),
    (
        "pathlib Path literal",
        "Path('sub/dir').mkdir(parents=True)\n",
        {"writes": ["sub/dir"], "reads": []},
    ),
    (
        "f-string with literal parts",
        "plt.savefig(f'fig_{1}.png')\n",
        {"writes": ["fig_1.png"], "reads": []},
    ),
    (
        "a computed path is unknown, not guessed",
        "for name in names:\n    np.save(name + '.npy', arr)\n",
        {"writes": [], "reads": [], "unknownAtLeast": 1},
    ),
    (
        "network access is reported",
        "requests.get('https://example.org/data.csv')\n",
        {"networks": 1},
    ),
    (
        "a method named write on a non-file receiver is not claimed as a file write",
        # `report.write(...)` is an object method, not a file handle. The analyzer
        # sees the call but must not invent a path for it.
        "report.write('status')\n",
        {"writes": []},
    ),
    (
        "append mode is a write",
        "with open('log.txt', 'a') as f:\n    f.write('x')\n",
        {"writes": ["log.txt"], "reads": []},
    ),
    (
        "binary mode is a read",
        "with open('data.bin', 'rb') as f:\n    blob = f.read()\n",
        {"writes": [], "reads": ["data.bin"]},
    ),
    (
        "a method call is matched by its final name",
        # `pd.to_csv` is the bare `to_csv` entry, not a receiver table. This is
        # the case the removed RECEIVER_* tables used to be claimed to cover.
        "pd.to_csv(df, 'via-module.csv')\n",
        {"writes": ["via-module.csv"], "reads": []},
    ),
    (
        "a method read is matched by its final name",
        "pd.read_csv('via-module-in.csv')\n",
        {"writes": [], "reads": ["via-module-in.csv"]},
    ),
    (
        "pathlib division composes a literal path",
        "Path('sub') / 'out.txt'\nwith open(Path('sub') / 'out.txt', 'w') as f:\n    f.write('x')\n",
        {"writes": ["sub/out.txt"], "reads": []},
    ),
    (
        "a subprocess call is reported",
        "import subprocess\nsubprocess.run(['ls', '-l'])\n",
        {"subprocesses": 1},
    ),
    (
        "os.system is reported",
        "import os\nos.system('rm -rf tmp')\n",
        {"subprocesses": 1},
    ),
    (
        "nested dynamic calls are each reported",
        # Both `exec` and `compile` are dynamic; reporting only the outer one
        # would understate how much of the script reading cannot recover.
        "exec(compile(src, 'f', 'exec'))\n",
        {"dynamicCalls": 2},
    ),
    (
        "a single eval is one dynamic call",
        "eval(expr)\n",
        {"dynamicCalls": 1},
    ),
    (
        "directory enumeration is a read",
        "for p in glob.glob('data/*.csv'):\n    print(p)\n",
        {"reads": ["data/*.csv"]},
    ),
    (
        "a syntax error is reported as a failure to analyze",
        "def broken(:\n    pass\n",
        {"expectError": True},
    ),
]

failures = []
for name, script, expected in CASES:
    proc = subprocess.run(
        [sys.executable, ANALYZER],
        input=script,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if proc.returncode != 0:
        failures.append(f"{name}: analyzer exited {proc.returncode}\n  {proc.stderr[:300]}")
        continue
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError:
        failures.append(f"{name}: output is not JSON\n  {proc.stdout[:300]}")
        continue
    if not result.get("ok"):
        # A script that will not parse must be reported as a failure to analyze,
        # never as a clean "this script touches no files".
        if expected.get("expectError"):
            if "syntax" not in str(result.get("error", "")).lower():
                failures.append(f"{name}: expected a syntax error, got {result.get('error')!r}")
            continue
        failures.append(f"{name}: analyzer reported {result.get('error')}")
        continue

    if expected.get("expectError"):
        failures.append(f"{name}: expected the analyzer to fail, but it reported a clean result")
        continue

    for key in ("writes", "reads"):
        if key not in expected:
            continue
        actual = sorted(item.get("path") for item in result.get(key, []))
        want = sorted(expected[key])
        if actual != want:
            failures.append(f"{name}: {key}\n    expected {want}\n    actual   {actual}")

    if "unknownAtLeast" in expected and len(result.get("unknown", [])) < expected["unknownAtLeast"]:
        failures.append(f"{name}: expected at least {expected['unknownAtLeast']} unknown, got {len(result.get('unknown', []))}")

    # Count-only checks for the effect categories that carry no path.
    for key in ("networks", "subprocesses", "dynamicCalls"):
        if key in expected:
            actual = len(result.get(key, []))
            if actual != expected[key]:
                failures.append(f"{name}: {key}\n    expected {expected[key]}\n    actual   {actual}")

passed = len(CASES) - len({f.split(":")[0] for f in failures})
print(f"{passed} passed, {len(failures)} failed")
for failure in failures:
    print("FAIL " + failure)
sys.exit(1 if failures else 0)