// 通用界面组件。全部返回 DOM 元素, 不拼 HTML 字符串。

import { h, svg, icon, toast, toastError } from './dom.js';
import { rate, errText } from './labels.js';

const arr = (x) => (x === null || x === undefined ? [] : Array.isArray(x) ? x : [x]);

export function card({ title, sub, icon: ic, actions, body }) {
  return h('section', { class: 'card' },
    title
      ? h('div', { class: 'card-head' },
        h('div', null, h('h2', null, ic ? icon(ic, 17) : null, title), sub ? h('div', { class: 'sub' }, sub) : null),
        arr(actions).length ? h('div', { class: 'actions' }, arr(actions)) : null)
      : null,
    body);
}

export function pageHead(title, desc, actions) {
  return h('div', { class: 'page-head' },
    h('div', null, h('h1', null, title), desc ? h('div', { class: 'desc' }, desc) : null),
    arr(actions).length ? h('div', { class: 'actions' }, arr(actions)) : null);
}

/** kind: '' | ok | warn | danger | accent | info | outline */
export function badge(text, kind = '', { dot = false, title } = {}) {
  return h('span', { class: `badge ${kind}`, title }, dot ? h('i', { class: 'dot' }) : null, text);
}

/**
 * 按钮。onClick(btn, event) 里的异步过程自带忙碌态, 抛出的错误自动弹提示。
 * variant: primary | danger | ghost; size: sm; href 有值时渲染成新窗口链接;
 * stop: 用在本身可点击的卡片 / 行里时阻止冒泡, 免得同时触发外层的点击;
 * fk: 焦点键 (data-fk), 会被定时重绘的列表用它保住键盘焦点, 见 dom.js 的 repaintKeepingFocus。
 */
export function button(label, { variant = '', size, icon: ic, onClick, title, disabled = false, href, submit = false, stop = false, fk = null } = {}) {
  const cls = ['btn', variant, size, label ? '' : 'icon', size === 'sm' && !label ? 'sm' : ''].filter(Boolean).join(' ');
  const content = [ic ? icon(ic, size === 'sm' ? 15 : 17) : null, label ? h('span', label) : null];
  if (href) return h('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer', title }, content);
  const btn = h('button', { class: cls, type: submit ? 'submit' : 'button', title, disabled, 'data-fk': fk }, content);
  if (onClick) {
    btn.addEventListener('click', async (ev) => {
      if (stop) ev.stopPropagation(); // 用在本身可点击的卡片 / 行里: 不让这次点击同时触发外层
      const wasDisabled = btn.disabled;
      btn.classList.add('is-busy');
      btn.disabled = true;
      try {
        await onClick(btn, ev);
      } catch (err) {
        toastError(err);
      } finally {
        btn.classList.remove('is-busy');
        btn.disabled = wasDisabled;
      }
    });
  }
  return btn;
}

export const input = ({ cls = '', ...props } = {}) => h('input', { class: `input ${cls}`, ...props });

/** options: [[value, label], ...] */
export function select(options, value, { cls = '', ...props } = {}) {
  return h('select', { class: `select ${cls}`, ...props },
    options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)));
}

export function toggle(checked, onChange, { label, disabled = false } = {}) {
  const box = h('input', { type: 'checkbox', checked, disabled, onchange: (e) => onChange?.(e.target.checked) });
  return h('label', { class: 'toggle' }, box, h('span', { class: 'track', 'aria-hidden': 'true' }), label ? h('span', { class: 'toggle-text' }, label) : null);
}

/** 分段选择 (单选)。元素上挂有 .set(value), 当前值在 .value。 */
export function segmented(options, value, onChange, { disabled = false } = {}) {
  const root = h('div', { class: 'seg', role: 'group' });
  root.value = value;
  root.set = (v) => {
    root.value = v;
    [...root.children].forEach((b, i) => b.setAttribute('aria-pressed', String(options[i][0]) === String(v)));
  };
  options.forEach(([v, label]) => {
    root.append(h('button', { type: 'button', 'aria-pressed': String(v) === String(value), disabled, onclick: () => {
      root.set(v);
      onChange?.(v);
    } }, label));
  });
  return root;
}

/**
 * 端口多选 (按钮组)。选中汇聚组的任一成员会连同其它成员一起选中 (与原厂页面行为一致)。
 * extras 追加非端口的选项 (例如 "LAG 1", value 为字符串)。
 * 元素上挂有 .value (已选, 数字在前) 和 .set(list)。
 */
