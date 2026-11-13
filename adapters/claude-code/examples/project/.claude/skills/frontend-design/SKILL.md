---
name: frontend-design
description: "Build distinctive, accessible, production-grade frontend interfaces with strong design direction. Guidance only; edits stay within frontend paths."
disable-model-invocation: true
---

<!-- Generated from skill frontend-design@1.0.0. Do not edit. -->

# Frontend Design

Create distinctive, production-grade frontend interfaces with high design
quality, avoiding generic AI aesthetics. Adapted from the Anthropic skill of the
same name (Apache-2.0, see `licenses/frontend-design-Apache-2.0.md` and
`licenses/frontend-design-NOTICE.md`). Use it when asked to build web
components, pages, applications or to style and beautify a web UI.

## Guardrails (added by this repository, they take precedence)

- Respect the project's existing design system, framework and conventions
  before introducing a new aesthetic. A bold direction applies to new work, not
  to unrequested rewrites of existing screens.
- Accessibility is not optional: sufficient contrast, keyboard operability,
  visible focus, semantic HTML, reduced-motion support.
- Do not add external CDN scripts, fonts or tracking without explicit approval;
  prefer packages already in the project or self-hosted assets.
- Keep changes within the files the task allows. This skill grants no shell
  access and no network access.

## Design thinking

The user provides frontend requirements: a component, page, application or
interface. Before coding, understand the context and commit to a bold aesthetic
direction:

- **Purpose**: what problem does this interface solve? Who uses it?
- **Tone**: pick a direction (brutally minimal, maximalist, retro-futuristic,
  organic, luxury/refined, playful, editorial, brutalist, art deco, soft/pastel,
  industrial/utilitarian, and so on) and stay true to it.
- **Constraints**: framework, performance, accessibility.
- **Differentiation**: what is the one thing someone will remember?

Choose a clear conceptual direction and execute it with precision. Bold
maximalism and refined minimalism both work; intentionality matters more than
intensity.

Then implement working code (HTML/CSS/JS, React, Vue, and so on) that is
production-grade and functional, visually striking and memorable, cohesive with
a clear point of view, and refined in every detail.

## Frontend aesthetics guidelines

- **Typography**: choose characterful fonts rather than defaults; pair a
  distinctive display font with a refined body font.
- **Color and theme**: commit to a cohesive palette using CSS variables;
  dominant colors with sharp accents beat timid, evenly distributed palettes.
- **Motion**: use animation for high-impact moments (a well-orchestrated page
  load with staggered reveals) and purposeful hover and scroll states. Prefer
  CSS-only solutions for HTML; use a motion library for React only when already
  available.
- **Spatial composition**: asymmetry, overlap, diagonal flow, grid-breaking
  elements, and generous negative space or controlled density.
- **Backgrounds and visual details**: create atmosphere and depth with
  gradients, textures, patterns, layered transparency, shadows and borders that
  match the aesthetic.

Avoid generic AI-generated aesthetics: overused font families, cliched color
schemes (particularly purple gradients on white), predictable layouts and
cookie-cutter components. No two designs should be the same; vary themes, fonts
and aesthetics, and do not converge on the same choices across generations.

Match implementation complexity to the aesthetic vision: maximalist designs need
elaborate code and animation, minimalist designs need restraint, precision and
careful spacing and typography.
