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

    // Otherwise return cached snapshot
    const snapshot = device.getMapSnapshot(floorId);
    if (!snapshot) {
      throw new Error(`No cached map for floor "${floorId}"`);
    }
    return snapshot;
  },
};