export function portChips({ count, value = [], onChange, lagOf = () => 0, disabled = () => false, extras = [] }) {
  const options = [
    ...Array.from({ length: count }, (_, i) => {
      const p = i + 1;
      return { value: p, label: `端口 ${p}`, lag: lagOf(p), disabled: disabled(p) };
    }),
    ...extras.map((x) => ({ value: x.value, label: x.label, lag: 0, disabled: false })),
  ];
  const set = new Set(value);
  const buttons = [];
  const sync = () => {
    buttons.forEach((b, i) => b.setAttribute('aria-pressed', set.has(options[i].value)));
    root.value = [...set].sort((a, b) => (typeof a === typeof b ? (a < b ? -1 : 1) : typeof a === 'number' ? -1 : 1));
  };
  const root = h('div', { class: 'chips', role: 'group', 'aria-label': '选择端口' });
  options.forEach((opt) => {
    const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': set.has(opt.value), disabled: opt.disabled, onclick: () => {
      const add = !set.has(opt.value);
      if (opt.lag) {
        for (const o of options) if (o.lag === opt.lag) (add ? set.add(o.value) : set.delete(o.value));
      } else if (add) set.add(opt.value);
      else set.delete(opt.value);
      sync();
      onChange?.(root.value);
    } }, opt.label, opt.lag ? h('span', { class: 'small' }, `L${opt.lag}`) : null);
    buttons.push(b);
    root.append(b);
  });
  root.set = (list) => {
    set.clear();
    for (const v of list ?? []) set.add(typeof v === 'number' ? v : String(v));
    sync();
  };
  sync();
  return root;
}

/** 键值表。pairs: [[标签, 值, { mono }], ...] */
export function kv(pairs) {
  return h('dl', { class: 'kv' }, pairs.filter(([, v]) => v !== null && v !== undefined).map(([k, v, opt]) => [
    h('dt', null, k), h('dd', { class: opt?.mono ? 'mono' : '' }, v === '' ? '—' : v),
  ]).flat());
}

/** columns: [{ title, cls: 'num'|'center', width }]; rows: [[cell...]] 或 { cells, cls } */
export function table(columns, rows) {
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'table' },
      h('thead', null, h('tr', null, columns.map((c) => h('th', { class: c.cls, style: c.width ? { width: c.width } : null }, c.title)))),
      h('tbody', null, rows.map((row) => h('tr', { class: Array.isArray(row) ? null : row?.cls },
        (Array.isArray(row) ? row : row?.cells ?? []).map((cell, i) => h('td', { class: columns[i]?.cls ?? '' }, cell)))))));
}

/** kind: '' | info | warn | danger */
export function banner(kind, ...content) {
  return h('div', { class: `banner ${kind}` }, icon(kind === 'warn' || kind === 'danger' ? 'alert' : 'info'), h('div', { style: { 'min-width': '0' } }, content));
}

/** 原厂页面底部的"注意"事项。 */
export const notes = (lines) => banner('info', h('ul', null, lines.map((line) => h('li', null, line))));

