import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Store } from './lib/store.mjs';
import { Mirror } from './lib/mirror.mjs';
import { LivePreview } from './lib/live-preview.mjs';
import { Runner } from './lib/runner.mjs';
import { Scheduler } from './lib/scheduler.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(directory, 'public');
const port = Number(process.env.PHONE_WORKBENCH_PORT || 4173);
const token = randomBytes(24).toString('hex');
const agentToken = randomBytes(24).toString('hex');
const store = new Store(path.join(directory, 'data'));
const bridgeFile = path.join(directory, 'data', 'agent-bridge.json');
const phone = new Mirror(directory);
const preview = new LivePreview(directory);
phone.setPreview(preview);
const runner = new Runner(store, directory, { port, agentToken }, phone);
const scheduler = new Scheduler(store, runner);
const clients = new Set();
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
function error(res, err, status = 400) { json(res, status, { error: err.message || String(err) }); }
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20000) throw new Error('请求内容过长');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
function notifySystem(title, message) {
  if (process.platform !== 'darwin') return;
  const quote = value => String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replace(/[\r\n]/g, ' ').slice(0, 180);
  const script = `display notification "${quote(message)}" with title "${quote(title)}"`;
  const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
  child.on('error', () => {});
}
function publish(type, data = {}) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(payload);
}
runner.on('update', () => publish('update'));
runner.on('decision', decision => {
  publish('decision', { id: decision.id, title: decision.title, detail: decision.detail });
  notifySystem('手机工作台 · 需要决定', decision.title);
});
runner.on('reminder', decisions => {
  publish('reminder', { decisions: decisions.map(item => ({ id: item.id, title: item.title })) });
  notifySystem('手机工作台 · 即将到期', `${decisions.length} 项决定等待处理`);
});
scheduler.on('update', () => publish('update'));
scheduler.on('fired', ({ schedule, task }) => {
  publish('schedule', { scheduleId: schedule.id, title: schedule.title, taskId: task.id });
  notifySystem('手机工作台 · 定时任务已开始', schedule.title);
});
phone.on('status', () => publish('update'));
setInterval(() => runner.reminders(), 30000).unref();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const pathname = url.pathname;
  if (pathname.startsWith('/api/agent/')) {
    if (req.headers['x-agent-token'] !== agentToken) return error(res, new Error('未授权'), 403);
    try {
      if (pathname === '/api/agent/status' && req.method === 'GET') return json(res, 200, await phone.status(true));
      if (pathname === '/api/agent/frame' && req.method === 'GET') {
        const frame = await phone.snapshot();
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': frame.length });
        return res.end(frame);
      }
      if (pathname === '/api/agent/tap' && req.method === 'POST') { const input = await body(req); return json(res, 200, await phone.tap(input.x, input.y)); }
      if (pathname === '/api/agent/long-press' && req.method === 'POST') { const input = await body(req); return json(res, 200, await phone.longPress(input.x, input.y)); }
      if (pathname === '/api/agent/scroll' && req.method === 'POST') { const input = await body(req); return json(res, 200, await phone.scroll(input.direction, input.distance)); }
      if (pathname === '/api/agent/type' && req.method === 'POST') { const input = await body(req); return json(res, 200, await phone.type(input.text)); }
      if (pathname === '/api/agent/key' && req.method === 'POST') { const input = await body(req); return json(res, 200, await phone.key(input.key)); }
      if (pathname === '/api/agent/home' && req.method === 'POST') return json(res, 200, await phone.home());
      if (pathname === '/api/agent/spotlight' && req.method === 'POST') return json(res, 200, await phone.spotlight());
      if (pathname === '/api/agent/find-app' && req.method === 'POST') { const input = await body(req); return json(res, 200, await phone.findApp(input.search)); }
      return error(res, new Error('接口不存在'), 404);
    } catch (err) { return error(res, err); }
  }
  if (pathname === '/api/bootstrap' && req.method === 'GET') {
    return json(res, 200, { token, title: '手机工作台', models: [
      { id: '', label: 'Codex 默认模型', hint: '使用你当前的 Codex 默认模型' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna · 快速', hint: 'gpt-6-luna · 轻量任务' },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol · 均衡', hint: 'gpt-6.1-sol · 推荐日常任务' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra · 深度', hint: 'gpt-6-astra · 复杂任务' },
      { id: 'gpt-6-sol', label: 'GPT-6 Sol · 经典', hint: 'gpt-6-sol · 上一代 Sol' },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol · 旧版', hint: 'gpt-5.6-sol · 旧版模型' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna · 旧版快速', hint: 'gpt-5.6-luna · 旧版快速模型' },
    ] });
  }
  if (pathname.startsWith('/api/')) {
    if (req.headers['x-workbench-token'] !== token && url.searchParams.get('token') !== token) return error(res, new Error('未授权'), 403);
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return error(res, new Error('来源不受信任'), 403);
    try {
      if (pathname === '/api/state' && req.method === 'GET') return json(res, 200, { tasks: runner.list(), decisions: store.state.decisions, schedules: scheduler.list(), settings: store.state.settings, activeTaskId: runner.active?.id || null, device: await phone.status() });
      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
        res.write('event: connected\ndata: {}\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (pathname === '/api/tasks' && req.method === 'POST') return json(res, 201, runner.create(await body(req)));
      if (pathname === '/api/schedules' && req.method === 'POST') return json(res, 201, scheduler.create(await body(req)));
      const scheduleAction = pathname.match(/^\/api\/schedules\/([a-f0-9-]+)\/(pause|resume|cancel)$/);
      if (scheduleAction && req.method === 'POST') return json(res, 200, scheduler.setStatus(scheduleAction[1], scheduleAction[2]));
      const scheduleDelete = pathname.match(/^\/api\/schedules\/([a-f0-9-]+)$/);
      if (scheduleDelete && req.method === 'DELETE') return json(res, 200, scheduler.remove(scheduleDelete[1]));
      const cancel = pathname.match(/^\/api\/tasks\/([a-f0-9-]+)\/cancel$/);
      if (cancel && req.method === 'POST') return json(res, 200, runner.cancel(cancel[1]));
      const retry = pathname.match(/^\/api\/tasks\/([a-f0-9-]+)\/retry$/);
      if (retry && req.method === 'POST') return json(res, 200, runner.retry(retry[1]));
      const resolve = pathname.match(/^\/api\/decisions\/([a-f0-9-]+)$/);
      if (resolve && req.method === 'POST') {
        const choice = await body(req);
        return json(res, 200, runner.resolveDecision(resolve[1], choice.action));
      }
      if (pathname === '/api/settings' && req.method === 'POST') {
        const input = await body(req);
        const minutes = Number(input.reminderMinutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('提醒提前量需为 1 到 1440 分钟');
        store.update(state => { state.settings.reminderMinutes = minutes; });
        publish('update');
        return json(res, 200, store.state.settings);
      }
      if (pathname === '/api/device/connect' && req.method === 'POST') return json(res, 200, await phone.connect());
      if (pathname === '/api/device/status' && req.method === 'GET') return json(res, 200, await phone.status());
      if (pathname === '/api/device/live' && req.method === 'GET') return await preview.subscribe(res);
      if (pathname === '/api/device/frame' && req.method === 'GET') {
        const frame = await phone.snapshot();
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': frame.length });
        return res.end(frame);
      }
      if (pathname === '/api/device/tap' && req.method === 'POST') {
        if (runner.active) throw new Error('Agent 正在操作手机，请先等待或暂停任务');
        const input = await body(req);
        return json(res, 200, await phone.tap(input.x, input.y));
      }
      if (pathname === '/api/device/home' && req.method === 'POST') {
        if (runner.active) throw new Error('Agent 正在操作手机，请先等待或暂停任务');
        return json(res, 200, await phone.home());
      }
      return error(res, new Error('接口不存在'), 404);
    } catch (err) { return error(res, err); }
  }
  if (req.method !== 'GET') return error(res, new Error('方法不支持'), 405);
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'style.css', 'app.js', 'phone-workbench-icon.png'].includes(file)) return error(res, new Error('页面不存在'), 404);
  const bytes = fs.readFileSync(path.join(publicDir, file));
  res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Content-Length': bytes.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(bytes);
});

server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(bridgeFile, JSON.stringify({ port, agentToken }), { mode: 0o600 });
  fs.chmodSync(bridgeFile, 0o600);
  process.stdout.write(`手机工作台已启动：http://127.0.0.1:${port}\n`);
  runner.start();
  scheduler.start();
});
function close() { scheduler.close(); phone.close(); preview.close(); try { fs.unlinkSync(bridgeFile); } catch {} server.close(); }
process.on('SIGINT', close);
process.on('SIGTERM', close);
