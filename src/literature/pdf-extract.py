"""
Extract text and section structure from a PDF.

Runs inside the user's own interpreter, so it uses whichever of the installed
PDF libraries is available rather than asking for one. Preference order is by
what each library is actually good at: PyMuPDF is fastest and keeps page
boundaries exactly, pypdf is the most widely installed, pdfminer.six handles the
awkward cases, and pdfplumber is the fallback when all three decline.

Output is one JSON object on stdout. Anything that cannot be read is reported as
a reason rather than as empty text, so a caller can tell "this PDF has no text
layer" from "the extraction produced nothing".

Adapted from the upstream pdf contracts (Apache-2.0): the idea that extraction
records its own provenance and that an unreadable document is a stated outcome
rather than a silently empty result.
"""

import json
import os
import re
import sys

# stdout carries the answer and nothing else.
#
# PyMuPDF prints a deprecation warning when imported under its old `fitz` name,
# and that warning goes to stdout: left alone it prefixed the JSON, so the caller
# failed to parse a perfectly good result. Any library imported below inherits
# the redirect.
_answer = sys.stdout
sys.stdout = sys.stderr

# Section headings, most specific first.
#
# Ordered by specificity because "Methods" must win over the generic capitalised
# line rule when both match, or every heading in a paper reads as "Unknown".
NUMBERED = re.compile(
    r"^\s*(?:"
    r"(?:\d+|[IVXLC]{1,5})[.)]?\s+"          # 1. 2) IV. 
    r"|(?:chapter|section|part)\s+[0-9IVXLC]+[.:]?\s*"
    r")",
    re.IGNORECASE,
)
NAMED = re.compile(
    r"^\s*(abstract|introduction|background|summary|conclusions?|"
    r"discussion|results?|methods?|materials and methods|"
    r"experimental( section)?|methodology|"
    r"data and (methods|availability)|"
    r"code availability|"
    r"data availability|"
    r"ethic(?:s|al)(?: statement)?|"
    r"conflicts? of interest|"
    r"competing interests?|"
    r"funding|acknowledg(?:e)?ments?|"
    r"supplementary|references|"
    r"author contributions?|"
    r"declarations?|"
    r"institutional review board|consent|"
    r"limitations?|"
    r"conclusion[s]? and[s]? future|"
    r"specific hypotheses|"
    r"significance statement)"
    # A lookahead, not a consumed character: a heading is usually the whole
    # line, so requiring a trailing space or colon meant "Introduction" matched
    # nothing and every section went undetected.
    r"(?=\s|:|\.|$)",
    re.IGNORECASE,
)
CAPITALISED = re.compile(r"^[A-Z][A-Z0-9 ,'&()\-]{3,60}$")

# A heading line is short; body text is not.
MAX_HEADING_CHARS = 72


def is_heading(line):
    """True when a line reads as a section heading rather than body text."""
    text = line.strip()
    if not text or len(text) > MAX_HEADING_CHARS:
        return False
    if NAMED.match(text) or NUMBERED.match(text):
        return True
    # Body text usually ends in punctuation and runs longer than a heading; a
    # short all-caps line that ends in a full stop is still a heading, so this
    # check only gates the generic rule.
    if text.endswith((".", ",", ";", ":")):
        return False
    return bool(CAPITALISED.match(text))


def split_sections(pages):
    """
    Records where each section heading starts, in page order.

    Only the first heading on a page is taken. A page usually carries one section
    start; when it carries two, the second is almost always a cross-reference or
    a figure label rather than a boundary in the document's own structure.
    """
    sections = []
    for page_number, page_text in enumerate(pages, start=1):
        for line in page_text.splitlines():
            if is_heading(line):
                sections.append({"title": line.strip(), "page": page_number})
                break
    return sections


def read_with_pymupdf(path):
    # Imported by its current name; `fitz` is the deprecated alias and warns on
    # use. The alias is kept as a fallback for installations that predate the
    # rename, not as the first choice.
    try:
        import pymupdf as module
    except ImportError:
        import fitz as module

    with module.open(path) as document:
        if document.needs_pass:
            raise RuntimeError("the document is password protected")
        pages = [page.get_text() for page in document]
        count = document.page_count
    return pages, count, "pymupdf"


def read_with_pypdf(path):
    from pypdf import PdfReader

    reader = PdfReader(path)
    if reader.is_encrypted:
        raise RuntimeError("the document is password protected")
    pages = [(page.extract_text() or "") for page in reader.pages]
    return pages, len(reader.pages), "pypdf"


def read_with_pdfminer(path):
    from pdfminer.high_level import extract_text
    from pdfminer.pdfpage import PDFPage

    with open(path, "rb") as handle:
        count = len(list(PDFPage.get_pages(handle)))
    text = extract_text(path) or ""
    pages = text.split("\f")
    return pages, count, "pdfminer"


def read_with_pdfplumber(path):
    import pdfplumber

    with pdfplumber.open(path) as pdf:
        pages = [(page.extract_text() or "") for page in pdf.pages]
        count = len(pdf.pages)
    return pages, count, "pdfplumber"


READERS = (
    ("pymupdf", read_with_pymupdf),
    ("pypdf", read_with_pypdf),
    ("pdfminer", read_with_pdfminer),
    ("pdfplumber", read_with_pdfplumber),
)


def has_pdf_signature(path):
    """
    Whether the file actually starts with a PDF header.

    Checked before any library is asked, because they disagree about what to do
    with something that is not a PDF: PyMuPDF opened a plain text file and
    reported its contents as a one-page document, which would have put a text
    file's bytes into a paper's full text.
    """
    try:
        with open(path, "rb") as handle:
            return handle.read(5) == b"%PDF-"
    except OSError:
        return False


def emit(payload):
    """Writes the answer to the real stdout, whatever the libraries did to it."""
    json.dump(payload, _answer)
    _answer.flush()


def main():
    argv = sys.argv[1:]
    # `--pages` returns the per-page text as well as the structure. The caller
    # stores one file per page so a section's page offset refers to the same
    # boundaries the text was split on.
    want_pages = "--pages" in argv
    if want_pages:
        argv = [a for a in argv if a != "--pages"]

    if not argv:
        emit({"ok": False, "error": "a PDF path is required"})
        return

    path = argv[0]
    if not os.path.isfile(path):
        emit({"ok": False, "error": f"no such file: {path}"})
        return

    if not has_pdf_signature(path):
        emit({"ok": False, "error": "this file does not begin with %PDF- and is not a PDF"})
        return

    attempts = []

    for name, reader in READERS:
        try:
            pages, count, extractor = reader(path)
        except ImportError:
            attempts.append(f"{name}: not installed")
            continue
        except Exception as error:  # noqa: BLE001 - a failing library is a data point
            attempts.append(f"{name}: {type(error).__name__}: {error}")
            continue

        text = "\n\n".join(pages)
        if not text.strip():
            # A clean extraction of nothing means the PDF carries no text
            # layer — a scan, most likely. Reported as such, because an empty
            # string here would be indistinguishable from a read failure.
            attempts.append(f"{name}: extracted no text (no text layer, or the file is a scan)")
            continue

        payload = {
            "ok": True,
            "extractor": extractor,
            "pages": count,
            "characters": len(text),
            "sections": split_sections(pages),
            "attempts": attempts,
        }
        if want_pages:
            payload["pagesText"] = pages
        emit(payload)
        return

    emit(
        {
            "ok": False,
            "error": "no installed PDF library could read text from this document",
            "attempts": attempts,
            "note": "A PDF with no text layer (a scan) needs OCR, which no installed library here performs.",
        }
    )


if __name__ == "__main__":
    main()