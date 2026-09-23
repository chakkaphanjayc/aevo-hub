# ADR 0009: Shared design-system and interaction primitives

- Status: accepted
- Date: 2026-09-19

## Decision

Phase 2 starts with `@aevocado/design-system` as a framework-neutral React
primitive package. It owns semantic tokens, accessible controls, surface
states, and interaction feedback; feature routes continue to own business
rules and server mutations.

The first shared contract includes:

- `Button` with primary/secondary/ghost/danger variants and visible pending
  feedback that disables duplicate submission.
- `Input`, `Select`, and `FormField` with focus, invalid, hint, and disabled
  states.
- `StatusBadge`, `Card`, `DataTable`, `Breadcrumbs`, `SearchBar`, filter
  chips, sort/group selectors, and pagination primitives.
- `LoadingState`, `EmptyState`, `ErrorState`, `PermissionDeniedState`, and
  offline recovery states with semantic live-region roles.
- Native `Dialog`, `Drawer`, `Toast`, `ToastRegion`, and `CommandMenu`
  primitives with keyboard/Escape behavior and reduced-motion fallbacks.

The Hub modern workspace and settings pilot consume these primitives for
status, cards, inputs, selects, permission recovery, and server-form pending
states. Existing legacy pages remain compatible and are not restyled by this
slice.

## Interaction rules

Micro-interactions are limited to native CSS transitions: a short press-scale,
specular button sheen, status surfaces, and skeleton sheen. They communicate
state and preserve keyboard behavior; no animation dependency or decorative
gesture is required for routine Hub actions. Destructive or privileged actions
remain subject to the hold-to-confirm policy in the UX skill.

All controls have visible focus, disabled/pending semantics, and a recovery
surface for failure. Reduced-motion users receive immediate state changes and
no looping shimmer.

## Verification

The package has server-rendered primitive tests for pending buttons, dotless
status badges, and permission-denied alert semantics. Modern Hub typecheck and
production build must pass before a route consumes new primitives.

The package also includes a package-local Storybook catalog for the shared
primitives. It is intentionally isolated from the application runtime and is
verified with:

```bash
bun run --cwd packages/design-system build-storybook
```

The catalog currently covers actions, surfaces, states, query/form controls,
tables, dialogs, drawers, toasts, and command navigation; new primitives
should add a story and an interaction-state test before being adopted by
another migrated route.
