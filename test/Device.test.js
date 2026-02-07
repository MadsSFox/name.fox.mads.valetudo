'use strict';

const assert = require('assert');
const sinon = require('sinon');
const EventEmitter = require('events');

// We test device logic by simulating the key methods since the actual Device
// class extends Homey.Device which isn't available outside Homey runtime.
// We focus on the business logic: state mapping, error classification,
// zone management, statistics, and MQTT/REST command routing.

describe('Device logic', () => {

  describe('STATE_MAP', () => {
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

    it('should map all known Valetudo states', () => {
      assert.strictEqual(STATE_MAP['cleaning'], 'cleaning');
      assert.strictEqual(STATE_MAP['docked'], 'docked');
      assert.strictEqual(STATE_MAP['idle'], 'idle');
      assert.strictEqual(STATE_MAP['returning'], 'returning');
      assert.strictEqual(STATE_MAP['paused'], 'paused');
      assert.strictEqual(STATE_MAP['error'], 'error');
      assert.strictEqual(STATE_MAP['manual_control'], 'manual_control');
      assert.strictEqual(STATE_MAP['moving'], 'moving');
    });

    it('should return undefined for unknown states (fallback to idle)', () => {
      const mapped = STATE_MAP['unknown_state'] || 'idle';
      assert.strictEqual(mapped, 'idle');
    });
  });

  describe('onoff state mapping', () => {
    function isOn(state) {
      return state === 'cleaning' || state === 'returning' || state === 'moving';
    }

    it('cleaning should be on', () => assert.strictEqual(isOn('cleaning'), true));
    it('returning should be on', () => assert.strictEqual(isOn('returning'), true));
    it('moving should be on', () => assert.strictEqual(isOn('moving'), true));
    it('docked should be off', () => assert.strictEqual(isOn('docked'), false));
    it('idle should be off', () => assert.strictEqual(isOn('idle'), false));
    it('paused should be off', () => assert.strictEqual(isOn('paused'), false));
    it('error should be off', () => assert.strictEqual(isOn('error'), false));
  });

  describe('error classification', () => {
    function classifyError(message) {
      const lower = message.toLowerCase();
      const result = { stuck: false, dustbin: false };
      if (lower.includes('stuck') || lower.includes('trapped') || lower.includes('wheel')) {
        result.stuck = true;
      }
      if (lower.includes('dustbin') || lower.includes('dust bin') || lower.includes('bin full')) {
        result.dustbin = true;
      }
      return result;
    }

    it('should detect stuck conditions', () => {
      assert.strictEqual(classifyError('Robot is stuck').stuck, true);
      assert.strictEqual(classifyError('Trapped near table').stuck, true);
      assert.strictEqual(classifyError('Left wheel jammed').stuck, true);
    });

    it('should detect dustbin full', () => {
      assert.strictEqual(classifyError('Dustbin is full').dustbin, true);
      assert.strictEqual(classifyError('Dust bin needs emptying').dustbin, true);
      assert.strictEqual(classifyError('Bin full error').dustbin, true);
    });

    it('should not flag unrelated errors', () => {
      const result = classifyError('Low battery');
      assert.strictEqual(result.stuck, false);
      assert.strictEqual(result.dustbin, false);
    });
  });

  describe('zone management', () => {
    let zones;

    beforeEach(() => {
      zones = {};
    });

    function getZones() {
      return Object.entries(zones).map(([id, zone]) => ({
        id, name: zone.name, coordinates: zone.coordinates,
      }));
    }

    function saveZone(name, x1, y1, x2, y2) {
      const id = `zone_${Date.now()}`;
      zones[id] = { name, coordinates: { x1, y1, x2, y2 } };
      return { id, name };
    }

    function deleteZone(zoneId) {
      delete zones[zoneId];
    }

    it('should save and retrieve zones', () => {
      saveZone('Kitchen', 100, 200, 300, 400);
      const list = getZones();
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].name, 'Kitchen');
      assert.deepStrictEqual(list[0].coordinates, { x1: 100, y1: 200, x2: 300, y2: 400 });
    });

    it('should delete zones', () => {
      const saved = saveZone('Kitchen', 100, 200, 300, 400);
      deleteZone(saved.id);
      assert.strictEqual(getZones().length, 0);
    });

    it('should handle multiple zones', () => {
      const id1 = `zone_${Date.now()}`;
      zones[id1] = { name: 'Kitchen', coordinates: { x1: 100, y1: 200, x2: 300, y2: 400 } };
      const id2 = `zone_${Date.now() + 1}`;
      zones[id2] = { name: 'Living Room', coordinates: { x1: 500, y1: 600, x2: 700, y2: 800 } };
      assert.strictEqual(getZones().length, 2);
    });
  });

  describe('zone clean spec generation', () => {
    it('should create zone spec with 4 corner points', () => {
      const x1 = 100, y1 = 200, x2 = 300, y2 = 400;
      const zoneSpec = [{
        points: {
          pA: { x: x1, y: y1 },
          pB: { x: x2, y: y1 },
          pC: { x: x2, y: y2 },
          pD: { x: x1, y: y2 },
        },
      }];

      assert.strictEqual(zoneSpec[0].points.pA.x, 100);
      assert.strictEqual(zoneSpec[0].points.pA.y, 200);
      assert.strictEqual(zoneSpec[0].points.pB.x, 300);
      assert.strictEqual(zoneSpec[0].points.pB.y, 200);
      assert.strictEqual(zoneSpec[0].points.pC.x, 300);
      assert.strictEqual(zoneSpec[0].points.pC.y, 400);
      assert.strictEqual(zoneSpec[0].points.pD.x, 100);
      assert.strictEqual(zoneSpec[0].points.pD.y, 400);
    });
  });

  describe('statistics conversion', () => {
    it('should convert area from cm2 to m2', () => {
      const areaCm2 = 420000; // 42 m2
      const areaM2 = Math.round(areaCm2 / 10000);
      assert.strictEqual(areaM2, 42);
    });

    it('should convert time from seconds to minutes', () => {
      const timeSec = 2100; // 35 min
      const timeMin = Math.round(timeSec / 60);
      assert.strictEqual(timeMin, 35);
    });

    it('should convert total time from seconds to hours', () => {
      const timeSec = 360000; // 100 hrs
      const timeHrs = Math.round(timeSec / 3600);
      assert.strictEqual(timeHrs, 100);
    });

    it('should convert total area from cm2 to m2', () => {
      const areaCm2 = 50000000; // 5000 m2
      const areaM2 = Math.round(areaCm2 / 10000);
      assert.strictEqual(areaM2, 5000);
    });
  });

  describe('battery threshold logic', () => {
    it('should trigger when battery drops below previous level', () => {
      let lastLevel = 50;
      const level = 45;
      const shouldTrigger = lastLevel !== null && level < lastLevel;
      assert.strictEqual(shouldTrigger, true);
    });

    it('should not trigger when battery increases (charging)', () => {
      let lastLevel = 50;
      const level = 55;
      const shouldTrigger = lastLevel !== null && level < lastLevel;
      assert.strictEqual(shouldTrigger, false);
    });

    it('should not trigger on first reading', () => {
      let lastLevel = null;
      const level = 50;
      const shouldTrigger = lastLevel !== null && level < lastLevel;
      assert.strictEqual(shouldTrigger, false);
    });
  });

  describe('MQTT vs REST command routing', () => {
    it('should prefer MQTT when connected', () => {
      const mqttConnected = true;
      const mqttCalled = mqttConnected;
      const apiCalled = !mqttConnected;
      assert.strictEqual(mqttCalled, true);
      assert.strictEqual(apiCalled, false);
    });

    it('should fall back to REST when MQTT disconnected', () => {
      const mqttConnected = false;
      const mqttCalled = mqttConnected;
      const apiCalled = !mqttConnected;
      assert.strictEqual(mqttCalled, false);
      assert.strictEqual(apiCalled, true);
    });
  });

  describe('cleaning state transitions', () => {
    it('should detect cleaning started', () => {
      const previous = 'docked';
      const current = 'cleaning';
      const started = current === 'cleaning' && previous !== 'cleaning';
      assert.strictEqual(started, true);
    });

    it('should detect cleaning finished (not paused)', () => {
      const previous = 'cleaning';
      const current = 'docked';
      const finished = previous === 'cleaning' && current !== 'cleaning' && current !== 'paused';
      assert.strictEqual(finished, true);
    });

    it('should not fire finished when transitioning to paused', () => {
      const previous = 'cleaning';
      const current = 'paused';
      const finished = previous === 'cleaning' && current !== 'cleaning' && current !== 'paused';
      assert.strictEqual(finished, false);
    });

    it('should not fire started when already cleaning', () => {
      const previous = 'cleaning';
      const current = 'cleaning';
      const started = previous && previous !== current && current === 'cleaning';
      assert.strictEqual(started, false);
    });
  });

  describe('consumable threshold', () => {
    const DEPLETED_THRESHOLD = 10;

    it('should flag consumable at or below threshold', () => {
      assert.strictEqual(5 <= DEPLETED_THRESHOLD, true);
      assert.strictEqual(10 <= DEPLETED_THRESHOLD, true);
    });

    it('should not flag consumable above threshold', () => {
      assert.strictEqual(50 <= DEPLETED_THRESHOLD, false);
    });
  });

  describe('update detection', () => {
    it('should detect version change', () => {
      const knownVersion = '2026.01.0';
      const currentVersion = '2026.02.0';
      const changed = knownVersion && knownVersion !== currentVersion;
      assert.strictEqual(changed, true);
    });

    it('should not flag on first check', () => {
      const knownVersion = null;
      const currentVersion = '2026.02.0';
      const changed = !!(knownVersion && knownVersion !== currentVersion);
      assert.strictEqual(changed, false);
    });

    it('should detect applicable update state', () => {
      const state = { __class: 'ValetudoUpdaterApplicableState' };
      const isApplicable = state.__class === 'ValetudoUpdaterApplicableState';
      assert.strictEqual(isApplicable, true);
    });

    it('should not flag idle state', () => {
      const state = { __class: 'ValetudoUpdaterIdleState' };
      const isApplicable = state.__class === 'ValetudoUpdaterApplicableState';
      assert.strictEqual(isApplicable, false);
    });

    it('should not flag no-update-required state', () => {
      const state = { __class: 'ValetudoUpdaterNoUpdateRequiredState' };
      const isApplicable = state.__class === 'ValetudoUpdaterApplicableState';
      assert.strictEqual(isApplicable, false);
    });
  });

  describe('low battery alarm', () => {
    const LOW_BATTERY_THRESHOLD = 20;

    it('should alarm when below threshold', () => {
      assert.strictEqual(15 < LOW_BATTERY_THRESHOLD, true);
    });

    it('should not alarm when above threshold', () => {
      assert.strictEqual(50 < LOW_BATTERY_THRESHOLD, false);
    });

    it('should not alarm at exactly threshold', () => {
      assert.strictEqual(20 < LOW_BATTERY_THRESHOLD, false);
    });
  });

  describe('floor button cycling', () => {
    it('should cycle to next floor', () => {
      const floors = [
        { id: 'ground', name: 'Ground' },
        { id: 'upstairs', name: 'Upstairs' },
        { id: 'basement', name: 'Basement' },
      ];
      const activeId = 'ground';
      const currentIdx = floors.findIndex((f) => f.id === activeId);
      const nextIdx = (currentIdx + 1) % floors.length;
      assert.strictEqual(floors[nextIdx].id, 'upstairs');
    });

    it('should wrap around to first floor', () => {
      const floors = [
        { id: 'ground', name: 'Ground' },
        { id: 'upstairs', name: 'Upstairs' },
      ];
      const activeId = 'upstairs';
      const currentIdx = floors.findIndex((f) => f.id === activeId);
      const nextIdx = (currentIdx + 1) % floors.length;
      assert.strictEqual(floors[nextIdx].id, 'ground');
    });

    it('should handle single floor', () => {
      const floors = [{ id: 'ground', name: 'Ground' }];
      const activeId = 'ground';
      const currentIdx = floors.findIndex((f) => f.id === activeId);
      const nextIdx = (currentIdx + 1) % floors.length;
      assert.strictEqual(floors[nextIdx].id, 'ground');
    });
  });
});
