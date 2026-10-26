#!/usr/bin/env python3
"""Regenerate js/cctv-data.js from the public BPJT toll-road CCTV registry.

BPJT (Badan Pengatur Jalan Tol, Kementerian PU) publishes every toll-road
camera — operator, road, KM marker, coordinates and HLS stream — on
https://bpjt.pu.go.id/cctv/ as an embedded `allStreams` JSON object.
Stream IDs rotate over time and the registry can lag behind the operators:
re-run this when cameras stop resolving, and add to STREAM_FIXES when an
operator has moved a stream the registry still lists.

Usage:
    python3 tools/update_cctv.py                      # fetch live registry
    python3 tools/update_cctv.py --from-file page.html
    python3 tools/update_cctv.py --bbox -6.40,106.68,-6.08,107.02
"""
import argparse
import datetime
import json
import pathlib
import sys
import urllib.request

REGISTRY_URL = "https://bpjt.pu.go.id/cctv/"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"

# Whole of Indonesia (south, west, north, east) — the BPJT registry covers every
# national toll road, so by default we keep them all and tag each with a city.
DEFAULT_BBOX = (-11.0, 94.0, 6.5, 141.5)

# Metro bounding boxes (south, west, north, east) for tagging a camera with its
# city. Ordered most-specific first; the first box that contains the point wins.
CITIES = [
    ("Jakarta",      -6.37, 106.68, -6.08, 106.99),
    ("Tangerang",    -6.35, 106.50, -6.10, 106.70),
    ("Depok",        -6.46, 106.74, -6.37, 106.90),
    ("Bekasi",       -6.38, 106.96, -6.10, 107.10),
    ("Bogor",        -6.70, 106.68, -6.46, 106.92),
    ("Bandung",      -7.08, 107.48, -6.78, 107.80),
    ("Cirebon",      -6.82, 108.46, -6.63, 108.62),
    ("Semarang",     -7.12, 110.30, -6.90, 110.54),
    ("Surakarta",    -7.63, 110.74, -7.48, 110.92),
    ("Yogyakarta",   -7.92, 110.28, -7.68, 110.48),
    ("Surabaya",     -7.42, 112.58, -7.16, 112.88),
    ("Sidoarjo",     -7.52, 112.62, -7.40, 112.82),
    ("Malang",       -8.06, 112.54, -7.90, 112.72),
    ("Medan",         3.48,  98.58,  3.74,  98.82),
    ("Palembang",    -3.06, 104.66, -2.86, 104.84),
    ("Makassar",     -5.24, 119.36, -5.04, 119.54),
    ("Pekanbaru",     0.42, 101.36,  0.62, 101.54),
    ("Balikpapan",   -1.32, 116.78, -1.08, 116.98),
    ("Denpasar",     -8.78, 115.13, -8.58, 115.30),
]

# Coarse island boxes for cameras that fall outside any metro (south, west, north, east).
REGIONS = [
    ("Jawa",       -8.9, 105.0, -5.8, 114.6),
    ("Sumatra",    -6.0,  95.0,  6.2, 106.6),
    ("Bali-Nusra", -11.0, 114.6, -8.0, 125.0),
    ("Kalimantan", -4.3, 108.5,  4.5, 119.2),
    ("Sulawesi",   -6.1, 118.5,  2.0, 125.6),
]


def place_of(lat, lng):
    for name, s, w, n, e in CITIES:
        if s <= lat <= n and w <= lng <= e:
            return name
    for name, s, w, n, e in REGIONS:
        if s <= lat <= n and w <= lng <= e:
            return name
    return "Lainnya"

# Operator codes as used in the registry. Only codes that could be tied to a
# stream host + road with confidence get a readable name; others show as-is.
OPERATORS = {
    "jm": "Jasa Marga",
    "hk": "Hutama Karya",
    "cmnp": "Citra Marga Nusaphala Persada",
    "jtd": "Jakarta Tollroad Development",
    "jlb": "Jakarta Lingkar Baratsatu",
    "cct": "Cimanggis Cibitung Tollways",
    "ctp": "Cibitung Tanjung Priok Port Tollways",
    "wtr": "Waskita Toll Road",
}

