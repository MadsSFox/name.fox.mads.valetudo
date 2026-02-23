'use strict';

const os = require('os');
const axios = require('axios');
const Homey = require('homey');
const ValetudoApi = require('./ValetudoApi');

class ValetudoDriver extends Homey.Driver {

  async onInit() {
    this.log('ValetudoDriver initialized');
    this._registerFlowCards();
  }

  _registerFlowCards() {
    // --- Triggers ---
    this._floorSwitchedTrigger = this.homey.flow.getDeviceTriggerCard('floor_switched');
    this._cleaningStartedTrigger = this.homey.flow.getDeviceTriggerCard('cleaning_started');
    this._cleaningFinishedTrigger = this.homey.flow.getDeviceTriggerCard('cleaning_finished');
    this._errorOccurredTrigger = this.homey.flow.getDeviceTriggerCard('error_occurred');
    this._segmentCleaningStartedTrigger = this.homey.flow.getDeviceTriggerCard('segment_cleaning_started');
    this._segmentCleaningFinishedTrigger = this.homey.flow.getDeviceTriggerCard('segment_cleaning_finished');
    this._consumableDepletedTrigger = this.homey.flow.getDeviceTriggerCard('consumable_depleted');
    this._robotStuckTrigger = this.homey.flow.getDeviceTriggerCard('robot_stuck');
    this._dustbinFullTrigger = this.homey.flow.getDeviceTriggerCard('dustbin_full');
    this._valetudoUpdatedTrigger = this.homey.flow.getDeviceTriggerCard('valetudo_updated');
    this._updateAvailableTrigger = this.homey.flow.getDeviceTriggerCard('update_available');

    // --- Conditions ---
    this.homey.flow.getConditionCard('is_on_floor')
      .registerRunListener(async (args, state) => {
        const activeFloor = args.device.floorManager?.getActiveFloor();
        return activeFloor === args.floor.id;
      })
      .registerArgumentAutocompleteListener('floor', async (query, args) => {
        return this._getFloorAutocomplete(args.device, query);
      });

    this.homey.flow.getConditionCard('has_state')
      .registerRunListener(async (args) => {
        const state = args.device.getCapabilityValue('vacuum_state');
        return state === args.state;
      });

    this.homey.flow.getConditionCard('has_dock')
      .registerRunListener(async (args) => {
        return args.device.floorManager.activeFloorHasDock();
      });

    this.homey.flow.getConditionCard('is_on_carpet')
      .registerRunListener(async (args) => {
        return args.device.isOnCarpet();
      });

    this.homey.flow.getConditionCard('is_in_segment')
      .registerRunListener(async (args) => {
        return args.device.isInSegment(args.segment.id);
      })
      .registerArgumentAutocompleteListener('segment', async (query, args) => {
        return this._getSegmentAutocomplete(args.device, query);
      });

    this.homey.flow.getConditionCard('is_dnd_enabled')
      .registerRunListener(async (args) => {
        return args.device.isDndEnabled();
      });

    this.homey.flow.getConditionCard('is_carpet_mode_enabled')
      .registerRunListener(async (args) => {
        return args.device.isCarpetModeEnabled();
      });

    // --- Actions ---
    this.homey.flow.getActionCard('switch_floor')
      .registerRunListener(async (args) => {
        await args.device.switchFloor(args.floor.id);
      })
      .registerArgumentAutocompleteListener('floor', async (query, args) => {
        return this._getFloorAutocomplete(args.device, query);
      });

    this.homey.flow.getActionCard('save_floor')
      .registerRunListener(async (args) => {
        await args.device.saveFloor(args.floor_name, args.has_dock === 'yes');
      });

    this.homey.flow.getActionCard('update_floor')
      .registerRunListener(async (args) => {
        if (args.new_name) {
          await args.device.floorManager.renameFloor(args.floor.id, args.new_name);
        }
        await args.device.floorManager.setFloorDock(args.floor.id, args.has_dock === 'yes');
        args.device._updateFloorCapability();
      })
      .registerArgumentAutocompleteListener('floor', async (query, args) => {
        return this._getFloorAutocomplete(args.device, query);
      });

    this.homey.flow.getActionCard('start_cleaning')
      .registerRunListener(async (args) => {
        await args.device.startCleaning();
      });

    this.homey.flow.getActionCard('stop_cleaning')
      .registerRunListener(async (args) => {
        await args.device.stopCleaning();
      });

    this.homey.flow.getActionCard('pause_cleaning')
      .registerRunListener(async (args) => {
        await args.device.pauseCleaning();
      });

    this.homey.flow.getActionCard('return_to_dock')
      .registerRunListener(async (args) => {
        await args.device.returnToDock();
      });

    this.homey.flow.getActionCard('clean_segment')
      .registerRunListener(async (args) => {
        await args.device.cleanSegment(args.segment.id, args.iterations || 1);
      })
      .registerArgumentAutocompleteListener('segment', async (query, args) => {
        return this._getSegmentAutocomplete(args.device, query);
      });

    this.homey.flow.getActionCard('set_fan_speed')
      .registerRunListener(async (args) => {
        await args.device.setFanSpeed(args.speed);
      });

    this.homey.flow.getActionCard('locate')
      .registerRunListener(async (args) => {
        await args.device.locateRobot();
      });

    this.homey.flow.getActionCard('set_water_usage')
      .registerRunListener(async (args) => {
        await args.device.setWaterUsage(args.level);
      });

    this.homey.flow.getActionCard('set_operation_mode')
      .registerRunListener(async (args) => {
        await args.device.setOperationMode(args.mode);
      });

    this.homey.flow.getActionCard('set_speaker_volume')
      .registerRunListener(async (args) => {
        await args.device.setSpeakerVolume(args.volume);
      });

    this.homey.flow.getActionCard('play_test_sound')
      .registerRunListener(async (args) => {
        await args.device.playTestSound();
      });

    this.homey.flow.getActionCard('trigger_auto_empty')
      .registerRunListener(async (args) => {
        await args.device.triggerAutoEmpty();
      });

    this.homey.flow.getActionCard('set_dnd')
      .registerRunListener(async (args) => {
        await args.device.setDnd(args.enabled === 'enable');
      });

    this.homey.flow.getActionCard('set_carpet_mode')
      .registerRunListener(async (args) => {
        await args.device.setCarpetMode(args.enabled === 'enable');
      });

    this.homey.flow.getActionCard('go_to_location')
      .registerRunListener(async (args) => {
        await args.device.goToLocation(args.x, args.y);
      });

    this.homey.flow.getActionCard('reset_consumable')
      .registerRunListener(async (args) => {
        const [type, subType] = args.consumable.split(':');
        await args.device.resetConsumable(type, subType);
      });

    this.homey.flow.getActionCard('clean_zone')
      .registerRunListener(async (args) => {
        await args.device.cleanZone(args.zone.id, args.iterations || 1);
      })
      .registerArgumentAutocompleteListener('zone', async (query, args) => {
        return this._getZoneAutocomplete(args.device, query);
      });

    this.homey.flow.getActionCard('save_zone')
      .registerRunListener(async (args) => {
        await args.device.saveZone(args.name, args.x1, args.y1, args.x2, args.y2);
      });

    this.homey.flow.getActionCard('delete_zone')
      .registerRunListener(async (args) => {
        await args.device.deleteZone(args.zone.id);
      })
      .registerArgumentAutocompleteListener('zone', async (query, args) => {
        return this._getZoneAutocomplete(args.device, query);
      });

    this.homey.flow.getActionCard('rename_segment')
      .registerRunListener(async (args) => {
        await args.device.renameSegment(args.segment.id, args.name);
      })
      .registerArgumentAutocompleteListener('segment', async (query, args) => {
        return this._getSegmentAutocomplete(args.device, query);
      });

    this.homey.flow.getActionCard('start_new_map')
      .registerRunListener(async (args) => {
        await args.device.startNewMap();
      });

    this.homey.flow.getActionCard('install_voice_pack')
      .registerRunListener(async (args) => {
        await args.device.installVoicePack(args.url, args.language);
      });

    this.homey.flow.getActionCard('refresh_segments')
      .registerRunListener(async (args) => {
        await args.device.refreshSegments();
      });
  }

