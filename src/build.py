#!/usr/bin/env python3
"""Builds the Grudge Clock website from src/ into docs/, the folder GitHub Pages publishes, then checks it.

    python3 src/build.py

Each page in src/pages/ starts with its settings in a comment:

    <!--page
    {"path": "/articles/example/", "title": "...", "description": "...", ...}
    -->

and the rest is the page's <main> content. Settings:

    path, title, description        required
    social_title                     title for link previews, if different
    image, image_alt                 link-preview image in assets/generated (default: og-image.png)
    article: {"published", "updated", "headline"}   marks the page as an article (BlogPosting data)
    crumbs: [["Articles", "/articles/"], ...]        breadcrumb trail above the page title
    faq: true                        builds FAQPage data from the page's <details> questions
    jsonld: [...]                    extra structured data
    campaign                         label for the Google Play link, so Play Console shows installs per page
    scripts: ["demo.js"]             scripts from src/ to load at the end of the page
    noindex: true                    keeps the page out of search engines and the sitemap

Placeholders in pages: {{site}}, {{play_url}}, {{support_email}}, and
{{img name "alt text"}} / {{img name "alt text" eager}} for a responsive image made of the WebP sizes
named name-<width>.webp in src/assets/generated/.

The checks cover what search engines and visitors rely on: one <h1> per page, unique titles and
descriptions of a sensible length, alt text and dimensions on every image, images and link previews
that exist, internal links and anchors that resolve, and structured data that parses. The build stops
with a list of problems if any check fails.

To move to a custom domain, change SITE and rebuild.
"""
import codecs, datetime, hashlib, html, json, os, re, shutil, struct, sys
from html.parser import HTMLParser

SITE = "https://grudgeclock.github.io"
PLAY_ID = "com.grudge_clock"
SUPPORT_EMAIL = "builtbyargo@proton.me"
PUBLISHER = "Built by Argo"
# Google Search Console's HTML-tag verification code, if you verify that way (only the content="…" value).
GOOGLE_VERIFICATION = ""
# Words that must never appear in the published site. Stored in ROT13 so that this file
# does not contain them either.
FORBIDDEN = tuple(codecs.decode(w, "rot13") for w in ("pynhqr", "naguebcvp"))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
OUT = os.path.join(ROOT, "docs")
GENERATED = os.path.join(SRC, "assets", "generated")
TODAY = datetime.date.today().isoformat()


def play_url(campaign):
    """The Play listing with an install referrer, so Play Console can attribute installs to the website."""
    referrer = "utm_source%3Dgrudgeclock.github.io%26utm_medium%3Dwebsite%26utm_campaign%3D" + campaign
    return "https://play.google.com/store/apps/details?id=%s&amp;referrer=%s" % (PLAY_ID, referrer)


