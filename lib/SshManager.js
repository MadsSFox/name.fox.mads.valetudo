'use strict';

const { Client } = require('ssh2');

class SshManager {

  constructor({ host, port, username, password, privateKey, log }) {
    this._log = log || console.log;
    this._host = host;
    this._port = port || 22;
    this._username = username || 'root';
    this._password = password;
    this._privateKey = privateKey;
    this._conn = null;
    this._connected = false;
  }

  updateConfig({ host, port, username, password, privateKey }) {
    const changed = host !== this._host || port !== this._port
      || username !== this._username || password !== this._password
      || privateKey !== this._privateKey;
    this._host = host;
    this._port = port || 22;
    this._username = username || 'root';
    this._password = password;
    this._privateKey = privateKey;
    if (changed && this._connected) {
      this.disconnect();
    }
  }

  _connect() {
    return new Promise((resolve, reject) => {
      if (this._connected && this._conn) {
        resolve(this._conn);
        return;
      }

      const conn = new Client();
      conn.on('ready', () => {
        this._conn = conn;
        this._connected = true;
        this._log('SSH connected');
        resolve(conn);
      });
      conn.on('error', (err) => {
        this._connected = false;
        reject(err);
      });
      conn.on('close', () => {
        this._connected = false;
        this._conn = null;
      });
      const connectOpts = {
        host: this._host,
        port: this._port,
        username: this._username,
        readyTimeout: 10000,
        keepaliveInterval: 30000,
      };
      if (this._privateKey) {
        connectOpts.privateKey = this._privateKey;
      }
      if (this._password) {
        connectOpts.password = this._password;
      }
      conn.connect(connectOpts);
    });
  }

  async exec(command) {
    const conn = await this._connect();
    return new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        stream.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`Command failed (exit ${code}): ${stderr || stdout}`));
          } else {
            resolve(stdout);
          }
        });
        stream.on('data', (data) => { stdout += data; });
        stream.stderr.on('data', (data) => { stderr += data; });
      });
    });
  }

  async readFile(path) {
    return this.exec(`cat "${path}"`);
  }

  async writeFile(path, data) {
    // Base64-encode to safely transport arbitrary file content over shell
    const b64 = Buffer.from(data).toString('base64');
    await this.exec(`echo '${b64}' | base64 -d > "${path}"`);
  }

  async listDir(path) {
    const output = await this.exec(`ls "${path}"`);
    return output.trim().split('\n').filter(Boolean);
  }

  async copyFile(src, dst) {
    await this.exec(`cp "${src}" "${dst}"`);
  }

  async removeFile(path) {
    await this.exec(`rm -f "${path}"`);
  }

  async fileExists(path) {
    try {
      await this.exec(`test -e "${path}"`);
      return true;
    } catch {
      return false;
    }
  }

  async reboot() {
    try {
      await this.exec('reboot');
    } catch {
      // reboot closes the connection, which is expected
    }
    this._connected = false;
    this._conn = null;
  }

  disconnect() {
    if (this._conn) {
      this._conn.end();
      this._conn = null;
      this._connected = false;
    }
  }

}

module.exports = SshManager;
