// 各页面共用的小流程: 数据页骨架、写操作、等待设备重启。

import { h, clear, confirmDialog, toast, toastError, icon } from '../dom.js';
import { pageHead, loading, errorState } from '../ui.js';

const arr = (x) => (x === null || x === undefined ? [] : Array.isArray(x) ? x : [x]);

const FAILING = /失败|错误|不合法|无效|超时|不允许|已满|冲突/;

/** 执行白名单里的一个写操作。
 *  spec 存在时先弹确认框 (危险操作后端也要求 params.confirm === true)。
 *  done 在成功后调用, 用来把 res.fresh 合并回页面数据。失败只弹提示, 返回 null。 */
export async function applyOp(ctx, op, params, { confirm: spec, success = '已应用', done, quiet = false } = {}) {
  let sent = { ...params };
  if (spec) {
    if (!(await confirmDialog({ danger: true, ...spec }))) return null;
    sent = { ...sent, confirm: true };
  }
  try {
    const res = await ctx.api.op(op, sent);
    if (!quiet) toast(res.tip || success, res.tip && FAILING.test(res.tip) ? 'error' : 'ok');
    done?.(res);
    return res;
  } catch (err) {
    toastError(err);
    return null;
  }
}

/**
 * 数据页骨架: 依次读取 keys 对应的页面 → build(data, tools) 生成内容。
 * tools.apply 提交写操作后自动把回读结果合并进 data 并重绘; tools.reload 重新从交换机读取。
 */
export async function dataPage(ctx, { title, desc, keys, head, build, afterLoad }) {
  const body = h('div', { class: 'stack' }, loading(5));
  const data = {};
  const tools = {
    data,
    rerender: () => {
      clear(body);
      arr(build(data, tools)).forEach((node) => body.append(node));
    },
    reload: async () => {
      clear(body);
      body.append(loading(5));
      try {
        await load();
      } catch (err) {
        clear(body);
        body.append(errorState(err, tools.reload));
      }
    },
    apply: (op, params, opts = {}) => applyOp(ctx, op, params, {
      ...opts,
      done: (res) => {
        Object.assign(data, res.fresh ?? {});
        tools.rerender();
        opts.done?.(res);
      },
    }),
  };
  const load = async () => {
    Object.assign(data, await ctx.api.pages(...keys));
    if (data.overview) ctx.setOverview(data.overview); // 页面自己读了概览 → 顺便更新顶栏的云状态
    await afterLoad?.(data, tools);
    tools.rerender();
  };
  const root = h('div', null, pageHead(title, desc, head ? head(tools) : null), body);
  await tools.reload();
  return root;
}

/**
 * 等交换机重启回来: 先等它掉线, 再等它恢复。期间显示不可关闭的进度弹窗。
 * @returns {Promise<{ rebooted: boolean }>} rebooted=false 表示它始终没掉线 (操作可能没有生效)
 */
export async function waitReboot(ctx, { title = '正在重启', hint = '交换机重启通常需要 30 秒到 1 分钟，期间请勿断电。', timeoutMs = 240000 } = {}) {
  const status = h('div', { class: 'modal-text', role: 'status' }, '正在提交，等待设备响应…');
  const dialog = h('dialog', { class: 'modal' },
    h('div', { class: 'modal-body' },
      h('div', { class: 'modal-title' }, icon('power'), title),
      hint ? h('div', { class: 'modal-text muted' }, hint) : null,
      status,
      h('div', { class: 'skeleton', style: { height: '6px' } })));
  document.body.append(dialog);
  dialog.showModal();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const online = async () => {
    try {
      return (await ctx.api.ping()).online;
    } catch (err) {
      if (err.status === 401) {
        dialog.remove(); // 面板登录态失效: 先关掉模态框 (否则会挡住登录页), 再交给外壳处理
        throw err;
      }
      return false; // 面板联系不上交换机也算不在线
    }
  };

  let wentOffline = false;
  for (let i = 0; i < 12; i++) {
    await sleep(3000);
    if (!(await online())) {
      wentOffline = true;
      break;
    }
  }
  if (wentOffline) {
    const since = Date.now();
    const until = since + timeoutMs;
    while (Date.now() < until) {
      await sleep(3000);
      if (await online()) {
        dialog.remove();
        await ctx.reconnect();
        toast('设备已重新上线', 'ok');
        return { rebooted: true };
      }
      status.textContent = `设备已断开，正在等待它重新上线… (已等待 ${Math.round((Date.now() - since) / 1000)} 秒)`;
    }
    status.textContent = '等待超时：设备还没有回来。请检查设备电源，稍后刷新页面。';
    dialog.append(h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dialog.remove() }, '关闭')));
    return { rebooted: false };
  }
  dialog.remove();
  toast('设备没有重启，操作可能没有生效，请刷新后确认', 'error', 7000);
  await ctx.reconnect();
  return { rebooted: false };
}
