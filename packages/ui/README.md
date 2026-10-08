# @bylinecrm/ui — the design system

Tokens, a Tailwind v4 theme and the components every BylineCRM screen is built from. Spec: corpus
doc 48 §10 (D-241). Consumed **from source** by the Vite apps; nothing is built.

## Use it

```css
/* your app's one stylesheet */
@import 'tailwindcss';
@import '@bylinecrm/ui/styles.css';
@source '../../../packages/ui/src'; /* so your Tailwind sees the components' classes */
```

```tsx
import { ThemeProvider, TooltipProvider, Button, Badge } from '@bylinecrm/ui';
```

Wrap the app in `ThemeProvider` (theme + density, persisted) and `TooltipProvider` once.

## The palette is deleted — on purpose

`theme.css` starts with `--color-*: initial`, which removes Tailwind's entire default palette.
**`bg-emerald-300`, `text-slate-500`, `border-zinc-200` do not exist.** They render nothing and
raise no error. The only colours are the semantic tokens (`bg-surface`, `text-text-muted`,
`bg-success-soft`, …) defined in `tokens.css`. This is how "tokens only" is enforced: a raw
palette value cannot reach the product because the class for it is not there. If a colour class
"does nothing", that is why. The same applies to `font-*`, `radius-*` and `shadow-*`.

## Tokens

- `tokens.css` — every value, once. Light on `:root`; dark under `:root[data-theme="dark"]` and,
  when no attribute is set, under `prefers-color-scheme: dark`; `[data-density="compact"]`
  tightens the spacing base and root font size.
- `theme.css` — the `@theme` block mapping Tailwind utilities onto the tokens.
- `theme/theme.ts` — the attribute names, the storage keys and `applyTheme`/`applyDensity`:
  the one place the app, Storybook and tests agree on how a mode is set.

Status colours mean one thing each (see `Badge`): neutral · success · warning · danger · info.
Pick the meaning, never the hue.

## Components

Radix Primitives underneath, written here, owned here (the shadcn pattern): Button, Input,
Textarea, Select, Checkbox, Switch, Badge, Tooltip, Dialog, DropdownMenu, Tabs, Command (+
CommandDialog for ⌘K), Skeleton, EmptyState, DataTableShell, ThemeToggle. Every one takes
`className`, forwards its ref, merges classes through the one `cn()`, and shows the one
`focusRing` for keyboard users.

## Storybook, and the two gates

```
pnpm storybook                 # workbench on :6006
pnpm build-storybook           # static build the gates run against
pnpm test:a11y                 # axe, WCAG 2.1 AA, every story — any violation fails
pnpm test:visual               # screenshots vs __snapshots__/ — any pixel fails
```

Each component's gallery is exported in three modes (`Gallery`, `GalleryDark`, `GalleryCompact`)
through `.storybook/modes.ts`, so both gates cover light, dark and compact without the story
files repeating the list.

**a11y** — `.storybook/test-runner.ts`. No rule is disabled. If one must be, it is disabled in
that file with its reason beside it, and reviewed like code.

### Visual baselines

Baselines are produced **on the CI runner only** (`ubuntu-latest`, Chromium from Playwright,
the `fonts-inter` package so the product's typeface is what is rendered). A Mac rasterises text
differently, so a local run of `test:visual` is expected to differ and is for debugging only.
To update baselines after an intended change:

```
pnpm --filter @bylinecrm/ui visual:baseline
```

That dispatches the `visual-baseline` workflow on your branch, waits for it, and downloads the
new `__snapshots__/` for you to review and commit **in the same PR** as the change that moved
the pixels. A baseline is a reviewed decision, not a fixture. Never commit a locally generated
baseline.

## Tests

`pnpm test` — Vitest + Testing Library: behaviour that a screenshot cannot show (focus trap,
Escape returning focus, a loading button refusing clicks, the theme preference round-trip).
