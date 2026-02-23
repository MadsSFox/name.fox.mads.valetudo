'use strict';

const Homey = require('homey');
const ValetudoApi = require('./ValetudoApi');
const ValetudoMqtt = require('./ValetudoMqtt');
const SshManager = require('./SshManager');
const FloorManager = require('./FloorManager');

const REST_POLL_INTERVAL_MS = 30000;
const CONSUMABLE_POLL_INTERVAL_MS = 3600000; // 1 hour
const UPDATE_CHECK_INTERVAL_MS = 86400000; // 24 hours
const CONSUMABLE_DEPLETED_THRESHOLD = 10; // percent
const LOW_BATTERY_THRESHOLD = 20;
const SEGMENT_POLL_INTERVAL_MS = 10000;

// Map Valetudo status values to our vacuum_state enum
const STATE_MAP = {
  cleaning: 'cleaning',
  docked: 'docked',
  idle: 'idle',
  returning: 'returning',
  paused: 'paused',
  error: 'error',
  manual_control: 'manual_control',
  moving: 'moving',
};

class ValetudoDevice extends Homey.Device {

  async onInit() {
    this.log('ValetudoDevice initializing...');

    const settings = this.getSettings();

    // SSH key: stored securely, textarea is only used for input (cleared after saving)
    await this._secureSshKey(settings);
    const sshKey = this.getStoreValue('ssh_private_key') || undefined;

    // Initialize REST API client
    this._api = new ValetudoApi({
      host: settings.host,
      authUser: settings.valetudo_auth_user || undefined,
      authPass: settings.valetudo_auth_pass || undefined,
      log: this.log.bind(this),
    });

    // Initialize MQTT client
    this._mqtt = new ValetudoMqtt({
      broker: settings.mqtt_broker || undefined,
      username: settings.mqtt_username || undefined,
      password: settings.mqtt_password || undefined,
      topicPrefix: settings.mqtt_topic_prefix || 'valetudo',
      identifier: settings.mqtt_identifier || this.getData().id,
      log: this.log.bind(this),
    });

    // Initialize SSH manager (key from secure store, not settings)
    this._ssh = new SshManager({
      host: settings.ssh_host || settings.host,
      port: settings.ssh_port || 22,
      username: settings.ssh_user || 'root',
      password: settings.ssh_password || undefined,
      privateKey: sshKey,
      log: this.log.bind(this),
    });

    // Initialize Floor manager
    this._floorManager = new FloorManager({
      device: this,
      ssh: this._ssh,
      api: this._api,
      mqttClient: this._mqtt,
      log: this.log.bind(this),
    });

    this._previousState = null;
    this._onCarpet = false;
    this._currentSegmentId = null;
    this._dustbinTriggered = false;
    this._knownVersion = null;
    this._updateAlerted = false;
    this._restFailCount = 0;
    this._discoveryAvailable = false;
    this._mapSnapshots = {}; // floorId -> map JSON (in-memory cache for widget preview)
    this._pendingNewFloor = null; // { name, hasDock } when mapping a new floor
    this._waitingForSegments = false; // true while polling map for segment finalization

    // Register capability listeners
    this._registerCapabilityListeners();

    // Setup MQTT event handlers
    this._setupMqttHandlers();

    // Set Valetudo Web UI link with actual host
    this._updateValetudoUrl(settings.host);

    // Connect MQTT (works independently of discovery)
    this._mqtt.connect();

    // On first init, register floor entry
    await this._initFirstFloor();

    // Set current floor display
    this._updateFloorCapability();

    // Default "new floor has dock" toggle to true
    if (this.getCapabilityValue('new_floor_has_dock') === null) {
      this.setCapabilityValue('new_floor_has_dock', true).catch(this.error);
    }

    // Start REST polling (will activate once discovery marks device available)
    this._startRestPolling();

    // Start consumable monitoring
    this._startConsumablePolling();

    // Start update check polling
    this._startUpdateCheckPolling();

    this.log('ValetudoDevice initialized (waiting for discovery...)');
  }

  // --- Homey Discovery API callbacks ---

  onDiscoveryResult(discoveryResult) {
    // Return true if this discovery result matches our device
    return discoveryResult.id === this.getData().id;
  }

  async onDiscoveryAvailable(discoveryResult) {
    // Called by Homey when the device is found on the network
    this.log(`Discovery: device available at ${discoveryResult.address}`);
    this._discoveryAvailable = true;

    // Update host from discovery (address may have changed)
    const newHost = discoveryResult.address;
    this._api.updateHost(newHost);
    this._ssh.updateConfig({ host: newHost });
    this._updateValetudoUrl(newHost);
    await this.setSettings({ host: newHost }).catch(this.error);

    // Now connect: fetch state from REST API
    await this._fetchInitialState();

    // Populate robot diagnostics
    await this._fetchRobotDiagnostics();

    // Fetch consumables and statistics
    await this._updateConsumables();
    await this._updateStatistics();

    // Fetch segments so flow card autocompletes are populated immediately
    await this._fetchAndCacheSegments();

    // Try SSH floor backup if first floor was registered without one
    await this._tryFloorBackup();

    // Cache current map snapshot for the active floor
    await this._cacheCurrentMap();
  }

