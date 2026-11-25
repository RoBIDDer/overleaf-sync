'use strict';
// These adapters target the installed Workshop 0.15.10 API; fail explicitly if it changes.
exports.takeControl = (vfs, root) => {
  const collection = vfs.scmCollectionItem?.collection;
  if (!Array.isArray(collection?.scms)) throw Error('无法访问 Workshop 同步配置；请确认项目连接已就绪。');
  const normalize = value => value.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const key = typeof root.toString === 'function' ? root.toString() : '';
  const matches = collection.scms.filter(item => normalize(item.scm.baseUri.path) === normalize(root.path) && item.scm.constructor.name === 'LocalReplicaSCMProvider');
  if (!matches.length && vfs.getProjectSCMPersist(key)) throw Error('Workshop 本地副本仍在初始化，请稍后再次运行同步。');
  if (matches.some(item => item.enabled && item.scm.status?.status && item.scm.status.status !== 'idle')) throw Error('Workshop 正在同步，请等待完成后再次运行。');
  for (const item of matches) {
    const persist = vfs.getProjectSCMPersist(item.scm.scmKey);
    if (!persist) throw Error('无法读取当前副本的自动同步配置。');
    vfs.setProjectSCMPersist(item.scm.scmKey, { ...persist, enabled: false });
    for (const trigger of item.triggers) trigger.dispose();
    item.triggers = [];
    item.enabled = false;
  }
  collection.updateStatus();
};
