// 面板设置: 面板账号密码、默认轮询间隔、指标接口的访问令牌、版本信息。
// (设备各自的设置在各设备的页面里; 这里只放与具体设备无关的面板级设置。)

import { h } from '../dom.js';
import { actions, banner, button, card, field, input, pageHead } from '../ui.js';

export default {
  async render(ctx) {
    let settings = await ctx.api.settings.get();
    const about = await ctx.api.about().catch(() => ({ version: 'unknown', node: '?', adapters: 0 }));
    const port = location.port || (location.protocol === 'https:' ? '443' : '80');

    // ── 面板账号 ──────────────────────────────────────────────────────
    const oldPassword = input({ type: 'password', required: true, autocomplete: 'current-password', 'aria-label': '当前面板密码' });
    const newPassword = input({ type: 'password', required: true, minlength: 8, maxlength: 128, autocomplete: 'new-password', 'aria-label': '新的面板密码' });
    const confirmPassword = input({ type: 'password', required: true, minlength: 8, maxlength: 128, autocomplete: 'new-password', 'aria-label': '确认新的面板密码' });

    const changePassword = async () => {
      if (newPassword.value !== confirmPassword.value) {
        ctx.toast('两次输入的新密码不一致', 'error');
        return;
      }
      await ctx.api.changePassword({ oldPassword: oldPassword.value, newPassword: newPassword.value });
      for (const el of [oldPassword, newPassword, confirmPassword]) el.value = '';
      ctx.toast('面板密码已修改，其它浏览器上需要重新登录', 'ok');
    };

    // ── 轮询 ──────────────────────────────────────────────────────────
    const pollInterval = input({ type: 'number', min: 5, max: 3600, required: true, value: settings.pollIntervalSec, 'aria-label': '默认轮询间隔 (秒)' });
    const statsInterval = input({ type: 'number', min: 10, max: 3600, required: true, value: settings.statsIntervalSec, 'aria-label': '端口统计轮询间隔 (秒)' });

    const savePolling = async () => {
      settings = await ctx.api.settings.set({ pollIntervalSec: Number(pollInterval.value), statsIntervalSec: Number(statsInterval.value) });
      ctx.toast('轮询设置已保存，对没有单独设置间隔的设备立即生效', 'ok');
    };

    // ── 指标接口 ──────────────────────────────────────────────────────
    // 访问令牌按需生成: 用户点"显示"时后端才生成并返回
    const tokenBox = h('code', { class: 'token' }, '点「显示」查看（首次会自动生成）');
    const showToken = button('显示', {
      size: 'sm',
      onClick: async () => {
        tokenBox.textContent = await ctx.api.settings.metricsToken();
      },
    });
    const rotateToken = button('重新生成', {
      size: 'sm', variant: 'danger',
      onClick: async () => {
        const yes = await ctx.confirm({ title: '重新生成访问令牌？', message: '旧令牌会立即失效，Prometheus 那边需要换成新令牌。', confirmText: '重新生成' });
        if (!yes) return;
        tokenBox.textContent = await ctx.api.settings.rotateMetricsToken();
        ctx.toast('新的访问令牌已生成', 'ok');
      },
    });

    return h('div', { class: 'stack' },
      pageHead('面板设置', '面板自己的账号、轮询和指标接口。设备相关的设置在各设备的页面里。'),
      card({
        title: '面板账号', icon: 'user',
        sub: `当前登录：${ctx.user ?? ''}`,
        body: h('div', { class: 'stack' },
          h('div', { class: 'form-grid' }, field('当前密码', oldPassword), field('新密码', newPassword, '至少 8 个字符'), field('确认新密码', confirmPassword)),
          banner('info', '修改后其它浏览器上的登录会立即失效，本浏览器保持登录。忘记密码时，在面板所在机器上用命令行 `switchctl user passwd` 重置。'),
          actions(button('修改密码', { variant: 'primary', icon: 'check', onClick: changePassword }))),
      }),
      card({
        title: '轮询', icon: 'activity',
        body: h('div', { class: 'stack' },
          h('div', { class: 'form-grid' },
            field('默认轮询间隔 (秒)', pollInterval, '每台设备多久被读取一次概览；5-3600'),
            field('端口统计轮询间隔 (秒)', statsInterval, '端口计数多久被读取一次（供指标导出使用）；10-3600')),
          banner('info', '面板在后台按这些间隔读取各设备并缓存，总览页和指标导出读的是缓存。打开某台设备的概览页时，那一页会单独实时读取。'),
          actions(button('保存', { variant: 'primary', icon: 'check', onClick: savePolling }))),
      }),
      card({
        title: '指标接口（Prometheus）', icon: 'gauge',
        body: h('div', { class: 'stack' },
          h('div', { class: 'field' },
            h('span', { class: 'field-label' }, '访问令牌'),
            h('div', { class: 'row' }, tokenBox, showToken, rotateToken)),
          h('div', { class: 'field' },
            h('span', { class: 'field-label' }, '抓取配置示例'),
            h('pre', { class: 'snippet' }, `scrape_configs:
  - job_name: netpanel
    authorization:
      type: Bearer
      credentials: <访问令牌>
    static_configs:
      - targets: ['<面板地址或域名>:${port}']`)),
          banner('info', `指标地址：/metrics。必须带访问令牌（否则返回 401），因为指标里会暴露设备名称和地址。`)),
      }),
      card({
        title: '关于', icon: 'info',
        body: h('dl', { class: 'kv' },
          h('dt', null, '面板版本'), h('dd', null, about.version),
          h('dt', null, 'Node.js'), h('dd', null, about.node),
          h('dt', null, '已注册的适配器'), h('dd', null, String(about.adapters)),
          h('dt', null, '项目主页'), h('dd', null, h('a', { href: 'https://github.com/LceAn/netpanel', target: '_blank', rel: 'noopener noreferrer' }, 'github.com/LceAn/netpanel'))),
      }));
  },
};
