"""Check the PDF extractor against a document with a known section structure."""

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXTRACT = os.path.join(ROOT, "src", "literature", "pdf-extract.py")

PROBE = os.path.join(tempfile.gettempdir(), "pdf_extract_probe")
os.makedirs(PROBE, exist_ok=True)

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages

GOOD = os.path.join(PROBE, "paper.pdf")
# A paper-shaped document: the headings are drawn as titles, the body as
# wrapped paragraph text, so a reader has a real answer to check against.
with PdfPages(GOOD) as pdf:
    for name, body in [
        ("Introduction", "Short-chain fatty acids are produced by the colonic microbiota. "
                         "Metformin shifts that production in humans, which is the effect studied here."),
        ("Methods", "Participants were randomised 1:1 to metformin or placebo for twelve weeks. "
                    "Stool samples were collected at baseline and at week twelve."),
        ("Results", "Butyrate rose by 1.40 mmol/g on metformin and fell by 0.04 on placebo."),
        ("Data availability", "The extracted data are available from the corresponding author on request."),
    ]:
        fig = plt.figure(figsize=(8.5, 11))
        fig.text(0.1, 0.95, name, fontsize=16, weight="bold")
        fig.text(0.1, 0.88, body, fontsize=11, wrap=True)
        pdf.savefig(fig)
        plt.close(fig)

# A file with no PDF signature at all.
BOGUS = os.path.join(PROBE, "not-a-pdf.txt")
with open(BOGUS, "w", encoding="utf-8") as fh:
    fh.write("this is plain text pretending to be a PDF\n")

failures = []


def run(path):
    proc = subprocess.run(
        [sys.executable, EXTRACT, path], capture_output=True, text=True, encoding="utf-8"
    )
    if proc.returncode != 0:
        return None, f"exited {proc.returncode}: {proc.stderr[:200]}"
    try:
        return json.loads(proc.stdout), None
    except json.JSONDecodeError:
        return None, f"not JSON: {proc.stdout[:200]}"


# --- a readable paper --------------------------------------------------------

result, err = run(GOOD)
if err:
    failures.append(f"paper.pdf: {err}")
else:
    if not result.get("ok"):
        failures.append(f"paper.pdf reported failure: {result.get('error')} attempts={result.get('attempts')}")
    else:
        if result["pages"] != 4:
            failures.append(f"paper.pdf: expected 4 pages, got {result['pages']}")
        if result["characters"] < 200:
            failures.append(f"paper.pdf: only {result['characters']} characters extracted")
        titles = [s["title"].lower() for s in result["sections"]]
        for wanted in ["introduction", "methods", "results"]:
            if not any(wanted in t for t in titles):
                failures.append(f"paper.pdf: section '{wanted}' not found in {titles}")
        if result["extractor"] not in ("pymupdf", "pypdf", "pdfminer", "pdfplumber"):
            failures.append(f"paper.pdf: unknown extractor {result['extractor']!r}")

# --- a file that is not a PDF -------------------------------------------------

result, err = run(BOGUS)
if err:
    failures.append(f"not-a-pdf: {err}")
elif result.get("ok"):
    failures.append("not-a-pdf: reported success on a plain text file")

# --- a missing file -----------------------------------------------------------

proc = subprocess.run(
    [sys.executable, EXTRACT, os.path.join(PROBE, "absent.pdf")],
    capture_output=True,
    text=True,
    encoding="utf-8",
)
try:
    parsed = json.loads(proc.stdout)
    if parsed.get("ok"):
        failures.append("absent.pdf: reported success on a missing file")
except json.JSONDecodeError:
    failures.append(f"absent.pdf: no JSON answer: {proc.stdout[:200]}")

passed = 3 - len({f.split(":")[0] for f in failures})
print(f"{passed} passed, {len(failures)} failed")
for failure in failures:
    print("FAIL " + failure)
sys.exit(1 if failures else 0)