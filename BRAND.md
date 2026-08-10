# Waysera — Brand Guide

This file is the source of truth for Waysera's identity. Anything user-facing — copy, colour, naming, tone — should be checked against it before shipping.

---

## 1. Name and pronunciation

**Waysera**

> **way-SEH-rah**

## 2. Capitalisation

Always write **Waysera**.

Never write:

- WaySera
- Way Sera
- WAYSERA in headings or prose
- "the Waysera"

The compound reads as *Way + sera*, but the logo expresses that through weight and colour contrast in the wordmark, never through camel case in the string itself. One spelling everywhere: docs, code identifiers, domain, handles.

## 3. Product category

**Live group navigation.**

Waysera is not a location tracker, a social network, a fleet-management tool, or convoy software. It is a lightweight navigation experience for people heading to a shared destination.

## 4. Primary tagline

> **Every journey, together.**

This is the permanent brand tagline.

## 5. Supporting campaign line

> **Stay together. Arrive together.**

For promotional material, onboarding, and launch content. Never display it alongside the primary tagline.

## 6. Product one-liner

> Waysera lets people heading to the same destination share a temporary journey, see their group on a live map, and navigate together — without creating an account.

## 7. Brand promise

> **Stay connected from departure to arrival.**

Waysera removes the repeated questions: Where are you? Who has left? Who is behind? Has everyone arrived? Which car took a different route?

## 8. Brand personality

Waysera should feel **calm, human, dependable, lightweight, friendly, modern, clear and reassuring.**

It should never feel like surveillance software, a logistics dashboard, something military or convoy-oriented, overly futuristic, corporate, childish, emoji-heavy, or a generic map clone.

## 9. User-facing terminology

| Instead of | Use |
| --- | --- |
| Room | Journey |
| Create Room | Start a Journey |
| Join Room | Join a Journey |
| Room Code | Journey Code |
| Room Created | Your Journey Is Ready |
| Riders | Your Group |
| Member | Person |
| Copy Link | Share Invite |
| Copy Code | Copy Journey Code |
| Leave Room | Leave Journey |
| Room expired | This Journey Has Ended |
| 3h left | Ends in 3h |
| 1 member | 1 person |
| 4 members | 4 people |

Never call someone a *rider*, a *user* in UI copy, a *subject*, a *target*, or a *fleet member*. They are **people** in **your group**.

## 10. Colour tokens

| Role | Name | Hex |
| --- | --- | --- |
| Primary | Indigo | `#4F46E5` |
| Primary pressed | Deep Indigo | `#4338CA` |
| Secondary | Deep Teal | `#0F766E` |
| Accent | Aqua | `#14B8A6` |
| Gradient midpoint | Sky | `#0EA5E9` |
| Primary text | Ink | `#0F172A` |
| Secondary text | Slate | `#64748B` |
| Light background | Cloud | `#F8FAFC` |
| Light surface | White | `#FFFFFF` |
| Dark background | Night | `#0B1120` |
| Dark surface | Deep Slate | `#111827` |

```css
--waysera-primary: #4F46E5;
--waysera-primary-strong: #4338CA;
--waysera-secondary: #0F766E;
--waysera-accent: #14B8A6;
--waysera-sky: #0EA5E9;
--waysera-ink: #0F172A;
--waysera-muted: #64748B;
--waysera-canvas: #F8FAFC;
--waysera-surface: #FFFFFF;
--waysera-dark: #0B1120;
--waysera-dark-surface: #111827;
```

**Brand gradient**

```css
linear-gradient(135deg, #4F46E5 0%, #0EA5E9 55%, #14B8A6 100%);
```

Use the gradient only for: the brand mark, small hero accents, navigation highlights, and arrival celebration states. Everything else uses solid colour.

**Rules**

- Primary buttons are solid `#4F46E5`; pressed state is `#4338CA`.
- Success, warning, and error colours stay semantic and independent of the brand palette. Never recolour them for visual consistency.
- Never place white body text directly on `#14B8A6` or `#0EA5E9` without independently verifying contrast.
- Map readability outranks brand expression. Never tint the map for brand reasons.

## 11. Logo

**Concept: multiple paths, one destination.**