def image_size(path):
    """Width and height of a PNG, JPEG or WebP file, read from its header."""
    data = open(path, "rb").read(64 * 1024)
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", data[16:24])
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        chunk = data[12:16]
        if chunk == b"VP8X":
            w = int.from_bytes(data[24:27], "little") + 1
            h = int.from_bytes(data[27:30], "little") + 1
            return w, h
        if chunk == b"VP8L":
            bits = int.from_bytes(data[21:25], "little")
            return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        if chunk == b"VP8 ":
            w, h = struct.unpack("<HH", data[26:30])
            return w & 0x3FFF, h & 0x3FFF
    if data[:2] == b"\xff\xd8":
        i = 2
        while i < len(data):
            marker, length = data[i + 1], struct.unpack(">H", data[i + 2:i + 4])[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack(">HH", data[i + 5:i + 9])
                return w, h
            i += 2 + length
    raise ValueError("unknown image format: %s" % path)


def responsive_image(match):
    """{{img name "alt"}}: every name-<width>.webp as a srcset, the largest as src, sized for layout."""
    name, alt, eager = match.group(1), match.group(2), bool(match.group(3))
    widths = sorted(int(m.group(1)) for f in os.listdir(GENERATED)
                    for m in [re.fullmatch(re.escape(name) + r"-(\d+)\.webp", f)] if m)
    if not widths:
        sys.exit("{{img %s}}: no %s-<width>.webp in %s" % (name, name, GENERATED))
    largest = "%s-%d.webp" % (name, widths[-1])
    w, h = image_size(os.path.join(GENERATED, largest))
    srcset = ", ".join("/assets/%s-%d.webp %dw" % (name, x, x) for x in widths)
    loading = 'loading="eager" fetchpriority="high"' if eager else 'loading="lazy"'
    # Images are shown at most ~half the page wide in two-column layouts; full width on phones.
    return ('<img src="/assets/%s" srcset="%s" sizes="(max-width: 960px) 100vw, 600px" width="%d" height="%d" alt="%s" %s decoding="async">'
            % (largest, srcset, w // 2, h // 2, html.escape(alt, quote=True), loading))


def fill(text, values):
    for key, value in values.items():
        text = text.replace("{{%s}}" % key, value)
    return text


def read_pages():
    pages = []
    for name in sorted(os.listdir(os.path.join(SRC, "pages"))):
        if not name.endswith(".html"):
            continue
        text = open(os.path.join(SRC, "pages", name), encoding="utf-8").read()
        match = re.match(r"\s*<!--page\s*(\{.*?\})\s*-->\s*", text, re.S)
        if not match:
            sys.exit("%s has no <!--page {...} --> settings" % name)
        meta = json.loads(match.group(1))
        meta["file"] = name
        meta["body"] = text[match.end():]
        pages.append(meta)
    return pages


def organization():
    return {"@type": "Organization", "@id": SITE + "/#builtbyargo", "name": PUBLISHER, "email": SUPPORT_EMAIL,
            "url": SITE + "/", "logo": {"@type": "ImageObject", "url": SITE + "/assets/icon-512.png", "width": 512, "height": 512}}


def structured_data(page, body):
    graph = [organization(),
             {"@type": "WebSite", "@id": SITE + "/#website", "url": SITE + "/", "name": "Grudge Clock",
              "inLanguage": "en", "publisher": {"@id": SITE + "/#builtbyargo"}}]
    url = SITE + page["path"]
    image = SITE + "/assets/" + page.get("image", "og-image.png")
    if "crumbs" in page:
        trail = [["Home", "/"]] + page["crumbs"] + [[page.get("crumb", page["title"].split(" – ")[0].split(":")[0]), page["path"]]]
        graph.append({"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "name": name, "item": SITE + path} for i, (name, path) in enumerate(trail)]})
    if page.get("article"):
        a = page["article"]
        graph.append({"@type": "BlogPosting", "@id": url + "#article", "mainEntityOfPage": url, "url": url,
                      "headline": a.get("headline", page["title"]), "description": page["description"],
                      "image": [image], "datePublished": a["published"], "dateModified": a.get("updated", a["published"]),
                      "inLanguage": "en", "author": {"@id": SITE + "/#builtbyargo"}, "publisher": {"@id": SITE + "/#builtbyargo"},
                      "isPartOf": {"@id": SITE + "/#website"}})
    if page.get("faq"):
        # FAQPage data from the page's own <details> questions, so the two never differ.
        def plain(fragment):
            return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", fragment))).strip()
        questions = re.findall(r"<details[^>]*>\s*<summary>(.*?)</summary>(.*?)</details>", body, re.S)
        graph.append({"@type": "FAQPage", "mainEntity": [
            {"@type": "Question", "name": plain(q), "acceptedAnswer": {"@type": "Answer", "text": plain(a)}} for q, a in questions]})
    graph.extend(page.get("jsonld", []))
    return {"@context": "https://schema.org", "@graph": graph}


def build():
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    os.makedirs(os.path.join(OUT, "assets", "fonts"))
    css = open(os.path.join(SRC, "style.css"), "rb").read()
    open(os.path.join(OUT, "assets", "style.css"), "wb").write(css)
    for name in os.listdir(GENERATED):
        shutil.copy2(os.path.join(GENERATED, name), os.path.join(OUT, "assets", name))
    for name in os.listdir(os.path.join(SRC, "assets", "fonts")):
        shutil.copy2(os.path.join(SRC, "assets", "fonts", name), os.path.join(OUT, "assets", "fonts", name))
    for name in os.listdir(os.path.join(SRC, "scripts")):
        shutil.copy2(os.path.join(SRC, "scripts", name), os.path.join(OUT, "assets", name))
    # Files that must sit at the site's root as they are: app-ads.txt, search engines' verification files.
    for name in os.listdir(os.path.join(SRC, "root")):
        shutil.copy2(os.path.join(SRC, "root", name), os.path.join(OUT, name))
    layout = open(os.path.join(SRC, "layout.html"), encoding="utf-8").read()
    pages = read_pages()
    for page in pages:
        path = page["path"]
        campaign = page.get("campaign") or (path.strip("/").split("/")[-1] or "home").replace(".html", "")
        common = {"site": SITE, "play_url": play_url(campaign), "support_email": SUPPORT_EMAIL}
        body = re.sub(r'\{\{img ([\w-]+) "(.*?)"( eager)?\}\}', responsive_image, page["body"])
        body = fill(body, common)
        if "crumbs" in page:
            items = "".join('<li><a href="%s">%s</a></li>' % (p, html.escape(n)) for n, p in [["Home", "/"]] + page["crumbs"])
            body = body.replace("{{crumbs}}", '<nav aria-label="Breadcrumb"><ol class="crumbs">%s</ol></nav>' % items)
        article = page.get("article")
        image = page.get("image", "og-image.png")
        values = dict(common)
        values.update({
            "title": html.escape(page["title"]),
            "social_title": html.escape(page.get("social_title", page["title"])),
            "description": html.escape(page["description"], quote=True),
            "canonical": SITE + (path if path != "/404.html" else "/"),
            "robots": "noindex" if page.get("noindex") else "index, follow, max-image-preview:large, max-snippet:-1",
            "verification": ('<meta name="google-site-verification" content="%s">\n' % GOOGLE_VERIFICATION) if GOOGLE_VERIFICATION else "",
            "css_version": hashlib.sha256(css).hexdigest()[:10],
            "og_type": "article" if article else "website",
            "og_image": "%s/assets/%s" % (SITE, image),
            "og_image_alt": html.escape(page.get("image_alt", "Grudge Clock: how long have you been holding it?"), quote=True),
            "article_meta": ('<meta property="article:published_time" content="%s">\n<meta property="article:modified_time" content="%s">\n'
                             % (article["published"], article.get("updated", article["published"]))) if article else "",
            "preload": "".join('<link rel="preload" as="image" href="/assets/%s" type="image/webp">\n' % p for p in page.get("preload", [])),
            "scripts": "".join('<script src="/assets/%s" defer></script>\n' % s for s in page.get("scripts", [])),
            "jsonld": json.dumps(structured_data(page, body), indent=1, ensure_ascii=False),
            "body": body.strip(),
        })
        out = fill(layout, values)
        # Mark the current section in the main navigation.
        section = "/" + path.strip("/").split("/")[0] + "/" if path.strip("/") else None
        if section:
            out = out.replace('<li><a href="%s">' % section, '<li><a href="%s" aria-current="page">' % section, 1)
        target = os.path.join(OUT, "404.html") if path == "/404.html" else os.path.join(OUT, path.strip("/"), "index.html")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        open(target, "w", encoding="utf-8").write(out)
        page["output"] = target
    urls = ""
    for p in pages:
        if p.get("noindex"):
            continue
        lastmod = (p.get("article") or {}).get("updated") or (p.get("article") or {}).get("published") or p.get("updated") or TODAY
        urls += "  <url><loc>%s%s</loc><lastmod>%s</lastmod></url>\n" % (SITE, p["path"], lastmod)
    open(os.path.join(OUT, "sitemap.xml"), "w").write(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n%s</urlset>\n' % urls)
    open(os.path.join(OUT, "robots.txt"), "w").write("User-agent: *\nAllow: /\n\nSitemap: %s/sitemap.xml\n" % SITE)
    # Plain files: GitHub Pages must not run them through Jekyll.
    open(os.path.join(OUT, ".nojekyll"), "w").close()
    return pages


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.h1 = 0
        self.ids, self.links, self.images, self.jsonld, self.metas = set(), [], [], [], {}
        self.title = ""
        self._in_title = self._in_jsonld = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if "id" in a:
            self.ids.add(a["id"])
        if tag == "h1":
            self.h1 += 1
        elif tag == "a" and "href" in a:
            self.links.append(a["href"])
        elif tag == "img":
            self.images.append(a)
        elif tag == "title":
            self._in_title = True
        elif tag == "meta":
            self.metas[a.get("name") or a.get("property")] = a.get("content", "")
        elif tag == "script" and a.get("type") == "application/ld+json":
            self._in_jsonld = True
            self.jsonld.append("")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag == "script":
            self._in_jsonld = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self._in_jsonld:
            self.jsonld[-1] += data


def check(pages):
    problems, parsed, titles, descriptions = [], {}, {}, {}
    for page in pages:
        text = open(page["output"], encoding="utf-8").read()
        parser = Page()
        parser.feed(text)
        parsed[page["path"]] = parser
    for path, p in parsed.items():
        if p.h1 != 1:
            problems.append("%s: %d <h1> elements" % (path, p.h1))
        if not 25 <= len(p.title) <= 65:
            problems.append("%s: title is %d characters (25–65)" % (path, len(p.title)))
        description = p.metas.get("description", "")
        if not 70 <= len(description) <= 160:
            problems.append("%s: description is %d characters (70–160)" % (path, len(description)))
        titles.setdefault(p.title, []).append(path)
        descriptions.setdefault(description, []).append(path)
        og = p.metas.get("og:image", "")
        if not os.path.exists(os.path.join(OUT, og.replace(SITE + "/", ""))):
            problems.append("%s: link-preview image %s does not exist" % (path, og))
        for img in p.images:
            if "alt" not in img or not img.get("width") or not img.get("height"):
                problems.append("%s: image %s lacks alt, width or height" % (path, img.get("src")))
            for src in [img.get("src", "")] + [s.split()[0] for s in img.get("srcset", "").split(",") if s.strip()]:
                if src.startswith("/") and not os.path.exists(os.path.join(OUT, src.lstrip("/"))):
                    problems.append("%s: image %s does not exist" % (path, src))
        for block in p.jsonld:
            try:
                json.loads(block)
            except ValueError as error:
                problems.append("%s: structured data does not parse (%s)" % (path, error))
        for href in p.links:
            if not href.startswith("/"):
                continue
            target, _, anchor = href.partition("#")
            target = target or path
            if target not in parsed and not os.path.exists(os.path.join(OUT, target.lstrip("/"))):
                problems.append("%s: link to %s, which does not exist" % (path, href))
            elif anchor and target in parsed and anchor not in parsed[target].ids:
                problems.append("%s: link to %s, but that page has no id %s" % (path, href, anchor))
    for kind, seen in (("title", titles), ("description", descriptions)):
        for text, paths in seen.items():
            if len(paths) > 1:
                problems.append("same %s on %s" % (kind, ", ".join(paths)))
    for folder, _, files in os.walk(OUT):
        for name in files:
            if name.endswith((".html", ".xml", ".txt", ".css", ".js")):
                content = open(os.path.join(folder, name), encoding="utf-8").read().lower()
                for word in FORBIDDEN:
                    if word in content:
                        problems.append("%s contains the word %r" % (os.path.relpath(os.path.join(folder, name), OUT), word))
    return problems


if __name__ == "__main__":
    pages = build()
    problems = check(pages)
    for page in pages:
        print("built %-48s %s" % (page["path"], os.path.relpath(page["output"], ROOT)))
    if problems:
        print("\n%d problem(s):" % len(problems))
        for problem in problems:
            print("  " + problem)
        sys.exit(1)
    print("\nAll checks passed: %d pages, sitemap.xml, robots.txt." % len(pages))
