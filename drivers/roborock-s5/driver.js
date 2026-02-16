'use strict';

const ValetudoDriver = require('../../lib/ValetudoDriver');
const ValetudoApi = require('../../lib/ValetudoApi');

class RoborockS5Driver extends ValetudoDriver {

  async onInit() {
    this.log('RoborockS5Driver initialized');
    this._registerFlowCards();
  }

  async onPair(session) {
    let pairData = null;

    session.setHandler('discover', async () => {
      const found = [];
      const seenHosts = new Set();

      // mDNS discovery
      try {
        const strategy = this.getDiscoveryStrategy();
        const results = strategy.getDiscoveryResults();
        for (const [, result] of Object.entries(results)) {
          const host = result.address;
          if (seenHosts.has(host)) continue;
          const txt = result.txt || {};
          const name = txt.model || txt.manufacturer || 'Valetudo Robot';
          const id = txt.id || host.replace(/\./g, '_');
          found.push({ host, name, id });
          seenHosts.add(host);
          this.log(`mDNS: found ${name} at ${host} (id: ${id})`);
        }
      } catch {
        // mDNS not available
      }

      // Subnet scan fallback
      if (found.length === 0) {
        this.log('mDNS found no devices, falling back to subnet scan...');
        const scanned = await this._scanForValetudo();
        for (const d of scanned) {
          if (!seenHosts.has(d.host)) {
            found.push(d);
            seenHosts.add(d.host);
          }
        }
      }

      // Filter to only Roborock S5 models
      const s5Only = [];
      for (const d of found) {
        try {
          const api = new ValetudoApi({ host: d.host, log: this.log.bind(this) });
          const info = await api.getRobotInfo();
          const model = (info.modelName || '').toLowerCase();
          if (model.includes('s5') || model.includes('s50') || model.includes('s55')) {
            d.name = info.modelName || d.name;
            s5Only.push(d);
            this.log(`Roborock S5 found: ${d.name} at ${d.host}`);
          } else {
            this.log(`Skipping non-S5 robot: ${info.modelName || 'unknown'} at ${d.host}`);
          }
        } catch {
          // Can't verify model, include it anyway for manual pairing
          s5Only.push(d);
        }
      }

      this.log(`Discovery found ${s5Only.length} Roborock S5 robot(s)`);
      return s5Only;
    });

    session.setHandler('validate', async (data) => {
      const { host, password, ssh_private_key, name: mdnsName, id: mdnsId } = data;

      const api = new ValetudoApi({
        host,
        authUser: password ? 'valetudo' : undefined,
        authPass: password,
        log: this.log.bind(this),
      });

      try {
        const info = await api.getRobotInfo();
        const model = (info.modelName || '').toLowerCase();

        // Validate this is a Roborock S5
        if (!model.includes('s5') && !model.includes('s50') && !model.includes('s55')) {
          throw new Error(
            `This robot is a ${info.modelName || 'unknown model'}, not a Roborock S5. `
            + 'Use the "Valetudo Robot Vacuum" driver for other models.',
          );
        }

        const name = info.modelName || mdnsName || 'Roborock S5';
        const id = info.id || mdnsId || host.replace(/\./g, '_');
        pairData = { host, password, ssh_private_key: ssh_private_key || '', name, id };
        return { name, id };
      } catch (err) {
        if (err.message.includes('not a Roborock S5')) throw err;
        this.log('Validation failed:', err.message);
        throw new Error(`Cannot connect to Valetudo at ${host}: ${err.message}`);
      }
    });

    session.setHandler('list_devices', async () => {
      if (!pairData) return [];

      const { host, password, ssh_private_key, name, id } = pairData;
      return [{
        name: `${name} (Valetudo)`,
        data: { id },
        settings: {
          host,
          valetudo_auth_user: password ? 'valetudo' : '',
          valetudo_auth_pass: password || '',
          mqtt_broker: '',
          mqtt_username: '',
          mqtt_password: '',
          mqtt_topic_prefix: 'valetudo',
          mqtt_identifier: id,
          ssh_host: '',
          ssh_port: 22,
          ssh_user: 'root',
          ssh_password: '',
          ssh_private_key: ssh_private_key || '',
        },
      }];
    });
  }

}

module.exports = RoborockS5Driver;
