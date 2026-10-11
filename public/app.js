const $ = selector => document.querySelector(selector);
const nodes = {
  decisions: $('#decisions'), tasks: $('#tasks'), schedules: $('#schedules'), timeline: $('#timeline'),
  deviceDot: $('#deviceDot'), deviceStatus: $('#deviceStatus'), frameStatus: $('#frameStatus'),
  frame: $('#phoneFrame'), screenEmpty: $('#screenEmpty'), agentStatus: $('#agentStatus'),
  decisionCount: $('#decisionCount'), taskCount: $('#taskCount'), toast: $('#toast'), phonePanel: $('#phonePanel'),
};
let token = '';
let state = null;
let selectedId = null;
let manual = false;
let toastTimer;
let frameBusy = false;
let livePreviewMode = 'stream';
let historyVisibleCount = 6;
let lastDecisionIds = new Set();

function el(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}
function showToast(message) {
  nodes.toast.textContent = message;
  nodes.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => nodes.toast.classList.remove('show'), 4200);
}
async function api(route, options = {}) {
  const response = await fetch(route, { ...options, headers: { 'x-workbench-token': token, 'content-type': 'application/json', ...(options.headers || {}) } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `请求失败：${response.status}`);
  return result;
}
function formatTime(value) { return value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; }
function statusLabel(value) { return ({ queued: '排队中', running: '执行中', awaiting_decision: '等你决定', done: '已完成', blocked: '已阻塞', failed: '失败', cancelled: '已取消', interrupted: '已中断' })[value] || value; }
function scheduleLabel(value) { return ({ active: '等待执行', paused: '已暂停', completed: '已触发', cancelled: '已取消', error: '配置错误' })[value] || value; }
function repeatLabel(value) { return ({ once: '仅一次', daily: '每天', weekly: '每周' })[value] || value; }
function taskById(id) { return state?.tasks.find(task => task.id === id); }
function browserNotify(title, body) { if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body }); }

