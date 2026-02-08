'use strict';

module.exports = {
  async getMap({ homey, query }) {
    const deviceId = query.deviceId;
    if (!deviceId) {
      throw new Error('Missing deviceId');
    }

    const driver = homey.drivers.getDriver('valetudo');
    const devices = driver.getDevices();
    const device = devices.find((d) => d.getData().id === deviceId);
    if (!device) {
      throw new Error('Device not found');
    }

    return device._api.getMap();
  },
};
