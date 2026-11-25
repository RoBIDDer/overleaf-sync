'use strict';
// Use WHATWG FormData with fetch. Legacy form-data streams are not a native fetch body.
exports.sendFile = async ({ apiUrl, server, identity, projectId, folderId, filename, bytes, fetchImpl = fetch }) => {
  const url = new URL(`project/${encodeURIComponent(projectId)}/upload`, apiUrl);
  if (url.host !== server || !['https:', 'http:'].includes(url.protocol)) throw Error('上传目标与当前 Overleaf 项目服务器不一致。');
  url.searchParams.set('folder_id', folderId);
  const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf', svg: 'image/svg+xml' })[filename.split('.').pop().toLowerCase()] || 'application/octet-stream';
  const form = new FormData();
  form.append('targetFolderId', folderId);
  form.append('name', filename);
  form.append('type', mime);
  form.append('qqfile', new Blob([Buffer.from(bytes)], { type: mime }), filename);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000),
      headers: { Cookie: identity.cookies, 'X-Csrf-Token': identity.csrfToken }, body: form
    });
  } catch (error) { throw Error('上传请求失败：' + (error.cause?.code || error.name || 'network_error')); }
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw Error(`上传响应不是 JSON（HTTP ${response.status}，类型 ${response.headers.get('content-type') || '未知'}）；请检查登录或服务器响应。`); }
  if (!response.ok || payload.success !== true || !payload.entity_id || !['file', 'doc'].includes(payload.entity_type)) {
    const code = typeof payload.error === 'string' && /^[a-z0-9_ -]{1,100}$/i.test(payload.error) ? payload.error : 'missing_success_or_entity';
    throw Error(`服务器拒绝上传：HTTP ${response.status}，${code}`);
  }
  return { type: 'success', entity: { _type: payload.entity_type, _id: payload.entity_id, name: filename, linkedFileData: null, created: new Date().toISOString() } };
};
