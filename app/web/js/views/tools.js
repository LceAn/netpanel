// 系统工具 (保存 / 备份 / 还原 / 重启 / 恢复出厂) 与固件升级。

import { h, kids, toast, toastError } from '../dom.js';
import { card, badge, button, banner, notes, kv, actions, pageHead } from '../ui.js';
import { dataPage, waitReboot } from './shared.js';

export const tools = {
  id: 'system.tools',
  render: (ctx) => {
    let saveOnReboot = true;
    const restoreInput = h('input', { type: 'file', accept: '.cfg', hidden: true });

    restoreInput.addEventListener('change', async () => {
      const file = restoreInput.files?.[0];
      restoreInput.value = '';
      if (!file) return;
      const ok = await ctx.confirm({
        title: '还原配置？', confirmText: '还原',
        message: `将用「${file.name}」覆盖交换机上的当前配置。`,
        details: ['当前配置会丢失；错误的配置可能导致交换机无法管理。', '还原需要几分钟，期间不要断电或进行其它操作。', '如果配置里的管理 IP 或账号密码不同，本面板会连不上交换机。'],
      });
      if (!ok) return;
      try {
        const res = await ctx.api.upload(ctx.api.restoreUrl, file);
        if (res.disconnected) await waitReboot(ctx, { title: '配置已还原，交换机重启中', hint: '' }); // 还原完成后交换机自己重启了: 等它回来
        else toast(res.tip || '配置已还原', 'ok', 6000);
        ctx.reload();
      } catch (err) {
        toastError(err);
      }
    });

    return h('div', { class: 'stack' },
      pageHead('系统工具', '保存配置、备份与还原、重启、恢复出厂设置。'),
      card({
        title: '保存配置', icon: 'save',
        body: h('div', { class: 'stack' },
          h('p', { class: 'muted' }, '把当前运行配置写入 FLASH，重启后仍然生效。修改了端口、VLAN、QoS 等配置后记得保存。'),
          actions(button('保存到 FLASH', { variant: 'primary', icon: 'save', onClick: () => ctx.apply('config.save', {}, { success: '配置已保存到 FLASH' }) }))),
      }),
      card({
        title: '配置备份与还原', icon: 'upload',
        body: h('div', { class: 'stack' },
          h('p', { class: 'muted' }, '备份会下载一个 .cfg 文件；还原时上传同一个文件即可回到当时的状态。'),
          h('div', { class: 'row' }, button('下载配置备份', { icon: 'save', href: ctx.api.backupUrl }), button('还原配置', { icon: 'upload', onClick: () => restoreInput.click() }), restoreInput),
          notes(['备份或还原配置需要花费几分钟时间，在此期间请不要进行其它操作。', '备份或还原过程中请不要断电。'])),
      }),
      card({
        title: '重启', icon: 'power',
        body: h('div', { class: 'stack' },
          h('label', { class: 'toggle' },
            h('input', { type: 'checkbox', checked: true, onchange: (e) => (saveOnReboot = e.target.checked) }),
            h('span', { class: 'track', 'aria-hidden': 'true' }), h('span', { class: 'toggle-text' }, '重启前保存配置')),
          actions(button('重启交换机', {
            icon: 'power',
            onClick: async () => {
              const res = await ctx.apply('system.reboot', { save: saveOnReboot }, { confirm: { title: '重启交换机？', message: '重启期间所有端口会断网约 1 分钟。', confirmText: '重启' }, quiet: true });
              if (res) await waitReboot(ctx);
            },
          }))),
      }),
      card({
        title: '恢复出厂设置', icon: 'alert',
        body: h('div', { class: 'stack' },
          banner('danger', '所有配置（端口、VLAN、账号密码、IP 地址）都会被清空并恢复成默认。管理地址会变回 192.168.0.1，账号密码恢复为出厂默认。此操作不可撤销。'),
          h('p', { class: 'muted' }, '如果只是个别功能配置乱了，建议先试「配置还原」或到对应页面单独修改。'),
          actions(button('恢复出厂设置', {
            variant: 'danger', icon: 'alert',
            onClick: async () => {
              const res = await ctx.apply('system.reset', { confirmText: 'RESET' }, {
                confirm: { title: '恢复出厂设置？', typed: 'RESET', message: '输入 RESET 以确认。所有配置都会丢失，交换机会重启。' }, quiet: true,
              });
              if (res) {
                await waitReboot(ctx, { title: '正在恢复出厂设置' });
                toast('设备已恢复出厂：管理地址和账号密码都变回了出厂默认。请到「设备管理」里修改这台设备的地址和密码。', 'info', 12000);
              }
            },
          }))),
      }));
  },
};

const JOB_TEXT = { idle: '', running: '升级进行中', rebooting: '固件已写入，设备重启中', done: '升级完成，设备已重新上线', failed: '升级失败' };
const JOB_TONE = { running: 'warn', rebooting: 'ok', done: 'ok', failed: 'danger' };

/** 已经等过重启的升级任务 (设备 id + 任务开始时间)。
 *  "设备重启中"的状态会一直保留到下次升级; 等待重启成功后页面会重绘, render() 重新执行 —— 这个集合放在模块里, 不随重绘清空。 */
const waitedReboot = new Set();