Two route lines rise from separate origins and converge on a single destination point. The silhouette subtly suggests a **W**. Strokes are rounded, the motion reads forward and upward.

The mark must:

- stay recognisable at 20–24 px
- work as a single flat colour
- work on light and dark backgrounds
- carry no text inside the icon form

Avoid: a plain map pin, a chain link or tether, a car, a steering wheel, a stock compass, or detail that collapses at small sizes.

**Usage.** In HTML, compose the lockup from the SVG mark plus real text, so the wordmark stays crisp, selectable, and searchable. Use `waysera-lockup.svg` only where a single self-contained file is required (README, social previews).

Decorative instances take `aria-hidden="true"`. Instances that carry meaning take an accessible label.

## 12. Typography

Keep the system font stack — no downloaded fonts, no build step.

```css
-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
```

| Element | Weight |
| --- | --- |
| Brand wordmark | 750–800 |
| Page headings | 700 |
| Section headings | 600–700 |
| Buttons | 600 |
| Body | 400–500 |

Sentence case for buttons and labels. Avoid all-caps beyond small utility labels.

## 13. Writing style

Short, helpful, reassuring. Say what happened and what to do next.

**Approved**

- "Your journey is ready."
- "Share this code with your group."
- "Three people are on the way."
- "Riya has arrived."
- "We couldn't find that journey. Check the code and try again."
- "Location access helps your group see where you are during this journey."

**Avoid**

- "Track your friends"
- "Monitor users"
- "Subjects", "targets", "fleet members"
- "Military-grade"
- "Guaranteed safety"

## 14. Approved UI examples

Home:

> **Waysera**
> **Every journey, together.**
> Start a shared journey, invite your group, and see everyone move toward the same destination.
>
> `No signup · Live location · Temporary journeys`

Actions: **Start a Journey** · **Join a Journey**

Create form: "Where are you going?" · "Search for a destination" · "Journey duration"

Journey created: "Your Journey Is Ready" · "Share this journey code with your group:" · **Share Invite**

Journey page: "Journey code: ABC123" · "Ends in 2h 14m" · "4 people" · "Your Group" · **Copy Journey Code** · **Leave Journey**

Arrival: "You've arrived." · "Alex has arrived." · "Everyone has arrived."

Location permission: "Share your location for this journey" / "Location access lets your group see where you are while the journey is active." / **Enable Location** · **Use Demo Mode**

## 15. Claims we do not make

Never claim:

- guaranteed security or safety
- suitability for emergencies
- background tracking while the browser is closed
- unlimited group size
- "completely private"

### The privacy claim, precisely

Waysera's relay is **zero-knowledge**: journey payloads are encrypted on the device, the key travels in the URL fragment which browsers never transmit, and the server stores nothing. So this is true:

> **We can't see your journey.**

This is **not** true, and must never be written:

> ~~Your location never leaves your device.~~

The client still contacts third parties that receive location data: **Mapbox** (map tiles), **Photon** (destination search, including a rough position used to rank nearby results first), and **openstreetmap.de** (routing, which sees origin *and* destination). Any privacy copy must stay within what the architecture actually delivers.

Describe encryption factually, and only once it ships. Planned capability is not present capability.

## 16. Dark mode

Both modes are first-class.

- Light: `--waysera-canvas` background, `--waysera-surface` cards, `--waysera-ink` text.
- Dark: `--waysera-dark` background, `--waysera-dark-surface` cards, near-white text.

Brand indigo holds up in both. Verify contrast wherever brand colour meets text, especially aqua and sky. Respect `prefers-reduced-motion` — animation is decorative and always optional.

## 17. Assets

```
web/assets/brand/
├── waysera-mark.svg       # symbol only, currentColor, any size
├── waysera-lockup.svg     # mark + wordmark, self-contained
├── favicon.svg            # gradient tile, legible at 16px
└── waysera-app-icon.svg   # 512×512 rounded square, no text
```

Raster exports (180×180 Apple touch, 192×192 and 512×512 PWA) are **still outstanding** — they need image tooling not available in this environment. Placeholder PNGs must never be committed; export from `waysera-app-icon.svg` and reference them from `web/manifest.webmanifest` once real files exist.

---

*Waysera was previously developed under the working name Tether. That name must not appear in the product UI.*
