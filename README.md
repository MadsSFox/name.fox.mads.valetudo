# Valetudo for Homey

Control your Valetudo-powered robot vacuum from Homey. Full vacuum control, real-time status via MQTT, room cleaning, zone cleaning, consumable monitoring, and multi-floor map swapping.

## Features

- **Cleaning Control**: Start, stop, pause cleaning and return to dock
- **Real-time Status**: Updates via MQTT (with REST API polling fallback)
- **Fan Speed**: Off, min, low, medium, high, turbo, max
- **Water Usage & Operation Mode**: Control mop water level and vacuum/mop mode
- **Room/Segment Cleaning**: Clean specific rooms with unlimited iteration control
- **Zone Cleaning**: Save custom zone presets and clean them from flow cards
- **Battery Monitoring**: Real-time battery level with configurable low-battery threshold trigger
- **Consumable Monitoring**: Alerts when filter, brushes, mop, or sensors need replacement
- **Error Detection**: Triggers for robot stuck, dustbin full, and general errors
- **Carpet Detection**: Condition card for carpet boost logic
- **Speaker Control**: Set volume and play test sounds
- **Do Not Disturb**: Enable/disable DND mode
- **Carpet Boost Mode**: Enable/disable automatic carpet boost
- **Auto-Empty Dock**: Trigger dustbin emptying
- **Go To Location**: Send robot to specific coordinates
- **Voice Pack Installation**: Install custom voice packs via URL
- **Robot Locate**: Make the robot beep to find it
- **Update Notifications**: Triggers when Valetudo is updated or a new version is available
- **Multi-Floor Maps**: Save, switch, and rename floor maps via SSH with dock-aware behavior
- **New Map Building**: Reset the current map and start a fresh mapping run
- **Cleaning Statistics**: Last session and lifetime area/duration on device page
- **Auto-Discovery**: Finds Valetudo robots on your network via mDNS and subnet scanning

## Device Page

The device page shows real-time robot status and provides quick controls:

| Capability | Description |
|---|---|
| Cleaning (on/off) | Start or stop cleaning |
| Vacuum State | cleaning, docked, idle, returning, paused, error, manual control, moving |
| Fan Speed | Settable speed preset |
| Battery | Current battery percentage |
| Low Battery | Alert when battery drops below 20% |
| Current Floor | Active floor name |
| Error | Current error description (if any) |
| Last Clean Area | Area cleaned in last session (m2) |
| Last Clean Duration | Duration of last session (min) |
| Total Area | Lifetime area cleaned (m2) |
| Total Duration | Lifetime cleaning time (hours) |
| Return to Dock | Button — sends robot home (stops on dockless floors) |
| Floor | Picker — switch between floors or create a new one |

## Flow Cards

### Triggers (12) — "When..."

| Trigger | Tokens |
|---|---|
| Floor was switched | `floor_name` |
| Cleaning started | — |
| Cleaning finished | `area_m2`, `duration_min` |
| An error occurred | `error_message` |
| Robot is stuck | `error_message` |
| Dustbin needs emptying | — |
| Battery dropped below threshold | `battery_level` (configurable %) |
| Started cleaning a segment | `segment_name`, `segment_id` |
| Finished cleaning a segment | `segment_name`, `segment_id` |
| A consumable needs replacement | `consumable_type`, `consumable_sub_type`, `remaining` |
| Valetudo was updated | `old_version`, `new_version` |
| A Valetudo update is available | `current_version` |

### Conditions (7) — "And..."

| Condition | Args | Invertible |
|---|---|---|
| State is / is not ... | dropdown: all 8 vacuum states | Yes |
| Is on floor / not on floor | autocomplete: floor list | Yes |
| Current floor has / has no dock | — | Yes |
| Is on carpet / not on carpet | — | Yes |
| Is in segment / not in segment | autocomplete: room list | Yes |
| Do Not Disturb is enabled/disabled | — | Yes |
| Carpet boost mode is enabled/disabled | — | Yes |

### Actions (24) — "Then..."

**Cleaning**

