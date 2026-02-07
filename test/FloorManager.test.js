'use strict';

const assert = require('assert');
const sinon = require('sinon');
const FloorManager = require('../lib/FloorManager');

describe('FloorManager', () => {
  let fm;
  let device;
  let ssh;
  let api;
  let mqttClient;
  let store;

  beforeEach(() => {
    store = {};

    device = {
      getStoreValue: sinon.stub().callsFake((key) => store[key]),
      setStoreValue: sinon.stub().callsFake(async (key, val) => { store[key] = val; }),
    };

    ssh = {
      exec: sinon.stub().resolves(''),
      fileExists: sinon.stub().resolves(true),
      copyFile: sinon.stub().resolves(),
      removeFile: sinon.stub().resolves(),
      readFile: sinon.stub().resolves('need_recover_map=1\nother=value'),
      writeFile: sinon.stub().resolves(),
      reboot: sinon.stub().resolves(),
    };

    api = {
      getStateAttributes: sinon.stub().resolves([
        { __class: 'StatusStateAttribute', value: 'docked' },
      ]),
      basicControl: sinon.stub().resolves(),
      isReachable: sinon.stub().resolves(true),
    };

    mqttClient = {};

    fm = new FloorManager({
      device,
      ssh,
      api,
      mqttClient,
      log: () => {},
    });
  });

  describe('getFloors', () => {
    it('should return empty array when no floors configured', () => {
      const floors = fm.getFloors();
      assert.deepStrictEqual(floors, []);
    });

    it('should return configured floors', () => {
      store.floor_config = {
        floors: [{ id: 'ground', name: 'Ground Floor' }],
        activeFloor: 'ground',
      };
      const floors = fm.getFloors();
      assert.strictEqual(floors.length, 1);
      assert.strictEqual(floors[0].name, 'Ground Floor');
    });
  });

  describe('getActiveFloor', () => {
    it('should return null when no active floor', () => {
      assert.strictEqual(fm.getActiveFloor(), null);
    });

    it('should return active floor id', () => {
      store.floor_config = { floors: [], activeFloor: 'upstairs' };
      assert.strictEqual(fm.getActiveFloor(), 'upstairs');
    });
  });

  describe('getActiveFloorName', () => {
    it('should return null when no active floor', () => {
      assert.strictEqual(fm.getActiveFloorName(), null);
    });

    it('should return floor name', () => {
      store.floor_config = {
        floors: [{ id: 'ground', name: 'Ground Floor' }],
        activeFloor: 'ground',
      };
      assert.strictEqual(fm.getActiveFloorName(), 'Ground Floor');
    });

    it('should return null if active floor id has no matching floor entry', () => {
      store.floor_config = { floors: [], activeFloor: 'deleted' };
      assert.strictEqual(fm.getActiveFloorName(), null);
    });
  });

  describe('addFloor', () => {
    it('should add a new floor', async () => {
      await fm.addFloor('ground', 'Ground Floor');
      assert.strictEqual(store.floor_config.floors.length, 1);
      assert.strictEqual(store.floor_config.floors[0].id, 'ground');
      assert.strictEqual(store.floor_config.floors[0].name, 'Ground Floor');
    });

    it('should throw if floor already exists', async () => {
      store.floor_config = {
        floors: [{ id: 'ground', name: 'Ground Floor' }],
        activeFloor: null,
      };

      await assert.rejects(
        () => fm.addFloor('ground', 'Ground Floor'),
        (err) => err.message.includes('already exists')
      );
    });
  });

  describe('removeFloor', () => {
    it('should remove a floor from config', async () => {
      store.floor_config = {
        floors: [
          { id: 'ground', name: 'Ground Floor' },
          { id: 'upstairs', name: 'Upstairs' },
        ],
        activeFloor: 'ground',
      };

      await fm.removeFloor('ground');
      assert.strictEqual(store.floor_config.floors.length, 1);
      assert.strictEqual(store.floor_config.floors[0].id, 'upstairs');
      assert.strictEqual(store.floor_config.activeFloor, null);
    });

    it('should attempt to remove floor files via SSH', async () => {
      store.floor_config = {
        floors: [{ id: 'ground', name: 'Ground Floor' }],
        activeFloor: null,
      };
      await fm.removeFloor('ground');
      sinon.assert.calledWith(ssh.exec, 'rm -rf "/mnt/data/rockrobo/floors/ground"');
    });

    it('should not fail if SSH removal fails', async () => {
      store.floor_config = {
        floors: [{ id: 'ground', name: 'Ground Floor' }],
        activeFloor: null,
      };
      ssh.exec.rejects(new Error('SSH failed'));
      await fm.removeFloor('ground'); // Should not throw
    });

    it('should not clear activeFloor if removing a different floor', async () => {
      store.floor_config = {
        floors: [
          { id: 'ground', name: 'Ground Floor' },
          { id: 'upstairs', name: 'Upstairs' },
        ],
        activeFloor: 'ground',
      };
      await fm.removeFloor('upstairs');
      assert.strictEqual(store.floor_config.activeFloor, 'ground');
    });
  });

  describe('saveCurrentFloor', () => {
    it('should throw if floor not found', async () => {
      store.floor_config = { floors: [], activeFloor: null };
      await assert.rejects(
        () => fm.saveCurrentFloor('nonexistent'),
        (err) => err.message.includes('not found')
      );
    });

    it('should create directory and copy map files', async () => {
      store.floor_config = {
        floors: [{ id: 'ground', name: 'Ground Floor' }],
        activeFloor: null,
      };

      await fm.saveCurrentFloor('ground');

      // Should create floor directory
      sinon.assert.calledWith(ssh.exec, 'mkdir -p "/mnt/data/rockrobo/floors/ground"');

      // Should check and copy each map file
      assert.ok(ssh.fileExists.callCount >= 4); // 4 map files
      assert.ok(ssh.copyFile.callCount >= 4);

      // Should set as active floor
      assert.strictEqual(store.floor_config.activeFloor, 'ground');
    });

    it('should throw when no map files exist on robot', async () => {
      store.floor_config = {
        floors: [{ id: 'ground', name: 'Ground Floor' }],
        activeFloor: null,
      };

      ssh.fileExists.resolves(false);
      await assert.rejects(
        () => fm.saveCurrentFloor('ground'),
        (err) => {
          assert.ok(err.message.includes('No map files found'));
          return true;
        }
      );

      // Should check file existence but not copy
      assert.ok(ssh.fileExists.callCount >= 4);
      sinon.assert.notCalled(ssh.copyFile);
    });
  });

  describe('saveAsNewFloor', () => {
    it('should create floor ID from name and save', async () => {
      store.floor_config = { floors: [], activeFloor: null };
      const result = await fm.saveAsNewFloor('Ground Floor');
      assert.strictEqual(result.id, 'ground_floor');
      assert.strictEqual(result.name, 'Ground Floor');
      assert.ok(store.floor_config.floors.some((f) => f.id === 'ground_floor'));
    });

    it('should sanitize floor name for ID', async () => {
      store.floor_config = { floors: [], activeFloor: null };
      const result = await fm.saveAsNewFloor('Floor #2!');
      assert.strictEqual(result.id, 'floor_2');
    });

    it('should throw for invalid name', async () => {
      await assert.rejects(
        () => fm.saveAsNewFloor('!!!'),
        (err) => err.message.includes('Invalid floor name')
      );
    });

    it('should reuse existing floor entry if same id', async () => {
      store.floor_config = {
        floors: [{ id: 'ground_floor', name: 'Ground Floor' }],
        activeFloor: null,
      };
      await fm.saveAsNewFloor('Ground Floor');
      // Should not duplicate the entry
      assert.strictEqual(store.floor_config.floors.filter((f) => f.id === 'ground_floor').length, 1);
    });
  });

  describe('activeFloorHasDock', () => {
    it('should return true when no floors configured', () => {
      assert.strictEqual(fm.activeFloorHasDock(), true);
    });

    it('should return true by default (backward compat)', () => {
      store.floor_config = {
        floors: [{ id: 'ground', name: 'Ground Floor' }],
        activeFloor: 'ground',
      };
      assert.strictEqual(fm.activeFloorHasDock(), true);
    });

    it('should return false when hasDock is false', () => {
      store.floor_config = {
        floors: [{ id: 'upstairs', name: 'Upstairs', hasDock: false }],
        activeFloor: 'upstairs',
      };
      assert.strictEqual(fm.activeFloorHasDock(), false);
    });

    it('should return true when hasDock is explicitly true', () => {
      store.floor_config = {
        floors: [{ id: 'ground', name: 'Ground', hasDock: true }],
        activeFloor: 'ground',
      };
      assert.strictEqual(fm.activeFloorHasDock(), true);
    });
  });

  describe('setFloorDock', () => {
    it('should set hasDock on a floor', async () => {
      store.floor_config = {
        floors: [{ id: 'ground', name: 'Ground Floor' }],
        activeFloor: 'ground',
      };
      await fm.setFloorDock('ground', false);
      assert.strictEqual(store.floor_config.floors[0].hasDock, false);
    });

    it('should throw if floor not found', async () => {
      store.floor_config = { floors: [], activeFloor: null };
      await assert.rejects(
        () => fm.setFloorDock('nonexistent', true),
        (err) => err.message.includes('not found')
      );
    });
  });

  describe('saveAsNewFloor with hasDock', () => {
    it('should save floor with hasDock=true by default', async () => {
      store.floor_config = { floors: [], activeFloor: null };
      await fm.saveAsNewFloor('Ground Floor');
      assert.strictEqual(store.floor_config.floors[0].hasDock, true);
    });

    it('should save floor with hasDock=false', async () => {
      store.floor_config = { floors: [], activeFloor: null };
      await fm.saveAsNewFloor('Upstairs', false);
      assert.strictEqual(store.floor_config.floors[0].hasDock, false);
    });

    it('should update hasDock on existing floor', async () => {
      store.floor_config = {
        floors: [{ id: 'upstairs', name: 'Upstairs', hasDock: true }],
        activeFloor: null,
      };
      await fm.saveAsNewFloor('Upstairs', false);
      assert.strictEqual(store.floor_config.floors[0].hasDock, false);
    });
  });

  describe('isFloorSaved', () => {
    it('should check for last_map file existence', async () => {
      await fm.isFloorSaved('ground');
      sinon.assert.calledWith(ssh.fileExists, '/mnt/data/rockrobo/floors/ground/last_map');
    });
  });

  describe('switchFloor', () => {
    beforeEach(() => {
      store.floor_config = {
        floors: [
          { id: 'ground', name: 'Ground Floor' },
          { id: 'upstairs', name: 'Upstairs' },
        ],
        activeFloor: 'ground',
      };
    });

    it('should throw if floor not found', async () => {
      await assert.rejects(
        () => fm.switchFloor('basement'),
        (err) => err.message.includes('not found')
      );
    });

    it('should return immediately if already on target floor', async () => {
      const result = await fm.switchFloor('ground');
      assert.strictEqual(result.name, 'Ground Floor');
      // Should not have done any SSH operations
      sinon.assert.notCalled(ssh.reboot);
    });

    it('should throw if target floor has no saved map', async () => {
      ssh.fileExists.resolves(false);
      await assert.rejects(
        () => fm.switchFloor('upstairs'),
        (err) => err.message.includes('No saved map found')
      );
    });

    it('should perform full switch sequence', async () => {
      // fileExists returns true for all checks
      ssh.fileExists.resolves(true);
      // Stub sleep to avoid real delays
      sinon.stub(fm, '_sleep').resolves();

      const result = await fm.switchFloor('upstairs');
      assert.strictEqual(result.name, 'Upstairs');

      // Should have checked state and tried to stop if cleaning
      sinon.assert.called(api.getStateAttributes);

      // Should have backed up current floor
      sinon.assert.called(ssh.exec);

      // Should have removed conflict files (StartPos.data, user_map0)
      const removeCalls = ssh.removeFile.getCalls().map((c) => c.args[0]);
      assert.ok(removeCalls.some((p) => p.includes('StartPos.data')));
      assert.ok(removeCalls.some((p) => p.includes('user_map0')));

      // Should have patched config
      sinon.assert.called(ssh.readFile);
      sinon.assert.called(ssh.writeFile);
      const writtenCfg = ssh.writeFile.getCalls().find((c) => c.args[0].includes('RoboController'));
      assert.ok(writtenCfg.args[1].includes('need_recover_map=0'));

      // Should have rebooted
      sinon.assert.called(ssh.reboot);

      // Should have waited for online
      sinon.assert.called(api.isReachable);

      // Should have updated active floor
      assert.strictEqual(store.floor_config.activeFloor, 'upstairs');
    });

    it('should stop robot if cleaning before switch', async () => {
      api.getStateAttributes.resolves([
        { __class: 'StatusStateAttribute', value: 'cleaning' },
      ]);
      ssh.fileExists.resolves(true);

      // Speed up the sleep
      sinon.stub(fm, '_sleep').resolves();

      await fm.switchFloor('upstairs');
      sinon.assert.calledWith(api.basicControl, 'stop');
    });
  });
});
