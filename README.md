# grudgeclock.github.io

The website of [Grudge Clock](https://grudgeclock.github.io), the grudge tracker for Android, made by
Built by Argo.

## How it is built

Plain HTML and CSS, with one small script for the live clocks. No framework, no tracking, no cookies,
nothing loaded from other services. GitHub Pages publishes the `docs/` folder of the `main` branch.

- `src/pages/` holds the pages. Each starts with its settings (address, title, description, link
  preview image, article dates, breadcrumbs) in a `<!--page {...} -->` comment; the options are listed
  at the top of `src/build.py`.
- `src/layout.html` is the frame every page shares (header, footer, search and link-preview tags);
  `src/style.css` the styles; `src/scripts/clock.js` the live clocks.
- `src/build.py` puts the pages in the frame, writes `docs/` with the sitemap, `robots.txt` and
  structured data for search engines, and checks the result: one main heading per page, unique titles
  and descriptions of the right length, alt text and sizes on images, link previews and images that
  exist, internal links that resolve, valid structured data.
- `src/root/` holds files copied to the site's root unchanged: `app-ads.txt`, which AdMob reads to
  verify the app's ads, and any verification file from Google Search Console. Keep them.
- `src/assets/fonts/` holds Inter and JetBrains Mono, cut down to the characters the site uses. Both
  are under the SIL Open Font License; the licences sit next to the fonts.
- `src/assets/screens/` holds screenshots of the real app; `src/assets/generated/` the finished images.

After changing anything in `src/`, run:

```sh
python3 src/build.py
```

and commit both `src/` and `docs/`. The site address, Play Store id and support address are set at the
top of `src/build.py`; change the address there to move to a custom domain.

## Images

`src/tools/make-assets.mjs` makes every image with headless Google Chrome (Node 22 or later, no npm
packages):

```sh
node src/tools/make-assets.mjs render          # all graphics from src/tools/scenes/
node src/tools/make-assets.mjs render hero     # only scenes whose file name contains "hero"
```

The graphics are HTML pages in `src/tools/scenes/` using the app's colours and fonts. To photograph the
app again after a redesign, build its web version in the app's repository and point the tool at it:

```sh
npx expo export --platform web --output-dir /tmp/app-web     # in the app's repository
node src/tools/make-assets.mjs capture --app /tmp/app-web    # here
```

`capture` fills the app with the sample records in `make-assets.mjs` and saves each screen to
`src/assets/screens/`. Run `render` afterwards, then the build.

## Licence

© 2026 Built by Argo. Google Play and the Google Play logo are trademarks of Google LLC.
