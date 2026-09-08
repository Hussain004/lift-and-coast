# LIFT & COAST

A serverless, browser-based formula racing game for the 2026 regulation era.
Real track layouts, skill-based driving physics, energy management, and a
retro-modern art style. No database, no DRS.

Save the juice. Send the apex.

## Status

Phase 0 (vertical slice): a single car on a flat placeholder surface, driven
with a real Rapier vehicle controller, keyboard input, and a chase camera.
Real track geometry, tire modeling, AI, and the rest of the roadmap have not
been built yet.

## Stack

- Next.js (App Router) on Vercel
- Three.js via React Three Fiber, `drei`
- Rapier physics (`@dimforge/rapier3d-compat`, `@react-three/rapier`)
- Zustand for state
- TypeScript (strict)
- Vitest

## Development

```bash
npm install
npm run dev
```

Open http://localhost:3000. Click Drive, then use WASD or the arrow keys.

## Testing

```bash
npm run test
npm run lint
npx tsc --noEmit
```

## Deployment

Zero-config on Vercel: connect this repository as a Vercel project. No
environment variables or server infrastructure are required; all game state
lives in the browser.
