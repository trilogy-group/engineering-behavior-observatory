# Project site

Source of the GitHub Pages site. `.github/workflows/pages.yml` assembles it on
every push to `main` that touches the site or its media, and stamps the package
version and commit into the colophon:

- `index.html`, `style.css`, `site.js`, `tokens.css` → the site root
- `docs/assets/ebo-atlas.png`, `ebo-promo.mp4`, `ebo-promo-poster.jpg` → `assets/`

`PRODUCT.md` is the brief (audience, voice, anti-references) and `DESIGN.md` the
visual system ([design.md format](https://github.com/google-labs-code/design.md)).
`tokens.css` is generated from `DESIGN.md`; regenerate it after token changes:

```sh
node viewer/design/build-tokens.mjs site/DESIGN.md site/tokens.css
```

Preview locally with the same layout:

```sh
rm -rf /tmp/ebo-site && mkdir -p /tmp/ebo-site/assets
cp site/index.html site/style.css site/site.js site/tokens.css /tmp/ebo-site/
cp docs/assets/ebo-atlas.png docs/assets/ebo-promo.mp4 docs/assets/ebo-promo-poster.jpg /tmp/ebo-site/assets/
python3 -m http.server 8090 --directory /tmp/ebo-site
```
