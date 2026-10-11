import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const now = () => new Date().toISOString();
const repeats = new Set(['once', 'daily', 'weekly']);

export function nextOccurrence(base, repeat, after = Date.now()) {
  if (repeat === 'once') return null;
  const days = repeat === 'daily' ? 1 : 7;
  const next = new Date(base);
  const approximateSteps = Math.max(0, Math.floor((after - next.getTime()) / (days * 86400000)));
  next.setDate(next.getDate() + approximateSteps * days);
  while (next.getTime() <= after) next.setDate(next.getDate() + days);
  return next.toISOString();
}

export class Scheduler extends EventEmitter {
  constructor(store, runner) {
    super();
    this.store = store;
    this.runner = runner;
    this.timer = null;
  }

  list() { return this.store.state.schedules; }

  create({ title, prompt, runAt, repeat = 'once', model = '', reasoningEffort = '' }) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 3000) throw new Error('请输入 1 到 3000 字的定时任务');
    if (typeof title !== 'string' || title.trim().length > 80) throw new Error('任务名称不能超过 80 字');
    if (!Number.isFinite(Date.parse(runAt)) || Date.parse(runAt) <= Date.now()) throw new Error('执行时间必须晚于现在');
    if (!repeats.has(repeat)) throw new Error('重复方式无效');
    if (model && !/^[a-zA-Z0-9._-]{1,80}$/.test(model)) throw new Error('模型名称无效');
    if (reasoningEffort && !['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) throw new Error('思考档位无效');
    const schedule = {
      id: randomUUID(), title: title.trim() || prompt.trim().slice(0, 30), prompt: prompt.trim(),
      model, reasoningEffort, runAt: new Date(runAt).toISOString(), nextRunAt: new Date(runAt).toISOString(),
      repeat, status: 'active', createdAt: now(), updatedAt: now(), lastRunAt: null,
      lastTaskId: null, lastError: null,
    };
    this.store.update(state => { state.schedules.unshift(schedule); state.schedules = state.schedules.slice(0, 100); });
    this.emit('update');
    return schedule;
  }

  setStatus(id, action) {
    const schedule = this.list().find(item => item.id === id);
    if (!schedule) throw new Error('定时任务不存在');
    if (action === 'pause' && schedule.status === 'active') schedule.status = 'paused';
    else if (action === 'resume' && schedule.status === 'paused') schedule.status = 'active';
    else if (action === 'cancel' && ['active', 'paused', 'error'].includes(schedule.status)) schedule.status = 'cancelled';
    else throw new Error('无法执行这项操作');
    schedule.updatedAt = now();
    this.store.save();
    this.emit('update');
    if (action === 'resume') this.tick();
    return schedule;
  }

  remove(id) {
    const schedule = this.list().find(item => item.id === id);
    if (!schedule) throw new Error('定时任务不存在');
    if (['active', 'paused'].includes(schedule.status)) throw new Error('请先取消定时任务，再删除记录');
    this.store.update(state => { state.schedules = state.schedules.filter(item => item.id !== id); });
    this.emit('update');
    return { deleted: true, id };
  }

  tick(at = Date.now()) {
    for (const schedule of this.list()) {
      if (schedule.status !== 'active' || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > at) continue;
      const planned = schedule.nextRunAt;
      try {
        const task = this.runner.create({
          prompt: schedule.prompt, model: schedule.model, reasoningEffort: schedule.reasoningEffort,
          scheduleId: schedule.id, idempotencyKey: `schedule:${schedule.id}:${planned}`,
        });
        schedule.lastRunAt = planned;
        schedule.lastTaskId = task.id;
        schedule.lastError = null;
        schedule.nextRunAt = nextOccurrence(planned, schedule.repeat, at);
        if (!schedule.nextRunAt) schedule.status = 'completed';
        schedule.updatedAt = now();
        this.store.save();
        this.emit('fired', { schedule, task });
        this.emit('update');
      } catch (error) {
        schedule.status = 'error';
        schedule.lastError = error.message;
        schedule.updatedAt = now();
        this.store.save();
        this.emit('update');
      }
    }
  }

  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 10000);
    this.timer.unref();
  }

  close() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
