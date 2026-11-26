// DOM 小工具。不依赖框架, 也不拼接 HTML 字符串:
// 交换机返回的任何文本 (设备描述、VLAN 名、MAC 搜索结果…) 都经由文本节点进入页面, 天然免 XSS。

/** 把任意嵌套的子节点数组摊平成 Node/Text 列表, 丢掉 null/false。
 *  原生 append()/replaceChildren() 会把 null 转成文字 "null", 所以带条件的地方都要经过这里。 */
export function kids(children) {
  return [children].flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true)
    .map((c) => (c instanceof Node ? c : document.createTextNode(String(c))));
}

/**
 * h('div', { class: 'card', onclick: fn, style: { color: 'red' } }, child, [more])
 * 也允许省略属性对象: h('span', '文字') / h('div', node)。
 * value / checked / selected 走 DOM 属性, 在子节点挂好之后设置 (select 需要 option 先就位)。
 */
export function h(tag, props, ...children) {
  // 第二个参数不是 { 属性 } 而是字符串 / 节点 / 数组 → 当作子节点
  if (props !== null && props !== undefined && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style' && typeof value === 'object') {
        for (const [prop, v] of Object.entries(value)) if (v !== null && v !== undefined) el.style.setProperty(prop, String(v));
      } else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'value' || key === 'checked' || key === 'selected' || key === 'disabled') {
        // 延后到 append 之后
      } else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  el.append(...kids(children));
  if (props) {
    if (props.value !== undefined && props.value !== null) el.value = String(props.value);
    if (props.checked) el.checked = true;
    if (props.selected) el.selected = true;
    if (props.disabled) el.disabled = true;
  }
  return el;
}

const NS = 'http://www.w3.org/2000/svg';

export function svg(tag, props, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value !== null && value !== undefined && value !== false) el.setAttribute(key, String(value));
  }
  el.append(...kids(children));
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function mount(el, ...children) {
  clear(el);
  el.append(...kids(children));
  return el;
}

/** 定时重绘时保住键盘焦点: 焦点在 root 里时, 记下它所在的 data-fk, 重绘后把焦点还给同一个 key 的元素。
 *  (元素被整个换掉之后焦点会掉到 body, 键盘用户每 5 秒就得从头 Tab 一遍。) */
export function repaintKeepingFocus(root, paint) {
  const active = document.activeElement;
  const key = active && root.contains(active) ? active.closest('[data-fk]')?.dataset.fk ?? null : null;
  paint();
  if (key) root.querySelector(`[data-fk="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

// ── 图标 (内联 SVG 描边图标) ─────────────────────────────────────────

const ICON_PATHS = {
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  cpu: 'M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4',
  swap: 'M4 7h13M13 3l4 4-4 4M20 17H7M11 21l-4-4 4-4',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  layers: 'M12 3l9 5-9 5-9-5zM3 12.5l9 5 9-5M3 17l9 5 9-5',
  gauge: 'M4 15a8 8 0 1 1 16 0M12 15l4-5',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5 5L3.5 3.5M19.5 19.5L18 18M5 19l-1.5 1.5M19.5 4.5L18 6M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  refresh: 'M20 11A8 8 0 0 0 6.3 6.3L4 8.5M4 13a8 8 0 0 0 13.7 4.7L20 15.5M4 4v4.5H8.5M20 20v-4.5H15.5',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  alert: 'M12 3l10 18H2zM12 10v5M12 18v.5',
  check: 'M5 13l4 4L19 7',
  menu: 'M4 7h16M4 12h16M4 17h16',
  jack: 'M4 4h16v11a3 3 0 0 1-3 3h-2l-1 3h-2l-1-3H7a3 3 0 0 1-3-3zM8 8v4M12 8v4M16 8v4',
  save: 'M5 3h11l4 4v14H5zM8 3v5h7V3M8 21v-7h8v7',
  power: 'M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8v.5',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21c0-4 3.5-6 8-6s8 2 8 6',
  cloud: 'M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4 4 0 0 1-.5 9z',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  cable: 'M3 4h6v6H3zM15 14h6v6h-6zM9 7h2a3 3 0 0 1 3 3v4a3 3 0 0 0 3 3',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  x: 'M18 6L6 18M6 6l12 12',
};

export function icon(name, size = 18) {
  return svg(
    'svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    svg('path', { d: ICON_PATHS[name] ?? ICON_PATHS.info }),
  );
}

// ── 浮层提示 ─────────────────────────────────────────────────────────

export function toast(message, kind = 'info', ms = 3800) {
  let box = document.getElementById('toasts');
  if (!box) box = document.body.appendChild(h('div', { id: 'toasts' }));
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'ok' ? 'check' : kind === 'error' ? 'alert' : 'info'), h('div', message));
  box.append(el);
  while (box.children.length > 4) box.firstChild.remove();
  const kill = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  };
  const timer = setTimeout(kill, ms);
  el.addEventListener('click', () => {
    clearTimeout(timer);
    kill();
  });
}

/** 把接口错误变成一条提示。 */
export function toastError(err) {
  const text = err?.details?.length ? err.details.join('；') : err?.message ?? '未知错误';
  toast(text, 'error', err?.details?.length ? 7000 : 5200);
}

// ── 确认弹窗 ─────────────────────────────────────────────────────────

/**
 * 确认弹窗。danger 用红色确认键; typed 要求手工输入该文本才能确认 (用于恢复出厂这类不可撤销的操作)。
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title = '确认操作', message = '', details = [], confirmText = '确定', cancelText = '取消', danger = false, typed = null }) {
  return new Promise((resolve) => {
    const input = typed
      ? h('input', { class: 'input mono', autocomplete: 'off', spellcheck: 'false', placeholder: `请输入 ${typed}`, 'aria-label': '确认文本' })
      : null;
    const ok = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', disabled: !!typed }, confirmText);
    const cancel = h('button', { class: 'btn', type: 'button' }, cancelText);
    const dialog = h('dialog', { class: 'modal' },
      h('div', { class: 'modal-body' },
        h('div', { class: `modal-title${danger ? ' danger' : ''}` }, icon(danger ? 'alert' : 'info'), title),
        message ? h('div', { class: 'modal-text' }, message) : null,
        details.length ? h('ul', { class: 'modal-text' }, details.map((d) => h('li', null, d))) : null,
        input,
        h('div', { class: 'modal-actions' }, cancel, ok)));
    document.body.append(dialog);
    const close = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    ok.addEventListener('click', () => close(true));
    cancel.addEventListener('click', () => close(false));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(false);
    });
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) close(false); // 点遮罩 = 取消
    });
    if (input) {
      input.addEventListener('input', () => {
        ok.disabled = input.value !== typed;
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !ok.disabled) close(true);
      });
    }
    dialog.showModal();
    (input ?? (danger ? cancel : ok)).focus();
  });
}
