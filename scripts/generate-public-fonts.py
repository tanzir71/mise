"""Regenerate committed public-page WOFF2 fonts; not required for Node builds.

Run after pnpm install, with Python fonttools[woff]==4.63.0 installed.
The public page has a complete 60,000-byte offline budget. Subsetting retains
all Bengali cmap entries and shaping; UPM reduction rounds outline geometry.
Owner/landing fonts remain unchanged. See assets/public-fonts/provenance.json.
"""
import hashlib
import io
import json
from pathlib import Path

import fontTools
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.ttLib.scaleUpem import scale_upem
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "packages/ui/assets/public-fonts"
HIND = ROOT / "packages/ui/node_modules/@fontsource/hind-siliguri/files"
ENGLISH = set(range(0x20, 0x7F)) | {0xA0, 0xA3, 0xB7, 0xD7, 0x2013,
    0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def generate(source, characters, upm=None, weights=None):
    font = TTFont(source, recalcTimestamp=False)
    if weights:
        font = instantiateVariableFont(font, {"wght": weights}, inplace=True)
    options = subset.Options()
    options.hinting = False
    options.layout_features = ["*"]
    sub = subset.Subsetter(options=options)
    sub.populate(unicodes=characters)
    sub.subset(font)
    assert set(font.getBestCmap()) == characters, "Requested characters were lost"
    if upm:
        scale_upem(font, upm)
    font.flavor = "woff2"
    result = io.BytesIO()
    font.save(result)
    return result.getvalue()


geist = OUTPUT / "geist-source.woff2"
hind = HIND / "hind-siliguri-bengali-400-normal.woff"
taka = HIND / "hind-siliguri-bengali-600-normal.woff"
assert digest(geist.read_bytes()) == "19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1"
assert digest(hind.read_bytes()) == "7ffe9456e2957755ef86a46375cadf2f83a4dd3caea3959873e5e61ca4466265"
bengali = set(TTFont(hind).getBestCmap())
assert len(bengali) == 99
outputs = {
    "geist-public.woff2": generate(geist, ENGLISH, 128, (400, 600)),
    "hind-public.woff2": generate(hind, bengali, 64),
    "taka-public.woff2": generate(taka, {0x09F3}),
}
for name, data in outputs.items():
    (OUTPUT / name).write_bytes(data)
provenance = {
    "generator": "scripts/generate-public-fonts.py", "fontTools": fontTools.__version__,
    "geometry": "UPM reduction rounds outlines and variable deltas; these are modified fonts, not byte-identical exports.",
    "geist": {"package": "@fontsource-variable/geist", "version": "5.3.0",
        "sourceSha256": digest(geist.read_bytes()), "characters": len(ENGLISH),
        "weights": [400, 600], "upm": 128, "baseCoordinateRoundingBoundAt24px": 0.09375,
        "basePlusVariationRoundingBoundAt24px": 0.1875},
    "hind": {"package": "@fontsource/hind-siliguri", "version": "5.3.0",
        "sourceSha256": digest(hind.read_bytes()), "characters": len(bengali),
        "upm": 64, "baseCoordinateRoundingBoundAt16px": 0.125},
    "taka": {"sourceSha256": digest(taka.read_bytes()), "characters": ["U+09F3"], "weight": 600, "upm": 1000},
    "outputs": {name: {"bytes": len(data), "sha256": digest(data)} for name, data in outputs.items()},
}
(OUTPUT / "provenance.json").write_bytes((json.dumps(provenance, indent=2) + "\n").encode("utf-8"))
print(json.dumps(provenance["outputs"], indent=2))
