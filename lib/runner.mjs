import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { TARGET_APPS, resolveTargetApp } from './target-app.mjs';

const now = () => new Date().toISOString();
const safeLine = value => String(value || '').replace(/[\r\n]+/g, ' ').slice(0, 500);
function toolActivity(item) {
  const name = String(item.tool || item.tool_name || item.name || item.server || '镜像').split('__').pop();
  let args = item.arguments || {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
  if (!args || typeof args !== 'object') args = {};
  if (name === 'phone_tap' && Number.isFinite(args.x) && Number.isFinite(args.y))
    return `调用手机工具：${name}（${Math.round(args.x * 100)}%, ${Math.round(args.y * 100)}%）`;
  if (name === 'phone_scroll') return `调用手机工具：${name}（${safeLine(args.direction)} ${args.distance ?? 2}）`;
  if (name === 'phone_type') return `调用手机工具：${name}（输入内容已隐藏）`;
  return `调用手机工具：${name}`;
}

function instructions(task, continuation) {
  const target = TARGET_APPS[task.targetApp];
  const routing = target
    ? continuation
      ? `本任务的目标应用是${target.label}。先截图核对当前页面和上轮准备的内容，不要因切换应用而丢失草稿；若当前页面不是${target.label}或批准内容已变化，停止并说明。\n`
      : `本任务的目标应用是${target.label}。系统已先打开 Spotlight 并搜索“${target.search}”。第一步读取 phone_capture，只点选匹配的${target.label}应用结果；再截图确认已进入${target.label}，然后才能执行任务内容。若结果不匹配，重新用 phone_find_app 搜索；绝不可先在上一个应用操作。\n`
    : `先用 phone_capture 识别当前应用。若任务涉及指定应用，第一项控制操作必须使用 phone_find_app 切换过去，确认目标应用后再执行；不要在上一个任务留下的应用中操作。\n`;
  const base = `你是 Codex 手机工作台的执行 Agent。用户的任务是：${task.prompt}\n\n` +
    routing +
    `只通过 phone_workbench MCP 工具操作 Mac 自带的「iPhone 镜像」窗口。以 phone_capture 读取真实画面；仅在画面无法判断连接时再调用 phone_status。根据画面点击、滚动、输入；连续且确定的导航动作可合并，关键页面和结果必须截图核对。找 App 优先用 phone_find_app 一次打开 Spotlight 并输入应用拼音或英文名，再截图点选正确结果。phone_type 对连续中文会输入拼音并返回 needsCandidateSelection=true，必须截图后点选正确汉字。中英混合搜索词须分段输入：先输入英文，截图并点击输入法候选栏中的完整英文词使其提交；再输入中文拼音，截图并点击正确汉字候选；最后截图确认搜索框显示完整词，再点搜索。若联想词已是用户要搜的完整词，也可直接点该联想词。不要点击页面底部的语音搜索。phone_tap、phone_scroll、phone_type 返回 ok 只代表事件已发送，不能当作页面或文字已经正确变化。不要调用 iPhone Use、WebDriverAgent、USB 通道、其他电脑工具或终端。镜像暂停或需要 Mac 登录密码、Touch ID、iPhone 密码、App 认证时，停止并交给用户本人，不索取凭据。支付、输入支付凭据和接受法律协议也由用户本人完成，即使批准了工作台决策也不能代办。一次只执行一项任务，发送、提交、下单后核对真实结果；状态不确定时先读取现状，不重做。\n` +
    `你不能修改工作台源代码、绕过权限或使用终端直接访问手机。最终只返回符合指定 JSON Schema 的对象。status=done 表示有结果证据；status=blocked 表示外部条件阻塞。\n`;
  if (continuation) {
    return base + `用户刚刚在工作台明确批准这项具体决策：${continuation.title}。详情：${continuation.detail}。` +
      `请按照上一轮提出的步骤执行一次：${continuation.resumeInstruction}。如果收件人、价格、地址、字段值或页面与批准时不同，停止并返回 needs_decision。` +
      `执行后核对最终结果，不确定时不要重复。`;
  }
  return base + `当前处于准备阶段。你可以读取、导航、筛选和填写草稿，但在发送消息、提交报表、下单、支付或其他对外最终动作之前必须停止，` +
    `返回 status=needs_decision，并在 decisionTitle、decisionDetail、resumeInstruction 中写出供用户确认的具体内容。` +
    `如果任务只是读取信息且已完成，返回 status=done。不要把工具调用成功误写成业务已完成。`;
}

export class Runner extends EventEmitter {
  constructor(store, directory, bridge, phone) {
    super();
    this.store = store;
    this.directory = directory;
    this.bridge = bridge;
    this.phone = phone;
    this.active = null;
    this.queue = [];
  }
  list() { return this.store.state.tasks; }
  start() {
    const pending = this.store.state.tasks.filter(task => task.status === 'queued').slice().reverse().map(task => task.id);
    this.queue.push(...pending.filter(id => !this.queue.includes(id)));
    this.pump();
  }
  create({ prompt, model, reasoningEffort, targetApp = '', dueAt, scheduleId = null, idempotencyKey = null }) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 3000) throw new Error('请输入 1 到 3000 字的任务');
    if (model && !/^[a-zA-Z0-9._-]{1,80}$/.test(model)) throw new Error('模型名称无效');
    if (reasoningEffort && !['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) throw new Error('思考档位无效');
    if (dueAt && (!Number.isFinite(Date.parse(dueAt)) || Date.parse(dueAt) < Date.now())) throw new Error('提醒时间必须晚于现在');
    if (idempotencyKey) {
      const existing = this.store.state.tasks.find(item => item.idempotencyKey === idempotencyKey);
      if (existing) return existing;
    }
    const task = { id: randomUUID(), prompt: prompt.trim(), model: model || '', reasoningEffort: reasoningEffort || '', targetApp: resolveTargetApp(prompt, targetApp), dueAt: dueAt || null, scheduleId, idempotencyKey, status: 'queued', phase: 'prepare', createdAt: now(), updatedAt: now(), logs: [], summary: '', evidence: '', sessionId: null };
    this.store.update(state => { state.tasks.unshift(task); state.tasks = state.tasks.slice(0, 100); });
    this.queue.push(task.id);
    this.emit('update');
    this.pump();
    return task;
  }
  log(task, message) {
    task.logs.push({ at: now(), message: safeLine(message) });
    task.logs = task.logs.slice(-120);
    task.updatedAt = now();
    this.store.save();
    this.emit('update');
  }
  pump() {
    if (this.active || !this.queue.length) return;
    const id = this.queue.shift();
    const task = this.store.task(id);
    if (task?.status === 'queued') this.run(task).catch(error => this.fail(task, error));
    else this.pump();
  }
  fail(task, error) {
    task.status = 'failed';
    this.log(task, `执行失败：${safeLine(error.message)}`);
    this.active = null;
    this.emit('update');
    this.pump();
  }
  async run(task) {
    task.status = 'running';
    task.updatedAt = now();
    this.store.save();
    this.emit('update');
    this.active = { id: task.id, child: null };
    if (task.phase === 'prepare' && TARGET_APPS[task.targetApp]) {
      const target = TARGET_APPS[task.targetApp];
      this.log(task, `先切换目标应用：${target.label}`);
      const result = await this.phone.findApp(target.search);
      if (!result.queryVisible) throw new Error(`未能在 Spotlight 中确认${target.label}的搜索词，请检查镜像画面`);
      this.log(task, `已搜索${target.label}，等待 Agent 从画面确认并打开应用`);
      if (task.status === 'cancelled') { this.active = null; this.pump(); return; }
    }
    const schema = path.join(this.directory, 'task-result.schema.json');
    const mcpPath = path.join(this.directory, 'mcp-server.mjs');
    const common = [
      '--approve-for-me', '--ignore-user-config', '--json', '--skip-git-repo-check', '--output-schema', schema,
      '-c', `mcp_servers.phone_workbench.command=${JSON.stringify(process.execPath)}`,
      '-c', `mcp_servers.phone_workbench.args=${JSON.stringify([mcpPath])}`,
    ];
    if (task.model) common.push('-m', task.model);
    if (task.reasoningEffort) common.push('-c', `model_reasoning_effort=${JSON.stringify(task.reasoningEffort)}`);
    const args = ['exec', ...common, '-C', this.directory, '-'];
    const env = { ...process.env, NO_COLOR: '1' };
    delete env.CODEX_API_KEY;
    const child = spawn('codex', args, { cwd: this.directory, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.active = { id: task.id, child };
    let buffer = '', stderr = '', finalText = '', lastMessage = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'thread.started') { task.sessionId = event.thread_id; this.store.save(); }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          lastMessage = event.item.text || '';
          let description = lastMessage;
          try {
            const structured = JSON.parse(lastMessage);
            if (structured.summary) description = structured.summary;
          } catch { /* The model may also send a plain progress note. */ }
          this.log(task, description.slice(0, 300));
        }
        if (event.type === 'item.started' && event.item?.type === 'mcp_tool_call') this.log(task, toolActivity(event.item));
        if (event.type === 'turn.failed') this.log(task, `模型回合失败：${safeLine(event.error?.message)}`);
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-3000); });
    child.stdin.end(instructions(task, task.phase === 'execute' ? task.approvedDecision : null));
    const code = await new Promise(resolve => child.once('exit', resolve));
    this.active = null;
    finalText = lastMessage.trim();
    if (task.status === 'cancelled') { this.pump(); return; }
    if (code !== 0) throw new Error(stderr.trim().split('\n').slice(-2).join(' ') || `Codex 退出码 ${code}`);
    let result;
    try { result = JSON.parse(finalText); } catch {
      throw new Error(`Codex 未返回可解析的结果：${safeLine(finalText || stderr)}`);
    }
    task.summary = result.summary || '';
    task.evidence = result.evidence || '';
    task.updatedAt = now();
    if (result.status === 'needs_decision') {
      task.status = 'awaiting_decision';
      const decision = { id: randomUUID(), taskId: task.id, title: result.decisionTitle || '需要你决定', detail: result.decisionDetail || task.summary, resumeInstruction: result.resumeInstruction || '', status: 'pending', createdAt: now(), dueAt: task.dueAt, remindedAt: null };
      this.store.state.decisions.unshift(decision);
      this.log(task, `等待决定：${decision.title}`);
      this.emit('decision', decision);
    } else {
      task.status = result.status === 'done' ? 'done' : 'blocked';
      this.log(task, task.summary || task.status);
    }
    this.store.save();
    this.emit('update');
    this.pump();
  }
  resolveDecision(id, action) {
    const decision = this.store.decision(id);
    if (!decision || decision.status !== 'pending') throw new Error('这项决定已处理');
    const task = this.store.task(decision.taskId);
    if (!task) throw new Error('任务不存在');
    if (!['approve', 'reject'].includes(action)) throw new Error('无效选择');
    decision.status = action === 'approve' ? 'approved' : 'rejected';
    decision.resolvedAt = now();
    if (action === 'approve') {
      task.phase = 'execute';
      task.approvedDecision = { title: decision.title, detail: decision.detail, resumeInstruction: decision.resumeInstruction };
      task.status = 'queued';
      this.queue.push(task.id);
    } else {
      task.status = 'cancelled';
      this.log(task, '用户取消了最终操作');
    }
    this.store.save();
    this.emit('update');
    this.pump();
    return { decision, task };
  }
  cancel(id) {
    const task = this.store.task(id);
    if (!task || !['queued', 'running'].includes(task.status)) throw new Error('任务无法取消');
    task.status = 'cancelled';
    task.updatedAt = now();
    if (this.active?.id === id) this.active.child?.kill('SIGINT');
    this.store.save();
    this.emit('update');
    return task;
  }
  retry(id) {
    const task = this.store.task(id);
    if (!task || !['blocked', 'failed', 'interrupted'].includes(task.status)) throw new Error('仅可重试已阻塞、失败或中断的任务');
    task.status = 'queued';
    task.phase = 'prepare';
    task.summary = '';
    task.evidence = '';
    task.updatedAt = now();
    this.log(task, '用户要求继续：从当前手机画面重新检查任务进度');
    this.queue.push(task.id);
    this.pump();
    return task;
  }
  reminders() {
    const minutes = Math.max(1, Number(this.store.state.settings.reminderMinutes) || 15);
    const due = this.store.state.decisions.filter(item => item.status === 'pending' && item.dueAt && !item.remindedAt && Date.parse(item.dueAt) - Date.now() <= minutes * 60000);
    if (!due.length) return;
    for (const item of due) item.remindedAt = now();
    this.store.save();
    this.emit('reminder', due);
    this.emit('update');
  }
}
