---
version: alpha
name: EBO site
description: Tokens for the EBO project site, an observatory data release for research partners. Light values use the plain name; dark-mode values use the same name with a -dark suffix. Data colors are copied unchanged from the Atlas viewer's DESIGN.md and appear only where they encode Atlas data.
colors:
  surface-0: "#ffffff"
  surface-0-dark: "#100e0c"
  surface-1: "#f8f6f5"
  surface-1-dark: "#181513"
  surface-2: "#f0efed"
  surface-2-dark: "#211d1a"
  rule: "#dbd9d6"
  rule-dark: "#393431"
  rule-strong: "#231e1b"
  rule-strong-dark: "#d5d0ca"
  ink: "#18130e"
  ink-dark: "#f2f0ec"
  text-secondary: "#47413d"
  text-secondary-dark: "#c7c3be"
  text-muted: "#67625f"
  text-muted-dark: "#9f9b96"
  primary: "#eb9431"
  primary-dark: "#fba541"
  primary-ink: "#944e12"
  primary-ink-dark: "#fcae52"
  on-primary: "#18130e"
  on-primary-dark: "#100e0c"
  projection: "#0b0907"
  projection-ink: "#eae7e3"
  projection-muted: "#a29e99"
  projection-rule: "#312d2a"
  div-pos: "#2a78d6"
  div-pos-dark: "#3987e5"
  div-neg: "#e34948"
  div-neg-dark: "#e66767"
  div-mid: "#d9d7cf"
  div-mid-dark: "#55554f"
  cat-inspect: "#2a78d6"
  cat-inspect-dark: "#3987e5"
  cat-edit: "#eb6834"
  cat-edit-dark: "#d95926"
  cat-read: "#1baf7a"
  cat-read-dark: "#199e70"
  cat-check: "#eda100"
  cat-check-dark: "#c98500"
  cat-shell: "#e87ba4"
  cat-shell-dark: "#d55181"
  cat-vcs: "#4a3aa7"
  cat-vcs-dark: "#9085e9"
  cat-other: "#a3a29b"
  cat-other-dark: "#6f6e68"
  status-critical: "#d03b3b"
  status-critical-dark: "#e66767"
typography:
  display:
    fontFamily: Archivo, "Helvetica Neue", Arial, sans-serif
    fontSize: 80px
    fontWeight: 640
    lineHeight: 0.98
    letterSpacing: -0.025em
  headline:
    fontFamily: Archivo, "Helvetica Neue", Arial, sans-serif
    fontSize: 44px
    fontWeight: 620
    lineHeight: 1.06
    letterSpacing: -0.02em
  title:
    fontFamily: Archivo, "Helvetica Neue", Arial, sans-serif
    fontSize: 19px
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: Archivo, "Helvetica Neue", Arial, sans-serif
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.6
  small:
    fontFamily: Archivo, "Helvetica Neue", Arial, sans-serif
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  readout:
    fontFamily: '"Chivo Mono", ui-monospace, Menlo, monospace'
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: '"Chivo Mono", ui-monospace, Menlo, monospace'
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: 2px
  md: 4px
  pill: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
  2xl: 64px
  3xl: 112px
