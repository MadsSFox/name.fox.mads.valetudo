'use strict';

const assert = require('assert');
const sinon = require('sinon');
const ValetudoApi = require('../lib/ValetudoApi');

describe('ValetudoApi', () => {
  let api;
  let clientStub;

  beforeEach(() => {
    api = new ValetudoApi({
      host: '192.168.1.100',
      log: () => {},
    });
    // Stub the internal axios client
    clientStub = {
      get: sinon.stub(),
      put: sinon.stub(),
      defaults: { baseURL: '', auth: undefined },
    };
    api._client = clientStub;
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('constructor', () => {
    it('should set baseURL from host', () => {
      const a = new ValetudoApi({ host: '10.0.0.1', log: () => {} });
      assert.ok(a._host === '10.0.0.1');
    });

    it('should configure auth when user/pass provided', () => {
      const a = new ValetudoApi({ host: '10.0.0.1', authUser: 'admin', authPass: 'secret', log: () => {} });
      assert.deepStrictEqual(a._auth, { username: 'admin', password: 'secret' });
    });

    it('should not set auth when no user provided', () => {
      const a = new ValetudoApi({ host: '10.0.0.1', log: () => {} });
      assert.strictEqual(a._auth, undefined);
    });
  });

  describe('updateHost', () => {
    it('should update host and baseURL', () => {
      api.updateHost('10.0.0.2');
      assert.strictEqual(api._host, '10.0.0.2');
      assert.strictEqual(clientStub.defaults.baseURL, 'http://10.0.0.2');
    });
  });

  describe('updateAuth', () => {
    it('should set auth when user provided', () => {
      api.updateAuth('user', 'pass');
      assert.deepStrictEqual(api._auth, { username: 'user', password: 'pass' });
      assert.deepStrictEqual(clientStub.defaults.auth, { username: 'user', password: 'pass' });
    });

    it('should clear auth when no user provided', () => {
      api.updateAuth('', '');
      assert.strictEqual(api._auth, undefined);
      assert.strictEqual(clientStub.defaults.auth, undefined);
    });
  });

  describe('getRobotInfo', () => {
    it('should GET /api/v2/robot', async () => {
      const info = { manufacturer: 'Roborock', modelName: 'S5' };
      clientStub.get.resolves({ data: info });
      const result = await api.getRobotInfo();
      assert.deepStrictEqual(result, info);
      sinon.assert.calledWith(clientStub.get, '/api/v2/robot');
    });
  });

  describe('getCapabilities', () => {
    it('should GET /api/v2/robot/capabilities', async () => {
      const caps = ['BasicControlCapability', 'FanSpeedControlCapability'];
      clientStub.get.resolves({ data: caps });
      const result = await api.getCapabilities();
      assert.deepStrictEqual(result, caps);
    });
  });

  describe('getStateAttributes', () => {
    it('should GET /api/v2/robot/state/attributes', async () => {
      const attrs = [
        { __class: 'BatteryStateAttribute', level: 85 },
        { __class: 'StatusStateAttribute', value: 'docked' },
      ];
      clientStub.get.resolves({ data: attrs });
      const result = await api.getStateAttributes();
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].level, 85);
    });
  });

  describe('basicControl', () => {
    it('should PUT start action', async () => {
      clientStub.put.resolves({ data: {} });
      await api.basicControl('start');
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/BasicControlCapability',
        { action: 'start' });
    });

    it('should PUT stop action', async () => {
      clientStub.put.resolves({ data: {} });
      await api.basicControl('stop');
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/BasicControlCapability',
        { action: 'stop' });
    });

    it('should PUT home action', async () => {
      clientStub.put.resolves({ data: {} });
      await api.basicControl('home');
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/BasicControlCapability',
        { action: 'home' });
    });
  });

  describe('setFanSpeed', () => {
    it('should PUT fan speed preset', async () => {
      clientStub.put.resolves({ data: {} });
      await api.setFanSpeed('turbo');
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/FanSpeedControlCapability/preset',
        { name: 'turbo' });
    });
  });

  describe('renameSegment', () => {
    it('should PUT rename action with segment id and name', async () => {
      clientStub.put.resolves({ data: {} });
      await api.renameSegment('17', 'Kitchen');
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/MapSegmentRenameCapability',
        { action: 'rename_segment', segment_id: '17', name: 'Kitchen' });
    });
  });

  describe('cleanSegments', () => {
    it('should PUT segment clean with ids and iterations', async () => {
      clientStub.put.resolves({ data: {} });
      await api.cleanSegments(['17', '18'], 2);
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/MapSegmentationCapability',
        { action: 'start_segment_action', segment_ids: ['17', '18'], iterations: 2 });
    });

    it('should default iterations to 1', async () => {
      clientStub.put.resolves({ data: {} });
      await api.cleanSegments(['17']);
      const args = clientStub.put.firstCall.args[1];
      assert.strictEqual(args.iterations, 1);
    });
  });

  describe('locateRobot', () => {
    it('should PUT locate action', async () => {
      clientStub.put.resolves({ data: {} });
      await api.locateRobot();
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/LocateCapability',
        { action: 'locate' });
    });
  });

  describe('setSpeakerVolume', () => {
    it('should PUT volume value', async () => {
      clientStub.put.resolves({ data: {} });
      await api.setSpeakerVolume(80);
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/SpeakerVolumeControlCapability',
        { action: 'set_volume', value: 80 });
    });
  });

  describe('setWaterUsage', () => {
    it('should PUT water usage preset', async () => {
      clientStub.put.resolves({ data: {} });
      await api.setWaterUsage('medium');
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/WaterUsageControlCapability/preset',
        { name: 'medium' });
    });
  });

  describe('setOperationMode', () => {
    it('should PUT operation mode preset', async () => {
      clientStub.put.resolves({ data: {} });
      await api.setOperationMode('vacuum_and_mop');
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/OperationModeControlCapability/preset',
        { name: 'vacuum_and_mop' });
    });
  });

  describe('getConsumables', () => {
    it('should GET consumables', async () => {
      const consumables = [
        { type: 'filter', remaining: { unit: 'percent', value: 50 } },
      ];
      clientStub.get.resolves({ data: consumables });
      const result = await api.getConsumables();
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].type, 'filter');
    });
  });

  describe('resetConsumable', () => {
    it('should PUT reset with type and subType', async () => {
      clientStub.put.resolves({ data: {} });
      await api.resetConsumable('brush', 'main');
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/ConsumableMonitoringCapability/brush/main',
        { action: 'reset' });
    });

    it('should use "none" for missing subType', async () => {
      clientStub.put.resolves({ data: {} });
      await api.resetConsumable('filter');
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/ConsumableMonitoringCapability/filter/none',
        { action: 'reset' });
    });
  });

  describe('triggerAutoEmpty', () => {
    it('should PUT trigger action', async () => {
      clientStub.put.resolves({ data: {} });
      await api.triggerAutoEmpty();
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/AutoEmptyDockManualTriggerCapability',
        { action: 'trigger' });
    });
  });

  describe('setDoNotDisturb', () => {
    it('should PUT enabled state', async () => {
      clientStub.put.resolves({ data: {} });
      await api.setDoNotDisturb(true);
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/DoNotDisturbCapability',
        { enabled: true });
    });
  });

  describe('setToggle', () => {
    it('should PUT enable action', async () => {
      clientStub.put.resolves({ data: {} });
      await api.setToggle('CarpetModeControlCapability', true);
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/CarpetModeControlCapability',
        { action: 'enable' });
    });

    it('should PUT disable action', async () => {
      clientStub.put.resolves({ data: {} });
      await api.setToggle('CarpetModeControlCapability', false);
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/CarpetModeControlCapability',
        { action: 'disable' });
    });
  });

  describe('goToLocation', () => {
    it('should PUT goto coordinates', async () => {
      clientStub.put.resolves({ data: {} });
      await api.goToLocation(2500, 2500);
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/GoToLocationCapability',
        { action: 'goto', coordinates: { x: 2500, y: 2500 } });
    });
  });

  describe('resetMap', () => {
    it('should PUT reset action', async () => {
      clientStub.put.resolves({ data: {} });
      await api.resetMap();
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/MapResetCapability',
        { action: 'reset' });
    });
  });

  describe('startMappingPass', () => {
    it('should PUT start action', async () => {
      clientStub.put.resolves({ data: {} });
      await api.startMappingPass();
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/MappingPassCapability',
        { action: 'start' });
    });
  });

  describe('cleanZones', () => {
    it('should PUT zone clean request', async () => {
      const zones = [{ points: { pA: { x: 0, y: 0 }, pB: { x: 100, y: 0 }, pC: { x: 100, y: 100 }, pD: { x: 0, y: 100 } } }];
      clientStub.put.resolves({ data: {} });
      await api.cleanZones(zones, 2);
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/ZoneCleaningCapability',
        { action: 'clean', zones, iterations: 2 });
    });
  });

  describe('installVoicePack', () => {
    it('should PUT download action with url and language', async () => {
      clientStub.put.resolves({ data: {} });
      await api.installVoicePack('https://example.com/voice.pkg', 'de');
      sinon.assert.calledWith(clientStub.put,
        '/api/v2/robot/capabilities/VoicePackManagementCapability',
        { action: 'download', url: 'https://example.com/voice.pkg', language: 'de' });
    });

    it('should include hash when provided', async () => {
      clientStub.put.resolves({ data: {} });
      await api.installVoicePack('https://example.com/voice.pkg', 'en', 'abc123');
      const args = clientStub.put.firstCall.args[1];
      assert.strictEqual(args.hash, 'abc123');
    });
  });

  describe('getCurrentStatistics', () => {
    it('should GET current stats', async () => {
      const stats = [
        { type: 'area', value: 420000 },
        { type: 'time', value: 2100 },
      ];
      clientStub.get.resolves({ data: stats });
      const result = await api.getCurrentStatistics();
      assert.strictEqual(result.length, 2);
    });
  });

  describe('getTotalStatistics', () => {
    it('should GET total stats', async () => {
      const stats = [
        { type: 'area', value: 50000000 },
        { type: 'time', value: 360000 },
      ];
      clientStub.get.resolves({ data: stats });
      const result = await api.getTotalStatistics();
      assert.strictEqual(result.length, 2);
    });
  });

  describe('getMap', () => {
    it('should GET /api/v2/robot/state/map with extended timeout', async () => {
      const mapData = { size: { x: 5120, y: 5120 }, pixelSize: 5, layers: [], entities: [] };
      clientStub.get.resolves({ data: mapData });
      const result = await api.getMap();
      assert.deepStrictEqual(result, mapData);
      sinon.assert.calledWith(clientStub.get, '/api/v2/robot/state/map', { timeout: 30000 });
    });
  });

  describe('getVersion', () => {
    it('should GET valetudo version', async () => {
      clientStub.get.resolves({ data: { release: '2026.02.0' } });
      const result = await api.getVersion();
      assert.strictEqual(result.release, '2026.02.0');
    });
  });

  describe('getUpdaterState', () => {
    it('should GET updater state', async () => {
      clientStub.get.resolves({ data: { __class: 'ValetudoUpdaterIdleState' } });
      const result = await api.getUpdaterState();
      assert.strictEqual(result.__class, 'ValetudoUpdaterIdleState');
    });
  });

  describe('checkForUpdates', () => {
    it('should PUT check action', async () => {
      clientStub.put.resolves({ data: {} });
      await api.checkForUpdates();
      sinon.assert.calledWith(clientStub.put, '/api/v2/updater', { action: 'check' });
    });
  });

  describe('isReachable', () => {
    it('should return true when robot responds', async () => {
      clientStub.get.resolves({ data: {} });
      const result = await api.isReachable();
      assert.strictEqual(result, true);
    });

    it('should return false when request fails', async () => {
      clientStub.get.rejects(new Error('timeout'));
      const result = await api.isReachable();
      assert.strictEqual(result, false);
    });
  });
});