# Busy, varied views confirmed live and CORS-open on 2026-10-26 (verified down to
# the segment, across 4 stream hosts). These are the quick-pick presets in the
# feed view and are listed first in the camera panel. Pinned by exact URL so a
# registry re-pull (which renumbers row ids) can't point them at the wrong camera.
FEATURED_URLS = [
    "https://pub2.hk-opt.com/LiveApp/streams/786252567929925275184104.m3u8",       # JORR S · GT Pasar Rebo
    "https://cctv.citramarga.com/hls/cam3-interchange-pluit/stream.m3u8",           # Interchange Pluit KM 24+800
    "https://pub2.hk-opt.com/LiveApp/streams/241370079371388169899174.m3u8",       # Akses Tj Priok KM 61+400 B
    "https://pub2.hk-opt.com/LiveApp/streams/309430648597231213602103.m3u8",       # JORR S KM 30+300
    "https://pub2.hk-opt.com/LiveApp/streams/529068807902101265499497.m3u8",       # JORR S KM 24+450
    "https://cctv.citramarga.com/hls/cam1-interchange-cawang/stream.m3u8",          # Interchange Cawang KM 00+400
    "https://cctv.ctptollways.com:2254/streams/cam_38/index.m3u8",                  # Cibitung-Cilincing MR STA 27
    "https://streaming-cct.co.id/LiveApp/streams/395563568012170999809057.m3u8",   # Cimanggis-Cibitung · GT Jatikarya 1
    # Other cities / islands (reliable hosts — Jasa Marga's jmlive host is often down,
    # so Bandung/Semarang stay clickable markers but aren't pinned as presets).
    "https://cctv.cms.co.id/stream1/stream.m3u8",                                   # Surabaya · Waru–Bandara Juanda KM 0+200
    "https://pub2.hk-opt.com/LiveApp/streams/WC7vTv1owjTr1732879982313.m3u8",       # Sumatra · Bayung Lencir–Jambi
    "https://pub.hk-opt.com/LiveApp/streams/lmmPRLvM75XM1670838964818.m3u8",        # Sumatra · Pekanbaru–Dumai
]

# Streams an operator has moved while the registry still lists the old URL.
# BSD (Tol Pondok Aren–Serpong) recreated its Restreamer streams: all 23 BSD URLs
# in the registry (snapshot 2026-05-11) return 404. Each fix maps a registry URL
# to the stream BSD's own player page (https://stream.bsdtol.com/) serves under
# the same KM name; every new stream was checked live, down to the segment, from
# a browser on 2026-10-26. lat/lng are BSD's own, from the map on its Live CCTV
# page (https://bsdtol.com/live-cctv), where that differs from the registry by
# more than 10 m. Keyed by the registry URL, so a fix stops applying as soon as
# BPJT publishes a new URL for that camera. The other 11 BSD cameras in the
# registry no longer appear on BSD's player page, so they keep their dead URLs.
BSD = "https://stream.bsdtol.com/memfs/"
STREAM_FIXES = {
    BSD + "f6541ad9-15d2-45a5-88c6-ec625dfb56c6.m3u8": {"hls": BSD + "09610e5b-ed8a-4065-86c2-fd09916c4fcc.m3u8", "lat": -6.289263, "lng": 106.726073},  # Exit Pondok Aren Barat 1 ("PAB 1"), moved 86 m
    BSD + "3f2b1849-6791-4643-9298-6bb50b5e9bf2.m3u8": {"hls": BSD + "4e895ec1-073c-48f0-b274-75f535903358.m3u8"},  # km 05+500
    BSD + "7a2d5b4a-a408-4de6-888b-6f83848fa9bf.m3u8": {"hls": BSD + "e1416c04-477f-48a7-bfb3-430e6cf8331e.m3u8", "lat": -6.289644, "lng": 106.726431},  # KM 06+200, moved 19 m
    BSD + "f88035ff-8d15-48f6-b338-742c44f55245.m3u8": {"hls": BSD + "908c8b07-39b7-4420-ba29-1c62c0454819.m3u8", "lat": -6.290563, "lng": 106.723117},  # km 06+600, moved 366 m
    BSD + "74220d9a-a9da-4c18-b628-4b7c41727f1e.m3u8": {"hls": BSD + "37e72725-96a3-4f4a-b00b-22705e48c333.m3u8"},  # KM 07+200
    BSD + "4f166be4-4e6c-46de-9fd0-0431503493e3.m3u8": {"hls": BSD + "293cdf1a-bc5f-4ce3-aca1-880385dcb5ec.m3u8", "lat": -6.294335, "lng": 106.715111},  # KM 07+600, moved 73 m
    BSD + "73cc6e50-e75e-46d3-b51d-654eb992fa08.m3u8": {"hls": BSD + "1ebecbca-354e-4d1b-b8aa-9d23b437fbc5.m3u8"},  # km 08+700
    BSD + "31a155a0-dbfe-4c69-a1ee-1c4e66eee56b.m3u8": {"hls": BSD + "fae1d8ab-1323-4293-a46e-ab224d6775c3.m3u8"},  # KM 09+200
    BSD + "45622a12-c356-455a-85ef-34b3e6080564.m3u8": {"hls": BSD + "5dc62447-d329-433d-8e00-d900a0e32eb4.m3u8"},  # km 09+700
    # BSD's map still links the old 10+000 stream; its player page has the new one under "KM 10+000"
    BSD + "84bff122-de3c-499f-8b0b-5e549b856b89.m3u8": {"hls": BSD + "2ab5f200-eea8-4778-8458-d89011612e5d.m3u8"},  # KM 10+000
    BSD + "7f0767d4-8500-4e51-880a-99b48a20bfb8.m3u8": {"hls": BSD + "f51cf0cc-94f7-492a-8562-9f7ded928fe9.m3u8"},  # KM 11+000
    BSD + "885d3159-dc20-41c2-8dcf-564592079f02.m3u8": {"hls": BSD + "bbeac803-c29f-402f-97bb-25f007e384f1.m3u8"},  # KM 12+600
}

