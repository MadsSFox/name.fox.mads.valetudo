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

  getActiveFloorName() {
    const config = this._getStore();
    if (!config.activeFloor) return null;
    const floor = config.floors.find((f) => f.id === config.activeFloor);
    return floor ? floor.name : null;
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

    const saved = await this.isFloorSaved(floorId);
    if (!saved) {
      throw new Error(`No saved map found for floor "${floor.name}". Save it first.`);
    }

    this._log(`Switching to floor "${floor.name}"...`);

    // Step 1: Stop robot if cleaning
    await this._stopIfCleaning();

    // Step 2: Save current floor's map files (backup)
    if (config.activeFloor) {
      this._log('Backing up current floor map...');
      try {
        await this.saveCurrentFloor(config.activeFloor);
      } catch (err) {
        this._log('Warning: failed to backup current floor:', err.message);
      }
    }

    // Step 3: Remove conflicting files
    this._log('Removing conflicting files...');
    for (const file of CONFLICT_FILES) {
      await this._ssh.removeFile(`${MAP_BASE}/${file}`);
    }

    // Step 4: Remove current map files
    for (const file of MAP_FILES) {
      await this._ssh.removeFile(`${MAP_BASE}/${file}`);
    }

    // Step 5: Copy target floor files
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

    // Step 6: Patch RoboController.cfg
    this._log('Patching RoboController.cfg...');
    await this._patchConfig();

    // Step 7: Reboot
    this._log('Rebooting robot...');
    await this._ssh.reboot();

    // Step 8: Wait for robot to come back
    this._log('Waiting for robot to come back online...');
    await this._waitForOnline();

    // Step 9: Update store
    config.activeFloor = floorId;
    await this._setStore(config);

    this._log(`Switched to floor "${floor.name}" successfully`);
    return floor;
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
