'use strict';

const MAP_BASE = '/mnt/data/rockrobo';
const FLOORS_DIR = `${MAP_BASE}/floors`;
const MAP_FILES = [
  'last_map',
  'ChargerPos.data',
  'PersistentData_1.data',
  'PersistentData_2.data',
];

// Files that must be removed before restoring a different floor's map
const CONFLICT_FILES = [
  'StartPos.data',
  'user_map0',
];

const ROBO_CFG = `${MAP_BASE}/RoboController.cfg`;

const POLL_INTERVAL_MS = 10000;
const MAX_POLL_ATTEMPTS = 60; // 10 minutes max wait

class FloorManager {

  constructor({ device, ssh, api, mqttClient, log }) {
    this._device = device;
    this._ssh = ssh;
    this._api = api;
    this._mqtt = mqttClient;
    this._log = log || console.log;
  }

  _getStore() {
    const data = this._device.getStoreValue('floor_config');
    return data || { floors: [], activeFloor: null };
  }

  async _setStore(config) {
    await this._device.setStoreValue('floor_config', config);
  }

  getFloors() {
    return this._getStore().floors;
  }

  getActiveFloor() {
    return this._getStore().activeFloor;
  }

  getFloorName(floorId) {
    const config = this._getStore();
    const floor = config.floors.find((f) => f.id === floorId);
    return floor ? floor.name : null;
  }

  getActiveFloorName() {
    const config = this._getStore();
    if (!config.activeFloor) return null;
    return this.getFloorName(config.activeFloor);
  }

  activeFloorHasDock() {
    const config = this._getStore();
    if (!config.activeFloor) return true; // default to true if no floors configured
    const floor = config.floors.find((f) => f.id === config.activeFloor);
    if (!floor) return true;
    return floor.hasDock !== false; // default to true for backward compatibility
  }

  async renameFloor(floorId, newName) {
    const config = this._getStore();
    const floor = config.floors.find((f) => f.id === floorId);
    if (!floor) throw new Error(`Floor "${floorId}" not found`);
    floor.name = newName;
    await this._setStore(config);
    return floor;
  }

  async setFloorDock(floorId, hasDock) {
    const config = this._getStore();
    const floor = config.floors.find((f) => f.id === floorId);
    if (!floor) throw new Error(`Floor "${floorId}" not found`);
    floor.hasDock = hasDock;
    await this._setStore(config);
  }

  async addFloor(id, name) {
    const config = this._getStore();
    if (config.floors.find((f) => f.id === id)) {
      throw new Error(`Floor "${id}" already exists`);
    }
    config.floors.push({ id, name });
    await this._setStore(config);
    return config;
  }

  async removeFloor(id) {
    const config = this._getStore();
    config.floors = config.floors.filter((f) => f.id !== id);
    if (config.activeFloor === id) {
      config.activeFloor = null;
    }
    await this._setStore(config);

    // Remove stored map files
    try {
      await this._ssh.exec(`rm -rf "${FLOORS_DIR}/${id}"`);
    } catch (err) {
      this._log(`Failed to remove floor files for ${id}:`, err.message);
    }

    return config;
  }

  async saveCurrentFloor(floorId) {
    const config = this._getStore();
    let floor = config.floors.find((f) => f.id === floorId);
    if (!floor) {
      throw new Error(`Floor "${floorId}" not found. Add it first.`);
    }

    this._log(`Saving current map as floor "${floor.name}" (${floorId})`);

    // Create floor directory
    const floorDir = `${FLOORS_DIR}/${floorId}`;
    await this._ssh.exec(`mkdir -p "${floorDir}"`);

    // Copy map files
    let savedCount = 0;
    for (const file of MAP_FILES) {
      const src = `${MAP_BASE}/${file}`;
      const dst = `${floorDir}/${file}`;
      const exists = await this._ssh.fileExists(src);
      if (exists) {
        await this._ssh.copyFile(src, dst);
        this._log(`  Saved ${file}`);
        savedCount++;
      }
    }

    // Verify at least one map file was saved
    if (savedCount === 0) {
      throw new Error('No map files found on robot — cannot save floor');
    }

    // Verify the key file exists on the robot
    const verified = await this._ssh.fileExists(`${floorDir}/last_map`);
    if (!verified) {
      throw new Error('Floor save verification failed — last_map not found after copy');
    }

    // Mark as active floor only after successful save
    config.activeFloor = floorId;
    await this._setStore(config);

    this._log(`Floor "${floor.name}" saved successfully`);
    return floor;
  }

