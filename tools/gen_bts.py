#!/usr/bin/env python3
"""Build the BTS layer from the cell towers mapped in OpenStreetMap.

Asks the public Overpass API for every tower in Indonesia that OpenStreetMap
marks as serving mobile phones (communication:mobile_phone=yes, or a mobile
operator in its operator tag) and keeps two things per tower: its position and
its operator(s), as brand names. Every other tag stays behind: some carry phone
numbers. An operator tag that isn't a known operator or tower company is kept
only as "lain", never as its text.

Volunteers map these towers, so the layer is real but incomplete and uneven,
and it says nothing about coverage or about any phone.

Writes data/bts.json (the towers, which the page loads when the BTS layer is
switched on) and js/bts-data.js (source, date and counts, read at start).

Data © OpenStreetMap contributors, ODbL: https://www.openstreetmap.org/copyright

Usage:
    python3 tools/gen_bts.py                          # fetch from Overpass (~1-2 min)
    python3 tools/gen_bts.py --from-file overpass.json
"""
import argparse
import datetime
import json
import pathlib
import re
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DATA = ROOT / "data" / "bts.json"
OUT_META = ROOT / "js" / "bts-data.js"
OVERPASS = "https://overpass-api.de/api/interpreter"
UA = "SENTINEL-console/1.0 (+https://iyangdev.github.io/sentinel-console/)"
QUERY = """[out:json][timeout:200];
area["ISO3166-1"="ID"]["admin_level"="2"]->.id;
(nwr["tower:type"="communication"](area.id);
 nwr["communication:mobile_phone"="yes"](area.id););
out tags center;"""

# Mobile brands, then tower companies; an operator tag may name several ("telkomsel;xl").
OPERATORS = [
    (r"telkomsel", "Telkomsel"),
    (r"indosat|ooredoo|\bim3\b|\bisat\b", "Indosat"),
    (r"xl ?smart", "XLSmart"),
    (r"\bxl\b|axiata|\baxis\b|xl ?cell?uler", "XL"),
    (r"smart ?fren", "Smartfren"),
    (r"\btri\b|\bthree\b|hutchison|\bhcpt\b|\bh3i\b|^3$", "Tri"),
]
TOWER_COMPANIES = [
    (r"protelindo", "Protelindo"),
    (r"tower bersama|\btbig\b", "Tower Bersama"),
    (r"mitratel|dayamitra", "Mitratel"),
    (r"\bstp\b|solusi tunas", "STP"),
    (r"bali towerindo", "Bali Towerindo"),
    (r"centratama", "Centratama"),
]


def operators_of(tag):
    """(mobile brands, everything to show) from a free-text operator tag."""
    found, mobile = [], []
    for part in re.split(r"[;,/]| dan | and ", tag.lower()):
        part = part.strip()
        if not part:
            continue
        names = [n for pat, n in OPERATORS if re.search(pat, part)]
        mobile += names
        names += [n for pat, n in TOWER_COMPANIES if re.search(pat, part)]
        found += names or ["lain"]
    dedup = lambda xs: list(dict.fromkeys(xs))
    return dedup(mobile), dedup(found)


def fetch():
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    req = urllib.request.Request(OVERPASS, data=body, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=240) as r:
        return json.load(r)


def build(osm):
    towers = {}   # ~11 m grid cell -> [lat, lng, operators]; a tower mapped as node and way counts once
    for el in osm.get("elements", []):
        tags = el.get("tags", {})
        lat = el.get("lat", el.get("center", {}).get("lat"))
        lng = el.get("lon", el.get("center", {}).get("lon"))
        if lat is None or lng is None or tags.get("communication:mobile_phone") == "no":
            continue
        mobile, shown = operators_of(tags.get("operator", ""))
        if tags.get("communication:mobile_phone") != "yes" and not mobile:
            continue   # a radio/TV mast, or nothing says it's a phone tower
        key = (round(lat, 4), round(lng, 4))
        if key in towers:
            towers[key][2] = list(dict.fromkeys(towers[key][2] + shown))
        else:
            towers[key] = [round(lat, 5), round(lng, 5), shown]
    ops = [""]   # index 0: no operator recorded
    rows = []
    for lat, lng, shown in sorted(towers.values()):
        label = " · ".join(n for n in shown if n != "lain") or ("lain" if shown else "")
        if label not in ops:
            ops.append(label)
        rows.append([lat, lng, ops.index(label)])
    return ops, rows


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from-file", help="an Overpass JSON reply saved earlier")
    args = ap.parse_args()
    osm = json.loads(pathlib.Path(args.from_file).read_text(encoding="utf-8")) if args.from_file else fetch()
    ops, rows = build(osm)
    pulled = (osm.get("osm3s", {}).get("timestamp_osm_base") or datetime.datetime.now(datetime.timezone.utc).isoformat())[:10]
    with_op = sum(1 for r in rows if ops[r[2]] not in ("", "lain"))

    OUT_DATA.parent.mkdir(parents=True, exist_ok=True)
    OUT_DATA.write_text(json.dumps({"source": "OpenStreetMap", "license": "ODbL", "pulled": pulled,
                                    "ops": ops, "towers": rows}, separators=(",", ":")), encoding="utf-8")
    meta = {"source": "OpenStreetMap", "url": "https://www.openstreetmap.org/copyright", "license": "ODbL",
            "pulled": pulled, "count": len(rows), "withOperator": with_op, "file": "data/bts.json"}
    OUT_META.write_text(
        "/* AUTO-GENERATED by tools/gen_bts.py — do not edit by hand.\n"
        " *\n"
        " * Cell towers mapped in OpenStreetMap (© OpenStreetMap contributors, ODbL):\n"
        " * position and operator only. The towers are in data/bts.json, loaded when\n"
        " * the BTS layer is switched on. Not linked to any phone or device.\n"
        " */\n"
        f"window.BTS_SOURCE = {json.dumps(meta, ensure_ascii=False)};\n", encoding="utf-8")
    print(f"{len(rows)} towers ({with_op} with a named operator), OSM data of {pulled} -> {OUT_DATA.relative_to(ROOT)}, {OUT_META.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
