---
version: alpha
name: EBO Atlas (lab)
description: Tokens for the EBO Atlas lab app and its evidence views. Light values use the plain name; dark-mode values use the same name with a -dark suffix. Data colors follow the dataviz method (categorical in fixed order, diverging pair with a neutral midpoint, status colors reserved).
colors:
  primary: "#2268c0"
  primary-dark: "#3987e5"
  on-primary: "#ffffff"
  surface-0: "#f4f3f0"
  surface-0-dark: "#121211"
  surface-1: "#fcfcfb"
  surface-1-dark: "#1a1a19"
  surface-2: "#ffffff"
  surface-2-dark: "#222220"
  border: "#dedcd5"
  border-dark: "#353532"
  text-primary: "#0b0b0b"
  text-primary-dark: "#ffffff"
  text-secondary: "#52514e"
  text-secondary-dark: "#c3c2b7"
  text-muted: "#706e68"
  text-muted-dark: "#9a998f"
  div-pos: "#2a78d6"
  div-pos-dark: "#3987e5"
  div-neg: "#e34948"
  div-neg-dark: "#e66767"
  div-mid: "#d9d7cf"
  div-mid-dark: "#55554f"
  fam-messages: "#2a78d6"
  fam-messages-dark: "#3987e5"
  fam-episodes: "#eb6834"
  fam-episodes-dark: "#d95926"
  fam-tools: "#1baf7a"
  fam-tools-dark: "#199e70"
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
  status-good: "#1a7f52"
  status-good-dark: "#3fbf86"
  ribbon: "#2a78d6"
  ribbon-dark: "#3987e5"
typography:
  body:
    fontFamily: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
  small:
    fontFamily: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.35
  heading:
    fontFamily: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.3
  mono:
    fontFamily: ui-monospace, "SF Mono", Menlo, monospace
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
rounded:
  sm: 4px
  md: 6px
  lg: 8px
  pill: 999px
spacing:
  xs: 2px
  sm: 4px
  md: 8px
  lg: 12px
  xl: 16px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    padding: 4px 8px
  button-primary-dark:
    backgroundColor: "{colors.primary-dark}"
    textColor: "{colors.surface-0-dark}"
    rounded: "{rounded.md}"
  button:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: 4px 8px
  button-dark:
    backgroundColor: "{colors.surface-2-dark}"
    textColor: "{colors.text-primary-dark}"
    rounded: "{rounded.md}"
  page:
    backgroundColor: "{colors.surface-0}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
  page-dark:
    backgroundColor: "{colors.surface-0-dark}"
    textColor: "{colors.text-primary-dark}"
  panel:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text-secondary}"
  panel-dark:
    backgroundColor: "{colors.surface-1-dark}"
    textColor: "{colors.text-secondary-dark}"
  caption:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text-muted}"
    typography: "{typography.small}"
  caption-dark:
    backgroundColor: "{colors.surface-1-dark}"
    textColor: "{colors.text-muted-dark}"
  card:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: 8px 10px
  card-dark:
    backgroundColor: "{colors.surface-2-dark}"
    textColor: "{colors.text-primary-dark}"
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  divider-dark:
    backgroundColor: "{colors.border-dark}"
    height: 1px
  code:
    typography: "{typography.mono}"
  section-title:
    typography: "{typography.heading}"
  outcome-constructive:
    backgroundColor: "{colors.div-pos}"
    rounded: "{rounded.sm}"
    size: 10px
  outcome-constructive-dark:
    backgroundColor: "{colors.div-pos-dark}"
  outcome-mixed:
    backgroundColor: "{colors.div-mid}"
  outcome-mixed-dark:
    backgroundColor: "{colors.div-mid-dark}"
  outcome-adverse:
    backgroundColor: "{colors.div-neg}"
  outcome-adverse-dark:
    backgroundColor: "{colors.div-neg-dark}"
  tag-certified:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.status-good}"
    rounded: "{rounded.sm}"
  tag-certified-dark:
    backgroundColor: "{colors.surface-2-dark}"
    textColor: "{colors.status-good-dark}"
  tag-critical:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.status-critical}"
  tag-critical-dark:
    backgroundColor: "{colors.surface-2-dark}"
    textColor: "{colors.status-critical-dark}"
  family-messages:
    backgroundColor: "{colors.fam-messages}"
  family-messages-dark:
    backgroundColor: "{colors.fam-messages-dark}"
  family-episodes:
    backgroundColor: "{colors.fam-episodes}"
  family-episodes-dark:
    backgroundColor: "{colors.fam-episodes-dark}"
  family-tools:
    backgroundColor: "{colors.fam-tools}"
  family-tools-dark:
    backgroundColor: "{colors.fam-tools-dark}"
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
  token-ribbon:
    backgroundColor: "{colors.ribbon}"
  token-ribbon-dark:
    backgroundColor: "{colors.ribbon-dark}"