  onDiscoveryAddressChanged(discoveryResult) {
    // IP address changed, update connection details
    this.log(`Discovery: address changed to ${discoveryResult.address}`);
    const newHost = discoveryResult.address;
    this._api.updateHost(newHost);
    this._ssh.updateConfig({ host: newHost });
    this._updateValetudoUrl(newHost);
    this.setSettings({ host: newHost }).catch(this.error);
    this._fetchInitialState().catch(this.error);
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    // Device may have gone offline, try to reconnect
    this.log('Discovery: last seen changed, attempting reconnect...');
    this._fetchInitialState().catch(this.error);
    this._fetchAndCacheSegments().catch(this.error);
  }

  // Expose for driver flow card access
  get mqttClient() { return this._mqtt; }
  get floorManager() { return this._floorManager; }

  _registerCapabilityListeners() {
    this.registerCapabilityListener('onoff', async (value) => {
      if (value) {
        await this.startCleaning();
      } else {
        await this.stopCleaning();
      }
    });

    this.registerCapabilityListener('fan_speed', async (value) => {
      await this.setFanSpeed(value);
    });

    this.registerCapabilityListener('button_locate', async () => {
      await this.locateRobot();
    });

    this.registerCapabilityListener('button_dock', async () => {
      await this.returnToDock();
    });

    this.registerCapabilityListener('button_refresh_segments', async () => {
      await this.refreshSegments();
    });

    this.registerCapabilityListener('new_floor_has_dock', async (value) => {
      // Just stores the value — read by button_new_floor when pressed
      this.log(`New floor dock toggle set to: ${value}`);
    });

    this.registerCapabilityListener('button_new_floor', async () => {
      if (this._pendingNewFloor) {
        this.setWarning('A new floor is already being mapped — wait for it to finish').catch(this.error);
        this.homey.setTimeout(() => this.unsetWarning().catch(this.error), 10000);
        return;
      }

      const hasDock = this.getCapabilityValue('new_floor_has_dock') !== false;
      let floors = this._floorManager.getFloors();
      const activeFloorId = this._floorManager.getActiveFloor();

      // If no floors exist yet, save the current map as "Floor 1" first
      if (floors.length === 0) {
        this.log('No floors exist yet — saving current map as "Floor 1" first...');
        this.setWarning('Saving current map as Floor 1…').catch(this.error);
        await this.saveFloor('Floor 1', hasDock);
        this._updateFloorPicker();
        floors = this._floorManager.getFloors();
      }

      // Backup the CURRENT floor's map before resetting (this is the key step —
      // the current map belongs to the active floor, not the new one)
      if (activeFloorId) {
        this.log(`Backing up current floor "${activeFloorId}" before creating new floor...`);
        this.setWarning('Backing up current floor…').catch(this.error);
        await this._floorManager.saveCurrentFloor(activeFloorId);
      }

      const name = `Floor ${floors.length + 1}`;
      this.log(`Creating new floor "${name}" (dock: ${hasDock}), then starting new map...`);
      this.setWarning(`Creating "${name}"…`).catch(this.error);

      // Create the new floor entry (store-only — no map files yet, the robot
      // will build them via startNewMap). Auto-save triggers when mapping finishes.
      this._floorManager.createEmptyFloor(name, hasDock)
        .then(async () => {
          this._updateFloorPicker();
          this.setWarning('Starting new map…').catch(this.error);
          await this.startNewMap();
          // Set pending flag — auto-save will happen when mapping finishes
          this._pendingNewFloor = { name, hasDock };
          this.setWarning(`Mapping new floor… will auto-save as "${name}" when done`).catch(this.error);
          this.setCapabilityValue('current_floor', `${name} (mapping)`).catch(this.error);
          this.log(`New floor mapping started, will auto-save as "${name}"`);
        })
        .catch((err) => {
          const msg = this._sshErrorMessage(err);
          this.setWarning(msg).catch(this.error);
          this.log(`New floor creation failed: ${err.message}`);
          this.homey.setTimeout(() => this.unsetWarning().catch(this.error), 30000);
        });
    });

    this.registerCapabilityListener('floor_picker', async (value) => {
      const activeId = this._floorManager.getActiveFloor();
      if (value === activeId) return;

      if (this._pendingNewFloor) {
        // Reset picker and warn
        if (activeId) this.setCapabilityValue('floor_picker', activeId).catch(this.error);
        this.setWarning('Cannot switch floors while mapping is in progress').catch(this.error);
        this.homey.setTimeout(() => this.unsetWarning().catch(this.error), 10000);
        return;
      }

      const floorName = this._floorManager.getFloorName(value) || value;

      // Reset picker to current floor immediately — only update on confirmed success
      if (activeId) {
        this.setCapabilityValue('floor_picker', activeId).catch(this.error);
      }

      // Give immediate feedback and run in background (avoids Homey timeout)
      this.setWarning(`Switching to ${floorName}…`).catch(this.error);

      this.switchFloor(value)
        .then(() => {
          // Now confirmed — update picker to the new floor
          this.setCapabilityValue('floor_picker', value).catch(this.error);
          this._updateFloorPicker();
          this.setWarning(`Switched to ${floorName}`).catch(this.error);
          this.homey.setTimeout(() => this.unsetWarning().catch(this.error), 10000);
          this.setCapabilityValue('current_floor', floorName).catch(this.error);
          this.log(`Floor switch to "${floorName}" complete`);
        })
        .catch((err) => {
          const msg = this._sshErrorMessage(err);
          this.setWarning(msg).catch(this.error);
          this.log(`Floor switch failed: ${err.message}`);
          this.homey.setTimeout(() => this.unsetWarning().catch(this.error), 30000);
        });
    });
  }