function renderDevice() {
  const device = state.device;
  const online = Boolean(device.ready);
  nodes.frame.classList.toggle('landscape', Number(device.width) > Number(device.height));
  nodes.deviceDot.classList.toggle('online', online);
  nodes.deviceStatus.textContent = online ? 'iPhone 镜像已连接 · 手机保持锁定' : device.error ? `镜像待连接 · ${device.error}` : 'iPhone 镜像未打开';
  nodes.frameStatus.textContent = online ? (livePreviewMode === 'stream' ? '流畅预览 · 最多 20 FPS' : livePreviewMode === 'paused' ? '预览已暂停' : '实时预览') : device.windowVisible ? '镜像窗口已打开' : '离线';
  $('#connectBtn').textContent = device.windowVisible ? '检查镜像' : '连接镜像';
  if (!device.windowVisible) { nodes.frame.hidden = true; nodes.screenEmpty.hidden = false; }
  $('#manualBtn').classList.toggle('active', manual);
  $('#manualBtn').textContent = manual ? '手动接管：开启' : '手动接管：关闭';
  $('#homeBtn').disabled = !online || !device.accessibilityTrusted || Boolean(state.activeTaskId);
  $('#manualBtn').disabled = !online || !device.accessibilityTrusted || Boolean(state.activeTaskId);
}
function renderDecisions() {
  const pending = state.decisions.filter(item => item.status === 'pending');
  nodes.decisionCount.textContent = String(pending.length);
  nodes.decisions.replaceChildren();
  if (!pending.length) { nodes.decisions.append(el('div', 'empty-card', '当前没有待处理决定。')); return; }
  for (const item of pending) {
    const card = el('article', 'decision-card');
    card.append(el('div', 'badge', 'NEEDS YOUR CALL'), el('h3', '', item.title), el('p', '', item.detail));
    if (item.dueAt) card.append(el('span', 'due', `截止：${formatTime(item.dueAt)}`));
    const actions = el('div', 'decision-actions');
    const approve = el('button', 'approve', '批准继续');
    const reject = el('button', 'reject', '取消');
    approve.addEventListener('click', () => resolveDecision(item.id, 'approve'));
    reject.addEventListener('click', () => resolveDecision(item.id, 'reject'));
    actions.append(approve, reject); card.append(actions); nodes.decisions.append(card);
  }
}
function renderTasks() {
  nodes.taskCount.textContent = String(state.tasks.length);
  nodes.tasks.replaceChildren();
  if (!state.tasks.length) { nodes.tasks.append(el('div', 'empty-card', '任务记录会显示在这里。')); return; }
  for (const task of state.tasks.slice(0, historyVisibleCount)) {
    const row = el('button', `task-row${selectedId === task.id ? ' selected' : ''}`);
    row.append(el('span', 'task-title', task.prompt));
    const meta = el('span', 'task-meta');
    meta.append(el('span', '', `${task.scheduleId ? '定时 · ' : ''}${formatTime(task.createdAt)}`), el('span', 'task-status', statusLabel(task.status)));
    row.append(meta);
    row.addEventListener('click', () => { selectedId = task.id; renderTasks(); renderTimeline(); });
    nodes.tasks.append(row);
  }
  $('#showMoreTasks').hidden = state.tasks.length <= historyVisibleCount;
}
function renderSchedules() {
  nodes.schedules.replaceChildren();
  const list = state.schedules || [];
  if (!list.length) { nodes.schedules.append(el('div', 'empty-card', '还没有定时任务。')); return; }
  for (const item of list.slice(0, 20)) {
    const card = el('article', 'schedule-card');
    const top = el('div', 'schedule-top');
    top.append(el('h4', '', item.title), el('span', 'schedule-state', scheduleLabel(item.status)));
    card.append(top, el('p', '', item.prompt));
    const when = item.nextRunAt ? `下次：${formatTime(item.nextRunAt)}` : item.lastRunAt ? `上次：${formatTime(item.lastRunAt)}` : '';
    card.append(el('div', 'schedule-meta', `${when} · ${repeatLabel(item.repeat)}${item.reasoningEffort ? ` · 思考 ${({ low: '低', medium: '中', high: '高', xhigh: '极高' })[item.reasoningEffort]}` : ''}`));
    if (item.lastError) card.append(el('p', '', `错误：${item.lastError}`));
    const actions = el('div', 'schedule-buttons');
    if (item.status === 'active') actions.append(scheduleButton('暂停', item.id, 'pause'));
    if (item.status === 'paused') actions.append(scheduleButton('恢复', item.id, 'resume'));
    if (['active', 'paused', 'error'].includes(item.status)) actions.append(scheduleButton('取消', item.id, 'cancel', 'danger'));
    if (['completed', 'cancelled', 'error'].includes(item.status)) {
      const remove = el('button', 'danger', '删除');
      remove.addEventListener('click', async () => {
        if (!window.confirm(`删除定时任务「${item.title}」的记录？`)) return;
        try { await api(`/api/schedules/${item.id}`, { method: 'DELETE' }); await refresh(); showToast('定时任务记录已删除'); }
        catch (error) { showToast(error.message); }
      });
      actions.append(remove);
    }
    if (item.lastTaskId) {
      const view = el('button', '', '查看执行');
      view.addEventListener('click', () => { selectedId = item.lastTaskId; renderTasks(); renderTimeline(); $('#timeline').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      actions.append(view);
    }
    if (actions.childElementCount) card.append(actions);
    nodes.schedules.append(card);
  }
}
function scheduleButton(label, id, action, className = '') {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    try { await api(`/api/schedules/${id}/${action}`, { method: 'POST' }); await refresh(); showToast(action === 'pause' ? '定时任务已暂停' : action === 'resume' ? '定时任务已恢复' : '定时任务已取消'); }
    catch (error) { showToast(error.message); }
  });
  return button;
}
function renderTimeline() {
  const task = taskById(selectedId) || state.tasks[0];
  nodes.timeline.replaceChildren();
  if (!task) { nodes.timeline.append(el('div', 'timeline-empty', '开始任务后，这里会显示执行过程与结果。')); return; }
  selectedId = task.id;
  if (task.summary) nodes.timeline.append(el('div', 'result-box', `${statusLabel(task.status)} · ${task.summary}${task.evidence ? `\n\n结果依据：${task.evidence}` : ''}`));
  if (['running', 'queued'].includes(task.status)) {
    const cancel = el('button', 'secondary', '停止当前任务');
    cancel.addEventListener('click', async () => { try { await api(`/api/tasks/${task.id}/cancel`, { method: 'POST' }); await refresh(); } catch (error) { showToast(error.message); } });
    nodes.timeline.append(cancel);
  }
  if (['blocked', 'failed', 'interrupted'].includes(task.status)) {
    const retry = el('button', 'secondary', '从当前画面继续任务');
    retry.addEventListener('click', async () => {
      try { await api(`/api/tasks/${task.id}/retry`, { method: 'POST' }); await refresh(); showToast('任务已继续'); }
      catch (error) { showToast(error.message); }
    });
    nodes.timeline.append(retry);
  }
  for (const item of [...task.logs].reverse()) {
    const event = el('div', 'timeline-event');
    event.append(el('time', '', formatTime(item.at)), el('div', '', item.message));
    nodes.timeline.append(event);
  }
  if (!task.logs.length) nodes.timeline.append(el('div', 'timeline-empty', '任务已加入队列，等待 Agent 开始。'));
}
function render() {
  if (!state) return;
  renderDevice(); renderDecisions(); renderTasks(); renderSchedules(); renderTimeline();
  nodes.agentStatus.textContent = state.activeTaskId ? '正在执行' : '空闲';
  if (document.activeElement !== $('#reminderMinutes')) $('#reminderMinutes').value = state.settings.reminderMinutes;
}
async function refresh() {
  const next = await api('/api/state');
  const incoming = new Set(next.decisions.filter(item => item.status === 'pending').map(item => item.id));
  if (lastDecisionIds.size && [...incoming].some(id => !lastDecisionIds.has(id))) browserNotify('手机工作台需要你决定', '有新的待处理事项');
  lastDecisionIds = incoming;
  state = next; render();
}
async function resolveDecision(id, action) {
  try { await api(`/api/decisions/${id}`, { method: 'POST', body: JSON.stringify({ action }) }); showToast(action === 'approve' ? '已批准，Agent 将继续执行' : '已取消最终操作'); await refresh(); }
  catch (error) { showToast(error.message); }
}
async function pollFrame() {
  if (livePreviewMode !== 'fallback' || !state?.device.windowVisible || frameBusy) return;
  frameBusy = true;
  const image = new Image();
  image.onload = () => { nodes.frame.src = image.src; nodes.frame.hidden = false; nodes.screenEmpty.hidden = true; nodes.frameStatus.textContent = '实时预览'; frameBusy = false; };
  image.onerror = () => { frameBusy = false; nodes.frameStatus.textContent = '画面连接中'; };
  image.src = `/api/device/frame?token=${encodeURIComponent(token)}&t=${Date.now()}`;
}
function startLivePreview() {
  if (!state?.device.windowVisible || document.hidden) return;
  livePreviewMode = 'stream';
  nodes.frame.onload = () => {
    nodes.frame.hidden = false;
    nodes.screenEmpty.hidden = true;
    nodes.frameStatus.textContent = '流畅预览 · 最多 20 FPS';
  };
  nodes.frame.onerror = () => {
    livePreviewMode = 'fallback';
    nodes.frame.onload = null;
    nodes.frame.onerror = null;
    nodes.frameStatus.textContent = '实时预览';
    pollFrame();
  };
  nodes.frame.src = `/api/device/live?token=${encodeURIComponent(token)}&t=${Date.now()}`;
}
function localDateTimeAfter(minutes) {
  const date = new Date(Date.now() + minutes * 60000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}
async function start() {
  const bootstrap = await fetch('/api/bootstrap').then(response => response.json());
  token = bootstrap.token;
  const model = $('#modelSelect');
  for (const item of bootstrap.models) { const option = el('option', '', item.label); option.value = item.id; model.append(option); }
  model.value = localStorage.getItem('phone-workbench-model') || '';
  const updateModelHint = () => { $('#modelHint').textContent = bootstrap.models.find(item => item.id === model.value)?.hint || '选择执行模型'; };
  updateModelHint();
  model.addEventListener('change', () => { localStorage.setItem('phone-workbench-model', model.value); updateModelHint(); });
  const effort = $('#effortSelect');
  effort.value = localStorage.getItem('phone-workbench-effort') || '';
  effort.addEventListener('change', () => localStorage.setItem('phone-workbench-effort', effort.value));
  $('#scheduleAt').min = localDateTimeAfter(1);
  await refresh();
  const history = $('#historyPanel');
  history.open = localStorage.getItem('phone-workbench-history-open') !== 'false';
  history.addEventListener('toggle', () => localStorage.setItem('phone-workbench-history-open', String(history.open)));
  const events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  events.addEventListener('update', () => refresh().catch(() => {}));
  events.addEventListener('decision', event => { const item = JSON.parse(event.data); browserNotify('手机工作台需要你决定', item.title); refresh().catch(() => {}); });
  events.addEventListener('reminder', () => { browserNotify('手机工作台 · 即将到期', '有决定等待处理'); refresh().catch(() => {}); });
  events.addEventListener('schedule', event => { const item = JSON.parse(event.data); browserNotify('定时任务已开始', item.title); showToast(`定时任务已开始：${item.title}`); refresh().catch(() => {}); });
  setInterval(() => refresh().catch(() => {}), 10000);
  setInterval(pollFrame, 1200);
  startLivePreview();
}

$('#composer').addEventListener('submit', async event => {
  event.preventDefault();
  const prompt = $('#prompt').value.trim();
  if (!prompt) return;
  if (!state?.device.ready) { showToast('请先打开并连接 Mac 上的 iPhone 镜像'); return; }
  const due = $('#dueAt').value;
  $('#sendBtn').disabled = true;
  try {
    const task = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ prompt, model: $('#modelSelect').value, reasoningEffort: $('#effortSelect').value, targetApp: $('#targetApp').value, dueAt: due ? new Date(due).toISOString() : null }) });
    selectedId = task.id; $('#prompt').value = ''; $('#dueAt').value = '';
    await refresh(); showToast('任务已开始');
  } catch (error) { showToast(error.message); }
  finally { $('#sendBtn').disabled = false; }
});
for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => {
  const field = $('#prompt'); field.value = button.dataset.prompt; field.focus();
  const match = /【[^】]+】/.exec(field.value);
  if (match) field.setSelectionRange(match.index, match.index + match[0].length);
  field.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('#toggleSchedule').addEventListener('click', () => {
  const form = $('#scheduleForm'); form.hidden = !form.hidden;
  $('#toggleSchedule').textContent = form.hidden ? '＋ 新建' : '收起';
  if (!form.hidden) { if (!$('#scheduleAt').value) $('#scheduleAt').value = localDateTimeAfter(15); $('#scheduleTitle').focus(); }
});
$('#copyPromptBtn').addEventListener('click', () => { $('#schedulePrompt').value = $('#prompt').value; $('#schedulePrompt').focus(); });
$('#scheduleForm').addEventListener('submit', async event => {
  event.preventDefault();
  const prompt = $('#schedulePrompt').value.trim();
  const runAt = $('#scheduleAt').value;
  if (!prompt || !runAt) return showToast('请填写指令和首次执行时间');
  const button = $('#scheduleForm button[type="submit"]'); button.disabled = true;
  try {
    await api('/api/schedules', { method: 'POST', body: JSON.stringify({ title: $('#scheduleTitle').value, prompt, runAt: new Date(runAt).toISOString(), repeat: $('#scheduleRepeat').value, model: $('#modelSelect').value, reasoningEffort: $('#effortSelect').value }) });
    $('#scheduleForm').reset(); $('#scheduleForm').hidden = true; $('#toggleSchedule').textContent = '＋ 新建';
    await refresh(); showToast('定时任务已保存，到点会自动执行');
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});
$('#connectBtn').addEventListener('click', async () => {
  const button = $('#connectBtn'); button.disabled = true; button.textContent = '正在连接…';
  try { await api('/api/device/connect', { method: 'POST' }); await refresh(); showToast('iPhone 镜像已连接'); }
  catch (error) { showToast(error.message); await refresh(); }
  finally { button.disabled = false; }
});
$('#manualBtn').addEventListener('click', () => { manual = !manual; renderDevice(); });
$('#homeBtn').addEventListener('click', async () => { try { await api('/api/device/home', { method: 'POST' }); showToast('已返回主屏幕'); } catch (error) { showToast(error.message); } });
$('#refreshBtn').addEventListener('click', () => startLivePreview());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    nodes.frame.onload = null;
    nodes.frame.onerror = null;
    nodes.frame.removeAttribute('src');
    livePreviewMode = 'paused';
  } else startLivePreview();
});
$('#showMoreTasks').addEventListener('click', () => { historyVisibleCount += 10; renderTasks(); });
$('#expandBtn').addEventListener('click', () => { const expanded = nodes.phonePanel.classList.toggle('expanded'); $('#expandBtn').textContent = expanded ? '收起' : '放大'; });
$('#phoneFrame').addEventListener('click', async event => {
  if (!manual) return;
  const rect = event.currentTarget.getBoundingClientRect();
  try { await api('/api/device/tap', { method: 'POST', body: JSON.stringify({ x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }) }); }
  catch (error) { showToast(error.message); }
});
$('#saveSettings').addEventListener('click', async () => { try { await api('/api/settings', { method: 'POST', body: JSON.stringify({ reminderMinutes: Number($('#reminderMinutes').value) }) }); showToast('提醒设置已保存'); } catch (error) { showToast(error.message); } });
$('#notifyBtn').addEventListener('click', async () => { if (!('Notification' in window)) return showToast('当前浏览器不支持通知'); const result = await Notification.requestPermission(); showToast(result === 'granted' ? '桌面提醒已开启' : '浏览器未允许提醒'); });
start().catch(error => showToast(`工作台初始化失败：${error.message}`));