components:
  page:
    backgroundColor: "{colors.surface-0}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
  page-dark:
    backgroundColor: "{colors.surface-0-dark}"
    textColor: "{colors.ink-dark}"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface-0}"
    rounded: "{rounded.md}"
    padding: 12px 18px
  button-primary-dark:
    backgroundColor: "{colors.ink-dark}"
    textColor: "{colors.surface-0-dark}"
    rounded: "{rounded.md}"
  button:
    backgroundColor: "{colors.surface-0}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: 12px 18px
  button-dark:
    backgroundColor: "{colors.surface-0-dark}"
    textColor: "{colors.ink-dark}"
    rounded: "{rounded.md}"
  link:
    textColor: "{colors.primary-ink}"
  link-dark:
    textColor: "{colors.primary-ink-dark}"
  plate:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-muted}"
    typography: "{typography.label}"
  plate-dark:
    backgroundColor: "{colors.surface-2-dark}"
    textColor: "{colors.text-muted-dark}"
  annotation-marker:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.pill}"
    size: 24px
  annotation-marker-dark:
    backgroundColor: "{colors.primary-dark}"
    textColor: "{colors.on-primary-dark}"
  readout:
    backgroundColor: "{colors.surface-0}"
    textColor: "{colors.ink}"
    typography: "{typography.readout}"
  readout-dark:
    backgroundColor: "{colors.surface-0-dark}"
    textColor: "{colors.ink-dark}"
  table:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.small}"
  table-dark:
    backgroundColor: "{colors.surface-1-dark}"
    textColor: "{colors.text-secondary-dark}"
  table-rule:
    backgroundColor: "{colors.rule}"
    height: 1px
  table-rule-dark:
    backgroundColor: "{colors.rule-dark}"
    height: 1px
  section-rule:
    backgroundColor: "{colors.rule-strong}"
    height: 2px
  section-rule-dark:
    backgroundColor: "{colors.rule-strong-dark}"
    height: 2px
  film-chapter:
    backgroundColor: "{colors.projection}"
    textColor: "{colors.projection-muted}"
    typography: "{typography.label}"
  film-divider:
    backgroundColor: "{colors.projection-rule}"
    height: 1px
  outcome-constructive:
    backgroundColor: "{colors.div-pos}"
    rounded: "{rounded.sm}"
    size: 10px
  outcome-constructive-dark:
    backgroundColor: "{colors.div-pos-dark}"
  outcome-adverse:
    backgroundColor: "{colors.div-neg}"
  outcome-adverse-dark:
    backgroundColor: "{colors.div-neg-dark}"
  outcome-mixed:
    backgroundColor: "{colors.div-mid}"
  outcome-mixed-dark:
    backgroundColor: "{colors.div-mid-dark}"
  action-inspect:
    backgroundColor: "{colors.cat-inspect}"
  action-inspect-dark:
    backgroundColor: "{colors.cat-inspect-dark}"
  action-edit:
    backgroundColor: "{colors.cat-edit}"
  action-edit-dark:
    backgroundColor: "{colors.cat-edit-dark}"
  action-read:
    backgroundColor: "{colors.cat-read}"
  action-read-dark:
    backgroundColor: "{colors.cat-read-dark}"
  action-check:
    backgroundColor: "{colors.cat-check}"
  action-check-dark:
    backgroundColor: "{colors.cat-check-dark}"
  action-shell:
    backgroundColor: "{colors.cat-shell}"
  action-shell-dark:
    backgroundColor: "{colors.cat-shell-dark}"
  action-vcs:
    backgroundColor: "{colors.cat-vcs}"
  action-vcs-dark:
    backgroundColor: "{colors.cat-vcs-dark}"
  action-other:
    backgroundColor: "{colors.cat-other}"
  action-other-dark:
    backgroundColor: "{colors.cat-other-dark}"
  error-mark:
    textColor: "{colors.status-critical}"
  error-mark-dark:
    textColor: "{colors.status-critical-dark}"
  projection-room:
    backgroundColor: "{colors.projection}"
    textColor: "{colors.projection-ink}"
---

# EBO site

## Overview

The project site reads as an observatory's data release, written for research partners who will check the method:
annotated plates of the real Atlas, an instrument specification, a signal path, the anatomy of a claim and ruled
tables. White paper and dark ink carry the page; one amber `primary` (the red-light amber of an observatory control
room) marks annotations, focus and the active chapter. The film is shown in a dark projection room in both themes.

Light values use the plain token name; dark-mode values use the same name with `-dark`. `viewer/design/build-tokens.mjs`
writes them to `site/tokens.css` (`node viewer/design/build-tokens.mjs site/DESIGN.md site/tokens.css`).

## Colors

- **Surfaces** `surface-0` (page, pure white / near-black), `surface-1` (wells, table heads), `surface-2` (plate mats).
- **Rules** `rule` for hairlines; `rule-strong` (ink) for the top rule of tables and section starts.
- **Text** `ink`, `text-secondary`, `text-muted` (all ≥ 4.5:1 on `surface-0` and `surface-1`).
- **Primary** `primary` is a fill for annotation markers and marks (ink text on it, 7.7:1); `primary-ink` is the text and
  link color (6.2:1 on white). Never used for data.
- **Projection** `projection*` for the film band, the same in both themes.
- **Data** `div-*`, `cat-*`, `status-critical` are the Atlas viewer's values, unchanged, used only in figures that
  encode Atlas data (the swimlane trace, judge outcome swatches), always with a legend.

## Typography

Archivo, one grotesque family, set at its expanded width (`font-stretch: 112–125%`) for `display` and `headline` and at
normal width for `title`, `body` and `small`; Chivo Mono for `readout` and `label`: identifiers, commands, schema
fields, timestamps and units, never decoration. Display sizes are maxima for a fluid `clamp()`. Tabular figures for
every number.

## Layout

A 12-column grid (max 1280px, 16px gutter on phones). Sections open with a strong rule; the heading sits in the first
four columns and the content in the remaining eight, like a technical report. Plates span the full width. Generous
section separation (`3xl`), tight grouping inside (`sm`–`md`).

## Elevation & Depth

Flat. Rules and mats separate things; nothing casts a shadow except the sticky header's hairline.

## Shapes

`rounded.sm` for chips and swatches, `rounded.md` for buttons and code blocks; plates are square with registration
marks at the corners. Annotation markers are round.

## Components

`button-primary` (ink), `button` (outlined), `link` (`primary-ink`, underlined), `plate` (image on a mat with
registration marks, numbered `annotation-marker`s and a key), `readout` (spec-sheet and record rows in mono), the
`projection-room` band for the film with a chapter list.

## Do's and Don'ts

- Do label illustrations as illustrations and viewer numbers as exploratory.
- Do pair every data color with a legend or a label.
- Don't use gradients, glows, glass blur, grid backgrounds or card grids.
- Don't put an eyebrow label above every section; the section rule and heading are enough.
- Don't use `primary` for data or `cat-*` for interface.
