export const TARGET_APPS = Object.freeze({
  taobao: { label: '淘宝', search: 'taobao', names: ['淘宝'] },
  douyin: { label: '抖音', search: 'douyin', names: ['抖音'] },
  wechat: { label: '微信', search: 'weixin', names: ['微信'] },
  feishu: { label: '飞书', search: 'feishu', names: ['飞书'] },
  meituan: { label: '美团', search: 'meituan', names: ['美团', '外卖'] },
  xiaohongshu: { label: '小红书', search: 'xiaohongshu', names: ['小红书'] },
  notes: { label: '备忘录', search: 'beiwanglu', names: ['备忘录'] },
});

export function detectTargetApp(prompt) {
  const value = String(prompt || '');
  const intent = /(?:打开|进入|切换到|前往|去|在)\s*(淘宝|抖音|微信|飞书|美团|小红书|备忘录)/g;
  const firstIntent = intent.exec(value);
  if (firstIntent) return Object.keys(TARGET_APPS).find(key => TARGET_APPS[key].names.includes(firstIntent[1])) || '';
  const mentions = Object.entries(TARGET_APPS)
    .flatMap(([key, app]) => app.names.map(name => ({ key, at: value.indexOf(name) })))
    .filter(item => item.at >= 0)
    .sort((a, b) => a.at - b.at);
  return mentions[0]?.key || '';
}

export function resolveTargetApp(prompt, requested = '') {
  if (requested && !TARGET_APPS[requested]) throw new Error('目标应用无效');
  return requested || detectTargetApp(prompt);
}
