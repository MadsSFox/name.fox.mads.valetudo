'use strict';

function findDevice(homey, deviceId) {
  const driver = homey.drivers.getDriver('valetudo');
  const devices = driver.getDevices();

  let device = devices.find((d) => d.getData().id === deviceId);
  if (!device) {
    device = devices.find((d) => {
      try {
        return String(d.__id) === String(deviceId)
          || String(d.__name) === String(deviceId);
      } catch {
        return false;
      }
    });
  }
  if (!device && devices.length === 1) {
    device = devices[0];
  }
  if (!device) {
    throw new Error(`Device not found (id: ${deviceId})`);
  }
  return device;
}

module.exports = {
  async getMap({ homey, query }) {
    const device = findDevice(homey, query.deviceId);
    const mapData = await device._api.getMap();
    return mapData;
  },

  async getFloors({ homey, query }) {
    const device = findDevice(homey, query.deviceId);
    return device.getFloorList();
  },

  async getState({ homey, query }) {
    const device = findDevice(homey, query.deviceId);
    const state = device.getVacuumState();
    const settings = device.getSettings();
    const activeInterval = parseInt(settings.map_refresh_interval || '10', 10) * 1000;
    const activeStates = ['cleaning', 'returning', 'moving', 'manual_control'];
    const isActive = activeStates.includes(state);
    return {
      state,
      refreshInterval: isActive ? activeInterval : activeInterval * 5,
    };
  },

  async getFloorMap({ homey, query }) {
    const device = findDevice(homey, query.deviceId);
    const floorId = query.floorId;

    if (!floorId) {
      throw new Error('Missing floorId');
    }

    // If requesting the active floor, fetch live map
    const activeId = device.floorManager.getActiveFloor();
    if (floorId === activeId) {
      return device._api.getMap();
    }

    // Return cached snapshot if available
    const snapshot = device.getMapSnapshot(floorId);
    if (snapshot) {
      return snapshot;
    }

    // No in-memory snapshot — map files exist on robot but we can't render
    // them without switching. Return null so the widget can show a message.
    return null;
  },

  async renameFloor({ homey, body }) {
    const device = findDevice(homey, body.deviceId);
    await device.renameFloor(body.floorId, body.newName);
    return { success: true };
  },

  async deleteFloor({ homey, body }) {
    const device = findDevice(homey, body.deviceId);
    await device.deleteFloor(body.floorId);
    return { success: true };
  },

  async setFloorDock({ homey, body }) {
    const device = findDevice(homey, body.deviceId);
    await device.floorManager.setFloorDock(body.floorId, body.hasDock === true);
    device._updateFloorCapability();
    return { success: true };
  },

  async switchFloor({ homey, body }) {
    const device = findDevice(homey, body.deviceId);
    // Fire-and-forget — switching takes time (SSH + reboot)
    device.switchFloor(body.floorId).catch(() => {});
    return { success: true, message: 'Floor switch initiated' };
  },
};
