'use strict';

const assert = require('assert');
const sinon = require('sinon');
const EventEmitter = require('events');
const SshManager = require('../lib/SshManager');

// Fake SSH connection that simulates ssh2 Client behavior
class FakeConn extends EventEmitter {
  constructor() {
    super();
    this._ended = false;
    this._sftpStub = null;
    this._lastExecCmd = null;
  }

  exec(cmd, cb) {
    this._lastExecCmd = cmd;
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    cb(null, stream);
    process.nextTick(() => {
      stream.emit('data', 'output');
      stream.emit('close', 0);
    });
  }

  sftp(cb) {
    cb(null, this._sftpStub || {});
  }

  end() {
    this._ended = true;
  }
}

describe('SshManager', () => {
  let ssh;
  let fakeConn;

  beforeEach(() => {
    ssh = new SshManager({
      host: '192.168.1.100',
      port: 22,
      username: 'root',
      password: 'secret',
      log: () => {},
    });

    fakeConn = new FakeConn();

    // Override _connect to return our fake connection instead of using real ssh2
    sinon.stub(ssh, '_connect').callsFake(async () => {
      if (ssh._connected && ssh._conn) return ssh._conn;
      ssh._conn = fakeConn;
      ssh._connected = true;
      return fakeConn;
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('constructor', () => {
    it('should store connection parameters', () => {
      assert.strictEqual(ssh._host, '192.168.1.100');
      assert.strictEqual(ssh._port, 22);
      assert.strictEqual(ssh._username, 'root');
      assert.strictEqual(ssh._password, 'secret');
    });

    it('should default port to 22', () => {
      const s = new SshManager({ host: '10.0.0.1', log: () => {} });
      assert.strictEqual(s._port, 22);
    });

    it('should default username to root', () => {
      const s = new SshManager({ host: '10.0.0.1', log: () => {} });
      assert.strictEqual(s._username, 'root');
    });

    it('should start disconnected', () => {
      const s = new SshManager({ host: '10.0.0.1', log: () => {} });
      assert.strictEqual(s._connected, false);
      assert.strictEqual(s._conn, null);
    });
  });

  describe('updateConfig', () => {
    it('should update config values', () => {
      ssh.updateConfig({ host: '10.0.0.2', port: 2222, username: 'admin', password: 'new' });
      assert.strictEqual(ssh._host, '10.0.0.2');
      assert.strictEqual(ssh._port, 2222);
      assert.strictEqual(ssh._username, 'admin');
      assert.strictEqual(ssh._password, 'new');
    });

    it('should disconnect if config changed and currently connected', async () => {
      await ssh.exec('echo test');
      assert.strictEqual(ssh._connected, true);

      ssh.updateConfig({ host: '10.0.0.2', port: 22, username: 'root', password: 'secret' });
      assert.strictEqual(ssh._connected, false);
    });

    it('should not disconnect if config unchanged', async () => {
      await ssh.exec('echo test');
      ssh.updateConfig({ host: '192.168.1.100', port: 22, username: 'root', password: 'secret' });
      // Should still be connected since nothing changed
      assert.strictEqual(ssh._conn, fakeConn);
    });
  });

  describe('exec', () => {
    it('should execute command and return stdout', async () => {
      const result = await ssh.exec('echo hello');
      assert.strictEqual(result, 'output');
    });

    it('should reject on non-zero exit code', async () => {
      fakeConn.exec = (cmd, cb) => {
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        cb(null, stream);
        process.nextTick(() => {
          stream.stderr.emit('data', 'error message');
          stream.emit('close', 1);
        });
      };

      await assert.rejects(
        () => ssh.exec('bad command'),
        (err) => {
          assert.ok(err.message.includes('Command failed (exit 1)'));
          return true;
        }
      );
    });

    it('should reuse existing connection', async () => {
      await ssh.exec('echo 1');
      await ssh.exec('echo 2');
      // _connect is called twice (once per exec), but the same connection is reused
      assert.strictEqual(ssh._connect.callCount, 2);
      assert.strictEqual(ssh._conn, fakeConn);
    });

    it('should reconnect after disconnect', async () => {
      await ssh.exec('echo 1');
      ssh.disconnect(); // Clears _conn and _connected

      const newConn = new FakeConn();
      ssh._connect.callsFake(async () => {
        ssh._conn = newConn;
        ssh._connected = true;
        return newConn;
      });

      await ssh.exec('echo 2');
      assert.strictEqual(ssh._connect.callCount, 2);
    });
  });

  describe('readFile', () => {
    it('should read file via cat command', async () => {
      const result = await ssh.readFile('/tmp/test.txt');
      assert.strictEqual(fakeConn._lastExecCmd, 'cat "/tmp/test.txt"');
      assert.strictEqual(result, 'output');
    });
  });

  describe('writeFile', () => {
    it('should write data via base64 pipe', async () => {
      await ssh.writeFile('/tmp/test.txt', 'hello');
      const b64 = Buffer.from('hello').toString('base64');
      assert.strictEqual(fakeConn._lastExecCmd, `echo '${b64}' | base64 -d > "/tmp/test.txt"`);
    });
  });

  describe('listDir', () => {
    it('should return filenames from ls command', async () => {
      fakeConn.exec = (cmd, cb) => {
        fakeConn._lastExecCmd = cmd;
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        cb(null, stream);
        process.nextTick(() => {
          stream.emit('data', 'file1.txt\nfile2.txt\n');
          stream.emit('close', 0);
        });
      };

      const result = await ssh.listDir('/tmp');
      assert.deepStrictEqual(result, ['file1.txt', 'file2.txt']);
    });
  });

  describe('fileExists', () => {
    it('should return true when file exists', async () => {
      const result = await ssh.fileExists('/tmp/exists.txt');
      assert.strictEqual(result, true);
      assert.strictEqual(fakeConn._lastExecCmd, 'test -e "/tmp/exists.txt"');
    });

    it('should return false when file does not exist', async () => {
      fakeConn.exec = (cmd, cb) => {
        fakeConn._lastExecCmd = cmd;
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        cb(null, stream);
        process.nextTick(() => {
          stream.emit('close', 1);
        });
      };
      const result = await ssh.fileExists('/tmp/missing.txt');
      assert.strictEqual(result, false);
    });
  });

  describe('copyFile', () => {
    it('should exec cp command', async () => {
      await ssh.copyFile('/src/file', '/dst/file');
      assert.strictEqual(fakeConn._lastExecCmd, 'cp "/src/file" "/dst/file"');
    });
  });

  describe('removeFile', () => {
    it('should exec rm -f command', async () => {
      await ssh.removeFile('/tmp/file');
      assert.strictEqual(fakeConn._lastExecCmd, 'rm -f "/tmp/file"');
    });
  });

  describe('reboot', () => {
    it('should exec reboot and handle connection close gracefully', async () => {
      fakeConn.exec = (cmd, cb) => {
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        cb(null, stream);
        process.nextTick(() => {
          stream.stderr.emit('data', 'connection closed');
          stream.emit('close', 255);
        });
      };

      // Should not throw
      await ssh.reboot();
      assert.strictEqual(ssh._connected, false);
    });
  });

  describe('disconnect', () => {
    it('should end connection and reset state', async () => {
      await ssh.exec('echo test');
      ssh.disconnect();
      assert.strictEqual(ssh._connected, false);
      assert.strictEqual(ssh._conn, null);
      assert.strictEqual(fakeConn._ended, true);
    });

    it('should be safe to call when not connected', () => {
      ssh.disconnect();
      assert.strictEqual(ssh._connected, false);
    });
  });
});
