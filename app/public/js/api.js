// 面板后端的 API 封装。所有写请求都带自定义头 (后端用它挡跨站请求)。

const HEADERS = { 'X-Requested-With': 'switch-panel' };

async function request(method, url, body) {
  const isForm = body instanceof FormData;
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: isForm || body === undefined ? HEADERS : { ...HEADERS, 'Content-Type': 'application/json' },
      body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    const err = new Error('无法连接面板服务，请确认面板进程还在运行');
    err.code = 'PANEL_DOWN';
    throw err;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // 非 JSON 响应, 按状态码报错
  }
  if (!res.ok) {
    const err = new Error(data?.error ?? `请求失败 (HTTP ${res.status})`);
    err.code = data?.code;
    err.status = res.status;
    err.details = data?.details;
    // 登录态失效 (不包括"密码错误") → 通知外壳回到登录页
    if (res.status === 401 && data?.code !== 'BAD_CREDENTIALS') window.dispatchEvent(new Event('panel-unauthorized'));
    throw err;
  }
  return data;
}

export const api = {
  status: () => request('GET', '/api/status'),
  login: (username, password) => request('POST', '/api/login', { username, password }),
  logout: () => request('POST', '/api/logout'),
  overview: () => request('GET', '/api/overview'),
  pages: (...keys) => request('GET', `/api/pages?keys=${keys.join(',')}`),
  stats: (port) => request('GET', `/api/stats/${port}`),
  ping: () => request('GET', '/api/ping'),
  op: (op, params) => request('POST', '/api/op', { op, params }),
  macSearch: (params) => request('POST', '/api/mac-search', params),
  firmwareCheck: () => request('POST', '/api/firmware/check'),
  firmwareOnline: () => request('POST', '/api/firmware/online'),
  firmwareJob: () => request('GET', '/api/firmware/job'),
  upload: (url, file) => {
    const form = new FormData();
    form.append('file', file);
    return request('POST', url, form);
  },
  backupUrl: '/api/backup',
};
