#!/usr/bin/env python3
"""Collect headlines from public RSS feeds a browser page isn't allowed to read.

The Berita tab reads ANTARA, CNN Indonesia and iNews straight from the page:
their feeds send Access-Control-Allow-Origin: *. Detik, Tempo, Liputan6 and the
rest don't, so a browser can't fetch them from another site. This script does
it server side (a scheduled GitHub Actions job, .github/workflows/news.yml) and
writes one small JSON file the page can read: titles, links, times and source
names only, from the last few days. The stories stay on the publishers' sites.
The job keeps that file alone on the `news-data` branch, one commit replaced each
run, so the site's own history and its GitHub Pages builds aren't touched.

Every request says who it is (see UA). A feed that fails is listed as failed in
the output; nothing is retried around a block.

Usage:
    python3 tools/update_news.py --out news.json
"""
import argparse
import datetime
import email.utils
import html
import json
import pathlib
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET

UA = "SENTINEL-news-collector/1.0 (+https://iyangdev.github.io/sentinel-console/)"

# Kompas is missing on purpose: its feeds now need an API key. Okezone's feed is
# months stale, and korlantas.polri.go.id doesn't send its full TLS chain (TLS
# checks stay on), so neither is here.
FEEDS = [
    ("Detik", "https://news.detik.com/rss"),
    ("Tempo", "https://rss.tempo.co/"),
    ("Liputan6", "https://feed.liputan6.com/rss/news"),
    ("Republika", "https://www.republika.co.id/rss"),
    ("Viva", "https://www.viva.co.id/get/all"),
    ("Sindonews", "https://www.sindonews.com/feed"),
]
DAYS = 3            # older items are dropped
PER_FEED = 60       # newest items kept from each feed


def text(el, tag):
    found = el.find(tag)
    # html.unescape: some WordPress feeds encode entities twice (&amp;#8217;)
    return html.unescape((found.text or "").strip()) if found is not None else ""


def items_of(raw):
    """(title, link, pubDate) for each <item>; tolerates junk after </rss>."""
    end = raw.rfind(b"</rss>")
    try:
        root = ET.fromstring(raw[: end + 6] if end >= 0 else raw)
    except ET.ParseError:
        return []
    return [(text(it, "title"), text(it, "link"), text(it, "pubDate")) for it in root.iter("item")]


def collect():
    since = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=DAYS)
    sources, items, seen = [], [], set()
    for name, url in FEEDS:
        entry = {"name": name, "url": url, "ok": False, "kept": 0}
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=25) as r:
                parsed = items_of(r.read())
            if not parsed:
                raise ValueError("no RSS items")
        except Exception as e:   # one bad feed must not stop the others
            entry["error"] = str(e)[:120]
            sources.append(entry)
            print(f"  {name}: FAILED {entry['error']}", file=sys.stderr)
            continue
        kept = []
        for title, link, date in parsed:
            try:
                when = email.utils.parsedate_to_datetime(date)
            except (TypeError, ValueError):
                continue
            if when.tzinfo is None:
                when = when.replace(tzinfo=datetime.timezone.utc)
            key = re.sub(r"\s+", " ", title.lower())
            if not title or not re.match(r"https?://", link) or when < since or key in seen or link in seen:
                continue
            seen.update((key, link))
            kept.append({"source": name, "title": title, "link": link, "t": int(when.timestamp() * 1000)})
        kept.sort(key=lambda it: -it["t"])
        items += kept[:PER_FEED]
        entry.update(ok=True, kept=len(kept[:PER_FEED]))
        sources.append(entry)
        print(f"  {name}: {len(parsed)} items, {entry['kept']} kept")
    now = datetime.datetime.now(datetime.timezone.utc)
    return {"updated": now.isoformat(timespec="seconds"), "days": DAYS, "sources": sources,
            "items": sorted(items, key=lambda it: -it["t"])}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="where to write the JSON")
    args = ap.parse_args()
    data = collect()
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    ok = sum(s["ok"] for s in data["sources"])
    print(f"{len(data['items'])} headlines from {ok}/{len(FEEDS)} feeds -> {out}")
    if not ok:
        sys.exit(1)   # nothing worth publishing over the last good file


if __name__ == "__main__":
    main()
