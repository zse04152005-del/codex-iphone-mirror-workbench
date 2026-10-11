import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class LivePreview {
  constructor(directory) {
    this.source = path.join(directory, 'native/live-stream.swift');
    this.binary = path.join(directory, 'native/live-stream');
    this.cache = path.join(directory, 'data/swift-cache');
    this.clients = new Set();
    this.child = null;
    this.starting = null;
    this.buffer = Buffer.alloc(0);
    this.expected = 0;
    this.frame = null;
    this.frameAt = 0;
  }
  async ensureBinary() {
    if (fs.existsSync(this.binary) && fs.statSync(this.binary).mtimeMs >= fs.statSync(this.source).mtimeMs) return;
    fs.mkdirSync(this.cache, { recursive: true });
    await new Promise((resolve, reject) => {
      const child = spawn('swiftc', ['-parse-as-library', '-module-cache-path', this.cache, this.source, '-o', this.binary]);
      let error = '';
      child.stderr.on('data', chunk => { error = (error + chunk.toString()).slice(-3000); });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(error || `画面流编译失败：${code}`)));
    });
  }
  async start() {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await this.ensureBinary();
      if (!this.clients.size || this.child) return;
      const child = spawn(this.binary, [], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      this.buffer = Buffer.alloc(0);
      this.expected = 0;
      child.stdout.on('data', chunk => this.parse(chunk));
      child.stderr.on('data', () => {});
      child.once('error', () => this.stop(true));
      child.once('exit', () => {
        if (this.child !== child) return;
        this.child = null;
        this.frame = null;
        this.frameAt = 0;
        for (const response of this.clients) response.end();
        this.clients.clear();
      });
    })().finally(() => { this.starting = null; });
    return this.starting;
  }
  parse(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (!this.expected) {
        if (this.buffer.length < 4) return;
        this.expected = this.buffer.readUInt32BE(0);
        this.buffer = this.buffer.subarray(4);
        if (this.expected < 100 || this.expected > 2_000_000) { this.stop(true); return; }
      }
      if (this.buffer.length < this.expected) return;
      const frame = this.buffer.subarray(0, this.expected);
      this.buffer = this.buffer.subarray(this.expected);
      this.expected = 0;
      this.frame = frame;
      this.frameAt = Date.now();
      const header = Buffer.from(`--phoneframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      for (const response of this.clients) {
        if (response.destroyed) { this.clients.delete(response); continue; }
        if (response.writableLength > 1_000_000) continue;
        response.write(header);
        response.write(frame);
        response.write('\r\n');
      }
    }
  }
  async subscribe(response) {
    this.clients.add(response);
    try { await this.start(); }
    catch (error) { this.clients.delete(response); throw error; }
    response.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=phoneframe',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'keep-alive',
    });
    if (this.frame) {
      response.write(`--phoneframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${this.frame.length}\r\n\r\n`);
      response.write(this.frame);
      response.write('\r\n');
    }
    response.once('close', () => {
      this.clients.delete(response);
      if (!this.clients.size) this.stop();
    });
  }
  stop(endClients = false) {
    if (this.child) { this.child.kill('SIGTERM'); this.child = null; }
    this.buffer = Buffer.alloc(0);
    this.expected = 0;
    if (endClients) {
      for (const response of this.clients) response.end();
      this.clients.clear();
    }
  }
  close() {
    this.stop(true);
  }
}
