import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

function run(binary, args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], errors = [];
    let bytes = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('读取 iPhone 镜像超时；请检查屏幕录制权限和镜像窗口')); }, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { child.kill('SIGKILL'); return; }
      out.push(chunk);
    });
    child.stderr.on('data', chunk => errors.push(chunk));
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(Buffer.concat(errors).toString().trim() || `镜像助手退出码 ${code}`));
      else resolve(Buffer.concat(out));
    });
  });
}

export class Mirror extends EventEmitter {
  constructor(directory) {
    super();
    this.directory = directory;
    this.source = path.join(directory, 'native/mirror-helper.swift');
    this.binary = path.join(directory, 'native/mirror-helper');
    this.lastStatus = null;
    this.statusAt = 0;
    this.frame = null;
    this.frameAt = 0;
    this.capturePending = null;
    this.operation = Promise.resolve();
    this.preview = null;
    this.lastActionAt = 0;
  }
  setPreview(preview) { this.preview = preview; }
  async ensureBinary() {
    if (fs.existsSync(this.binary) && fs.statSync(this.binary).mtimeMs >= fs.statSync(this.source).mtimeMs) return;
    const cache = path.join(this.directory, 'data/swift-cache');
    fs.mkdirSync(cache, { recursive: true });
    await run('swiftc', ['-parse-as-library', '-module-cache-path', cache, this.source, '-o', this.binary], 120000);
  }
  async command(name, args = [], timeout = 8000) {
    const next = this.operation.then(async () => {
      await this.ensureBinary();
      const result = await run(this.binary, [name, ...args], timeout);
      if (['click', 'press', 'scroll', 'type', 'key', 'home', 'spotlight', 'find', 'reconnect'].includes(name)) {
        this.frame = null;
        this.frameAt = 0;
        this.statusAt = 0;
        this.lastActionAt = Date.now();
      }
      return result;
    });
    this.operation = next.catch(() => {});
    return next;
  }
  async status(force = false) {
    if (!force && this.lastStatus && Date.now() - this.statusAt < 4000) return this.lastStatus;
    try {
      const result = JSON.parse((await this.command('status')).toString());
      const reason = ({ paused: '镜像连接已暂停，点击「检查镜像」继续', needs_phone_lock: '请锁定 iPhone 后从 Mac 连接', disconnected: 'iPhone 镜像尚未连接', connecting: '镜像正在连接', needs_auth: '请在 Mac 上完成镜像认证' })[result.connectionState];
      this.lastStatus = { ...result, ready: result.connectionState === 'connected', preview: Boolean(this.frame && Date.now() - this.frameAt < 4000), error: reason || null };
    } catch (error) {
      this.lastStatus = { ready: false, running: false, windowVisible: false, captureReady: false, preview: false, error: error.message };
    }
    this.statusAt = Date.now();
    return this.lastStatus;
  }
  async connect() {
    const opened = JSON.parse((await this.command('open')).toString());
    if (!opened.ok) throw new Error('无法打开 iPhone 镜像应用');
    this.statusAt = 0;
    let status = await this.status(true);
    if (!status.ready && status.windowVisible && status.accessibilityTrusted) {
      try {
        await this.command('reconnect');
        for (let i = 0; i < 8; i++) {
          await new Promise(resolve => setTimeout(resolve, 800));
          status = await this.status(true);
          if (status.ready || status.connectionState === 'needs_auth') break;
        }
      } catch (error) {
        status.error = error.message;
      }
    }
    this.emit('status');
    if (!status.ready) throw new Error(status.error || '镜像应用已打开，请在 Mac 上完成首次连接或认证');
    return status;
  }
  async snapshot() {
    if (this.preview?.frame && Date.now() - this.preview.frameAt < 250 && this.preview.frameAt > this.lastActionAt + 120)
      return this.preview.frame;
    if (this.frame && Date.now() - this.frameAt < 900) return this.frame;
    if (this.capturePending) return this.capturePending;
    this.capturePending = this.command('capture', [], 12000)
      .then(frame => {
        if (frame.length < 100 || frame[0] !== 0xff || frame[1] !== 0xd8) throw new Error('镜像未返回有效画面');
        this.frame = frame;
        this.frameAt = Date.now();
        return frame;
      })
      .finally(() => { this.capturePending = null; });
    return this.capturePending;
  }
  async tap(nx, ny) {
    if (![nx, ny].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error('点击位置无效');
    return JSON.parse((await this.command('click', [String(nx), String(ny)])).toString());
  }
  async longPress(nx, ny) {
    if (![nx, ny].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error('长按位置无效');
    return JSON.parse((await this.command('press', [String(nx), String(ny)])).toString());
  }
  async scroll(direction, distance = 2) {
    if (!['up', 'down', 'left', 'right'].includes(direction) || !Number.isInteger(distance) || distance < 1 || distance > 5) throw new Error('滚动参数无效');
    return JSON.parse((await this.command('scroll', [direction, String(distance)])).toString());
  }
  async type(value) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 2000) throw new Error('输入内容长度无效');
    return JSON.parse((await this.command('type', [value])).toString());
  }
  async key(value) {
    if (!['Return', 'Backspace', 'Escape', 'Tab'].includes(value)) throw new Error('按键无效');
    return JSON.parse((await this.command('key', [value])).toString());
  }
  async home() { return JSON.parse((await this.command('home')).toString()); }
  async spotlight() { return JSON.parse((await this.command('spotlight')).toString()); }
  async findApp(search) {
    if (typeof search !== 'string' || !/^[a-z]{2,40}$/.test(search)) throw new Error('应用搜索词无效');
    return JSON.parse((await this.command('find', [search], 12000)).toString());
  }
  close() { /* Each native helper call owns a short-lived process. */ }
}