  _getFloorAutocomplete(device, query) {
    if (!device.floorManager) return [];
    const floors = device.floorManager.getFloors();
    return floors
      .filter((f) => f.name.toLowerCase().includes(query.toLowerCase()))
      .map((f) => ({ id: f.id, name: f.name }));
  }

  _getZoneAutocomplete(device, query) {
    const zones = device.getZones();
    return zones
      .filter((z) => z.name.toLowerCase().includes(query.toLowerCase()))
      .map((z) => ({ id: z.id, name: z.name }));
  }

  async _getSegmentAutocomplete(device, query) {
    const segments = await device.getSegments();
    return Object.entries(segments)
      .filter(([, name]) => name.toLowerCase().includes(query.toLowerCase()))
      .map(([id, name]) => ({ id, name }));
  }

  async onPair(session) {
    let pairData = null;

    // Step 1: Discover robots on the network (mDNS + subnet scan fallback)
    session.setHandler('discover', async () => {
      const found = [];
      const seenHosts = new Set();

      // Method 1: mDNS discovery (handled by Homey at system level, outside Docker)
      try {
        const strategy = this.getDiscoveryStrategy();
        const results = strategy.getDiscoveryResults();
        for (const [, result] of Object.entries(results)) {
          const host = result.address;
          if (seenHosts.has(host)) continue;
          // Use TXT records from mDNS (available even if API unreachable from Docker)
          const txt = result.txt || {};
          const name = txt.model || txt.manufacturer || 'Valetudo Robot';
          const id = txt.id || host.replace(/\./g, '_');
          found.push({ host, name, id });
          seenHosts.add(host);
          this.log(`mDNS: found ${name} at ${host} (id: ${id})`);
        }
      } catch {
        // mDNS discovery not available
      }

      // Method 2: Subnet scan (fallback if mDNS found nothing)
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

      this.log(`Discovery found ${found.length} robot(s)`);
      return found;
    });

    // Step 2: Validate a specific host (from selection or manual entry)
    session.setHandler('validate', async (data) => {
      const { host, password, ssh_private_key, name: mdnsName, id: mdnsId } = data;

      // If device was already identified via mDNS, skip API validation
      // (API may be unreachable from Docker container during pairing)
      if (mdnsId && mdnsName) {
        this.log(`Skipping API validation for mDNS device: ${mdnsName} at ${host}`);
        pairData = { host, password, ssh_private_key: ssh_private_key || '', name: mdnsName, id: mdnsId };
        return { name: mdnsName, id: mdnsId };
      }

      const api = new ValetudoApi({
        host,
        authUser: password ? 'valetudo' : undefined,
        authPass: password,
        log: this.log.bind(this),
      });

      try {
        const info = await api.getRobotInfo();
        const name = info.modelName || info.manufacturer || 'Valetudo Robot';
        const id = info.id || host.replace(/\./g, '_');
        pairData = { host, password, ssh_private_key: ssh_private_key || '', name, id };
        return { name, id };
      } catch (err) {
        this.log('Validation failed:', err.message);
        throw new Error(`Cannot connect to Valetudo at ${host}: ${err.message}`);
      }
    });

    // Step 3: Return validated device for list_devices view
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

  _getLocalSubnets() {
    const subnets = [];
    try {
      const interfaces = os.networkInterfaces();
      for (const [, addrs] of Object.entries(interfaces)) {
        for (const addr of addrs) {
          if (addr.family === 'IPv4' && !addr.internal) {
            const parts = addr.address.split('.');
            subnets.push(`${parts[0]}.${parts[1]}.${parts[2]}`);
          }
        }
      }
    } catch {
      // Ignore
    }
    return [...new Set(subnets)];
  }

  async _scanForValetudo() {
    const subnets = this._getLocalSubnets();
    const found = [];

    for (const subnet of subnets) {
      this.log(`Scanning subnet ${subnet}.0/24 for Valetudo...`);
      const promises = [];

      for (let i = 1; i <= 254; i++) {
        const ip = `${subnet}.${i}`;
        promises.push(
          axios.get(`http://${ip}/api/v2/robot`, { timeout: 3000 })
            .then((res) => {
              if (res.data && (res.data.modelName || res.data.manufacturer || res.data.id)) {
                const name = res.data.modelName || res.data.manufacturer || 'Valetudo Robot';
                return { host: ip, name, id: res.data.id || ip.replace(/\./g, '_') };
              }
              return null;
            })
            .catch(() => null),
        );
      }

      const results = await Promise.all(promises);
      for (const r of results) {
        if (r) found.push(r);
      }
    }

    return found;
  }

}

module.exports = ValetudoDriver;