  async saveAsNewFloor(name, hasDock = true) {
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '');
    if (!id) throw new Error('Invalid floor name');

    // First: copy map files to the robot (this will throw on failure)
    this._log(`Saving current map as new floor "${name}" (${id})`);
    const floorDir = `${FLOORS_DIR}/${id}`;
    await this._ssh.exec(`mkdir -p "${floorDir}"`);

    let savedCount = 0;
    for (const file of MAP_FILES) {
      const src = `${MAP_BASE}/${file}`;
      const dst = `${floorDir}/${file}`;
      const exists = await this._ssh.fileExists(src);
      if (exists) {
        await this._ssh.copyFile(src, dst);
        this._log(`  Saved ${file}`);
        savedCount++;
      }
    }

    if (savedCount === 0) {
      throw new Error('No map files found on robot — cannot save floor');
    }

    const verified = await this._ssh.fileExists(`${floorDir}/last_map`);
    if (!verified) {
      throw new Error('Floor save verification failed — last_map not found after copy');
    }

    // Only persist to Homey store after confirmed save on robot
    const config = this._getStore();
    const existing = config.floors.find((f) => f.id === id);
    if (!existing) {
      config.floors.push({ id, name, hasDock });
    } else {
      existing.hasDock = hasDock;
    }
    config.activeFloor = id;
    await this._setStore(config);

