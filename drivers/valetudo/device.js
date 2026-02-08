'use strict';

const Homey = require('homey');
const ValetudoApi = require('../../lib/ValetudoApi');
const ValetudoMqtt = require('../../lib/ValetudoMqtt');
const SshManager = require('../../lib/SshManager');
const FloorManager = require('../../lib/FloorManager');

const REST_POLL_INTERVAL_MS = 30000;
const CONSUMABLE_POLL_INTERVAL_MS = 3600000; // 1 hour
const UPDATE_CHECK_INTERVAL_MS = 86400000; // 24 hours
const CONSUMABLE_DEPLETED_THRESHOLD = 10; // percent
const LOW_BATTERY_THRESHOLD = 20;
const SSH_KEY_MASK = '********';

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

    // Migrate SSH key from settings to secure store on first run
    await this._migrateSshKey(settings);
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

    // Register capability listeners
    this._registerCapabilityListeners();

    // Setup MQTT event handlers
    this._setupMqttHandlers();

    // Set Valetudo Web UI link with actual host
    this._updateValetudoUrl(settings.host);

    // Connect MQTT
    this._mqtt.connect();

    // Fetch initial state from REST API
    await this._fetchInitialState();

    // On first init, save the current map as "Floor 1"
    await this._initFirstFloor();

    // Set current floor display
    this._updateFloorCapability();

    // Start REST polling as fallback
    this._startRestPolling();

    // Start consumable monitoring
    this._startConsumablePolling();

    // Fetch initial statistics
    await this._updateStatistics();

    // Start update check polling
    this._startUpdateCheckPolling();

    this.log('ValetudoDevice initialized');
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

    this.registerCapabilityListener('button_dock', async () => {
      await this.returnToDock();
    });

    this.registerCapabilityListener('button_new_floor', async () => {
      let floors = this._floorManager.getFloors();

      // If no floors exist yet, save the current map as "Floor 1" first
      if (floors.length === 0) {
        this.log('No floors exist yet — saving current map as "Floor 1" first...');
        await this.saveFloor('Floor 1');
        this._updateFloorPicker();
        floors = this._floorManager.getFloors();
      }

      const name = `Floor ${floors.length + 1}`;
      this.log(`Saving current map as "${name}", then starting new map...`);
      await this.saveFloor(name);
      this._updateFloorPicker();
      await this.startNewMap();
    });

    this.registerCapabilityListener('floor_picker', async (value) => {
      const activeId = this._floorManager.getActiveFloor();
      if (value !== activeId) {
        await this.switchFloor(value);
        this._updateFloorPicker();
      }
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
        this._triggerError(errorMsg);
        this._classifyError(errorMsg);
      } else {
        this.setCapabilityValue('vacuum_error', '').catch(this.error);
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
      this.setAvailable().catch(this.error);
    });

    this._mqtt.on('disconnected', () => {
      // Don't mark unavailable immediately — REST polling will handle it
    });
  }

  _updateVacuumState(state) {
    const previous = this._previousState;
    this._previousState = state;

    this.setCapabilityValue('vacuum_state', state).catch(this.error);

    // Update onoff based on state
    const isOn = state === 'cleaning' || state === 'returning' || state === 'moving';
    this.setCapabilityValue('onoff', isOn).catch(this.error);

    // Trigger flow cards for state transitions
    if (previous && previous !== state) {
      if (state === 'cleaning' && previous !== 'cleaning') {
        this.driver._cleaningStartedTrigger.trigger(this).catch(this.error);
      }
      if (previous === 'cleaning' && state !== 'cleaning' && state !== 'paused') {
        this._triggerCleaningFinished();
      }
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

      await this.setAvailable();
    } catch (err) {
      this.log('Failed to fetch initial state:', err.message);
      await this.setUnavailable('Cannot reach Valetudo');
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
      // Only poll REST if MQTT is not connected
      if (this._mqtt.connected) return;

      try {
        await this._fetchInitialState();
      } catch (err) {
        this.log('REST poll failed:', err.message);
      }
    }, REST_POLL_INTERVAL_MS);
  }

  _updateValetudoUrl(host) {
    const url = host ? `http://${host}` : 'http://';
    this.setSettings({ valetudo_url: url }).catch(this.error);
  }

  async _migrateSshKey(settings) {
    const settingsKey = settings.ssh_private_key;
    const storedKey = this.getStoreValue('ssh_private_key');

    // If settings has a real key (not the mask and not empty), migrate it to store
    if (settingsKey && settingsKey !== SSH_KEY_MASK) {
      await this.setStoreValue('ssh_private_key', settingsKey);
      // Mask it in settings so it's not visible in the UI
      await this.setSettings({ ssh_private_key: SSH_KEY_MASK });
      this.log('SSH key migrated to secure store');
    } else if (!storedKey && (!settingsKey || settingsKey === SSH_KEY_MASK)) {
      // No key anywhere — ensure settings shows empty
      if (settingsKey === SSH_KEY_MASK) {
        await this.setSettings({ ssh_private_key: '' });
      }
    }
  }

  async _initFirstFloor() {
    const floors = this._floorManager.getFloors();
    if (floors.length > 0) return;

    try {
      this.log('First init: saving current map as "Floor 1"...');
      await this._floorManager.saveAsNewFloor('Floor 1', true);
      this.log('First floor saved successfully');
    } catch (err) {
      this.log('Could not save initial floor (SSH may not be configured yet):', err.message);
    }
  }

  // --- Public methods for flow card actions ---

  async startCleaning() {
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

  async switchFloor(floorId) {
    const floor = await this._floorManager.switchFloor(floorId);
    this._updateFloorCapability();
    this.driver._floorSwitchedTrigger.trigger(this, { floor_name: floor.name }).catch(this.error);
    return floor;
  }

  async saveFloor(name, hasDock = true) {
    const floor = await this._floorManager.saveAsNewFloor(name, hasDock);
    this._updateFloorCapability();
    return floor;
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

  async _triggerCleaningFinished() {
    this.driver._cleaningFinishedTrigger.trigger(this).catch(this.error);

    // Refresh statistics capabilities
    await this._updateStatistics();
  }

  async _updateStatistics() {
    // Current session stats
    try {
      const current = await this._api.getCurrentStatistics();
      for (const stat of current) {
        if (stat.type === 'area') {
          await this.setCapabilityValue('measure_clean_area_last', Math.round(stat.value / 10000));
        } else if (stat.type === 'time') {
          await this.setCapabilityValue('measure_clean_duration_last', Math.round(stat.value / 60));
        }
      }
    } catch {
      // Not all robots support CurrentStatisticsCapability
    }

    // Total stats
    try {
      const total = await this._api.getTotalStatistics();
      for (const stat of total) {
        if (stat.type === 'area') {
          await this.setCapabilityValue('measure_clean_area_total', Math.round(stat.value / 10000));
        } else if (stat.type === 'time') {
          await this.setCapabilityValue('measure_clean_duration_total', Math.round(stat.value / 3600)); // sec -> hrs
        }
      }
    } catch {
      // Not all robots support TotalStatisticsCapability
    }
  }

  _startConsumablePolling() {
    // Fetch immediately on startup
    this._updateConsumables();

    this._consumablePollInterval = this.homey.setInterval(async () => {
      await this._updateConsumables();
    }, CONSUMABLE_POLL_INTERVAL_MS);
  }

  async _updateConsumables() {
    try {
      const consumables = await this._api.getConsumables();
      for (const c of consumables) {
        // Update capability value
        const capId = this._consumableCapabilityId(c.type, c.subType);
        if (capId && c.remaining && c.remaining.unit === 'percent') {
          this.setCapabilityValue(capId, c.remaining.value).catch(this.error);
        }

        // Trigger depleted alert
        if (c.remaining && c.remaining.unit === 'percent'
            && c.remaining.value <= CONSUMABLE_DEPLETED_THRESHOLD) {
          this.driver._consumableDepletedTrigger.trigger(this, {
            consumable_type: c.type,
            consumable_sub_type: c.subType || 'none',
            remaining: c.remaining.value,
          }).catch(this.error);
        }
      }
    } catch {
      // Consumable monitoring is optional — not all robots support it
    }
  }

  _consumableCapabilityId(type, subType) {
    const key = `${type}:${subType || 'none'}`;
    const map = {
      'filter:none': 'measure_consumable_filter',
      'brush:main': 'measure_consumable_main_brush',
      'brush:side_right': 'measure_consumable_side_brush',
      'mop:none': 'measure_consumable_mop',
      'sensor:all': 'measure_consumable_sensor',
    };
    return map[key] || null;
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

      if (changedKeys.includes('ssh_private_key')) {
        const newKey = newSettings.ssh_private_key;
        if (newKey && newKey !== SSH_KEY_MASK) {
          // User entered a new real key — save to store and mask in settings
          await this.setStoreValue('ssh_private_key', newKey);
          sshKey = newKey;
          // Schedule masking after settings save completes
          setTimeout(() => {
            this.setSettings({ ssh_private_key: SSH_KEY_MASK }).catch(this.error);
          }, 500);
        } else if (!newKey) {
          // User cleared the key
          await this.setStoreValue('ssh_private_key', '');
          sshKey = undefined;
        }
        // If newKey === SSH_KEY_MASK, the user didn't change it — keep stored key
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