export function field(label, control, hint) {
  return h('div', { class: 'field' },
    h('span', { class: 'field-label' }, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
}

export const actions = (...buttons) => h('div', { class: 'actions' }, buttons);

export function loading(rows = 4) {
  return h('div', { role: 'status', 'aria-label': '加载中' }, Array.from({ length: rows }, (_, i) => h('div', { class: 'skeleton', style: { width: `${88 - i * 14}%` } })));
}

export function errorState(err, onRetry) {
  return h('div', { class: 'state' }, icon('alert', 30), h('div', { class: 'title' }, '加载失败'), h('div', { class: 'detail' }, errText(err)),
    onRetry ? button('重试', { variant: 'primary', icon: 'refresh', onClick: onRetry }) : null);
}

export function emptyState(text) {
  return h('div', { class: 'state' }, icon('info', 28), h('div', { class: 'title' }, '暂无数据'), text ? h('div', { class: 'detail' }, text) : null);
}

// ── 网口 ─────────────────────────────────────────────────────────────

const JACK_PINS = [10, 13.4, 16.9, 20.3, 23.7, 27.1, 30.6, 34];

/** 网口图形。有 onClick 时是按钮, 否则是纯图形。el.update({ enabled, speedAct, loop }) 更新指示灯配色。 */
export function jack({ onClick, label = '端口' } = {}) {
  const el = h(onClick ? 'button' : 'span', {
    class: 'jack down',
    ...(onClick ? { type: 'button', onclick: onClick, 'aria-label': label } : { 'aria-hidden': 'true' }),
  },
    svg('svg', { viewBox: '0 0 44 40' },
      svg('path', { class: 'body', d: 'M5 3h34v24a5 5 0 0 1-5 5h-6l-2.5 5h-9L14 32h-4a5 5 0 0 1-5-5z' }),
      svg('g', { class: 'pins' }, JACK_PINS.map((x) => svg('line', { x1: x, y1: 8, x2: x, y2: 22 })))));
  el.update = ({ enabled = true, speedAct = 0, loop = 'off' }) => {
    const tone = !enabled ? 'off' : loop === 'blocked' ? 'blocked' : !speedAct ? 'down' : speedAct >= 6 ? 'up-g' : 'up-f';
    if (el.dataset.tone !== tone) {
      el.dataset.tone = tone;
      el.className = `jack ${tone}`;
    }
  };
  return el;
}

// ── 迷你趋势线 ───────────────────────────────────────────────────────

/** 折线 + 淡色面积, 配色由 tone 类决定 (tone-up | tone-fast | tone-accent)。el.update(values) / el.tone(name) */
export function sparkline(tone = 'tone-accent') {
  const fill = svg('path', { class: 'fill', 'vector-effect': 'non-scaling-stroke' });
  const line = svg('path', { class: 'line', 'vector-effect': 'non-scaling-stroke' });
  const el = svg('svg', { class: `spark ${tone}`, viewBox: '0 0 100 30', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, fill, line);
  el.tone = (name) => {
    el.classList.remove('tone-up', 'tone-fast', 'tone-accent');
    el.classList.add(name);
  };
  el.update = (values) => {
    const n = values?.length ?? 0;
    if (n < 2) {
      line.setAttribute('d', '');
      fill.setAttribute('d', '');
      return;
    }
    const max = Math.max(1, ...values);
    const pts = values.map((v, i) => `${((i / (n - 1)) * 100).toFixed(2)},${(29 - (v / max) * 27).toFixed(2)}`);
    const d = `M${pts.join('L')}`;
    line.setAttribute('d', d);
    fill.setAttribute('d', `${d}L100,30L0,30Z`);
  };
  el.update([]);
  return el;
}

// ── 面积图 (像素坐标, 文字不变形) ────────────────────────────────────

let chartSeq = 0;

const NICE = [1, 2, 5];

function niceMax(value) {
  if (!(value > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  for (const m of NICE) if (m * exp >= value) return m * exp;
  return 10 * exp;
}

/**
 * 多序列面积图。
 * areaChart([{ key, color, label }]).update({ rx: [Kbps...], tx: [Kbps...] }, spanSeconds)
 */
export function areaChart(series, { height = 200, format = rate } = {}) {
  // 颜色统一用 CSS 变量 var(--xx), 跟随深浅主题自动变化; 通过 CSSOM 设置 (页面 CSP 不允许内联 style 属性)
  const css = (s) => `var(${s.color})`;
  const id = `grad-${++chartSeq}`;
  const plot = svg('g');
  // 高度只给 svg 本身; 外层 .chart 不设高度, 否则下面的图例会溢出卡片。
  // 注意必须用 svg() 创建 (SVG 命名空间); 用 h() 会得到一个不渲染的同名 HTML 元素。
  const svgEl = svg('svg', { role: 'img', 'aria-label': '流量趋势' }, svg('defs', null, series.map((s) => {
    const top = svg('stop', { offset: '0%', 'stop-opacity': 0.3 });
    const bottom = svg('stop', { offset: '100%', 'stop-opacity': 0.02 });
    top.style.stopColor = css(s);
    bottom.style.stopColor = css(s);
    return svg('linearGradient', { id: `${id}-${s.key}`, x1: 0, y1: 0, x2: 0, y2: 1 }, top, bottom);
  })), plot);
  svgEl.style.height = `${height}px`;
  svgEl.style.width = '100%';
  svgEl.style.display = 'block';
  const el = h('div', { class: 'chart' }, svgEl, h('div', { class: 'legend', style: { 'margin-top': '8px' } },
    series.map((s) => {
      const swatch = h('i');
      swatch.style.background = css(s);
      return h('span', null, swatch, s.label);
    })));
  const state = { data: {}, span: 0 };

  const draw = () => {
    const w = Math.max(260, el.clientWidth);
    const pad = { l: 58, r: 14, t: 10, b: 24 };
    const iw = w - pad.l - pad.r;
    const ih = height - pad.t - pad.b;
    const svgEl = el.firstChild;
    svgEl.setAttribute('viewBox', `0 0 ${w} ${height}`);
    svgEl.setAttribute('width', w);
    svgEl.setAttribute('height', height);
    plot.replaceChildren();

    const lengths = series.map((s) => state.data[s.key]?.length ?? 0);
    const n = Math.max(2, ...lengths);
    const max = niceMax(Math.max(0, ...series.flatMap((s) => state.data[s.key] ?? [0])));
    const x = (i) => pad.l + (i / (n - 1)) * iw;
    const y = (v) => pad.t + ih - (v / max) * ih;

    for (const frac of [0, 0.5, 1]) {
      const gy = pad.t + ih - frac * ih;
      plot.append(svg('line', { class: 'grid-line', x1: pad.l, y1: gy, x2: w - pad.r, y2: gy }),
        svg('text', { class: 'label-y', x: pad.l - 10, y: gy + 4, 'text-anchor': 'end' }, format(max * frac)));
    }
    plot.append(svg('text', { class: 'label-x', x: pad.l, y: height - 6 }, state.span ? `-${Math.max(1, Math.round(state.span / 60))} 分钟` : ''),
      svg('text', { class: 'label-x', x: w - pad.r, y: height - 6, 'text-anchor': 'end' }, '现在'));

    for (const s of series) {
      const vals = state.data[s.key] ?? [];
      if (vals.length < 2) continue;
      const d = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
      const area = svg('path', { d: `${d}L${x(vals.length - 1).toFixed(1)},${pad.t + ih}L${pad.l},${pad.t + ih}Z`, fill: `url(#${id}-${s.key})` });
      const line = svg('path', { d, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
      line.style.stroke = css(s);
      plot.append(area, line);
    }
  };

  el.update = (data, span) => {
    state.data = data;
    state.span = span;
    draw();
  };
  new ResizeObserver(() => draw()).observe(el);
  el.update({}, 0);
  return el;
}
