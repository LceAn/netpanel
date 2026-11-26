// 面板后端的 API 封装。所有写请求都带自定义请求头 (后端用它挡跨站请求)。
//
// 分两组:
//   api.xxx          面板本身: 登录态、设备管理、设置
//   api.device(id)   针对某一台已绑定的设备 —— 返回一组固定名字的方法, 各功能页只用这一组。

const HEADERS = { 'X-Requested-With': 'netpanel' };

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
    // 面板登录态失效 (不包括"面板密码错误") → 通知外壳回到登录页
    if (res.status === 401 && data?.code !== 'BAD_CREDENTIALS') window.dispatchEvent(new Event('panel-unauthorized'));
    throw err;
  }
  return data;
}

const get = (url) => request('GET', url);
const post = (url, body) => request('POST', url, body ?? {});
const patch = (url, body) => request('PATCH', url, body);

const deviceUrl = (id) => `/api/devices/${encodeURIComponent(id)}`;

export const api = {
  // ── 面板本身 ──────────────────────────────────────────────────────
  status: () => get('/api/status'),
  setup: (credentials) => post('/api/setup', credentials),
  login: (credentials) => post('/api/login', credentials),
  logout: () => post('/api/logout'),
  changePassword: (body) => post('/api/password', body),

  settings: {
    get: async () => (await get('/api/settings')).settings,
    set: (patchBody) => post('/api/settings', patchBody).then((r) => r.settings),
    /** 取指标接口的访问令牌 (没有就生成)。 */
    metricsToken: async () => (await get('/api/settings/metrics-token')).metricsToken,
    rotateMetricsToken: async () => (await post('/api/settings/metrics-token')).metricsToken,
  },

  // ── 设备管理 ──────────────────────────────────────────────────────
  dashboard: () => get('/api/dashboard'),
  probe: (input) => post('/api/probe', input),
  adapters: {
    list: async () => (await get('/api/adapters')).adapters,
  },
  about: () => get('/api/about'),
  devices: {
    list: async () => (await get('/api/devices')).devices,
    get: (id) => get(deviceUrl(id)),
    add: (input) => post('/api/devices', input),
    update: (id, patchBody) => patch(deviceUrl(id), patchBody),
    remove: (id) => request('DELETE', deviceUrl(id)),
    test: (input) => post('/api/devices/test', input),
    testSaved: (id, input = {}) => post(`${deviceUrl(id)}/test`, input),
    refresh: (id) => post(`${deviceUrl(id)}/refresh`),
    history: async (id) => (await get(`${deviceUrl(id)}/history`)).history,
  },

  // ── 针对某一台设备 ───────────────────────────────────────────────
  device(id) {
    const base = deviceUrl(id);
    return {
      id,
      /** live: 向设备实时读取 (概览页的实时速率用); 否则优先用后台轮询的缓存。 */
      overview: ({ live = true } = {}) => get(`${base}/overview${live ? '?live=1' : ''}`),
      pages: (...keys) => get(`${base}/pages?keys=${keys.join(',')}`),
      stats: (port) => get(`${base}/stats/${port}`),
      ping: () => get(`${base}/ping`),
      op: (op, params) => post(`${base}/op`, { op, params }),
      macSearch: (params) => post(`${base}/mac-search`, params),
      history: async () => (await get(`${base}/history`)).history,
      refresh: () => post(`${base}/refresh`),
      firmwareCheck: () => post(`${base}/firmware/check`),
      firmwareOnline: () => post(`${base}/firmware/online`),
      firmwareJob: () => get(`${base}/firmware/job`),
      firmwareSettle: () => post(`${base}/firmware/job/settle`), // 设备重新上线后: "设备重启中" → "升级完成"
      firmwareClear: () => post(`${base}/firmware/job/clear`),
      upload: (url, file) => {
        const form = new FormData();
        form.append('file', file);
        return request('POST', url, form);
      },
      backupUrl: `${base}/backup`,
      restoreUrl: `${base}/restore`,
      firmwareUpgradeUrl: `${base}/firmware/upgrade`,
    };
  },
};
