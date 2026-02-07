'use strict';

const axios = require('axios');

class ValetudoApi {

  constructor({ host, authUser, authPass, log }) {
    this._log = log || console.log;
    this._host = host;
    this._auth = authUser ? { username: authUser, password: authPass || '' } : undefined;
    this._client = axios.create({
      baseURL: `http://${host}`,
      timeout: 10000,
      auth: this._auth,
    });
  }

  updateHost(host) {
    this._host = host;
    this._client.defaults.baseURL = `http://${host}`;
  }

  updateAuth(authUser, authPass) {
    this._auth = authUser ? { username: authUser, password: authPass || '' } : undefined;
    this._client.defaults.auth = this._auth;
  }

  async getRobotInfo() {
    const { data } = await this._client.get('/api/v2/robot');
    return data;
  }

  async getCapabilities() {
    const { data } = await this._client.get('/api/v2/robot/capabilities');
    return data;
  }

  async getStateAttributes() {
    const { data } = await this._client.get('/api/v2/robot/state/attributes');
    return data;
  }

  async getSegments() {
    const { data } = await this._client.get('/api/v2/robot/capabilities/MapSegmentationCapability');
    return data;
  }

  async basicControl(action) {
    const { data } = await this._client.put(
      '/api/v2/robot/capabilities/BasicControlCapability',
      { action },
    );
    return data;
  }

  async setFanSpeed(preset) {
    const { data } = await this._client.put(
      '/api/v2/robot/capabilities/FanSpeedControlCapability/preset',
      { name: preset },
    );
    return data;
  }

  async cleanSegments(segmentIds, iterations = 1) {
    const { data } = await this._client.put(
      '/api/v2/robot/capabilities/MapSegmentationCapability',
      {
        action: 'start_segment_action',
        segment_ids: segmentIds,
        iterations,
      },
    );
    return data;
  }

  async locateRobot() {
    const { data } = await this._client.put(
      '/api/v2/robot/capabilities/LocateCapability',
      { action: 'locate' },
    );
    return data;
  }

  async getMapSnapshots() {
    const { data } = await this._client.get('/api/v2/robot/capabilities/MapSnapshotCapability');
    return data;
  }

  // --- Speaker ---

  async getSpeakerVolume() {
    const { data } = await this._client.get('/api/v2/robot/capabilities/SpeakerVolumeControlCapability');
    return data;
  }

  async setSpeakerVolume(volume) {
    const { data } = await this._client.put(
      '/api/v2/robot/capabilities/SpeakerVolumeControlCapability',
      { action: 'set_volume', value: volume },
    );
    return data;
  }

  async playTestSound() {
    const { data } = await this._client.put(
      '/api/v2/robot/capabilities/SpeakerTestCapability',
      { action: 'play_test_sound' },
    );
    return data;
  }

  // --- Water Usage (mop water level) ---

  async getWaterUsagePresets() {
    const { data } = await this._client.get('/api/v2/robot/capabilities/WaterUsageControlCapability/presets');
    return data;
  }

  async setWaterUsage(preset) {
    const { data } = await this._client.put(
      '/api/v2/robot/capabilities/WaterUsageControlCapability/preset',
      { name: preset },
    );
    return data;
  }

  // --- Operation Mode (vacuum/mop/both) ---

  async getOperationModePresets() {
    const { data } = await this._client.get('/api/v2/robot/capabilities/OperationModeControlCapability/presets');
    return data;
  }

  async setOperationMode(preset) {
    const { data } = await this._client.put(
      '/api/v2/robot/capabilities/OperationModeControlCapability/preset',
      { name: preset },
    );
    return data;
  }

  // --- Consumables ---

  async getConsumables() {
    const { data } = await this._client.get('/api/v2/robot/capabilities/ConsumableMonitoringCapability');
    return data;
  }

  async resetConsumable(type, subType) {
    const { data } = await this._client.put(
      `/api/v2/robot/capabilities/ConsumableMonitoringCapability/${type}/${subType || 'none'}`,
      { action: 'reset' },
    );
    return data;
  }

  // --- Auto-Empty Dock ---

  async triggerAutoEmpty() {
    const { data } = await this._client.put(
      '/api/v2/robot/capabilities/AutoEmptyDockManualTriggerCapability',
      { action: 'trigger' },
    );
    return data;
  }

  // --- Do Not Disturb ---

  async getDoNotDisturb() {
    const { data } = await this._client.get('/api/v2/robot/capabilities/DoNotDisturbCapability');
    return data;
  }

  async setDoNotDisturb(enabled, start, end) {
    const body = { enabled };
    if (start) body.start = start;
    if (end) body.end = end;
    const { data } = await this._client.put(
      '/api/v2/robot/capabilities/DoNotDisturbCapability',
      body,
    );
    return data;
  }

  // --- Simple Toggle Capabilities ---

  async getToggle(capability) {
    const { data } = await this._client.get(`/api/v2/robot/capabilities/${capability}`);
    return data;
  }

  async setToggle(capability, enabled) {
    const { data } = await this._client.put(
      `/api/v2/robot/capabilities/${capability}`,
      { action: enabled ? 'enable' : 'disable' },
    );
    return data;
  }

  // --- Go To Location ---

  async goToLocation(x, y) {
    const { data } = await this._client.put(
      '/api/v2/robot/capabilities/GoToLocationCapability',
      { action: 'goto', coordinates: { x, y } },
    );
    return data;
  }

  // --- Current Statistics ---

  async getCurrentStatistics() {
    const { data } = await this._client.get('/api/v2/robot/capabilities/CurrentStatisticsCapability');
    return data;
  }

  async getTotalStatistics() {
    const { data } = await this._client.get('/api/v2/robot/capabilities/TotalStatisticsCapability');
    return data;
  }

  // --- Map Management ---

  async resetMap() {
    const { data } = await this._client.put(
      '/api/v2/robot/capabilities/MapResetCapability',
      { action: 'reset' },
    );
    return data;
  }

  async startMappingPass() {
    const { data } = await this._client.put(
      '/api/v2/robot/capabilities/MappingPassCapability',
      { action: 'start' },
    );
    return data;
  }

  // --- Zone Cleaning ---

  async cleanZones(zones, iterations = 1) {
    const { data } = await this._client.put(
      '/api/v2/robot/capabilities/ZoneCleaningCapability',
      { action: 'clean', zones, iterations },
    );
    return data;
  }

  // --- Voice Pack Management ---

  async getVoicePackStatus() {
    const { data } = await this._client.get('/api/v2/robot/capabilities/VoicePackManagementCapability');
    return data;
  }

  async installVoicePack(url, language, hash) {
    const body = { action: 'download', url, language: language || 'en' };
    if (hash) body.hash = hash;
    const { data } = await this._client.put(
      '/api/v2/robot/capabilities/VoicePackManagementCapability',
      body,
    );
    return data;
  }

  async getVersion() {
    const { data } = await this._client.get('/api/v2/valetudo/version');
    return data;
  }

  async getUpdaterState() {
    const { data } = await this._client.get('/api/v2/updater/state');
    return data;
  }

  async checkForUpdates() {
    await this._client.put('/api/v2/updater', { action: 'check' });
  }

  async isReachable() {
    try {
      await this._client.get('/api/v2/robot', { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

}

module.exports = ValetudoApi;
