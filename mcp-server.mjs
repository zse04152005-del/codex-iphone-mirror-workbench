import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const bridge = JSON.parse(fs.readFileSync(path.join(directory, 'data', 'agent-bridge.json'), 'utf8'));
const port = Number(bridge.port);
const agentToken = bridge.agentToken;
let input = '';

const tools = [
  { name: 'phone_status', description: '检查 Mac 自带 iPhone 镜像的连接状态。手机可以保持锁定。', inputSchema: { type: 'object', properties: {} } },
  { name: 'phone_capture', description: '读取当前 iPhone 镜像窗口的真实画面。执行每一步前后都应观察画面。', inputSchema: { type: 'object', properties: {} } },
  { name: 'phone_tap', description: '在最近看到的镜像画面上点击，x、y 为从 0 到 1 的相对坐标。点击控件中心；工具返回 ok 只表示事件已发送，必须重新截图确认页面变化。主屏幕找 App 优先使用 phone_spotlight。', inputSchema: { type: 'object', properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } }, required: ['x', 'y'] } },
  { name: 'phone_long_press', description: '在画面指定位置长按约 0.9 秒，用于显示 iPhone 的文本编辑菜单等。x、y 为 0 到 1 的相对坐标。', inputSchema: { type: 'object', properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } }, required: ['x', 'y'] } },
  { name: 'phone_scroll', description: '在镜像画面上滚动。方向为 up、down、left 或 right；distance 为 1 到 5。左右方向使用 iPhone 镜像支持的 Shift 加滚轮。操作后重新截图确认。', inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, distance: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['direction'] } },
  { name: 'phone_type', description: '向镜像中当前聚焦的输入框发送真实物理按键。先点击正确输入框。英文、数字和常用 ASCII 符号直接输入；连续中文会转成拼音，返回 needsCandidateSelection=true，此时必须截图并在 iPhone 候选栏选择正确汉字。中英混合请拆段；每段英文输入后先点击候选栏中的完整英文词，再输入中文拼音并选择正确汉字，最后截图确认整词。工具返回 ok 不等于最终文字正确。', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['text'] } },
  { name: 'phone_key', description: '向镜像发送 Return、Backspace、Escape 或 Tab。', inputSchema: { type: 'object', properties: { key: { type: 'string', enum: ['Return', 'Backspace', 'Escape', 'Tab'] } }, required: ['key'] } },
  { name: 'phone_home', description: '通过镜像返回 iPhone 主屏幕。', inputSchema: { type: 'object', properties: {} } },
  { name: 'phone_spotlight', description: '通过 iPhone 镜像的 Command-3 快捷键打开 iPhone 聚焦搜索。找 App 时先用它，再截图、输入 App 名称并选择正确结果。', inputSchema: { type: 'object', properties: {} } },
  { name: 'phone_find_app', description: '一次操作打开 Spotlight 并输入应用的英文名或拼音；随后必须截图，点选匹配的应用图标，并确认进入目标应用后再处理任务。', inputSchema: { type: 'object', properties: { search: { type: 'string', pattern: '^[a-z]{2,40}$' } }, required: ['search'] } },
];

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function text(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }
async function request(route, payload, image = false) {
  if (!agentToken || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('工作台 Agent 通道尚未启动');
  const response = await fetch(`http://127.0.0.1:${port}/api/agent/${route}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'x-agent-token': agentToken, 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `工作台请求失败：${response.status}`);
  }
  return image ? Buffer.from(await response.arrayBuffer()) : response.json();
}

async function call(name, args = {}) {
  if (name === 'phone_status') return text(await request('status'));
  if (name === 'phone_capture') {
    const frame = await request('frame', undefined, true);
    return { content: [{ type: 'image', data: frame.toString('base64'), mimeType: 'image/jpeg' }] };
  }
  if (name === 'phone_tap') return text(await request('tap', { x: args.x, y: args.y }));
  if (name === 'phone_long_press') return text(await request('long-press', { x: args.x, y: args.y }));
  if (name === 'phone_scroll') return text(await request('scroll', { direction: args.direction, distance: args.distance ?? 2 }));
  if (name === 'phone_type') return text(await request('type', { text: args.text }));
  if (name === 'phone_key') return text(await request('key', { key: args.key }));
  if (name === 'phone_home') return text(await request('home', {}));
  if (name === 'phone_spotlight') return text(await request('spotlight', {}));
  if (name === 'phone_find_app') return text(await request('find-app', { search: args.search }));
  throw new Error('未知手机工具');
}

async function handle(request) {
  if (!request || typeof request !== 'object' || request.id === undefined) return;
  const { id, method, params = {} } = request;
  try {
    if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'phone-workbench', version: '0.1.0' } } });
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
    if (method === 'tools/call') {
      try { return send({ jsonrpc: '2.0', id, result: await call(params.name, params.arguments || {}) }); }
      catch (error) { return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error.message }], isError: true } }); }
    }
    return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  } catch (error) { send({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } }); }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  let index;
  while ((index = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, index);
    input = input.slice(index + 1);
    if (line.trim()) {
      try { void handle(JSON.parse(line)); }
      catch { /* Ignore malformed transport lines. */ }
    }
  }
});
