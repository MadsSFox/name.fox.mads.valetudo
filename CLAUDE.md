# CLAUDE.md — name.fox.mads.valetudo

## Branch Strategy

- **`next_version`** is the integration branch. All new feature/fix branches must be based on `next_version`, and all PRs must target `next_version`.
- **`main`** is the stable release branch. Only `next_version` is merged into `main` at release time.

**Always do this:**
```bash
git checkout next_version && git pull
git checkout -b feat/my-feature
```

**Never base a branch on `main` directly.**

## Commands

```bash
npm run lint       # ESLint check
npm run test       # Mocha tests (5s timeout)
npm run validate   # Validate Homey app structure
npm run build      # Build app (homey app build)
npm start          # Sideload to Homey (homey app run)
```

Run a single test file:
```bash
npx mocha test/FloorManager.test.js
```

> **Note:** `homey app run` runs inside Docker and is isolated from the local network — mDNS discovery and SSH connections to the robot cannot be tested this way.

## Architecture

The app uses a forwarding pattern: `drivers/valetudo/device.js` and `drivers/valetudo/driver.js` are thin wrappers that re-export from `lib/`. All business logic lives in `lib/`:

| File | Responsibility |
|------|---------------|
| `lib/ValetudoDriver.js` | Driver lifecycle; registers all flow cards |
| `lib/ValetudoDevice.js` | Device lifecycle, capability listeners, polling intervals |
| `lib/ValetudoApi.js` | REST API wrapper for Valetudo v2 HTTP endpoints |
| `lib/ValetudoMqtt.js` | MQTT client for real-time state updates |
| `lib/FloorManager.js` | Multi-floor support via SSH file swapping |
| `lib/SshManager.js` | SSH connection management (ssh2 library) |

**Real-time updates:** MQTT is primary; REST polling (30s) is fallback.

**Multi-floor map swapping:** SSH into the robot and swap map files at `/mnt/data/rockrobo/`. Must also patch `RoboController.cfg` and reboot. SSH keys are stored in device store (not settings).

## Flow Cards

All flow cards must have `hint`, `platforms`, and `titleFormatted` fields. Registration is in `ValetudoDriver._registerFlowCards()`.

## Asset Requirements

- `brandColor`: `#1a73e8` (blue) — driver icons must use white SVGs
- Driver icon: 960×960 SVG
- Driver images: 500×500 px (large) + 75×75 px (small) PNG

## Version & Release Workflow

1. Create feature/fix branch from `next_version`
2. Open PR targeting `next_version`
3. Run the **version bump** GitHub Action on the PR branch before merging
4. Merge PR into `next_version`
5. When ready to release: run the **publish** GitHub Action on `main` after merging `next_version` → `main`
