// 系统类页面: 系统信息 / IP 设置 / 账户设置 / 云管理。

import { h, toast, toastError } from '../dom.js';
import { card, badge, button, banner, notes, kv, input, segmented, actions, field } from '../ui.js';
import { dataPage } from './shared.js';

export const info = {
  id: 'system.info',
  render: (ctx) => dataPage(ctx, {
    title: '系统信息',
    desc: '设备的基本信息。设备描述可在此修改。',
    keys: ['system'],
    build: (d, t) => {
      const s = d.system;
      const name = input({ value: s.description, maxlength: 32, disabled: s.cloudManaged, 'aria-label': '设备描述', autocomplete: 'off' });
      return [
        card({
          title: '设备信息', icon: 'cpu',
          body: kv([
            ['设备型号', s.model], ['硬件版本', s.hardware], ['软件版本', s.firmware],
            ['MAC 地址', s.mac, { mono: true }], ['IP 地址', s.ip, { mono: true }], ['子网掩码', s.netmask, { mono: true }], ['默认网关', s.gateway, { mono: true }],
          ]),
        }),
        card({
          title: '设备描述', icon: 'settings',
          body: h('div', { class: 'stack' },
            s.cloudManaged ? banner('warn', '云管理已启用：设备描述只能在云端修改。需要在设备端修改，请先到「云管理」页面关闭云管理。') : null,
            h('div', { class: 'form-grid' }, field('设备描述', name, '最长 32 个字符，可用空格、中文、数字、英文字母、连字符和下划线，每个中文占 3 个字符。')),
            actions(button('应用', {
              variant: 'primary', icon: 'check', disabled: s.cloudManaged,
              onClick: () => t.apply('system.description', { description: name.value }, { success: '设备描述已修改' }),
            }))),
        }),
      ];
    },
  }),
};

export const ip = {
  id: 'system.ip',
  render: (ctx) => dataPage(ctx, {
    title: 'IP 设置',
    desc: '交换机的管理地址与 DNS，以及固定 IP（用于管理地址丢失时应急访问）。',
    keys: ['ip', 'fixIp'],
    build: (d, t) => {
      const s = d.ip;
      let dhcp = s.dhcp;
      let dnsAuto = s.dnsAuto;
      const vlan = input({ value: s.manageVlan, inputmode: 'numeric', 'aria-label': '管理 VLAN' });
      const ip = input({ value: s.ip, cls: 'mono w-md', 'aria-label': 'IP 地址', autocomplete: 'off', spellcheck: 'false' });
      const mask = input({ value: s.netmask, cls: 'mono w-md', 'aria-label': '子网掩码', spellcheck: 'false' });
      const gateway = input({ value: s.gateway, cls: 'mono w-md', 'aria-label': '默认网关', spellcheck: 'false' });
      const dns = input({ value: s.dns, cls: 'mono w-md', 'aria-label': 'DNS 服务器', spellcheck: 'false' });
      const dnsMode = segmented([[true, '自动'], [false, '手动']], dnsAuto, (v) => {
        dnsAuto = v;
        sync();
      });
      const sync = () => {
        for (const el of [ip, mask, gateway]) el.disabled = dhcp;
        if (!dhcp) {
          dnsAuto = false;
          dnsMode.set(false);
        }
        dnsMode.querySelectorAll('button').forEach((b) => (b.disabled = !dhcp));
        dns.disabled = dhcp && dnsAuto;
        vlan.disabled = !s.vlanEditable;
      };
      const mode = segmented([[true, 'DHCP 自动获取'], [false, '静态 IP']], dhcp, (v) => {
        dhcp = v;
        sync();
      });
      sync();
      return [
        card({
          title: '管理 IP 与 DNS', icon: 'settings',
          body: h('div', { class: 'stack' },
            h('div', { class: 'form-grid' },
              field('获取方式', mode),
              field('管理 VLAN', vlan, s.vlanEditable ? '1-4094' : '当前 VLAN 模式下不可修改'),
              field('IP 地址', ip), field('子网掩码', mask), field('默认网关', gateway, '可留空'),
              field('DNS 服务器', h('div', { class: 'row' }, dnsMode, dns), '未手动指定时使用默认 DNS 114.114.114.114')),
            actions(button('应用', {
              variant: 'primary', icon: 'check',
              onClick: () => t.apply('ip.setting',
                { manageVlan: Number(vlan.value), dhcp, dnsAuto, ip: ip.value.trim(), netmask: mask.value.trim(), gateway: gateway.value.trim(), dns: dns.value.trim() },
                {
                  confirm: {
                    title: '修改 IP 设置？',
                    message: '提交后交换机会做一次 IP 冲突检测，期间请不要做其它操作。',
                    details: [
                      '如果管理地址变了，面板会连不上这台设备：请到「设备管理」里把它的地址改成新地址。',
                      '交换机当前开启了云管理，云管理要求配置默认网关。',
                    ],
                  },
                  success: 'IP 设置已提交',
                }),
            }))),
        }),
        card({
          title: '固定 IP', icon: 'shield',
          body: h('div', { class: 'stack' },
            kv([['固定 IP 地址', d.fixIp.ip, { mono: true }], ['状态', d.fixIp.enabled ? badge('已启用', 'ok') : badge('未启用')]]),
            banner('info', '启用后，无论管理 IP 被设成什么，都可以通过固定 IP 访问交换机，用于管理地址丢失时应急登录。'),
            actions(button(d.fixIp.enabled ? '禁用固定 IP' : '启用固定 IP', {
              icon: 'shield',
              onClick: () => t.apply('ip.fix', { enabled: !d.fixIp.enabled }, { confirm: { title: `${d.fixIp.enabled ? '禁用' : '启用'}固定 IP？`, confirmText: '确认' }, success: '固定 IP 设置已应用' }),
            }))),
        }),
        notes(['进行配置后会进行 IP 冲突检测，在操作结束前请勿进行其他操作，否则可能会造成异常。', '若使用云管理功能，需要配置默认网关。', '未分配 DNS 则使用默认 DNS 114.114.114.114。']),
      ];
    },
  }),
};