export const firmware = {
  id: 'system.firmware',
  render: (ctx) => {
    // 升级任务的显示属于整个页面: 重绘 (例如检查新版本之后) 只换显示用的节点, 轮询不重新开始
    const jobBox = { state: h('span'), log: h('div', { class: 'mono small', style: { 'white-space': 'pre-wrap', 'max-height': '180px', overflow: 'auto' } }, '当前没有升级任务。') };
    const paintJob = (job) => {
      jobBox.state.replaceChildren(...kids([job.state === 'idle' ? null : badge(JOB_TEXT[job.state] ?? job.state, JOB_TONE[job.state] ?? 'warn', { dot: job.state === 'running' })]));
      jobBox.log.textContent = [job.log.join('\n'), job.error].filter(Boolean).join('\n') || '当前没有升级任务。';
      jobBox.log.scrollTop = jobBox.log.scrollHeight;
    };
    let firstPoll = true;
    ctx.poll(async () => {
      let job;
      try {
        job = await ctx.api.firmwareJob();
      } catch {
        return; // 轮询失败不提示
      }
      paintJob(job);
      if (job.state !== 'rebooting') return;
      const key = `${ctx.device.id}:${job.startedAt}`;
      // 页面刚打开时设备刚刚还应答过 → 那次重启早就结束了 (或者是在别的标签页里等过了), 不必再等
      const alreadyBack = firstPoll && Date.now() - (ctx.device.lastOk ?? 0) < 15000;
      firstPoll = false;
      if (!alreadyBack && !waitedReboot.has(key)) {
        waitedReboot.add(key);
        await waitReboot(ctx, { title: '固件升级完成，设备重启中', hint: '升级完成后交换机会自动重启，请勿断电。' });
      }
      // 走到这里说明设备已经回来: 把任务标记为"升级完成", 以后 (包括重新打开页面) 不再等它重启
      await ctx.api.firmwareSettle().catch(() => {});
    }, 1500);

    const binInput = h('input', { type: 'file', accept: '.bin', hidden: true });
    binInput.addEventListener('change', async () => {
      const file = binInput.files?.[0];
      binInput.value = '';
      if (!file) return;
      const ok = await ctx.confirm({
        title: '升级固件？', confirmText: '开始升级',
        message: `将上传「${file.name}」(${(file.size / 1024 / 1024).toFixed(2)} MB) 并写入交换机。`,
        details: ['为了避免损坏设备，请不要在升级过程中关闭电源。', '建议在升级之前保存配置。', '升级过程中请勿关闭本页面，升级完成后交换机将自动重启。'],
      });
      if (!ok) return;
      try {
        await ctx.api.upload(ctx.api.firmwareUpgradeUrl, file);
        toast('固件已上传，开始写入', 'ok');
      } catch (err) {
        toastError(err);
      }
    });

    /** 在线检查的结果: 有新版本时给出升级按钮。 */
    const checkResult = (fw) => {
      const box = h('div', { class: 'stack' });
      if (fw.hasNew === 1) {
        box.append(
          banner('info', `发现新版本：${fw.newFirmware || '（版本号未知）'}`),
          h('div', { class: 'mono small', style: { 'white-space': 'pre-wrap' } }, fw.releaseLog ?? ''),
          actions(button('在线升级到新版本', {
            variant: 'primary', icon: 'upload',
            onClick: async () => {
              const ok = await ctx.confirm({ title: '在线升级？', confirmText: '开始升级', message: `交换机将从 TP-LINK 服务器下载 ${fw.newFirmware || '新固件'} 并安装，完成后自动重启。`, details: ['升级过程中请勿断电，建议先保存配置。'] });
              if (!ok) return;
              try {
                await ctx.api.firmwareOnline();
                toast('已开始在线升级', 'ok');
              } catch (err) {
                toastError(err);
              }
            },
          })));
      } else if (ctx.can('system.reboot')) {
        box.append(h('p', { class: 'muted' }, fw.hasNew === -1 ? '暂时无法获取版本信息，请稍后重试或使用本地升级。' : '当前已是最新版本。'));
      } else {
        box.append(h('p', { class: 'muted' }, fw.hasNew === 1 ? '发现新版本。这个适配器是只读的，请在交换机自己的管理界面里升级。' : '当前已是最新版本。'));
      }
      return box;
    };

    return dataPage(ctx, {
      title: '固件升级',
      desc: '在线检查并升级，或上传从官网下载的固件文件。',
      keys: ['firmware'],
      build: (d, t) => {
        const fw = d.firmware;
        const checking = h('span');
        const writable = ctx.can('system.reboot'); // 只读适配器: 能看版本, 但没有升级按钮
        return [
          card({
            title: '版本信息', icon: 'cpu',
            body: kv([['当前软件版本', fw.firmware], ['硬件版本', fw.hardware], ['在线升级', fw.onlineUpgrade ? badge('支持', 'ok') : badge('不支持')]]),
          }),
          card({
            title: '在线升级', icon: 'cloud',
            actions: checking,
            body: h('div', { class: 'stack' },
              writable && ctx.has('firmwareCheck')
                ? h('div', { class: 'row' }, button('检查新版本', {
                  icon: 'refresh', disabled: !fw.onlineUpgrade,
                  onClick: async () => {
                    checking.replaceChildren(badge('检查中…', 'warn'));
                    try {
                      t.data.firmware = await ctx.api.firmwareCheck();
                    } catch (err) {
                      toastError(err);
                    }
                    t.rerender();
                  },
                }))
                : null,
              checkResult(fw)),
          }),
          ...(writable && ctx.has('firmwareLocal')
            ? [card({
              title: '本地升级', icon: 'upload',
              body: h('div', { class: 'stack' },
                h('p', { class: 'muted' }, '从 TP-LINK 官网下载对应硬件版本的固件（.bin），在此上传。'),
                h('div', { class: 'row' }, button('选择固件并升级', { icon: 'upload', onClick: () => binInput.click() }), binInput),
                notes(['为了避免损坏设备，请不要在升级过程中关闭电源。', '建议在升级之前保存配置。', '升级过程中请勿刷新页面，升级完成后交换机将自动重启。'])),
            })]
            : []),
          card({ title: '升级进度', icon: 'activity', actions: jobBox.state, body: jobBox.log }),
        ];
      },
    });
  },
};