  _setupMqttHandlers() {
    this._mqtt.on('battery_level', (level) => {
      this.setCapabilityValue('measure_battery', level).catch(this.error);
      this.setCapabilityValue('alarm_battery', level < LOW_BATTERY_THRESHOLD).catch(this.error);
    });

    this._mqtt.on('vacuum_state', (state) => {
      const mapped = STATE_MAP[state] || 'idle';
      this._updateVacuumState(mapped);
    });

    this._mqtt.on('vacuum_error', (errorMsg) => {
      if (errorMsg && errorMsg !== 'none') {
        this.setCapabilityValue('vacuum_error', errorMsg).catch(this.error);
        this.setCapabilityValue('alarm_error', true).catch(this.error);
        this._triggerError(errorMsg);
        this._classifyError(errorMsg);
      } else {
        this.setCapabilityValue('vacuum_error', '').catch(this.error);
        this.setCapabilityValue('alarm_error', false).catch(this.error);
        this._dustbinTriggered = false;
      }
    });

    this._mqtt.on('fan_speed', (speed) => {
      this.setCapabilityValue('fan_speed', speed).catch(this.error);
    });

    this._mqtt.on('segment_started', ({ id, name }) => {
      this._currentSegmentId = id;
      this.driver._segmentCleaningStartedTrigger
        .trigger(this, { segment_name: name, segment_id: id })
        .catch(this.error);
    });

    this._mqtt.on('segment_finished', ({ id, name }) => {
      if (this._currentSegmentId === id) {
        this._currentSegmentId = null;
      }
      this.driver._segmentCleaningFinishedTrigger
        .trigger(this, { segment_name: name, segment_id: id })
        .catch(this.error);
    });

    this._mqtt.on('carpet_changed', (onCarpet) => {
      this._onCarpet = onCarpet;
    });

    this._mqtt.on('connected', () => {
      this.log('MQTT connected — robot available');
      this.setAvailable().catch(this.error);
      this._restFailCount = 0;
    });

    this._mqtt.on('disconnected', () => {
      this.log('MQTT disconnected — will rely on REST polling');
    });
  }

  _updateVacuumState(state) {
    const previous = this._previousState;
    this._previousState = state;

    this.setCapabilityValue('vacuum_state', state).catch(this.error);

    // Update onoff based on state
    const isOn = state === 'cleaning' || state === 'returning' || state === 'moving';
    this.setCapabilityValue('onoff', isOn).catch(this.error);

    // Clear error alarm when state is no longer error
    if (state !== 'error') {
      this.setCapabilityValue('alarm_error', false).catch(this.error);
    }

    // Trigger flow cards for state transitions
    if (previous && previous !== state) {
      if (state === 'cleaning' && previous !== 'cleaning') {
        this.driver._cleaningStartedTrigger.trigger(this).catch(this.error);
      }
      if (previous === 'cleaning' && state !== 'cleaning' && state !== 'paused') {
        this._triggerCleaningFinished();
      }

      // Auto-save new floor when mapping run finishes
      // Robot transitions to idle (no dock) or docked (with dock) or error (dock not found)
      if (this._pendingNewFloor && (state === 'idle' || state === 'docked' || state === 'error')) {
        if (previous === 'cleaning' || previous === 'returning' || previous === 'moving') {
          this._autoSaveNewFloor();
        }
      }
    }
  }

  async _autoSaveNewFloor() {
    const pending = this._pendingNewFloor;
    if (!pending) return;
    if (this._waitingForSegments) return; // prevent re-entry from repeated state changes

    this._waitingForSegments = true;
    const { name, hasDock } = pending;
    const settings = this.getSettings();
    const timeoutMs = parseInt(settings.segment_wait_timeout || '300', 10) * 1000;

    this.log(`Mapping run finished — waiting for firmware to finalize map with segments before saving "${name}"`);
    this.setWarning(`Waiting for "${name}" map to finalize…`).catch(this.error);

    // Poll map API until segment layers appear (firmware may process segments after docking)
    // If segments don't appear within the initial wait, trigger segmentation manually.
    const startTime = Date.now();
    let segmentsFound = false;
    let segmentationTriggered = false;
    const triggerAfterMs = 30000; // Trigger segmentation manually after 30s without segments

    while (Date.now() - startTime < timeoutMs) {
      await new Promise((resolve) => { this.homey.setTimeout(resolve, SEGMENT_POLL_INTERVAL_MS); });

      // Safety: abort if _pendingNewFloor was cleared externally
      if (!this._pendingNewFloor) {
        this.log('Segment wait aborted — pending floor was cleared');
        this._waitingForSegments = false;
        return;
      }

      // If no segments appeared after initial wait, trigger segmentation manually
      if (!segmentationTriggered && Date.now() - startTime >= triggerAfterMs) {
        segmentationTriggered = true;
        this.log('No segments after initial wait — triggering manual segmentation...');
        this.setWarning(`Triggering segmentation for "${name}"…`).catch(this.error);
        try {
          await this._floorManager.triggerSegmentation();
        } catch (err) {
          this.log('Manual segmentation trigger failed:', err.message);
        }
      }

      try {
        const mapData = await this._api.getMap();
        if (mapData && mapData.layers) {
          const hasSegments = mapData.layers.some((l) => l.type === 'segment');
          if (hasSegments) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            this.log(`Segments found in map after ${elapsed}s — map is finalized`);
            segmentsFound = true;
            break;
          }
        }
        const waited = Math.round((Date.now() - startTime) / 1000);
        this.log(`No segments in map yet (${waited}s elapsed), continuing to wait…`);
        this.setWarning(`Waiting for "${name}" map to finalize… (${waited}s)`).catch(this.error);
      } catch (err) {
        this.log('Map poll failed during segment wait:', err.message);
      }
    }

