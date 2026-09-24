#!/usr/bin/env python3
"""Writes a <script> tag for every sources/*.js into index.html (between core.js and app.js)."""
import pathlib, re
here = pathlib.Path(__file__).resolve().parent
tags = "\n".join(f'<script src="sources/{p.name}"></script>' for p in sorted((here / "sources").glob("*.js")))
page = here / "index.html"
html = page.read_text()
html = re.sub(r'(<script src="core.js"></script>\n)(?:<!--SOURCES-->|(?:<script src="sources/[^"]+"></script>\n?)+)\n?',
              lambda m: m.group(1) + tags + "\n", html)
page.write_text(html)
print(tags)
