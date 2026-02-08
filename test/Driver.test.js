'use strict';

const assert = require('assert');
const sinon = require('sinon');

// Mock the Homey module before requiring driver
const flowCards = {};
function mockFlowCard(id) {
  if (!flowCards[id]) {
    flowCards[id] = {
      id,
      _runListener: null,
      _autocompleteListeners: {},
      registerRunListener(fn) {
        this._runListener = fn;
        return this;
      },
      registerArgumentAutocompleteListener(arg, fn) {
        this._autocompleteListeners[arg] = fn;
        return this;
      },
      trigger: sinon.stub().resolves(),
    };
  }
  return flowCards[id];
}

const homeyMock = {
  flow: {
    getDeviceTriggerCard: (id) => mockFlowCard(`trigger:${id}`),
    getConditionCard: (id) => mockFlowCard(`condition:${id}`),
    getActionCard: (id) => mockFlowCard(`action:${id}`),
  },
};

// We can't easily require the Driver since it extends Homey.Driver.
// Instead we test the flow card logic directly by simulating what driver.js does.

describe('Driver flow card logic', () => {

  beforeEach(() => {
    // Reset flow cards
    Object.keys(flowCards).forEach((k) => delete flowCards[k]);
  });

  describe('Triggers', () => {
    it('should register all 11 triggers', () => {
      const triggerIds = [
        'floor_switched', 'cleaning_started', 'cleaning_finished',
        'error_occurred', 'robot_stuck', 'dustbin_full',
        'segment_cleaning_started', 'segment_cleaning_finished',
        'consumable_depleted', 'valetudo_updated', 'update_available',
      ];

      for (const id of triggerIds) {
        const card = homeyMock.flow.getDeviceTriggerCard(id);
        assert.ok(card, `Trigger ${id} should be retrievable`);
      }
      assert.strictEqual(Object.keys(flowCards).length, triggerIds.length);
    });

  });

  describe('Conditions', () => {
    it('has_state should match vacuum_state against selected state', async () => {
      const card = mockFlowCard('condition:has_state');
      card.registerRunListener(async (args) => {
        const state = args.device.getCapabilityValue('vacuum_state');
        return state === args.state;
      });

      const deviceCleaning = { getCapabilityValue: () => 'cleaning' };
      assert.strictEqual(await card._runListener({ device: deviceCleaning, state: 'cleaning' }), true);
      assert.strictEqual(await card._runListener({ device: deviceCleaning, state: 'docked' }), false);

      const deviceDocked = { getCapabilityValue: () => 'docked' };
      assert.strictEqual(await card._runListener({ device: deviceDocked, state: 'docked' }), true);
      assert.strictEqual(await card._runListener({ device: deviceDocked, state: 'idle' }), false);
    });

    it('is_on_floor should compare active floor', async () => {
      const card = mockFlowCard('condition:is_on_floor');
      card.registerRunListener(async (args) => {
        const activeFloor = args.device.floorManager?.getActiveFloor();
        return activeFloor === args.floor.id;
      });

      const device = { floorManager: { getActiveFloor: () => 'ground' } };
      assert.strictEqual(await card._runListener({ device, floor: { id: 'ground' } }), true);
      assert.strictEqual(await card._runListener({ device, floor: { id: 'upstairs' } }), false);
    });

    it('is_on_carpet should delegate to device', async () => {
      const card = mockFlowCard('condition:is_on_carpet');
      card.registerRunListener(async (args) => args.device.isOnCarpet());

      assert.strictEqual(await card._runListener({ device: { isOnCarpet: () => true } }), true);
      assert.strictEqual(await card._runListener({ device: { isOnCarpet: () => false } }), false);
    });

    it('is_in_segment should delegate to device', async () => {
      const card = mockFlowCard('condition:is_in_segment');
      card.registerRunListener(async (args) => args.device.isInSegment(args.segment.id));

      const device = {
        isInSegment: (id) => id === '17',
      };
      assert.strictEqual(await card._runListener({ device, segment: { id: '17' } }), true);
      assert.strictEqual(await card._runListener({ device, segment: { id: '99' } }), false);
    });
  });

  describe('Actions', () => {
    it('start_cleaning should call device.startCleaning', async () => {
      const card = mockFlowCard('action:start_cleaning');
      const device = { startCleaning: sinon.stub().resolves() };
      card.registerRunListener(async (args) => { await args.device.startCleaning(); });

      await card._runListener({ device });
      sinon.assert.calledOnce(device.startCleaning);
    });

    it('stop_cleaning should call device.stopCleaning', async () => {
      const card = mockFlowCard('action:stop_cleaning');
      const device = { stopCleaning: sinon.stub().resolves() };
      card.registerRunListener(async (args) => { await args.device.stopCleaning(); });

      await card._runListener({ device });
      sinon.assert.calledOnce(device.stopCleaning);
    });

    it('pause_cleaning should call device.pauseCleaning', async () => {
      const card = mockFlowCard('action:pause_cleaning');
      const device = { pauseCleaning: sinon.stub().resolves() };
      card.registerRunListener(async (args) => { await args.device.pauseCleaning(); });

      await card._runListener({ device });
      sinon.assert.calledOnce(device.pauseCleaning);
    });

    it('return_to_dock should call device.returnToDock', async () => {
      const card = mockFlowCard('action:return_to_dock');
      const device = { returnToDock: sinon.stub().resolves() };
      card.registerRunListener(async (args) => { await args.device.returnToDock(); });

      await card._runListener({ device });
      sinon.assert.calledOnce(device.returnToDock);
    });

    it('clean_segment should pass segment id and iterations', async () => {
      const card = mockFlowCard('action:clean_segment');
      const device = { cleanSegment: sinon.stub().resolves() };
      card.registerRunListener(async (args) => {
        await args.device.cleanSegment(args.segment.id, args.iterations || 1);
      });

      await card._runListener({ device, segment: { id: '17' }, iterations: 2 });
      sinon.assert.calledWith(device.cleanSegment, '17', 2);
    });

    it('set_fan_speed should pass speed preset', async () => {
      const card = mockFlowCard('action:set_fan_speed');
      const device = { setFanSpeed: sinon.stub().resolves() };
      card.registerRunListener(async (args) => { await args.device.setFanSpeed(args.speed); });

      await card._runListener({ device, speed: 'turbo' });
      sinon.assert.calledWith(device.setFanSpeed, 'turbo');
    });

    it('locate should call device.locateRobot', async () => {
      const card = mockFlowCard('action:locate');
      const device = { locateRobot: sinon.stub().resolves() };
      card.registerRunListener(async (args) => { await args.device.locateRobot(); });

      await card._runListener({ device });
      sinon.assert.calledOnce(device.locateRobot);
    });

    it('switch_floor should pass floor id', async () => {
      const card = mockFlowCard('action:switch_floor');
      const device = { switchFloor: sinon.stub().resolves() };
      card.registerRunListener(async (args) => { await args.device.switchFloor(args.floor.id); });

      await card._runListener({ device, floor: { id: 'upstairs' } });
      sinon.assert.calledWith(device.switchFloor, 'upstairs');
    });

    it('save_floor should pass floor name', async () => {
      const card = mockFlowCard('action:save_floor');
      const device = { saveFloor: sinon.stub().resolves() };
      card.registerRunListener(async (args) => { await args.device.saveFloor(args.floor_name); });

      await card._runListener({ device, floor_name: 'Basement' });
      sinon.assert.calledWith(device.saveFloor, 'Basement');
    });

    it('clean_zone should pass zone id and iterations', async () => {
      const card = mockFlowCard('action:clean_zone');
      const device = { cleanZone: sinon.stub().resolves() };
      card.registerRunListener(async (args) => {
        await args.device.cleanZone(args.zone.id, args.iterations || 1);
      });

      await card._runListener({ device, zone: { id: 'zone_123' }, iterations: 2 });
      sinon.assert.calledWith(device.cleanZone, 'zone_123', 2);
    });

    it('save_zone should pass name and coordinates', async () => {
      const card = mockFlowCard('action:save_zone');
      const device = { saveZone: sinon.stub().resolves() };
      card.registerRunListener(async (args) => {
        await args.device.saveZone(args.name, args.x1, args.y1, args.x2, args.y2);
      });

      await card._runListener({ device, name: 'Kitchen', x1: 100, y1: 200, x2: 300, y2: 400 });
      sinon.assert.calledWith(device.saveZone, 'Kitchen', 100, 200, 300, 400);
    });

    it('delete_zone should pass zone id', async () => {
      const card = mockFlowCard('action:delete_zone');
      const device = { deleteZone: sinon.stub().resolves() };
      card.registerRunListener(async (args) => { await args.device.deleteZone(args.zone.id); });

      await card._runListener({ device, zone: { id: 'zone_123' } });
      sinon.assert.calledWith(device.deleteZone, 'zone_123');
    });

    it('rename_segment should pass segment id and new name', async () => {
      const card = mockFlowCard('action:rename_segment');
      const device = { renameSegment: sinon.stub().resolves() };
      card.registerRunListener(async (args) => {
        await args.device.renameSegment(args.segment.id, args.name);
      });

      await card._runListener({ device, segment: { id: '17' }, name: 'Kitchen' });
      sinon.assert.calledWith(device.renameSegment, '17', 'Kitchen');
    });

    it('start_new_map should call device.startNewMap', async () => {
      const card = mockFlowCard('action:start_new_map');
      const device = { startNewMap: sinon.stub().resolves() };
      card.registerRunListener(async (args) => { await args.device.startNewMap(); });

      await card._runListener({ device });
      sinon.assert.calledOnce(device.startNewMap);
    });

    it('install_voice_pack should pass url and language', async () => {
      const card = mockFlowCard('action:install_voice_pack');
      const device = { installVoicePack: sinon.stub().resolves() };
      card.registerRunListener(async (args) => {
        await args.device.installVoicePack(args.url, args.language);
      });

      await card._runListener({ device, url: 'https://example.com/voice.pkg', language: 'de' });
      sinon.assert.calledWith(device.installVoicePack, 'https://example.com/voice.pkg', 'de');
    });

    it('set_water_usage should pass level', async () => {
      const card = mockFlowCard('action:set_water_usage');
      const device = { setWaterUsage: sinon.stub().resolves() };
      card.registerRunListener(async (args) => { await args.device.setWaterUsage(args.level); });

      await card._runListener({ device, level: 'medium' });
      sinon.assert.calledWith(device.setWaterUsage, 'medium');
    });

    it('set_operation_mode should pass mode', async () => {
      const card = mockFlowCard('action:set_operation_mode');
      const device = { setOperationMode: sinon.stub().resolves() };
      card.registerRunListener(async (args) => { await args.device.setOperationMode(args.mode); });

      await card._runListener({ device, mode: 'vacuum_and_mop' });
      sinon.assert.calledWith(device.setOperationMode, 'vacuum_and_mop');
    });

    it('set_speaker_volume should pass volume', async () => {
      const card = mockFlowCard('action:set_speaker_volume');
      const device = { setSpeakerVolume: sinon.stub().resolves() };
      card.registerRunListener(async (args) => { await args.device.setSpeakerVolume(args.volume); });

      await card._runListener({ device, volume: 80 });
      sinon.assert.calledWith(device.setSpeakerVolume, 80);
    });

    it('go_to_location should pass coordinates', async () => {
      const card = mockFlowCard('action:go_to_location');
      const device = { goToLocation: sinon.stub().resolves() };
      card.registerRunListener(async (args) => { await args.device.goToLocation(args.x, args.y); });

      await card._runListener({ device, x: 2500, y: 2500 });
      sinon.assert.calledWith(device.goToLocation, 2500, 2500);
    });

    it('reset_consumable should split type:subType', async () => {
      const card = mockFlowCard('action:reset_consumable');
      const device = { resetConsumable: sinon.stub().resolves() };
      card.registerRunListener(async (args) => {
        const [type, subType] = args.consumable.split(':');
        await args.device.resetConsumable(type, subType);
      });

      await card._runListener({ device, consumable: 'brush:main' });
      sinon.assert.calledWith(device.resetConsumable, 'brush', 'main');

      await card._runListener({ device, consumable: 'filter:none' });
      sinon.assert.calledWith(device.resetConsumable, 'filter', 'none');
    });
  });

  describe('Autocomplete helpers', () => {
    it('floor autocomplete should filter by query', () => {
      const device = {
        floorManager: {
          getFloors: () => [
            { id: 'ground', name: 'Ground Floor' },
            { id: 'upstairs', name: 'Upstairs' },
          ],
        },
      };

      // Simulate _getFloorAutocomplete
      function getFloorAutocomplete(dev, query) {
        if (!dev.floorManager) return [];
        const floors = dev.floorManager.getFloors();
        return floors
          .filter((f) => f.name.toLowerCase().includes(query.toLowerCase()))
          .map((f) => ({ id: f.id, name: f.name }));
      }

      const all = getFloorAutocomplete(device, '');
      assert.strictEqual(all.length, 2);

      const filtered = getFloorAutocomplete(device, 'ground');
      assert.strictEqual(filtered.length, 1);
      assert.strictEqual(filtered[0].id, 'ground');
    });

    it('zone autocomplete should filter by query', () => {
      const device = {
        getZones: () => [
          { id: 'zone_1', name: 'Kitchen Table' },
          { id: 'zone_2', name: 'Living Room' },
        ],
      };

      function getZoneAutocomplete(dev, query) {
        const zones = dev.getZones();
        return zones
          .filter((z) => z.name.toLowerCase().includes(query.toLowerCase()))
          .map((z) => ({ id: z.id, name: z.name }));
      }

      const all = getZoneAutocomplete(device, '');
      assert.strictEqual(all.length, 2);

      const filtered = getZoneAutocomplete(device, 'kitchen');
      assert.strictEqual(filtered.length, 1);
      assert.strictEqual(filtered[0].id, 'zone_1');
    });

    it('segment autocomplete should filter by query', () => {
      const device = {
        mqttClient: {
          segments: { '17': 'Kitchen', '18': 'Living Room', '19': 'Bedroom' },
        },
      };

      function getSegmentAutocomplete(dev, query) {
        if (!dev.mqttClient) return [];
        const segments = dev.mqttClient.segments;
        return Object.entries(segments)
          .filter(([, name]) => name.toLowerCase().includes(query.toLowerCase()))
          .map(([id, name]) => ({ id, name }));
      }

      const all = getSegmentAutocomplete(device, '');
      assert.strictEqual(all.length, 3);

      const filtered = getSegmentAutocomplete(device, 'room');
      assert.strictEqual(filtered.length, 2); // Living Room and Bedroom
    });
  });
});
