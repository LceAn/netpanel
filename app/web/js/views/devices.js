// 设备管理: 绑定了哪些交换机 (列表), 以及添加 / 修改设备的表单。
//
// 添加流程: 填名称、地址、设备的管理账号密码 → 「测试连接」(面板自动识别适配器、型号、固件、端口数)
//          → 确认无误后「保存」。密码在保存时用面板的保险箱加密, 之后只在面板进程的内存里解密使用。

import { h, repaintKeepingFocus } from '../dom.js';
import { banner, badge, button, card, errorState, field, input, loading, notes, pageHead, select, toggle } from '../ui.js';
import { ago } from '../labels.js';

const POLL_MS = 5000;

const HEALTH_BADGE = {
  online: ['在线', 'ok'],
  offline: ['离线', 'danger'],
  auth: ['凭据失效', 'warn'],
  error: ['出错', 'danger'],
  disabled: ['已停用', ''],
  unknown: ['连接中', ''],
};

const hostOf = (url) => String(url ?? '').replace(/^https?:\/\//, '');

// ── 列表 ──────────────────────────────────────────────────────────────

async function list(ctx) {
  const root = h('div', { class: 'stack' }, loading(4));
  let devices = [];
  let acting = 0; // 正在执行的操作数: 期间不重画表格, 免得把"忙碌中"的按钮换成一个新的

  /** 重新读列表并重画 (不等下一次轮询)。 */
  const reload = async () => {
    devices = await ctx.api.devices.list();
    paint();
    await ctx.refreshDevices(); // 侧边栏和顶栏的切换器跟着变
  };

  const act = async (d, fn) => {
    acting += 1;
    try {
      await fn();
      await reload();
    } catch (err) {
      ctx.toastError(err);
    } finally {
      acting -= 1;
    }
  };

  const actions = (d) => {
    const kind = d.enabled === false ? 'disabled' : d.health;
    return h('div', { class: 'row' },
      button('进入', { size: 'sm', onClick: () => ctx.navigate('device', { deviceId: d.id }), fk: `open:${d.id}` }),
      button('测试', {
        size: 'sm', fk: `test:${d.id}`, onClick: () => act(d, async () => {
          const res = await ctx.api.devices.testSaved(d.id);
          ctx.toast(`连接正常：${res.identified.model}，${res.identified.ports} 个端口（${res.adapter.name}）`, 'ok');
        }),
      }),
      button(d.enabled === false ? '启用' : '停用', { size: 'sm', variant: 'ghost', fk: `toggle:${d.id}`, onClick: () => act(d, () => ctx.api.devices.update(d.id, { enabled: d.enabled === false })) }),
      button('编辑', { size: 'sm', variant: 'ghost', fk: `edit:${d.id}`, onClick: () => ctx.navigate('deviceForm', { deviceId: d.id }) }),
      button('删除', {
        size: 'sm', variant: 'danger', fk: `remove:${d.id}`, onClick: () => act(d, async () => {
          const yes = await ctx.confirm({ title: `删除「${d.name}」？`, message: '只是把这台设备从面板里移除，不会改动交换机上的任何配置。', confirmText: '删除' });
          if (yes) {
            await ctx.api.devices.remove(d.id);
            ctx.toast('设备已删除', 'ok');
          }
        }),
      }));
  };

  const paint = () => {
    const rows = devices.map((d) => {
      const kind = d.enabled === false ? 'disabled' : d.health;
      const [text, tone] = HEALTH_BADGE[kind] ?? HEALTH_BADGE.unknown;
      const note = kind === 'offline' ? `最后在线 ${ago(d.lastOk)}` : kind === 'auth' ? '设备密码可能改过了，请编辑并更新密码' : kind === 'error' ? d.lastError ?? '' : kind === 'online' ? `运行中` : '';
      return [
        badge(text, tone, { dot: kind !== 'disabled' }),
        h('div', null, h('div', { class: 'strong' }, d.name), h('div', { class: 'muted small' }, d.model ?? '型号未知', d.adapterMaturity === 'experimental' ? ' · 实验性适配器' : '')),
        h('span', { class: 'mono' }, hostOf(d.url)),
        d.username,
        `${d.portsUp}/${d.portCount ?? '?'}`,
        d.pollIntervalSec ? `${d.pollIntervalSec} 秒` : '默认',
        h('div', { class: 'row' }, ...(d.tags ?? []).map((t) => h('span', { class: 'chip-tag' }, t))),
        h('div', { class: 'small muted' }, note),
        actions(d),
      ];
    });
    // 每 5 秒整块重画一次, 中途保住键盘焦点 (否则用键盘操作到一半, 焦点就掉了)
    repaintKeepingFocus(root, () => root.replaceChildren(
      pageHead('设备管理', '绑定到面板的交换机。设备密码加密保存在面板的数据目录里，不会发到浏览器。', button('添加设备', { variant: 'primary', icon: 'cable', fk: 'add', onClick: () => ctx.navigate('deviceForm') })),
      devices.length
        ? h('div', { class: 'card', style: { padding: '0', overflow: 'auto' } }, h('table', { class: 'table' },
          h('thead', null, h('tr', null, ...['状态', '设备', '地址', '账号', '在线端口', '轮询', '标签', '备注', '操作'].map((t) => h('th', null, t)))),
          h('tbody', null, ...rows.map((cells) => h('tr', null, ...cells.map((c) => h('td', null, c)))))))
        : card({ title: '还没有绑定设备', icon: 'cable', body: h('div', { class: 'stack' },
          h('p', { class: 'muted' }, '添加一台交换机只需要它的管理地址和管理账号。'),
          button('添加设备', { variant: 'primary', icon: 'cable', fk: 'add', onClick: () => ctx.navigate('deviceForm') })) }),
      notes([
        '面板通过设备的 Web 管理接口读写配置，不刷固件、不改设备；随时可以回到设备的原厂页面。',
        '如果交换机的管理地址变了，在这里编辑设备、改成新地址即可。',
        '修改了交换机自己的管理密码后，也要在这里更新，否则面板会显示「凭据失效」。',
      ])));
  };

  ctx.poll(async () => {
    try {
      if (acting) return; // 有操作在进行: 它结束时自己会刷新
      devices = await ctx.api.devices.list();
      paint();
    } catch (err) {
      if (!devices.length) root.replaceChildren(errorState(err, ctx.reload));
    }
  }, POLL_MS);
  return root;
}

// ── 添加 / 修改 ────────────────────────────────────────────────────────

const splitTags = (text) => [...new Set(String(text ?? '').split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean))];

