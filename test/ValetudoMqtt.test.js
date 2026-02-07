'use strict';

const assert = require('assert');
const sinon = require('sinon');
const EventEmitter = require('events');
const ValetudoMqtt = require('../lib/ValetudoMqtt');

// Fake MQTT client that simulates the real mqtt library's client
class FakeMqttClient extends EventEmitter {
  constructor() {
    super();
    this.subscriptions = [];
    this.published = [];
  }

  subscribe(topics, cb) {
    this.subscriptions.push(...(Array.isArray(topics) ? topics : [topics]));
    if (cb) cb(null);
  }

  publish(topic, payload) {
    this.published.push({ topic, payload });
  }

  end() {}
}

describe('ValetudoMqtt', () => {
  let mqttInstance;
  let fakeClient;

  beforeEach(() => {
    mqttInstance = new ValetudoMqtt({
      broker: 'mqtt://192.168.1.10',
      username: 'user',
      password: 'pass',
      topicPrefix: 'valetudo',
      identifier: 'robot1',
      log: () => {},
    });

    fakeClient = new FakeMqttClient();

    // Inject the fake client directly and simulate connect behavior
    // by calling connect() then manually setting up the client
  });

  afterEach(() => {
    sinon.restore();
  });

  // Helper: inject fake client and simulate connection
  function injectAndConnect() {
    // Override connect to inject our fake client
    mqttInstance._client = fakeClient;
    mqttInstance._connected = false;

    // Set up message handling like real connect() does
    fakeClient.on('message', (topic, message) => {
      mqttInstance._handleMessage(topic, message.toString());
    });
    fakeClient.on('close', () => {
      mqttInstance._connected = false;
      mqttInstance.emit('disconnected');
    });
    fakeClient.on('offline', () => {
      mqttInstance._connected = false;
    });

    // Simulate connect event
    mqttInstance._connected = true;
    mqttInstance.emit('connected');
    mqttInstance._subscribe();
  }

  describe('constructor', () => {
    it('should set prefix to "valetudo" when topicPrefix is not provided', () => {
      const m = new ValetudoMqtt({ broker: 'mqtt://localhost', identifier: 'r1', log: () => {} });
      assert.strictEqual(m._prefix, 'valetudo');
    });

    it('should use provided prefix', () => {
      const m = new ValetudoMqtt({ broker: 'mqtt://localhost', identifier: 'r1', topicPrefix: 'custom', log: () => {} });
      assert.strictEqual(m._prefix, 'custom');
    });

    it('should start disconnected', () => {
      assert.strictEqual(mqttInstance.connected, false);
    });

    it('should initialize segments as empty', () => {
      assert.deepStrictEqual(mqttInstance.segments, {});
    });

    it('should initialize activeSegmentIds as empty set', () => {
      assert.strictEqual(mqttInstance.activeSegmentIds.size, 0);
    });
  });

  describe('connect', () => {
    it('should skip if broker is not configured', () => {
      const noMqtt = new ValetudoMqtt({ log: () => {} });
      noMqtt.connect();
      assert.strictEqual(noMqtt._client, null);
    });

    it('should skip if identifier is not configured', () => {
      const noId = new ValetudoMqtt({ broker: 'mqtt://localhost', log: () => {} });
      noId.connect();
      assert.strictEqual(noId._client, null);
    });
  });

  describe('subscription', () => {
    it('should subscribe to expected topics', () => {
      injectAndConnect();
      assert.ok(fakeClient.subscriptions.length > 0);
      assert.ok(fakeClient.subscriptions.some((t) => t === 'valetudo/robot1/BatteryStateAttribute/level'));
      assert.ok(fakeClient.subscriptions.some((t) => t === 'valetudo/robot1/StatusStateAttribute/status'));
      assert.ok(fakeClient.subscriptions.some((t) => t === 'valetudo/robot1/StatusStateAttribute/error'));
      assert.ok(fakeClient.subscriptions.some((t) => t === 'valetudo/robot1/FanSpeedControlCapability/preset'));
      assert.ok(fakeClient.subscriptions.some((t) => t === 'valetudo/robot1/MapData/segments'));
    });
  });

  describe('message handling', () => {
    beforeEach(() => {
      injectAndConnect();
    });

    it('should emit battery_level on battery message', (done) => {
      mqttInstance.on('battery_level', (level) => {
        assert.strictEqual(level, 85);
        done();
      });
      fakeClient.emit('message', 'valetudo/robot1/BatteryStateAttribute/level', Buffer.from('85'));
    });

    it('should emit battery_status on status message', (done) => {
      mqttInstance.on('battery_status', (status) => {
        assert.strictEqual(status, 'charging');
        done();
      });
      fakeClient.emit('message', 'valetudo/robot1/BatteryStateAttribute/status', Buffer.from('Charging'));
    });

    it('should emit vacuum_state on status message (lowercased)', (done) => {
      mqttInstance.on('vacuum_state', (state) => {
        assert.strictEqual(state, 'cleaning');
        done();
      });
      fakeClient.emit('message', 'valetudo/robot1/StatusStateAttribute/status', Buffer.from('Cleaning'));
    });

    it('should emit vacuum_error on error message', (done) => {
      mqttInstance.on('vacuum_error', (error) => {
        assert.strictEqual(error, 'Stuck near wall');
        done();
      });
      fakeClient.emit('message', 'valetudo/robot1/StatusStateAttribute/error', Buffer.from('Stuck near wall'));
    });

    it('should emit fan_speed on preset message (lowercased)', (done) => {
      mqttInstance.on('fan_speed', (speed) => {
        assert.strictEqual(speed, 'turbo');
        done();
      });
      fakeClient.emit('message', 'valetudo/robot1/FanSpeedControlCapability/preset', Buffer.from('Turbo'));
    });

    it('should parse segments from array format', () => {
      const segments = [
        { id: '17', name: 'Kitchen' },
        { id: '18', name: 'Living Room' },
      ];
      fakeClient.emit('message', 'valetudo/robot1/MapData/segments', Buffer.from(JSON.stringify(segments)));
      assert.strictEqual(mqttInstance.segments['17'], 'Kitchen');
      assert.strictEqual(mqttInstance.segments['18'], 'Living Room');
    });

    it('should parse segments from object format', () => {
      const segments = { '17': 'Kitchen', '18': 'Living Room' };
      fakeClient.emit('message', 'valetudo/robot1/MapData/segments', Buffer.from(JSON.stringify(segments)));
      assert.strictEqual(mqttInstance.segments['17'], 'Kitchen');
    });

    it('should detect carpet state changes', () => {
      const changes = [];
      mqttInstance.on('carpet_changed', (onCarpet) => changes.push(onCarpet));

      fakeClient.emit('message', 'valetudo/robot1/StatusStateAttribute/flag', Buffer.from('carpet'));
      assert.strictEqual(mqttInstance.onCarpet, true);
      assert.deepStrictEqual(changes, [true]);

      fakeClient.emit('message', 'valetudo/robot1/StatusStateAttribute/flag', Buffer.from('none'));
      assert.strictEqual(mqttInstance.onCarpet, false);
      assert.deepStrictEqual(changes, [true, false]);
    });

    it('should not emit carpet_changed when state does not change', () => {
      const changes = [];
      mqttInstance.on('carpet_changed', (onCarpet) => changes.push(onCarpet));

      // Already false by default, so 'none' should not trigger change
      fakeClient.emit('message', 'valetudo/robot1/StatusStateAttribute/flag', Buffer.from('none'));
      assert.deepStrictEqual(changes, []);
    });

    it('should track active segment ids from map data', () => {
      const mapData = {
        layers: [
          { type: 'segment', metaData: { segmentId: 17, active: true } },
          { type: 'segment', metaData: { segmentId: 18, active: false } },
        ],
      };
      fakeClient.emit('message', 'valetudo/robot1/MapData/map-data-hass', Buffer.from(JSON.stringify(mapData)));
      assert.ok(mqttInstance.activeSegmentIds.has('17'));
      assert.ok(!mqttInstance.activeSegmentIds.has('18'));
    });

    it('should emit segment_started and segment_finished on transitions', () => {
      const started = [];
      const finished = [];
      mqttInstance.on('segment_started', (ev) => started.push(ev));
      mqttInstance.on('segment_finished', (ev) => finished.push(ev));

      // Segment 17 becomes active
      fakeClient.emit('message', 'valetudo/robot1/MapData/map-data-hass', Buffer.from(JSON.stringify({
        layers: [{ type: 'segment', metaData: { segmentId: 17, active: true } }],
      })));
      assert.strictEqual(started.length, 1);
      assert.strictEqual(started[0].id, '17');

      // Segment 17 finishes, segment 18 starts
      fakeClient.emit('message', 'valetudo/robot1/MapData/map-data-hass', Buffer.from(JSON.stringify({
        layers: [
          { type: 'segment', metaData: { segmentId: 17, active: false } },
          { type: 'segment', metaData: { segmentId: 18, active: true } },
        ],
      })));
      assert.strictEqual(finished.length, 1);
      assert.strictEqual(finished[0].id, '17');
      assert.strictEqual(started.length, 2);
      assert.strictEqual(started[1].id, '18');
    });

    it('should handle invalid JSON in segments gracefully', () => {
      // Should not throw
      fakeClient.emit('message', 'valetudo/robot1/MapData/segments', Buffer.from('not json'));
      assert.deepStrictEqual(mqttInstance.segments, {});
    });

    it('should handle invalid JSON in map data gracefully', () => {
      fakeClient.emit('message', 'valetudo/robot1/MapData/map-data-hass', Buffer.from('not json'));
      assert.strictEqual(mqttInstance.activeSegmentIds.size, 0);
    });
  });

  describe('commands', () => {
    beforeEach(() => {
      injectAndConnect();
    });

    it('should publish basic control commands in uppercase', () => {
      mqttInstance.basicControl('start');
      assert.strictEqual(fakeClient.published.length, 1);
      assert.strictEqual(fakeClient.published[0].topic, 'valetudo/robot1/BasicControlCapability/operation/set');
      assert.strictEqual(fakeClient.published[0].payload, 'START');
    });

    it('should publish fan speed', () => {
      mqttInstance.setFanSpeed('turbo');
      assert.strictEqual(fakeClient.published[0].topic, 'valetudo/robot1/FanSpeedControlCapability/preset/set');
      assert.strictEqual(fakeClient.published[0].payload, 'turbo');
    });

    it('should publish segment clean as JSON', () => {
      mqttInstance.cleanSegments(['17', '18'], 2);
      const msg = fakeClient.published[0];
      assert.strictEqual(msg.topic, 'valetudo/robot1/MapSegmentationCapability/clean/set');
      const parsed = JSON.parse(msg.payload);
      assert.deepStrictEqual(parsed.segment_ids, ['17', '18']);
      assert.strictEqual(parsed.iterations, 2);
      assert.strictEqual(parsed.customOrder, true);
    });

    it('should publish locate command', () => {
      mqttInstance.locate();
      assert.strictEqual(fakeClient.published[0].topic, 'valetudo/robot1/LocateCapability/locate/set');
      assert.strictEqual(fakeClient.published[0].payload, 'PERFORM');
    });

    it('should not publish when not connected', () => {
      mqttInstance._connected = false;
      mqttInstance.basicControl('start');
      assert.strictEqual(fakeClient.published.length, 0);
    });

    it('should not publish when client is null', () => {
      mqttInstance._client = null;
      mqttInstance.basicControl('start');
      // Should not throw
    });
  });

  describe('updateConfig', () => {
    it('should update config values without triggering reconnect', () => {
      // Pass same broker/username/password to avoid reconnect (which would try real mqtt.connect)
      mqttInstance.updateConfig({
        broker: 'mqtt://192.168.1.10',
        username: 'user',
        password: 'pass',
        topicPrefix: 'custom',
        identifier: 'robot2',
      });
      assert.strictEqual(mqttInstance._prefix, 'custom');
      assert.strictEqual(mqttInstance._identifier, 'robot2');
    });

    it('should update all config fields', () => {
      // Stub connect/disconnect to avoid real network calls
      sinon.stub(mqttInstance, 'disconnect');
      sinon.stub(mqttInstance, 'connect');

      mqttInstance.updateConfig({
        broker: 'mqtt://10.0.0.1',
        username: 'new_user',
        password: 'new_pass',
        topicPrefix: 'custom',
        identifier: 'robot2',
      });
      assert.strictEqual(mqttInstance._broker, 'mqtt://10.0.0.1');
      assert.strictEqual(mqttInstance._username, 'new_user');
      assert.strictEqual(mqttInstance._password, 'new_pass');
      assert.strictEqual(mqttInstance._prefix, 'custom');
      assert.strictEqual(mqttInstance._identifier, 'robot2');
    });

    it('should reconnect when broker changes', () => {
      sinon.stub(mqttInstance, 'disconnect');
      sinon.stub(mqttInstance, 'connect');

      mqttInstance.updateConfig({
        broker: 'mqtt://10.0.0.1',
        username: 'user',
        password: 'pass',
        topicPrefix: 'valetudo',
        identifier: 'robot1',
      });
      sinon.assert.calledOnce(mqttInstance.disconnect);
      sinon.assert.calledOnce(mqttInstance.connect);
    });

    it('should not reconnect when only prefix changes', () => {
      sinon.stub(mqttInstance, 'disconnect');
      sinon.stub(mqttInstance, 'connect');

      mqttInstance.updateConfig({
        broker: 'mqtt://192.168.1.10',
        username: 'user',
        password: 'pass',
        topicPrefix: 'custom',
        identifier: 'robot1',
      });
      sinon.assert.notCalled(mqttInstance.disconnect);
      sinon.assert.notCalled(mqttInstance.connect);
    });
  });

  describe('disconnect', () => {
    it('should set connected to false and null client', () => {
      injectAndConnect();
      mqttInstance.disconnect();
      assert.strictEqual(mqttInstance.connected, false);
      assert.strictEqual(mqttInstance._client, null);
    });

    it('should be safe to call when not connected', () => {
      mqttInstance.disconnect();
      assert.strictEqual(mqttInstance.connected, false);
    });
  });
});