    if (!segmentsFound) {
      this.log(`Timed out waiting for segments after ${timeoutMs / 1000}s — saving map without segments`);
      this.setWarning(`Map finalization timed out — saving "${name}" without segments`).catch(this.error);
    } else {
      this.setWarning(`Map finalized — saving "${name}"…`).catch(this.error);
    }

    // Save the floor
    try {
      await this.saveFloor(name, hasDock);
      this._pendingNewFloor = null;
      this._waitingForSegments = false;
      this._updateFloorPicker();
      this.setCapabilityValue('current_floor', name).catch(this.error);
      this.setWarning(`Floor "${name}" saved`).catch(this.error);
      this.homey.setTimeout(() => this.unsetWarning().catch(this.error), 10000);
      this.log(`Auto-saved new floor "${name}" successfully`);
    } catch (err) {
      this._pendingNewFloor = null;
      this._waitingForSegments = false;
      const msg = this._sshErrorMessage(err);
      this.setWarning(`Auto-save failed: ${msg}`).catch(this.error);
      this.log(`Auto-save of "${name}" failed: ${err.message}`);
      this.homey.setTimeout(() => this.unsetWarning().catch(this.error), 30000);
    }
  }

  _triggerError(message) {
    this.driver._errorOccurredTrigger.trigger(this, { error_message: message }).catch(this.error);
  }

  _classifyError(message) {
    const lower = message.toLowerCase();
    // Detect stuck conditions
    if (lower.includes('stuck') || lower.includes('trapped') || lower.includes('wheel')) {
      this.driver._robotStuckTrigger
        .trigger(this, { error_message: message })
        .catch(this.error);
    }
    // Detect dustbin full
    if ((lower.includes('dustbin') || lower.includes('dust bin') || lower.includes('bin full'))
        && !this._dustbinTriggered) {
      this._dustbinTriggered = true;
      this.driver._dustbinFullTrigger.trigger(this).catch(this.error);
    }
  }

  async _fetchRobotDiagnostics() {
    try {
      const robotInfo = await this._api.getRobotInfo();
      await this.setSettings({
        robot_model: robotInfo.modelName || 'Unknown',
        robot_manufacturer: robotInfo.manufacturer || 'Unknown',
      });
    } catch (err) {
      this.log('Robot info fetch failed:', err.message);
    }
    try {
      const version = await this._api.getVersion();
      await this.setSettings({ valetudo_version: version.release || 'Unknown' });
    } catch (err) {
      this.log('Valetudo version fetch failed:', err.message);
    }
  }

  async _fetchInitialState() {
    try {
      const attrs = await this._api.getStateAttributes();

      for (const attr of attrs) {
        switch (attr.__class) {
          case 'BatteryStateAttribute':
            if (typeof attr.level === 'number') {
              await this.setCapabilityValue('measure_battery', attr.level);
              await this.setCapabilityValue('alarm_battery', attr.level < LOW_BATTERY_THRESHOLD);
            }
            break;
          case 'StatusStateAttribute':
            if (attr.value) {
              const mapped = STATE_MAP[attr.value] || 'idle';
              this._updateVacuumState(mapped);
            }
            break;
          case 'PresetSelectionStateAttribute':
            if (attr.type === 'fan_speed' && attr.value) {
              await this.setCapabilityValue('fan_speed', attr.value);
            }
            break;
          default:
            break;
        }
      }

      this._restFailCount = 0;
      await this.setAvailable();
    } catch (err) {
      this._restFailCount++;
      this.log(`Failed to fetch state (attempt ${this._restFailCount}):`, err.message);
      // Only mark unavailable after 3 consecutive failures (90 seconds)
      if (this._restFailCount >= 3) {
        const host = this.getSettings().host || 'unknown';
        const reason = err.code === 'ECONNREFUSED' ? 'Connection refused'
          : err.code === 'ETIMEDOUT' ? 'Connection timed out'
            : err.code === 'EHOSTUNREACH' ? 'Host unreachable'
              : 'Cannot connect';
        await this.setUnavailable(`${reason} — check that the robot (${host}) is powered on and on the network`);
      }
    }
  }

  _updateFloorCapability() {
    const floorName = this._floorManager.getActiveFloorName();
    this.setCapabilityValue('current_floor', floorName || 'Unknown').catch(this.error);
    this._updateFloorPicker();
  }

  _updateFloorPicker() {
    const floors = this._floorManager.getFloors();
    const activeId = this._floorManager.getActiveFloor();

    if (floors.length === 0) return;

    const values = floors.map((f) => ({
      id: f.id,
      title: { en: f.name },
    }));

    this.setCapabilityOptions('floor_picker', { values }).catch(this.error);
    if (activeId) {
      this.setCapabilityValue('floor_picker', activeId).catch(this.error);
    }
  }

  _startRestPolling() {
    this._pollInterval = this.homey.setInterval(async () => {
      // Only poll REST if MQTT is not connected and discovery has found us
      if (this._mqtt.connected) return;
      if (!this._discoveryAvailable) return;

      try {
        await this._fetchInitialState();
      } catch (err) {
        this.log('REST poll failed:', err.message);
      }
    }, REST_POLL_INTERVAL_MS);
  }

  async _tryFloorBackup() {
    const floors = this._floorManager.getFloors();
    if (floors.length === 0) return;

    const activeId = this._floorManager.getActiveFloor();
    if (!activeId) return;

    // Check if the floor already has a map backup on the robot
    try {
      const hasSaved = await this._floorManager.isFloorSaved(activeId);
      if (hasSaved) {
        this.log(`Floor "${activeId}" already has a map backup`);
        return;
      }

      // Check if the robot has an existing map (last_map) that we can preserve
      const robotHasMap = await this._ssh.fileExists('/mnt/data/rockrobo/last_map');
      if (robotHasMap) {
        this.log(`Robot has an existing map — preserving it as "${activeId}" backup`);
        await this._floorManager.saveCurrentFloor(activeId);
        this.log('Existing map preserved as floor backup successfully');
      } else {
        this.log('Robot has no existing map to preserve');
      }
    } catch (err) {
      this.log('Floor backup skipped:', err.message);
    }
  }

  _updateValetudoUrl(host) {
    const url = host ? `http://${host}` : 'http://';
    this.setSettings({ valetudo_url: url }).catch(this.error);
  }

  async _secureSshKey(settings) {
    const settingsKey = settings.ssh_private_key;
    if (settingsKey) {
      // User pasted a key in the textarea — move it to secure store and clear the field
      await this.setStoreValue('ssh_private_key', settingsKey);
      await this.setSettings({ ssh_private_key: '' });
      this.log('SSH key saved to secure store');
    }
  }

  async _initFirstFloor() {
    const floors = this._floorManager.getFloors();
    if (floors.length > 0) return;

    const name = 'Floor 1';
    const id = 'floor_1';

    // Always register the floor in the store so the UI shows it
    try {
      await this._floorManager.addFloor(id, name);
      await this._floorManager.setFloorDock(id, true);
      // Set as active floor
      const config = this._floorManager._getStore();
      config.activeFloor = id;
      await this._floorManager._setStore(config);
      this.log(`Registered "${name}" in floor config`);
    } catch (err) {
      this.log('Could not register initial floor:', err.message);
      return;
    }

    // Try to backup map files via SSH (optional, will work when SSH is available)
    try {
      await this._floorManager.saveCurrentFloor(id);
      this.log('First floor map backup saved successfully');
    } catch (err) {
      this.log('Map backup skipped (SSH not available yet):', err.message);
    }
  }

  // --- Public methods for widget floor management ---

  async renameFloor(floorId, newName) {
    await this._floorManager.renameFloor(floorId, newName);
    this._updateFloorCapability();
    this._updateFloorPicker();
  }

  async deleteFloor(floorId) {
    const activeId = this._floorManager.getActiveFloor();
    if (floorId === activeId) throw new Error('Cannot delete the active floor');
    await this._floorManager.removeFloor(floorId);
    delete this._mapSnapshots[floorId];
    this._updateFloorCapability();
    this._updateFloorPicker();
  }

  // --- Public methods for flow card actions ---

  async startCleaning() {
    if (this._pendingNewFloor) {
      throw new Error('Cannot start cleaning while a new floor map is being finalized');
    }
    if (this._mqtt.connected) {
      this._mqtt.basicControl('start');
    } else {
      await this._api.basicControl('start');
    }
  }

  async stopCleaning() {
    if (this._mqtt.connected) {
      this._mqtt.basicControl('stop');
    } else {
      await this._api.basicControl('stop');
    }
  }

  async pauseCleaning() {
    if (this._mqtt.connected) {
      this._mqtt.basicControl('pause');
    } else {
      await this._api.basicControl('pause');
    }
  }

  async returnToDock() {
    // If active floor has no dock, stop instead of trying to dock
    if (!this._floorManager.activeFloorHasDock()) {
      await this.stopCleaning();
      return;
    }
    if (this._mqtt.connected) {
      this._mqtt.basicControl('home');
    } else {
      await this._api.basicControl('home');
    }
  }

  async setFanSpeed(speed) {
    if (this._mqtt.connected) {
      this._mqtt.setFanSpeed(speed);
    } else {
      await this._api.setFanSpeed(speed);
    }
  }

  async cleanSegment(segmentId, iterations = 1) {
    if (this._pendingNewFloor) {
      throw new Error('Cannot start segment cleaning while a new floor map is being finalized');
    }
    if (this._mqtt.connected) {
      this._mqtt.cleanSegments([segmentId], iterations);
    } else {
      await this._api.cleanSegments([segmentId], iterations);
    }
  }

  async locateRobot() {
    if (this._mqtt.connected) {
      this._mqtt.locate();
    } else {
      await this._api.locateRobot();
    }
  }

  isMappingNewFloor() {
    return !!this._pendingNewFloor;
  }

  async switchFloor(floorId) {
    if (this._pendingNewFloor) {
      throw new Error('Cannot switch floors while mapping is in progress. Wait for the new map to be finalized.');
    }
    // Cache current floor's map before switching
    await this._cacheCurrentMap();
    const floor = await this._floorManager.switchFloor(floorId);
    this._updateFloorCapability();
    // Cache the new floor's map after switch
    await this._cacheCurrentMap();
    // Clear stale segments from the previous floor — the new floor's segments will be
    // fetched when the robot comes back online after reboot (onDiscoveryLastSeenChanged)
    this._mqtt.clearSegments();
    this.driver._floorSwitchedTrigger.trigger(this, { floor_name: floor.name }).catch(this.error);
    return floor;
  }

  async refreshSegments() {
    await this._fetchAndCacheSegments();
  }

  async getSegments() {
    await this._fetchAndCacheSegments();
    if (this._mqtt) return this._mqtt.segments;
    // _mqtt not yet initialised — call REST directly and return a plain object
    try {
      const list = await this._api.getSegments();
      return Object.fromEntries((list || []).map(({ id, name }) => [id, name]));
    } catch {
      return {};
    }
  }

  async saveFloor(name, hasDock = true) {
    // Cache current map before saving as new floor
    await this._cacheCurrentMap();
    const floor = await this._floorManager.saveAsNewFloor(name, hasDock);
    this._updateFloorCapability();
    return floor;
  }

  getVacuumState() {
    return this.getCapabilityValue('vacuum_state') || 'idle';
  }

  isOnCarpet() {
    return this._onCarpet;
  }

  isInSegment(segmentId) {
    return this._mqtt.activeSegmentIds.has(String(segmentId));
  }

  async isDndEnabled() {
    try {
      const dnd = await this._api.getDoNotDisturb();
      return dnd.enabled === true;
    } catch {
      return false;
    }
  }

  async isCarpetModeEnabled() {
    try {
      const result = await this._api.getToggle('CarpetModeControlCapability');
      return result.enabled === true;
    } catch {
      return false;
    }
  }

  // --- New action methods ---

  async setWaterUsage(level) {
    await this._api.setWaterUsage(level);
  }

  async setOperationMode(mode) {
    await this._api.setOperationMode(mode);
  }

  async setSpeakerVolume(volume) {
    await this._api.setSpeakerVolume(volume);
  }

  async playTestSound() {
    await this._api.playTestSound();
  }

  async triggerAutoEmpty() {
    await this._api.triggerAutoEmpty();
  }

  async setDnd(enabled) {
    await this._api.setDoNotDisturb(enabled);
  }

  async setCarpetMode(enabled) {
    await this._api.setToggle('CarpetModeControlCapability', enabled);
  }

  async goToLocation(x, y) {
    await this._api.goToLocation(x, y);
  }

  async resetConsumable(type, subType) {
    await this._api.resetConsumable(type, subType);
  }

  // --- Zone Management ---

  getZones() {
    const store = this.getStoreValue('zones') || {};
    return Object.entries(store).map(([id, zone]) => ({
      id,
      name: zone.name,
      coordinates: zone.coordinates,
    }));
  }

  async saveZone(name, x1, y1, x2, y2) {
    const zones = this.getStoreValue('zones') || {};
    const id = `zone_${Date.now()}`;
    zones[id] = {
      name,
      coordinates: { x1, y1, x2, y2 },
    };
    await this.setStoreValue('zones', zones);
    return { id, name };
  }

  async deleteZone(zoneId) {
    const zones = this.getStoreValue('zones') || {};
    delete zones[zoneId];
    await this.setStoreValue('zones', zones);
  }

  async cleanZone(zoneId, iterations = 1) {
    const zones = this.getStoreValue('zones') || {};
    const zone = zones[zoneId];
    if (!zone) throw new Error('Zone not found');
    const { x1, y1, x2, y2 } = zone.coordinates;
    const zoneSpec = [{ points: { pA: { x: x1, y: y1 }, pB: { x: x2, y: y1 }, pC: { x: x2, y: y2 }, pD: { x: x1, y: y2 } } }];
    await this._api.cleanZones(zoneSpec, iterations);
  }

  // --- Map Management ---

  async startNewMap() {
    await this._api.resetMap();
    try {
      await this._api.startMappingPass();
    } catch {
      // MappingPassCapability may not be supported, fall back to regular cleaning
      await this._api.basicControl('start');
    }
  }

  // --- Voice Pack ---

  async installVoicePack(url, language) {
    await this._api.installVoicePack(url, language);
  }

  async renameSegment(segmentId, name) {
    await this._api.renameSegment(segmentId, name);
    // Update local MQTT segment cache
    if (this._mqtt.segments) {
      this._mqtt.segments[segmentId] = name;
    }
  }

  async _fetchAndCacheSegments() {
    try {
      const segments = await this._api.getSegments();
      if (Array.isArray(segments) && segments.length > 0) {
        this._mqtt.seedSegments(segments);
        this.log(`Fetched ${segments.length} segments via REST`);
      }
    } catch (err) {
      // MapSegmentationCapability may not be supported on all robots
      this.log('Segment fetch skipped:', err.message);
    }
  }

  async _triggerCleaningFinished() {
    this.driver._cleaningFinishedTrigger.trigger(this).catch(this.error);

    // Refresh statistics capabilities
    await this._updateStatistics();

    // Refresh segments — Valetudo may have re-segmented the map after cleaning
    await this._fetchAndCacheSegments();
  }

  async _updateStatistics() {
    // Current session stats
    try {
      const current = await this._api.getCurrentStatistics();
      this.log(`Current statistics: ${JSON.stringify(current)}`);
      for (const stat of current) {
        if (stat.type === 'area') {
          await this.setCapabilityValue('measure_clean_area_last', Math.round(stat.value / 10000));
        } else if (stat.type === 'time') {
          await this.setCapabilityValue('measure_clean_duration_last', Math.round(stat.value / 60));
        }
      }
    } catch (err) {
      this.log('Current statistics update failed:', err.message);
    }

    // Total stats
    try {
      const total = await this._api.getTotalStatistics();
      this.log(`Total statistics: ${JSON.stringify(total)}`);
      for (const stat of total) {
        if (stat.type === 'area') {
          await this.setCapabilityValue('measure_clean_area_total', Math.round(stat.value / 10000));
        } else if (stat.type === 'time') {
          await this.setCapabilityValue('measure_clean_duration_total', Math.round(stat.value / 3600)); // sec -> hrs
        }
      }
    } catch (err) {
      this.log('Total statistics update failed:', err.message);
    }
  }

  _startConsumablePolling() {
    this._consumablePollInterval = this.homey.setInterval(async () => {
      if (!this._discoveryAvailable && !this._mqtt.connected) return;
      await this._updateConsumables();
    }, CONSUMABLE_POLL_INTERVAL_MS);
  }

  async _updateConsumables() {
    try {
      const consumables = await this._api.getConsumables();
      this.log(`Consumables: ${consumables.length} items`);

      // Track which consumable capabilities are reported by the robot
      const reportedCaps = new Set();

      for (const c of consumables) {
        const capId = this._consumableCapabilityId(c.type, c.subType);
        if (!capId || !c.remaining) continue;

        reportedCaps.add(capId);

        // Dynamically add capability if not present
        if (!this.hasCapability(capId)) {
          await this.addCapability(capId);
          this.log(`Added consumable capability: ${capId}`);
        }

        let minutes;
        if (c.remaining.unit === 'minutes') {
          minutes = c.remaining.value;
        } else if (c.remaining.unit === 'percent') {
          this.setCapabilityValue(capId, `${c.remaining.value}%`).catch(this.error);
          continue;
        } else {
          continue;
        }

        const formatted = this._formatMinutes(minutes);
        this.setCapabilityValue(capId, formatted).catch(this.error);

        // Trigger depleted alert when less than 5% of typical max remains
        const maxMinutes = this._consumableMaxMinutes(c.type, c.subType);
        const pct = (minutes / maxMinutes) * 100;
        if (pct <= CONSUMABLE_DEPLETED_THRESHOLD) {
          this.driver._consumableDepletedTrigger.trigger(this, {
            consumable_type: c.type,
            consumable_sub_type: c.subType || 'none',
            remaining: formatted,
          }).catch(this.error);
        }
      }

      // Remove consumable capabilities the robot doesn't report
      const allConsumableCaps = [
        'measure_consumable_filter',
        'measure_consumable_main_brush',
        'measure_consumable_side_brush',
        'measure_consumable_mop',
        'measure_consumable_sensor',
      ];
      for (const capId of allConsumableCaps) {
        if (!reportedCaps.has(capId) && this.hasCapability(capId)) {
          await this.removeCapability(capId);
          this.log(`Removed unsupported consumable capability: ${capId}`);
        }
      }
    } catch (err) {
      this.log('Consumable update failed:', err.message);
    }
  }

  _formatMinutes(totalMinutes) {
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const mins = Math.round(totalMinutes % 60);
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || days > 0) parts.push(`${hours}h`);
    parts.push(`${mins}m`);
    return parts.join(' ');
  }

  _consumableCapabilityId(type, subType) {
    const key = `${type}:${subType || 'none'}`;
    const map = {
      'filter:none': 'measure_consumable_filter',
      'filter:main': 'measure_consumable_filter',
      'brush:main': 'measure_consumable_main_brush',
      'brush:side_right': 'measure_consumable_side_brush',
      'mop:none': 'measure_consumable_mop',
      'mop:main': 'measure_consumable_mop',
      'sensor:all': 'measure_consumable_sensor',
      'cleaning:sensor': 'measure_consumable_sensor',
    };
    return map[key] || null;
  }

  async _cacheCurrentMap() {
    try {
      const activeId = this._floorManager.getActiveFloor();
      if (!activeId) return;
      const mapData = await this._api.getMap();
      this._mapSnapshots[activeId] = mapData;
      this.log(`Cached map snapshot for ${activeId}`);
    } catch (err) {
      this.log('Map cache failed:', err.message);
    }
  }

  getMapSnapshot(floorId) {
    return this._mapSnapshots[floorId] || null;
  }

  getFloorList() {
    const floors = this._floorManager.getFloors();
    const activeId = this._floorManager.getActiveFloor();
    return {
      floors: floors.map((f) => ({
        id: f.id,
        name: f.name,
        hasDock: f.hasDock !== false,
        // All registered floors have verified map files on the robot
        hasCachedMap: true,
      })),
      activeFloor: activeId,
    };
  }

  _sshErrorMessage(err) {
    const msg = err.message || String(err);
    if (msg.includes('authentication') || msg.includes('auth')) {
      return 'SSH login failed — configure SSH password or key in device settings';
    }
    if (msg.includes('ECONNREFUSED') || msg.includes('EHOSTUNREACH') || msg.includes('ETIMEDOUT')) {
      return 'Cannot reach robot via SSH — check SSH host/port in settings';
    }
    return `Floor switch failed: ${msg}`;
  }

  _consumableMaxMinutes(type, subType) {
    const key = `${type}:${subType || 'none'}`;
    const defaults = {
      'brush:main': 18000,
      'brush:side_right': 12000,
      'filter:main': 9000,
      'filter:none': 9000,
      'cleaning:sensor': 1800,
      'sensor:all': 1800,
      'mop:none': 12000,
      'mop:main': 12000,
    };
    return defaults[key] || 18000;
  }

  _startUpdateCheckPolling() {
    // Check immediately on startup
    this._checkForUpdates();

    this._updateCheckInterval = this.homey.setInterval(async () => {
      await this._checkForUpdates();
    }, UPDATE_CHECK_INTERVAL_MS);
  }

  async _checkForUpdates() {
    try {
      const version = await this._api.getVersion();
      const currentVersion = version.release;

      // Detect version change (robot was updated)
      if (this._knownVersion && this._knownVersion !== currentVersion) {
        this.driver._valetudoUpdatedTrigger
          .trigger(this, { old_version: this._knownVersion, new_version: currentVersion })
          .catch(this.error);
        this._updateAlerted = false;
      }
      this._knownVersion = currentVersion;

      // Check if an update is available
      await this._api.checkForUpdates();
      // Wait a moment for the check to complete
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const updaterState = await this._api.getUpdaterState();

      if (updaterState.__class === 'ValetudoUpdaterApplicableState' && !this._updateAlerted) {
        this._updateAlerted = true;
        this.driver._updateAvailableTrigger
          .trigger(this, { current_version: currentVersion })
          .catch(this.error);
      }
    } catch {
      // Update check is optional
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    // Update REST API client
    if (changedKeys.includes('host') || changedKeys.includes('valetudo_auth_user') || changedKeys.includes('valetudo_auth_pass')) {
      this._api.updateHost(newSettings.host);
      this._api.updateAuth(newSettings.valetudo_auth_user, newSettings.valetudo_auth_pass);
      if (changedKeys.includes('host')) {
        this._updateValetudoUrl(newSettings.host);
      }
    }

    // Update MQTT client
    if (changedKeys.some((k) => k.startsWith('mqtt_'))) {
      this._mqtt.updateConfig({
        broker: newSettings.mqtt_broker,
        username: newSettings.mqtt_username,
        password: newSettings.mqtt_password,
        topicPrefix: newSettings.mqtt_topic_prefix,
        identifier: newSettings.mqtt_identifier,
      });
    }

    // Install voice pack if URL was set
    if (changedKeys.includes('voice_pack_url') && newSettings.voice_pack_url) {
      this.installVoicePack(newSettings.voice_pack_url, newSettings.voice_pack_language || 'en')
        .then(() => this.log('Voice pack installation triggered'))
        .catch((err) => this.log('Voice pack installation failed:', err.message));
    }

    // Update SSH client
    if (changedKeys.some((k) => k.startsWith('ssh_'))) {
      let sshKey = this.getStoreValue('ssh_private_key') || undefined;

      if (changedKeys.includes('ssh_private_key') && newSettings.ssh_private_key) {
        // User pasted a new key — save to secure store and clear the textarea
        sshKey = newSettings.ssh_private_key;
        await this.setStoreValue('ssh_private_key', sshKey);
        this.homey.setTimeout(() => {
          this.setSettings({ ssh_private_key: '' }).catch(this.error);
        }, 500);
        this.log('SSH key saved to secure store');
      }

      this._ssh.updateConfig({
        host: newSettings.ssh_host || newSettings.host,
        port: newSettings.ssh_port,
        username: newSettings.ssh_user,
        password: newSettings.ssh_password || undefined,
        privateKey: sshKey,
      });
    }
  }

  onDeleted() {
    this.log('ValetudoDevice deleted, cleaning up');
    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
    }
    if (this._consumablePollInterval) {
      this.homey.clearInterval(this._consumablePollInterval);
    }
    if (this._updateCheckInterval) {
      this.homey.clearInterval(this._updateCheckInterval);
    }
    this._mqtt.disconnect();
    this._ssh.disconnect();
  }

}

module.exports = ValetudoDevice;