| Action | Args |
|---|---|
| Start cleaning | — |
| Stop cleaning | — |
| Pause cleaning | — |
| Return to dock | — (stops instead of docking on dockless floors) |
| Start building a new map | — (resets map + starts mapping) |

**Room & Zone Cleaning**

| Action | Args |
|---|---|
| Clean segment | autocomplete room, iterations (no max) |
| Clean zone | autocomplete zone, iterations (no max) |
| Save zone | name, x1, y1, x2, y2 |
| Delete saved zone | autocomplete zone |

**Floor Management**

| Action | Args |
|---|---|
| Switch to floor | autocomplete floor |
| Save current map as floor | floor name, has dock (yes/no) |
| Rename floor | autocomplete floor, new name |
| Set floor dock | autocomplete floor, has dock (yes/no) |

**Robot Settings**

| Action | Args |
|---|---|
| Set fan speed | dropdown: off/min/low/medium/high/turbo/max |
| Set water usage | dropdown: off/min/low/medium/high/max |
| Set operation mode | dropdown: vacuum/mop/vacuum & mop/vacuum then mop |
| Set speaker volume | 0-100% |
| Play test sound | — |
| Locate robot | — |
| Empty dustbin | — (trigger auto-empty dock) |
| Set Do Not Disturb | enable/disable |
| Set carpet boost mode | enable/disable |
| Send robot to coordinates | x, y |
| Reset consumable | dropdown: filter/main brush/side brush/mop/sensors |
| Install voice pack | URL, language code |

## Requirements

- Homey Pro with SDK v3 support
- Robot vacuum running [Valetudo](https://valetudo.cloud/)
- MQTT broker (recommended for real-time updates)
- SSH access to the robot (required for multi-floor feature)

## Supported Robots

This app works with any robot vacuum running [Valetudo](https://valetudo.cloud/). For a list of supported robots and rooting instructions, see the Valetudo documentation:

- [Supported Robots](https://valetudo.cloud/pages/general/supported-robots.html)
- [Buying Supported Robots](https://valetudo.cloud/pages/general/buying-supported-robots.html)
- [Rooting Instructions](https://valetudo.cloud/pages/general/rooting-instructions.html)

## Setup

1. Install the app on your Homey
2. Add a new Valetudo device — the app will search your network automatically via mDNS and subnet scanning. If your robot isn't found, enter the IP address manually.
3. Configure MQTT broker in device settings for real-time updates
4. Configure SSH credentials in device settings for multi-floor support

## Multi-Floor Setup

1. Place the robot on floor 1 and let it create a complete map
2. Use the floor picker on the device page and select "New Floor..." or use the "Save current map as floor" action card
3. Move the robot to floor 2, select "New Floor..." from the picker (this resets the map and starts mapping)
4. Once mapping is complete, the floor is saved automatically
5. Switch between floors using the picker or the "Switch to floor" action card

The floor switch operation will: stop the robot if cleaning, back up the current map, swap map files via SSH, and reboot the robot.

Each floor can be marked as having a dock or not. On floors without a dock, the "Return to dock" button and action will stop the robot instead of trying to send it home.

Floors can be renamed using the "Rename floor" flow action card.

## Zone Cleaning

Zones let you define rectangular areas for frequent spot-cleaning:

1. Use the "Save zone" action card with a name and coordinates (top-left x/y, bottom-right x/y)
2. Use the "Clean zone" action card to clean a saved zone with optional iterations
3. Use the "Delete zone" action card to remove a saved zone

Zone coordinates can be found from the Valetudo web interface map.

## Acknowledgements

Thanks to [Soren Hypfer](https://github.com/Hypfer) for creating **[Valetudo](https://valetudo.cloud/)** — this app wouldn't exist without his work on freeing robot vacuums from the cloud.

Thanks to [Mark Haehnel](https://github.com/markhaehnel) for the **[original homey-valetudo app](https://github.com/markhaehnel/homey-valetudo)** that inspired this project.

## Source Code

[GitHub Repository](https://github.com/MadsSFox/homey-valetudo)

## License

MIT
