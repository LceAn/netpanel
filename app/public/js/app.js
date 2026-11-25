// 应用外壳: 启动、登录、路由、侧边栏、主题。

import { h, icon, kids, toastError, confirmDialog } from './dom.js';
import { api } from './api.js';
import { button, loading, input, field, errorState, badge } from './ui.js';
import { NAV, VIEWS, TITLES, hashOf, parseHash } from './views.js';
import { applyOp, waitReboot } from './views/shared.js';

const app = document.getElementById('app');
const THEME_KEY = 'switch-panel.theme';

const state = { status: null, overview: null, user: null };
let seq = 0; // 每次切页面 +1; 旧页面迟到的异步结果据此丢弃
let current = { controller: null };
let navLinks = [];
let topTitle;
let topCloud;
const closeNav = () => app.firstElementChild?.classList.remove('nav-open');

// ── 主题 ─────────────────────────────────────────────────────────────

function applyTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  document.documentElement.dataset.theme = saved ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  themeBtn.replaceChildren(icon(next === 'dark' ? 'sun' : 'moon'));
}

const themeBtn = h('button', { class: 'btn ghost icon', type: 'button', title: '切换深色 / 浅色主题', 'aria-label': '切换主题', onclick: toggleTheme }, icon('sun'));

// ── 外壳 ─────────────────────────────────────────────────────────────

function setOverview(data) {
  state.overview = data;
  if (!topCloud || !data) return;
  topCloud.replaceChildren(...kids([
    !data.cloud.enabled ? null : data.cloud.connected ? badge('云管理已连接', 'ok', { dot: true }) : badge('云管理未连接', 'warn', { dot: true }),
  ]));
}

function buildShell() {
  const view = h('main', { class: 'main', id: 'view' }, loading(6));
  const nav = h('nav', { class: 'nav' }, NAV.map((group) => h('div', { class: 'nav-group' },
    group.label ? h('div', { class: 'nav-label' }, group.label) : null,
    group.items.map(([id, label, ic]) => h('a', { href: hashOf(id), dataset: { view: id }, onclick: closeNav }, icon(ic, 17), label)))));
  navLinks = [...nav.querySelectorAll('a')];
  topTitle = h('span', { class: 'topbar-title' }, '交换机面板');
  topCloud = h('span', { class: 'row' });
  app.replaceChildren(
    h('div', { class: 'app' },
      h('aside', { class: 'sidebar' },
        h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('jack', 20)), h('span', null, '交换机面板')),
        nav,
        h('div', { class: 'sidebar-foot' }, button(`原厂页面 ${state.status.switchUrl.replace(/^https?:\/\//, '')}`, { icon: 'external', href: `${state.status.switchUrl}/`, variant: 'ghost', size: 'sm' }))),
      h('div', { class: 'backdrop', onclick: closeNav }),
      h('header', { class: 'topbar' },
        h('button', { class: 'btn ghost icon menu-toggle', type: 'button', 'aria-label': '菜单', onclick: () => app.firstElementChild.classList.toggle('nav-open') }, icon('menu')),
        topTitle,
        h('span', { class: 'spacer' }),
        topCloud,
        button('', { icon: 'refresh', title: '刷新', onClick: () => route() }),
        themeBtn,
        button('退出', { icon: 'logout', variant: 'ghost', onClick: logout })),
      view));
  setOverview(state.overview);
}

// ── 路由 ─────────────────────────────────────────────────────────────