OUT = pathlib.Path(__file__).resolve().parent.parent / "js" / "cctv-data.js"


def fetch_registry():
    req = urllib.request.Request(REGISTRY_URL, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def extract_streams(page):
    marker = "const allStreams ="
    i = page.find(marker)
    if i < 0:
        sys.exit("error: `allStreams` not found — the registry page layout changed")
    data, _ = json.JSONDecoder().raw_decode(page, page.index("{", i))
    for group in data.values():
        yield from group


def to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def build(records, bbox):
    south, west, north, east = bbox
    by_url, snapshot, fixed = {}, "", set()
    for r in records:
        # `protocol` describes the embed player, not `streamhls`: cameras tagged
        # "embedded"/"http" still carry a working HLS URL, so test the URL itself.
        hls = (r.get("streamhls") or "").strip()
        if not hls.startswith(("https://", "http://")) or ".m3u8" not in hls:
            continue
        lat, lng = to_float(r.get("lat")), to_float(r.get("lon"))
        fix = STREAM_FIXES.get(hls)
        if fix:
            hls = fix["hls"]
            lat, lng = fix.get("lat", lat), fix.get("lng", lng)
            fixed.add(hls)
        if lat is None or lng is None or not (south <= lat <= north and west <= lng <= east):
            continue
        snapshot = max(snapshot, (r.get("tgl_tarik") or "")[:10])
        # The registry lists one camera under several segments; keep one marker per stream.
        if hls in by_url:
            continue
        op = (r.get("bujt") or "").strip()
        km = (r.get("nama_km") or "").strip()
        segment = (r.get("nama_segment") or "").strip()
        road = (r.get("nama_ruas") or "").strip()
        by_url[hls] = {
            # `unique_id` is the stable camera key; the row `id` changes every registry pull.
            "id": str(r.get("unique_id") or r.get("id")),
            "name": km or segment or road,
            "road": road,
            "segment": segment,
            "op": op,
            "opName": OPERATORS.get(op, op.upper()),
            "city": place_of(lat, lng),
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            "hls": hls,
            "active": str(r.get("status")).lower() in ("1", "online"),
        }
    cams = sorted(by_url.values(), key=lambda c: (c["city"], c["road"], c["name"]))
    rank = {url: i for i, url in enumerate(FEATURED_URLS)}
    for c in cams:
        if c["hls"] in rank:
            c["featured"] = rank[c["hls"]]
    return cams, snapshot, len(fixed & {c["hls"] for c in cams})


def write(cams, snapshot, bbox, fixed):
    meta = {
        "name": "BPJT — Badan Pengatur Jalan Tol, Kementerian PU",
        "url": REGISTRY_URL,
        "pulled": datetime.date.today().isoformat(),
        "snapshot": snapshot,
        "bbox": bbox,
        "count": len(cams),
        "fixed": fixed,   # stream URLs corrected from operator sites (STREAM_FIXES)
    }
    rows = ",\n".join("  " + json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in cams)
    OUT.write_text(
        "/* AUTO-GENERATED by tools/update_cctv.py — do not edit by hand.\n"
        " *\n"
        f" * Source:   {meta['name']}\n"
        f" *           {meta['url']}\n"
        f" * Pulled:   {meta['pulled']} (registry snapshot {snapshot or 'unknown'})\n"
        f" * Coverage: {len(cams)} public toll-road cameras with HLS inside bbox {list(bbox)}\n"
        f" * Fixes:    {fixed} stream URLs corrected from operator sites (see STREAM_FIXES)\n"
        " *\n"
        " * Public traffic cameras published by the toll regulator for public viewing.\n"
        " * Respect each operator's terms; don't poll them aggressively.\n"
        " */\n"
        f"window.CCTV_SOURCE = {json.dumps(meta, ensure_ascii=False)};\n\n"
        f"window.CCTV_CAMERAS = [\n{rows}\n];\n",
        encoding="utf-8",
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from-file", help="parse a saved copy of the registry page instead of fetching it")
    ap.add_argument("--bbox", help="south,west,north,east (default: Jakarta metro)")
    args = ap.parse_args()

    bbox = tuple(float(x) for x in args.bbox.split(",")) if args.bbox else DEFAULT_BBOX
    if len(bbox) != 4:
        sys.exit("error: --bbox needs 4 numbers: south,west,north,east")
    page = pathlib.Path(args.from_file).read_text(encoding="utf-8", errors="replace") if args.from_file else fetch_registry()

    cams, snapshot, fixed = build(extract_streams(page), bbox)
    write(cams, snapshot, bbox, fixed)

    import collections
    cities = collections.Counter(c["city"] for c in cams)
    print(f"wrote {OUT.relative_to(OUT.parent.parent)}: {len(cams)} cameras "
          f"({sum(c['active'] for c in cams)} registry-active, {sum('featured' in c for c in cams)} featured, "
          f"{fixed} stream URLs fixed) across {len(cities)} places")
    for place, n in cities.most_common():
        print(f"  {n:4d}  {place}")


if __name__ == "__main__":
    main()
