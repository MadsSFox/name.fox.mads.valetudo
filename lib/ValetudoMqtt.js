'use strict';

const mqtt = require('mqtt');
const { EventEmitter } = require('events');

const RECONNECT_PERIOD_MS = 5000;

class ValetudoMqtt extends EventEmitter {

  constructor({ broker, username, password, topicPrefix, identifier, log }) {
    super();
    this._log = log || console.log;
    this._broker = broker;
    this._username = username;
    this._password = password;
    this._prefix = topicPrefix || 'valetudo';
    this._identifier = identifier;
    this._client = null;
    this._connected = false;
    this._segments = {};
    this._activeSegmentIds = new Set();
    this._onCarpet = false;
  }

  get connected() {
    return this._connected;
  }

  get segments() {
    return this._segments;
  }

  get activeSegmentIds() {
    return this._activeSegmentIds;
  }

  get onCarpet() {
    return this._onCarpet;
  }

  _topicBase() {
    return `${this._prefix}/${this._identifier}`;
  }

  connect() {
    if (!this._broker || !this._identifier) {
      this._log('MQTT not configured, skipping connection');
      return;
    }

    const opts = {
      reconnectPeriod: RECONNECT_PERIOD_MS,
      connectTimeout: 10000,
    };
    if (this._username) {
      opts.username = this._username;
      opts.password = this._password || '';
    }

    this._client = mqtt.connect(this._broker, opts);

    this._client.on('connect', () => {
      this._connected = true;
      this._log('MQTT connected');
      this.emit('connected');
      this._subscribe();
    });

    this._client.on('message', (topic, message) => {
      this._handleMessage(topic, message.toString());
    });

    this._client.on('error', (err) => {
      this._log('MQTT error:', err.message);
      this.emit('error', err);
    });

    this._client.on('close', () => {
      this._connected = false;
      this.emit('disconnected');
    });

    this._client.on('offline', () => {
      this._connected = false;
    });
  }

  _subscribe() {
    const base = this._topicBase();
    const topics = [
      `${base}/BatteryStateAttribute/level`,
      `${base}/BatteryStateAttribute/status`,
      `${base}/StatusStateAttribute/status`,
      `${base}/StatusStateAttribute/error`,
      `${base}/StatusStateAttribute/flag`,
      `${base}/FanSpeedControlCapability/preset`,
      `${base}/MapData/segments`,
      `${base}/MapData/map-data-hass`,
    ];
    this._client.subscribe(topics, (err) => {
      if (err) {
        this._log('MQTT subscribe error:', err.message);
      } else {
        this._log('MQTT subscribed to topics');
      }
    });
  }

  _handleMessage(topic, payload) {
    const base = this._topicBase();
    const relative = topic.replace(`${base}/`, '');

    switch (relative) {
      case 'BatteryStateAttribute/level':
        this.emit('battery_level', parseInt(payload, 10));
        break;
      case 'BatteryStateAttribute/status':
        this.emit('battery_status', payload.toLowerCase());
        break;
      case 'StatusStateAttribute/status':
        this.emit('vacuum_state', payload.toLowerCase());
        break;
      case 'StatusStateAttribute/error':
        this.emit('vacuum_error', payload);
        break;
      case 'StatusStateAttribute/flag':
        this._updateCarpetState(payload.toLowerCase());
        this.emit('vacuum_flag', payload.toLowerCase());
        break;
      case 'FanSpeedControlCapability/preset':
        this.emit('fan_speed', payload.toLowerCase());
        break;
      case 'MapData/segments':
        this._parseSegments(payload);
        break;
      case 'MapData/map-data-hass':
        this._parseMapData(payload);
        break;
      default:
        break;
    }
  }

  _parseSegments(payload) {
    try {
      const data = JSON.parse(payload);
      this._segments = {};
      if (Array.isArray(data)) {
        for (const seg of data) {
          this._segments[seg.id] = seg.name || `Segment ${seg.id}`;
        }
      } else if (typeof data === 'object') {
        for (const [id, name] of Object.entries(data)) {
          this._segments[id] = name || `Segment ${id}`;
        }
      }
      this.emit('segments', this._segments);
    } catch (err) {
      this._log('Failed to parse segments:', err.message);
    }
  }

  // Seed segments from the REST API response when MQTT hasn't published them yet.
  // The REST MapSegmentationCapability endpoint returns the same array format as the
  // MQTT MapData/segments topic: [{ id, name }, ...]
  seedSegments(segments) {
    if (!Array.isArray(segments) || segments.length === 0) return;
    const map = {};
    for (const seg of segments) {
      map[String(seg.id)] = seg.name || `Segment ${seg.id}`;
    }
    this._segments = map;
    this.emit('segments', this._segments);
  }

  // Clear the segment cache after a floor switch so stale room names don't appear
  clearSegments() {
    this._segments = {};
  }

  _parseMapData(payload) {
    try {
      const data = JSON.parse(payload);
      const newActiveIds = new Set();

      // Valetudo's map-data-hass format has layers with segment metadata
      if (data.layers) {
        for (const layer of data.layers) {
          if (layer.type === 'segment' && layer.metaData) {
            if (layer.metaData.active === true) {
              const id = String(layer.metaData.segmentId);
              newActiveIds.add(id);
            }
          }
        }
      }

      // Detect segment transitions
      const previousIds = this._activeSegmentIds;

      // Segments that just became active (started cleaning)
      for (const id of newActiveIds) {
        if (!previousIds.has(id)) {
          const name = this._segments[id] || `Segment ${id}`;
          this.emit('segment_started', { id, name });
        }
      }

      // Segments that were active but no longer are (finished cleaning)
      for (const id of previousIds) {
        if (!newActiveIds.has(id)) {
          const name = this._segments[id] || `Segment ${id}`;
          this.emit('segment_finished', { id, name });
        }
      }

      this._activeSegmentIds = newActiveIds;
    } catch (err) {
      this._log('Failed to parse map data:', err.message);
    }
  }

  _updateCarpetState(flag) {
    const wasCarpet = this._onCarpet;
    this._onCarpet = flag === 'carpet';
    if (wasCarpet !== this._onCarpet) {
      this.emit('carpet_changed', this._onCarpet);
    }
  }

  basicControl(action) {
    this._publish('BasicControlCapability/operation/set', action.toUpperCase());
  }

  setFanSpeed(preset) {
    this._publish('FanSpeedControlCapability/preset/set', preset);
  }

  cleanSegments(segmentIds, iterations = 1) {
    const payload = JSON.stringify({
      segment_ids: segmentIds,
      iterations,
      customOrder: true,
    });
    this._publish('MapSegmentationCapability/clean/set', payload);
  }

  locate() {
    this._publish('LocateCapability/locate/set', 'PERFORM');
  }

  _publish(subtopic, payload) {
    if (!this._client || !this._connected) {
      this._log('MQTT not connected, cannot publish');
      return;
    }
    const topic = `${this._topicBase()}/${subtopic}`;
    this._client.publish(topic, String(payload));
  }

  updateConfig({ broker, username, password, topicPrefix, identifier }) {
    const needReconnect = broker !== this._broker
      || username !== this._username
      || password !== this._password;

    this._broker = broker;
    this._username = username;
    this._password = password;
    this._prefix = topicPrefix || 'valetudo';
    this._identifier = identifier;

    if (needReconnect) {
      this.disconnect();
      this.connect();
    }
  }

  disconnect() {
    if (this._client) {
      this._client.end(true);
      this._client = null;
      this._connected = false;
    }
  }

}

module.exports = ValetudoMqtt;