export const user = {
  id: 'system.user',
  render: (ctx) => dataPage(ctx, {
    title: '设备账户',
    desc: '修改登录这台交换机的用户名和密码。',
    keys: ['user'],
    build: (d, t) => {
      const { limits } = d.user;
      const username = input({ value: d.user.username, maxlength: limits.userMax, autocomplete: 'username', 'aria-label': '新用户名' });
      const oldPassword = input({ type: 'password', autocomplete: 'current-password', 'aria-label': '旧密码' });
      const newPassword = input({ type: 'password', autocomplete: 'new-password', maxlength: limits.pwdMax, 'aria-label': '新密码' });
      const confirmPassword = input({ type: 'password', autocomplete: 'new-password', maxlength: limits.pwdMax, 'aria-label': '确认新密码' });
      return card({
        title: `当前账户：${d.user.username}`, icon: 'user',
        body: h('div', { class: 'stack' },
          h('div', { class: 'form-grid' },
            field('用户名', username, `${limits.userMin}-${limits.userMax} 个英文字母、数字或英文特殊字符`),
            field('旧密码', oldPassword),
            field('新密码', newPassword, `${limits.pwdMin}-${limits.pwdMax} 位，英文字母、数字或英文特殊字符，不能包含“?”`),
            field('确认新密码', confirmPassword)),
          banner('info', '这是交换机自己的管理账号。修改成功后面板会自动更新它为这台设备保存的账号密码。'),
          actions(button('应用', {
            variant: 'primary', icon: 'check',
            onClick: () => t.apply('user.account',
              { username: username.value.trim(), oldPassword: oldPassword.value, newPassword: newPassword.value, confirmPassword: confirmPassword.value },
              {
                confirm: { title: '修改设备的管理账户？', confirmText: '确认修改' },
                success: '设备账户已修改',
                done: async () => {
                  // 面板就是靠这组账号密码连接这台设备的, 必须跟着改, 否则它会立刻变成"凭据失效"
                  try {
                    await ctx.updateDevice({ username: username.value.trim(), password: newPassword.value });
                    toast('面板为这台设备保存的账号密码已同步更新', 'ok');
                  } catch (err) {
                    toastError(err);
                    toast('请到「设备管理」里手动更新这台设备的账号密码', 'error', 8000);
                  }
                },
              }),
          }))),
      });
    },
  }),
};