function makeCtx(controller) {
  const onAbort = (fn) => controller.signal.addEventListener('abort', fn, { once: true });
  /** 周期执行 fn。首次立即执行 (不管页面是否可见, 否则后台打开的标签页会一直停在加载态);
   *  页面在后台时把频率降到 1/10 (趋势图回来时不断档); 切回前台立即执行一次。 */
  const timer = (fn, ms) => {
    let busy = false;
    let lastRun = -Infinity;
    const tick = async () => {
      if (busy) return; // 上一次还没跑完 → 跳过, 避免请求堆积
      // 后台标签页的定时器本身会被浏览器节流 (严重时一分钟才触发一次), 所以按"距上次执行的时间"判断,
      // 而不是数触发次数 —— 数次数会和浏览器的节流叠加, 导致后台几乎不再刷新
      if (document.hidden && Date.now() - lastRun < ms * 10) return;
      lastRun = Date.now();
      busy = true;
      try {
        await fn();
      } catch (err) {
        toastError(err);
      } finally {
        busy = false;
      }
    };
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    const id = setInterval(tick, ms);
    document.addEventListener('visibilitychange', onVisible);
    onAbort(() => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    });
    void tick();
  };
  const ctx = {
    api,
    switchUrl: state.status.switchUrl,
    /** poll: 周期轮询接口; every: 轻量的界面定时刷新 (如运行时间计时)。都立即执行一次, 页面切走后自动停止。 */
    poll: (fn, ms) => timer(fn, ms),
    every: (fn, ms) => timer(fn, ms),
    navigate: (id, params) => {
      location.hash = hashOf(id, params);
    },
    reload: () => route(),
    confirm: (spec) => confirmDialog({ danger: true, ...spec }),
    apply: (op, params, opts) => applyOp(ctx, op, params, opts),
    /** 调用任意接口, 出错只弹提示并返回 null。 */
    call: async (fn) => {
      try {
        return await fn();
      } catch (err) {
        toastError(err);
        return null;
      }
    },
    waitReboot: (opts) => waitReboot(ctx, opts),
    setOverview,
    getOverview: () => state.overview,
    reconnect: async () => {
      state.overview = null;
      await route();
    },
    logout,
  };
  return ctx;
}

async function route() {
  const { id, params } = parseHash(location.hash);
  current.controller?.abort();
  const controller = new AbortController();
  current = { controller };
  const mine = ++seq;
  closeNav();
  for (const a of navLinks) a.classList.toggle('active', a.dataset.view === id);
  const view = document.getElementById('view');
  const title = TITLES[id] ?? id;
  topTitle.textContent = title;
  document.title = `${title} · 交换机面板`;
  // 顶栏的云状态来自概览数据。概览页自己会轮询; 其它页面只在没有缓存时补取一次
  if (id !== 'overview' && !state.overview) api.overview().then((res) => setOverview(res.data), () => {});
  view.replaceChildren(loading(6));
  try {
    const node = await VIEWS[id].render(makeCtx(controller), params);
    if (mine !== seq) return; // 用户已经切到别的页面
    view.replaceChildren(node);
    window.scrollTo(0, 0);
  } catch (err) {
    if (mine !== seq) return;
    view.replaceChildren(errorState(err, () => route()));
  }
}

// ── 登录 / 退出 ──────────────────────────────────────────────────────

async function logout() {
  try {
    await api.logout();
  } catch {
    // 会话可能早已过期
  }
  state.status.authed = false;
  state.overview = null;
  showLogin();
}

function showLogin() {
  app.replaceChildren();
  const user = input({ autocomplete: 'username', required: true, maxlength: 64, 'aria-label': '用户名' });
  const pass = input({ type: 'password', autocomplete: 'current-password', required: true, 'aria-label': '密码' });
  const err = h('div', { class: 'banner danger', hidden: true, role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%' } }, '登录');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      submit.classList.add('is-busy');
      submit.disabled = true;
      err.hidden = true;
      try {
        await enter(user.value.trim(), pass.value);
      } catch (e2) {
        err.hidden = false;
        err.replaceChildren(icon('alert'), e2.message);
        submit.classList.remove('is-busy');
        submit.disabled = false;
      }
    },
  }, field('用户名', user), field('密码', pass), err, submit);
  app.append(h('div', { class: 'login-wrap' },
    h('div', { class: 'login' },
      h('span', { class: 'brand-mark' }, icon('jack', 26)),
      h('h1', null, '交换机面板'),
      h('div', { class: 'sub' }, '用交换机自己的管理账号登录'),
      form,
      h('div', { class: 'target' }, icon('cable', 15), `交换机 ${state.status.switchUrl}`))));
  document.title = '登录 · 交换机面板';
  user.focus();
}

async function enter(username, password) {
  const res = await api.login(username, password);
  state.user = res.user;
  state.status.authed = true;
  buildShell();
  await route();
}

function fatal(err) {
  app.replaceChildren(h('div', { class: 'login-wrap' }, h('div', { class: 'login' },
    h('h1', null, '连不上面板服务'),
    h('div', { class: 'sub' }, err.message),
    button('重试', { variant: 'primary', icon: 'refresh', onClick: boot }))));
}

// ── 启动 ─────────────────────────────────────────────────────────────

async function boot() {
  applyTheme();
  try {
    state.status = await api.status();
  } catch (err) {
    return fatal(err);
  }
  window.addEventListener('hashchange', () => state.status?.authed && route());
  window.addEventListener('panel-unauthorized', () => state.status?.authed && logout());
  if (state.status.authed) {
    buildShell();
    await route();
  } else {
    showLogin();
  }
}

boot();