---

# EBO Atlas (lab)

## Overview

A dense analytical tool for reading agent behavior evidence: a point cloud, tables and timelines on quiet surfaces, with
color reserved for data. Interface chrome is neutral; the only interface hue is `primary` (selection, focus, links), a darker step of the data blue so white text on it
meets WCAG AA.
Every number the app computes is labelled exploratory unless it equals an EBO-certified tally.

Light values use the plain token name; dark-mode values use the same name with `-dark`. The generator
(`design/build-tokens.mjs`) writes both as one set of CSS custom properties, switching on `prefers-color-scheme` and on
`data-theme`.

## Colors

- **Surfaces** `surface-0` (page), `surface-1` (panels), `surface-2` (cards, inputs, popovers); `border` for hairlines.
- **Text** `text-primary`, `text-secondary`, `text-muted`. Text never takes a series color; a colored mark beside the
  text carries identity.
- **Diverging pair** `div-pos` (blue, over / constructive) and `div-neg` (red, under / adverse) with the neutral
  midpoint `div-mid` (mixed). Used for observed-vs-expected cells and for judge outcomes, which are polar. Context-
  dependent outcomes add a hatch texture and abstentions are an outlined empty swatch, so outcomes never rely on color
  alone; counts are always printed.
- **Categorical, fixed order** (dataviz slots 1-6, validated light and dark): unit families (`fam-*`) and swimlane action
  categories (`cat-inspect`, `cat-edit`, `cat-read`, `cat-check`, `cat-shell`, `cat-vcs`, then neutral `cat-other`).
  Never cycled; a new category folds into `other`.
- **Status, reserved** `status-critical` (errors, failed checks) and `status-good` (resolved, certified). Always with
  an icon or word.
- `ribbon` for the token-usage area in swimlanes.

## Typography

System fonts. `body` 13px for the interface, `small` 11px for metadata and captions, `heading` 14px semibold for panel
titles, `mono` for identifiers, commands and native records. Tabular figures for every number column.

## Layout

The page is a top bar, the cloud, a draggable splitter and a tabbed panel (Clusters × arm, Swimlanes, Assessments,
Claims). Evidence opens in a right drawer over the panel, so the cloud and lanes stay visible. Spacing uses the 2/4/8/12/
16px scale; tables use 2px cell gaps.

## Elevation & Depth

Flat surfaces separated by `border` hairlines. Only floating layers (tooltip, drawer) cast a shadow.

## Shapes

`rounded.sm` for chips and swatches, `rounded.md` for controls, `rounded.lg` for cards and popovers, `rounded.pill` for
filter chips. Data marks: bars with 1px rounding, 2px lines, swatches 10px.

## Components

Buttons (neutral `button`, `button-primary` for the selected segment), `card` (tooltip, drawer sections), `caption`,
`code`, outcome swatches (`outcome-*`, always followed by the outcome word in text color), provenance tags (`tag-certified` for numbers equal to an EBO report tally,
`tag-critical` for failures; exploratory numbers use a muted outlined tag), family and action swatches, the token
ribbon. Each has a `-dark` variant with the dark tokens.

## Do's and Don'ts

- Do print counts next to every outcome bar and keep the denominator visible.
- Do mark each number as EBO certified or exploratory.
- Don't color text with a series color, and don't reuse status colors for categories.
- Don't add a hue without re-running the palette validator for light and dark.