async function form(ctx, params) {
  const editingId = params?.deviceId ?? null;
  const existing = editingId ? await ctx.api.devices.get(editingId).catch((err) => (err.status === 404 ? null : Promise.reject(err))) : null;
  const adapters = await ctx.api.adapters.list().catch(() => []);
  if (editingId && !existing) {
    return h('div', null, pageHead('修改设备'), card({ body: errorState(new Error('设备不存在，可能已经被删除了。'), () => ctx.navigate('devices')) }));
  }

  const name = input({ value: existing?.name ?? '', maxlength: 64, required: true, placeholder: '例如：客厅交换机', 'aria-label': '设备名称' });
  const url = input({ value: existing?.url ?? '', required: true, placeholder: 'http://192.168.1.1', 'aria-label': '设备地址', spellcheck: 'false', autocomplete: 'off' });
  const username = input({ value: existing?.username ?? '', required: true, maxlength: 64, autocomplete: 'off', 'aria-label': '设备账号' });
  const password = input({ type: 'password', required: !existing, maxlength: 128, autocomplete: 'new-password', 'aria-label': '设备密码', placeholder: existing ? '留空表示不修改' : '' });
  const adapter = select([['auto', '自动识别'], ...adapters.map((a) => [a.id, a.maturity === 'experimental' ? `${a.name}（实验性）` : a.name])], existing?.adapter ?? 'auto', { 'aria-label': '适配器' });
  const interval = input({ type: 'number', min: 5, max: 3600, value: existing?.pollIntervalSec ?? '', placeholder: '默认', 'aria-label': '轮询间隔 (秒)' });
  const tags = input({ value: (existing?.tags ?? []).join(', '), placeholder: '用逗号分隔', 'aria-label': '标签' });
  const notesInput = h('textarea', { class: 'input area', maxlength: 500, rows: 2, 'aria-label': '备注' }, existing?.notes ?? '');
  let enabled = existing?.enabled ?? true;
  const result = h('div');

  const values = () => ({
    name: name.value.trim(),
    url: url.value.trim(),
    username: username.value.trim(),
    password: password.value,
    adapter: adapter.value,
    pollIntervalSec: interval.value === '' ? null : Number(interval.value),
    tags: splitTags(tags.value),
    notes: notesInput.value,
    enabled,
  });

  const showResult = (res) => {
    const i = res.identified;
    result.replaceChildren(card({
      title: '连接成功', icon: 'check',
      actions: res.adapter.maturity === 'experimental' ? badge('实验性适配器', 'warn', { title: '这个适配器还没有在真机上验证过' }) : null,
      body: h('dl', { class: 'kv' },
        h('dt', null, '适配器'), h('dd', null, res.adapter.name),
        h('dt', null, '型号'), h('dd', null, i.model || '—'),
        h('dt', null, '固件版本'), h('dd', null, i.firmware || '—'),
        h('dt', null, '硬件版本'), h('dd', null, i.hardware || '—'),
        h('dt', null, 'MAC 地址'), h('dd', { class: 'mono' }, i.mac || '—'),
        h('dt', null, '端口数'), h('dd', null, String(i.ports ?? '—'))),
    }));
  };

  const testBtn = button('测试连接', {
    icon: 'cable',
    onClick: async () => {
      result.replaceChildren(h('p', { class: 'muted' }, '正在连接设备并识别…'));
      try {
        const v = values();
        const res = editingId && !v.password && v.url === existing.url && v.username === existing.username && v.adapter === existing.adapter
          ? await ctx.api.devices.testSaved(editingId) // 没改连接信息: 用面板已保存的密码去试
          : await ctx.api.devices.test(v);
        showResult(res);
      } catch (err) {
        result.replaceChildren(banner('danger', '连接失败：', err.message));
      }
    },
  });

  const save = async () => {
    const v = values();
    const saved = editingId
      ? await ctx.api.devices.update(editingId, v)
      : await ctx.api.devices.add(v);
    await ctx.refreshDevices(); // 先让侧边栏 / 切换器认识这台设备, 再跳过去
    ctx.toast(editingId ? '设备已更新' : `已添加「${saved.name}」`, 'ok');
    ctx.navigate('device', { deviceId: saved.id });
  };

  return h('div', { class: 'stack' },
    pageHead(editingId ? '修改设备' : '添加设备', editingId ? '修改地址、账号密码或轮询设置。' : '填入交换机的管理地址和管理账号，面板会自动识别它。', button('返回', { icon: 'undo', variant: 'ghost', onClick: () => ctx.navigate('devices') })),
    card({
      title: editingId ? existing.name : '设备信息', icon: 'cable',
      body: h('div', { class: 'stack' },
        h('div', { class: 'form-grid' },
          field('名称', name, '给自己看的名字，需要唯一'),
          field('管理地址', url, '只填到主机和端口，例如 http://192.168.1.1 或 https://switch.lan:8443'),
          field('设备账号', username, '交换机自己的管理账号'),
          field('设备密码', password, existing ? '留空表示不修改已保存的密码' : '保存时加密存入面板的数据目录，不会发到浏览器')),
        h('div', { class: 'form-grid' },
          field('适配器', adapter, '不确定就选“自动识别”：面板会根据地址上的管理界面判断'),
          field('轮询间隔 (秒)', interval, '留空用面板默认值；范围 5-3600'),
          field('标签', tags, '用于在总览页筛选，例如 家里, 机房'),
          field('备注', notesInput)),
        editingId ? toggle(enabled, (v) => (enabled = v), { label: '启用这台设备（后台轮询并允许访问）' }) : null,
        existing ? h('p', { class: 'muted small' }, `首次识别：${existing.model ?? '—'} · ${existing.firmware ?? '—'} · ${existing.portCount ?? '—'} 个端口 · 添加于 ${new Date(existing.createdAt).toLocaleString('zh-CN')}`) : null,
        banner('info', '「测试连接」会真的登录这台设备读出型号等信息，然后立刻退出；不会改动设备上的任何配置。'),
        h('div', { class: 'row' }, testBtn, button(editingId ? '保存修改' : '添加设备', { variant: 'primary', icon: 'check', onClick: save })),
        result),
    }));
}

export default list;
export { form as deviceForm };