    this._log(`Floor "${name}" saved and registered successfully`);
    return { id, name };
  }

  async createEmptyFloor(name, hasDock = true) {
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '');
    if (!id) throw new Error('Invalid floor name');

    const config = this._getStore();
    const existing = config.floors.find((f) => f.id === id);
    if (!existing) {
      config.floors.push({ id, name, hasDock });
    } else {
      existing.hasDock = hasDock;
    }
    config.activeFloor = id;
    await this._setStore(config);

    this._log(`Floor "${name}" registered (no map yet — will be built by new map scan)`);
    return { id, name };
  }

  async isFloorSaved(floorId) {
    const floorDir = `${FLOORS_DIR}/${floorId}`;
    return this._ssh.fileExists(`${floorDir}/last_map`);
  }

  async switchFloor(floorId) {
    const config = this._getStore();
    const floor = config.floors.find((f) => f.id === floorId);
    if (!floor) {
      throw new Error(`Floor "${floorId}" not found`);
    }

    if (config.activeFloor === floorId) {
      this._log(`Already on floor "${floor.name}"`);
      return floor;
    }

    // Step 1: Always save current floor's latest map before switching away
    // (the backup may be stale from boot time or a previous session)
    if (config.activeFloor) {
      try {
        this._log('Saving current floor map before switch...');
        await this.saveCurrentFloor(config.activeFloor);
      } catch (err) {
        this._log('Warning: could not backup current floor:', err.message);
      }
    }

    // Step 2: Check if target floor has a saved map
    let saved = await this.isFloorSaved(floorId);

    // Fallback: search robot for unclaimed map directories or firmware maps
    if (!saved) {
      this._log(`No saved map for "${floor.name}", searching robot for existing maps...`);
      saved = await this._tryRecoverFloorMap(floorId, floor.name);
    }

    if (!saved) {
      throw new Error(`No saved map for "${floor.name}". Navigate robot to that floor and use "New Floor" to save it.`);
    }

    this._log(`Switching to floor "${floor.name}"...`);

    // Step 3: Stop robot if cleaning
    await this._stopIfCleaning();

    // Step 4: Save current floor's map files (backup)
    if (config.activeFloor) {
      this._log('Backing up current floor map...');
      try {
        await this.saveCurrentFloor(config.activeFloor);
      } catch (err) {
        this._log('Warning: failed to backup current floor:', err.message);
      }
    }

    // Step 5: Remove conflicting files
    this._log('Removing conflicting files...');
    for (const file of CONFLICT_FILES) {
      await this._ssh.removeFile(`${MAP_BASE}/${file}`);
    }

    // Step 6: Remove current map files
    for (const file of MAP_FILES) {
      await this._ssh.removeFile(`${MAP_BASE}/${file}`);
    }

    // Step 7: Copy target floor files
    this._log(`Restoring floor "${floor.name}" map files...`);
    const floorDir = `${FLOORS_DIR}/${floorId}`;
    for (const file of MAP_FILES) {
      const src = `${floorDir}/${file}`;
      const exists = await this._ssh.fileExists(src);
      if (exists) {
        await this._ssh.copyFile(src, `${MAP_BASE}/${file}`);
        this._log(`  Restored ${file}`);
      }
    }

    // Step 8: Patch RoboController.cfg
    this._log('Patching RoboController.cfg...');
    await this._patchConfig();

    // Step 9: Reboot
    this._log('Rebooting robot...');
    await this._ssh.reboot();

    // Step 10: Wait for robot to come back
    this._log('Waiting for robot to come back online...');
    await this._waitForOnline();

    // Step 11: Update store
    config.activeFloor = floorId;
    await this._setStore(config);

    this._log(`Switched to floor "${floor.name}" successfully`);
    return floor;
  }

  async _tryRecoverFloorMap(floorId, floorName) {
    const targetDir = `${FLOORS_DIR}/${floorId}`;

    // 1. Search floors directory for unclaimed map directories
    try {
      const output = await this._ssh.exec(`ls -1 "${FLOORS_DIR}" 2>/dev/null || true`);
      const dirs = output.trim().split('\n').filter(Boolean);

      if (dirs.length > 0) {
        const config = this._getStore();
        const registeredIds = new Set(config.floors.map((f) => f.id));

        for (const dir of dirs) {
          if (dir === floorId) continue; // already checked by isFloorSaved
          const dirPath = `${FLOORS_DIR}/${dir}`;
          const hasMap = await this._ssh.fileExists(`${dirPath}/last_map`);
          if (!hasMap) continue;

          // Skip directories claimed by other registered floors
          if (registeredIds.has(dir) && dir !== floorId) continue;

          this._log(`Found existing map in "${dir}", adopting for floor "${floorName}"`);
          await this._ssh.exec(`mkdir -p "${targetDir}"`);
          for (const file of MAP_FILES) {
            const src = `${dirPath}/${file}`;
            const exists = await this._ssh.fileExists(src);
            if (exists) {
              await this._ssh.copyFile(src, `${targetDir}/${file}`);
            }
          }
          if (await this._ssh.fileExists(`${targetDir}/last_map`)) return true;
        }
      }
    } catch (err) {
      this._log('Floor directory search failed:', err.message);
    }

    // 2. Check firmware multi-map files (user_map0, user_map1, etc.)
    try {
      const output = await this._ssh.exec(`ls -1 "${MAP_BASE}"/user_map* 2>/dev/null || true`);
      const userMaps = output.trim().split('\n').filter(Boolean);

      if (userMaps.length > 0) {
        // Find a user_map that isn't already used by another floor
        for (const mapPath of userMaps) {
          this._log(`Found firmware map: ${mapPath}`);
          await this._ssh.exec(`mkdir -p "${targetDir}"`);
          await this._ssh.copyFile(mapPath, `${targetDir}/last_map`);

          // Also grab PersistentData and ChargerPos if they exist nearby
          for (const file of MAP_FILES) {
            if (file === 'last_map') continue;
            const src = `${MAP_BASE}/${file}`;
            const exists = await this._ssh.fileExists(src);
            if (exists) {
              await this._ssh.copyFile(src, `${targetDir}/${file}`);
            }
          }

          if (await this._ssh.fileExists(`${targetDir}/last_map`)) {
            this._log(`Recovered floor "${floorName}" from firmware map`);
            return true;
          }
        }
      }
    } catch (err) {
      this._log('Firmware map search failed:', err.message);
    }

    // 3. Check for map backup files (last_map_backup, *.bak)
    try {
      const backupFiles = ['last_map_backup', 'last_map.bak', 'last_map.old'];
      for (const backup of backupFiles) {
        const src = `${MAP_BASE}/${backup}`;
        const exists = await this._ssh.fileExists(src);
        if (exists) {
          this._log(`Found map backup: ${backup}`);
          await this._ssh.exec(`mkdir -p "${targetDir}"`);
          await this._ssh.copyFile(src, `${targetDir}/last_map`);
          if (await this._ssh.fileExists(`${targetDir}/last_map`)) {
            this._log(`Recovered floor "${floorName}" from backup file`);
            return true;
          }
        }
      }
    } catch (err) {
      this._log('Backup file search failed:', err.message);
    }

    return false;
  }

  // --- Segment trigger for no-dock floors ---
  // After a mapping pass on a floor without a dock, the firmware won't
  // segment the map automatically (segmentation is triggered by docking).
  // We force it by: 1) trying the Valetudo quirk API, 2) falling back to
  // setting ready_for_segment_map=1 in RoboController.cfg + reboot.

  async triggerSegmentation() {
    // Try the Valetudo quirk API first
    try {
      const quirks = await this._api.getQuirks();
      const segmentQuirk = quirks.find(
        (q) => q.title && q.title.toLowerCase().includes('segment'),
      );
      if (segmentQuirk) {
        this._log(`Found segment quirk: "${segmentQuirk.title}", triggering...`);
        await this._api.setQuirk(segmentQuirk.id, 'trigger');
        this._log('Segment quirk triggered successfully');
        await this._sleep(5000);
        return;
      }
    } catch (err) {
      this._log('Quirk-based segmentation failed:', err.message);
    }

    // Fallback: set ready_for_segment_map=1 and reboot
    this._log('Falling back to config-based segmentation trigger...');
    try {
      let cfg = await this._ssh.readFile(ROBO_CFG);
      cfg = cfg.replace(/ready_for_segment_map\s*=\s*\d+/, 'ready_for_segment_map = 1');
      await this._ssh.writeFile(ROBO_CFG, cfg);
      this._log('Set ready_for_segment_map = 1, rebooting...');
      await this._ssh.reboot();
      await this._waitForOnline();
      this._log('Robot back online after segmentation reboot');
    } catch (err) {
      this._log('Config-based segmentation trigger failed:', err.message);
    }
  }

  async _stopIfCleaning() {
    try {
      const attrs = await this._api.getStateAttributes();
      const status = attrs.find((a) => a.__class === 'StatusStateAttribute');
      if (status && status.value === 'cleaning') {
        this._log('Robot is cleaning, stopping first...');
        await this._api.basicControl('stop');
        // Give it a moment to stop
        await this._sleep(3000);
      }
    } catch (err) {
      this._log('Could not check/stop cleaning state:', err.message);
    }
  }

  async _patchConfig() {
    try {
      let cfg = await this._ssh.readFile(ROBO_CFG);
      cfg = cfg.replace(/need_recover_map=\d+/, 'need_recover_map=0');
      await this._ssh.writeFile(ROBO_CFG, cfg);
    } catch (err) {
      this._log('Warning: failed to patch RoboController.cfg:', err.message);
    }
  }

  async _waitForOnline() {
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await this._sleep(POLL_INTERVAL_MS);
      const reachable = await this._api.isReachable();
      if (reachable) {
        this._log('Robot is back online');
        return;
      }
    }
    throw new Error('Robot did not come back online after reboot');
  }

  _sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
  }

}

module.exports = FloorManager;