export const cloud = {
  id: 'system.cloud',
  render: (ctx) => dataPage(ctx, {
    title: '云管理',
    desc: '让交换机接入 TP-LINK 商用网络云平台（商云 APP）或本地 NMS 平台，进行远程集中管理。',
    keys: ['cloud', 'system'],
    build: (d, t) => {
      const c = d.cloud;
      let type = c.type;
      // 切换类型后重绘, 让下面的按钮跟着变成"关闭"或"切换类型"
      const selector = segmented([['cloud', 'TP-LINK 商用网络云平台'], ['nms', '本地 NMS 管理平台']], type, (v) => {
        type = v;
        t.rerender();
      });
      const platform = 'https://smbcloud.tp-link.com.cn';
      const server = input({ value: c.nms.server, maxlength: 62, 'aria-label': 'NMS 服务器地址', spellcheck: 'false' });
      const port = input({ value: c.nms.port, inputmode: 'numeric', 'aria-label': 'NMS 端口' });
      return [
        card({
          title: '云管理', icon: 'cloud',
          actions: c.enabled ? badge('已启用', 'ok', { dot: true }) : badge('未启用'),
          body: h('div', { class: 'stack' },
            kv([
              ['云管理状态', c.enabled ? '启用' : '禁用'],
              ['云管理类型', c.type === 'nms' ? 'TP-LINK 本地 NMS 管理平台' : 'TP-LINK 商用网络云平台'],
              ['绑定状态', !c.enabled ? '—' : c.boundId ? `已绑定（${c.boundId}）` : '未绑定'],
              ['设备 MAC', d.system.mac, { mono: true }],
            ]),
            h('div', { class: 'field' }, h('span', { class: 'field-label' }, '云管理类型'), selector),
            actions(
              button('启用云管理', {
                variant: 'primary', icon: 'cloud', disabled: c.enabled && c.type === type,
                onClick: () => t.apply('cloud.setting', { enabled: true, type }, {
                  confirm: {
                    title: '启用云管理？', confirmText: '启用',
                    details: ['开启云管理可能会使部分配置被修改，建议在开启前导出配置。', '要使用云管理，请先在「IP 设置」页面配置默认网关。', '开启后可在 TP-LINK 商用网络云平台绑定设备，添加设备时需要用到上面的 MAC 地址。', '云管理启用后，设备描述只能在云端修改。'],
                  },
                  success: '云管理已启用',
                }),
              }),
              c.enabled
                ? button(type === c.type ? '关闭云管理' : '切换云管理类型', {
                  icon: type === c.type ? 'x' : 'swap', variant: type === c.type ? 'danger' : '',
                  onClick: () => t.apply('cloud.setting', { enabled: type !== c.type, type }, {
                    confirm: {
                      title: type === c.type ? '关闭云管理？' : '切换云管理类型？', confirmText: '确认',
                      message: type === c.type ? '关闭云管理后，云平台上已绑定的设备会离线。' : '关闭云管理或切换到 TP-LINK 商用网络云平台时，云平台上已绑定的设备会离线。',
                    },
                    success: type === c.type ? '云管理已关闭' : '云管理类型已切换',
                  }),
                })
                : null,
            )),
        }),
        c.type === 'nms'
          ? card({
            title: '本地 NMS 服务器', icon: 'settings',
            body: h('div', { class: 'stack' },
              h('div', { class: 'form-grid' }, field('服务器地址', server, '域名或 IP，例如 nms.example.com'), field('服务器端口', port, '1024 - 65534')),
              actions(button('提交', { variant: 'primary', icon: 'check', onClick: () => t.apply('cloud.nms', { server: server.value.trim(), port: Number(port.value) }, { success: 'NMS 服务器已设置' }) }))),
          })
          : card({
            title: '绑定到云平台', icon: 'external',
            body: h('div', { class: 'stack' },
              kv([['云平台地址', h('a', { href: platform, target: '_blank', rel: 'noopener noreferrer' }, platform)]]),
              banner('info', '登录 TP-LINK 商用网络云平台（或「商云」APP），添加设备并填写上面的 MAC 地址即可绑定。'),
              actions(button('打开云平台', { icon: 'external', href: platform }))),
          }),
      ];
    },
  }),
};
