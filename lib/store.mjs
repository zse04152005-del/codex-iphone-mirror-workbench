import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'state.json');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = {
        tasks: Array.isArray(saved.tasks) ? saved.tasks : [],
        decisions: Array.isArray(saved.decisions) ? saved.decisions : [],
        schedules: Array.isArray(saved.schedules) ? saved.schedules : [],
        settings: { reminderMinutes: 15, ...saved.settings },
      };
    } catch {
      this.state = { tasks: [], decisions: [], schedules: [], settings: { reminderMinutes: 15 } };
    }
    for (const task of this.state.tasks) {
      if (task.status === 'running') {
        task.status = 'interrupted';
        task.updatedAt = new Date().toISOString();
      }
    }
    this.save();
  }

  save() {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  update(fn) {
    const result = fn(this.state);
    this.save();
    return result;
  }

  task(id) { return this.state.tasks.find(item => item.id === id); }
  decision(id) { return this.state.decisions.find(item => item.id === id); }
}
