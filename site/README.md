# Project site

Source of the GitHub Pages site. `.github/workflows/pages.yml` assembles it on
every push to `main` that touches the site, its media or the design tokens:

- `site/*` → the site root
- `viewer/src/tokens.css` (generated from `viewer/design/DESIGN.md`) → `tokens.css`
- `docs/assets/ebo-atlas.png`, `ebo-promo.mp4`, `ebo-promo-poster.jpg` → `assets/`

Preview locally with the same layout:

```sh
rm -rf /tmp/ebo-site && mkdir -p /tmp/ebo-site/assets
cp site/index.html site/style.css site/site.js viewer/src/tokens.css /tmp/ebo-site/
cp docs/assets/ebo-atlas.png docs/assets/ebo-promo.mp4 docs/assets/ebo-promo-poster.jpg /tmp/ebo-site/assets/
python3 -m http.server 8090 --directory /tmp/ebo-site
```
