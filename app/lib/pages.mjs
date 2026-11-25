// 读取模型: 把每个原厂页面页首的原始变量归一化成语义化 JSON。
// 页面路径与菜单 (menuList.js) 一一对应; 前端只认这里输出的结构, 不接触原始变量。

const num = (v, dflt = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : dflt);
const first = (v) => (Array.isArray(v) ? v[0] : v);
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
/** 生成 count 个元素, 回调拿到的是 0 起始下标 (和 range 区分开, 避免拿 1 起始的序号当数组下标)。 */
const take = (count, fn) => Array.from({ length: Math.max(0, count) }, (_, i) => fn(i));
const at = (arr, i) => (Array.isArray(arr) ? arr[i] : undefined);

function bit(mask, port) {
  const m = num(mask);
  return Math.floor(m / 2 ** (port - 1)) % 2 === 1;
}

function maskPorts(mask, count) {
  return range(count).filter((p) => bit(mask, p));
}

/** "11 day - 4 hour - 17 min - 32 sec" → 秒数。 */
export function uptimeSeconds(text) {
  const m = /(\d+)\s*day\s*-\s*(\d+)\s*hour\s*-\s*(\d+)\s*min\s*-\s*(\d+)\s*sec/i.exec(String(text ?? ''));
  if (!m) return null;
  const [d, h, mi, s] = m.slice(1).map(Number);
  return ((d * 24 + h) * 60 + mi) * 60 + s;
}

function overview(v) {
  const info = v.info_ds ?? {};
  const pi = v.port_info ?? {};
  const qv = v.qvlan_ds ?? {};
  const loopConf = v.loopPortConf ?? {};
  const trunk = v.trunkConf ?? {};
  const maxPorts = num(v.max_port_num, 8);
  const showVlan = num(v.qvlan) === 0;
  const showLoop = num(v.loop) === 0;
  const showLag = num(v.trunk) === 0;
  const loopEnabled = num(loopConf.loopbackEnable) === 1;
  const lagOf = (p) => {
    for (let g = 1; g <= 8; g++) if (at(trunk[`portStr_g${g}`], p - 1)) return g;
    return 0;
  };
  const vlansOf = (p) => (qv.vlanList ?? []).filter((vid, i) => vid > 0 && bit(at(qv.portmask, i), p));

  return {
    maxPorts,
    support2_5G: num(v.support_2_5G) === 1,
    flags: { showVlan, showLoop, showLag, qvlanEnabled: num(qv.state) === 1, loopEnabled, poePorts: num(v.poeCfg?.poePortNum), maxLag: num(trunk.maxTrunkNum) },
    device: {
      model: first(info.hardwareStr) ?? '',
      description: first(info.descriStr) ?? '',
      mac: first(info.macStr) ?? '',
      ip: first(info.ipStr) ?? '',
      netmask: first(info.netmaskStr) ?? '',
      gateway: first(info.gatewayStr) ?? '',
      dns: first(info.dnsStr) ?? '',
      dhcp: num(info.dhcpEnable) === 1,
      dnsAuto: num(info.dnsEnable) === 1,
      firmware: first(info.firmwareStr) ?? '',
      uptime: uptimeSeconds(first(info.workTime)),
      uptimeText: first(info.workTime) ?? '',
      systemTime: num(v.systemTimeFlag) === 1 ? (first(info.systemTime) ?? '') : null,
    },
    cloud: {
      enabled: num(v.cloud_config) === 1,
      connected: num(v.cloud_status) === 1 && num(v.nms_status) === 1,
    },
    ports: range(maxPorts).map((p) => {
      const i = p - 1;
      const linkUp = num(at(pi.spd_act, i)) !== 0;
      return {
        id: p,
        enabled: num(at(pi.state, i)) === 1,
        speedCfg: num(at(pi.spd_cfg, i)),
        speedAct: num(at(pi.spd_act, i)),
        flowCfg: num(at(pi.fc_cfg, i)),
        flowAct: num(at(pi.fc_act, i)),
        lag: showLag ? lagOf(p) : 0,
        vlans: showVlan ? vlansOf(p) : null,
        loop: !showLoop || !loopEnabled ? 'off' : at(loopConf.ports, i) ? 'blocked' : linkUp ? 'normal' : 'down',
        rxKbps: num(at(pi.rx_rate, i)),
        txKbps: num(at(pi.tx_rate, i)),
      };
    }),
  };
}

function portsConfig(v) {
  const a = v.all_info ?? {};
  const maxPorts = num(v.max_port_num, 8);
  return {
    maxPorts,
    support2_5G: false,
    ports: range(maxPorts).map((p) => ({
      id: p,
      enabled: num(at(a.state, p - 1)) === 1,
      speedCfg: num(at(a.spd_cfg, p - 1)),
      speedAct: num(at(a.spd_act, p - 1)),
      flowCfg: num(at(a.fc_cfg, p - 1)),
      flowAct: num(at(a.fc_act, p - 1)),
      lag: num(at(a.trunk_info, p - 1)),
    })),
  };
}

function portStats(v) {
  const a = v.all_info ?? {};
  const maxPorts = num(v.max_port_num, 8);
  return {
    maxPorts,
    ports: range(maxPorts).map((p) => {
      const i = 4 * (p - 1);
      return {
        id: p,
        enabled: num(at(a.state, p - 1)) === 1,
        link: num(at(a.link_status, p - 1)),
        txGood: num(at(a.pkts, i)),
        txBad: num(at(a.pkts, i + 1)),
        rxGood: num(at(a.pkts, i + 2)),
        rxBad: num(at(a.pkts, i + 3)),
      };
    }),
  };
}

function portStatsDetail(v, port) {
  const rx = v.pkts_rx_info ?? [];
  const tx = v.pkts_tx_info ?? [];
  return {
    port,
    // 0-3: 单播/组播/广播/Pause帧; 4-8: 小于64字节/CRC错误/Fragments/Jabbers/Collisions
    rx: range(20).map((i) => num(at(rx, i - 1))),
    tx: range(20).map((i) => num(at(tx, i - 1))),
  };
}

const systemInfo = (v) => {
  const i = v.info_ds ?? {};
  return {
    description: first(i.descriStr) ?? '',
    mac: first(i.macStr) ?? '',
    ip: first(i.ipStr) ?? '',
    netmask: first(i.netmaskStr) ?? '',
    gateway: first(i.gatewayStr) ?? '',
    firmware: first(i.firmwareStr) ?? '',
    model: first(i.productModel) ?? '',
    hardware: first(i.hardwareStr) ?? '',
    cloudManaged: num(v.mngt_switch) === 1, // 云管理开启时设备描述只能在云端改
    supportsCloud: num(v.support_cloud) === 1,
  };
};

const ipSetting = (v) => {
  const i = v.ip_ds ?? {};
  return {
    dhcp: num(i.state) === 1,
    ip: first(i.ipStr) ?? '',
    netmask: first(i.netmaskStr) ?? '',
    gateway: first(i.gatewayStr) ?? '',
    dnsAuto: num(i.dnsEnable) === 1,
    dns: first(i.dnsStr) ?? '',
    manageVlan: num(v.manage_vlan, 1),
    vlanEditable: num(v.vlan_type) === 2,
  };
};

const fixIp = (v) => ({ enabled: num(v.ip_ds?.state) === 1, ip: first(v.ip_ds?.ipStr) ?? '' });

const userAccount = (v) => ({
  username: first(v.user_ds?.userNameStr) ?? '',
  limits: { userMin: num(v.userMinLenth, 1), userMax: num(v.userMaxLenth, 31), pwdMin: num(v.pwdMinLenth, 5), pwdMax: num(v.pwdMaxLenth, 31) },
});

const cloud = (v) => ({
  enabled: num(v.mngt_switch) === 1,
  type: num(v.cloud_type) === 1 ? 'nms' : 'cloud',
  nms: { server: v.tums_server ?? '', port: num(v.tums_port, 60445) },
  boundId: typeof v.connect_id === 'string' && v.connect_id ? v.connect_id : null,
});

const lag = (v) => {
  const t = v.trunk_conf ?? {};
  const maxLag = num(t.maxTrunkNum, 2);
  const portCount = num(t.portNum, 8);
  const view = Array.isArray(t.lag_view) ? t.lag_view : [];
  const ranges = {};
  // lag_view 形如 [组1起,组1止,组2起,组2止,...]; 只保留设备实际存在的汇聚组
  for (let g = 1; 2 * g <= view.length && g <= maxLag; g++) ranges[g] = [num(view[2 * g - 2]), num(view[2 * g - 1])];
  return {
    maxLag,
    portCount,
    portsPerLag: num(t.portNumPerTrunk, 4),
    ranges,
    groups: range(maxLag).map((id) => ({ id, members: range(portCount).filter((p) => at(t[`portStr_g${id}`], p - 1)) })),
  };
};

const isolation = (v) => {
  const c = v.portIso_conf ?? {};
  const portCount = num(c.portNum, 8);
  return {
    portCount,
    lags: Array.isArray(c.trunk_seq) ? c.trunk_seq.map(num) : [],
    rules: range(portCount).map((p) => ({ port: p, lag: num(at(c.trunk_info, p - 1)), forward: String(at(c.portStr_iso, p - 1) ?? '') })),
  };
};

const mirror = (v) => {
  const m = v.mirr_info ?? {};
  const maxPorts = num(v.max_port_num, 8);
  return {
    maxPorts,
    enabled: num(v.MirrEn) === 1,
    mirroringPort: num(v.MirrPort),
    ports: range(maxPorts).map((p) => ({
      id: p,
      ingress: num(at(m.ingress, p - 1)) === 1,
      egress: num(at(m.egress, p - 1)) === 1,
      lag: num(at(v.porttrunkid, p - 1)),
    })),
  };
};

const loop = (v) => ({ enabled: num(v.lpEn) === 1 });

const cable = (v) => {
  const maxPorts = num(v.maxPort, 8);
  return {
    maxPorts,
    results: range(maxPorts).map((p) => ({
      id: p,
      state: num(at(v.cablestate, p - 1), -1),
      length: num(at(v.cablelength, p - 1), -1),
      enabled: num(at(v.portdisableid, p)) !== 0,
    })),
  };
};

const vlanMtu = (v) => {
  const m = v.mtu_ds ?? {};
  return { enabled: num(m.state) === 1, portCount: num(m.portNum, 8), uplinkPort: num(m.uplinkPort, 1) };
};

const vlanPort = (v) => {
  const p = v.pvlan_ds ?? {};
  const count = Math.min(num(p.count), (p.vids ?? []).length);
  return {
    enabled: num(p.state) === 1,
    portCount: num(p.portNum, 8),
    maxVid: num(p.portNum, 8), // 原厂: pvMax = 端口数
    vlans: take(count, (i) => ({ id: num(at(p.vids, i)), members: maskPorts(at(p.mbrs, i), num(p.portNum, 8)) })),
  };
};

const vlan8021q = (v) => {
  const q = v.qvlan_ds ?? {};
  const portCount = num(q.portNum, 8);
  const count = Math.min(num(q.count), (q.vids ?? []).length);
  return {
    enabled: num(q.state) === 1,
    portCount,
    maxVlans: num(q.maxVids, 32),
    vlans: take(count, (i) => ({
      id: num(at(q.vids, i)),
      name: at(q.names, i) ?? '',
      tagged: maskPorts(at(q.tagMbrs, i), portCount),
      untagged: maskPorts(at(q.untagMbrs, i), portCount),
    })),
  };
};

const vlanPvid = (v) => {
  const p = v.pvid_ds ?? {};
  const portCount = num(p.portNum, 8);
  const count = Math.min(num(p.count), (p.vids ?? []).length);
  return {
    enabled: num(p.state) === 1,
    portCount,
    // 已存在的 802.1Q VLAN 及其成员掩码 (原厂用它在提交前提示 PVID 与成员关系不一致的端口)
    vlans: take(count, (i) => ({ id: num(at(p.vids, i)), mask: num(at(p.mbrs, i)) })),
    ports: range(portCount).map((id) => ({ id, pvid: num(at(p.pvids, id - 1), 1), lag: num(at(p.lagIds, id - 1)) })),
  };
};

const qosBasic = (v) => {
  const portCount = num(v.portNumber, 8);
  return {
    mode: num(v.qosMode),
    portCount,
    ports: range(portCount).map((id) => ({ id, priority: num(at(v.pPri, id - 1), 1), lag: num(at(v.pTrunk, id - 1)) })),
  };
};

const qosBandwidth = (v) => {
  const info = v.bcInfo ?? [];
  const portCount = num(v.portNumber, 8);
  return {
    portCount,
    ports: range(portCount).map((id) => ({
      id,
      ingress: num(at(info, 3 * (id - 1))),
      egress: num(at(info, 3 * (id - 1) + 1)),
      lag: num(at(info, 3 * id - 1)),
      enabled: num(at(v.portdisableid, id)) !== 0,
    })),
  };
};

const qosStorm = (v) => {
  const info = v.scInfo ?? [];
  const portCount = num(v.portNumber, 8);
  return {
    portCount,
    ports: range(portCount).map((id) => {
      const mask = num(at(info, 3 * (id - 1) + 1));
      return {
        id,
        rate: num(at(info, 3 * (id - 1))),
        enabled: mask !== 0,
        types: [1, 2, 4].filter((t) => (mask & t) === t), // 1=未知单播 2=组播 4=广播
        lag: num(at(info, 3 * id - 1)),
      };
    }),
  };
};

const firmware = (v) => ({
  firmware: first(v.upgrade_ds?.current_firmwareStr) ?? '',
  hardware: first(v.upgrade_ds?.current_hardwareStr) ?? '',
  onlineUpgrade: num(v.onlineUpgrade_flag) === 1,
  hasNew: num(v.hasNewFirmware),
  newFirmware: v.new_firmwareStr ?? '',
  releaseLog: v.release_log ?? '',
});

const macSearch = (v) => ({
  qvlan: num(v.mac_ds?.is_qvlan) === 1,
  results: (v.mac_ds?.mac_info ?? []).map((r) => ({ mac: String(r?.mac ?? ''), vid: num(r?.vid), port: num(r?.port) })),
});

/**
 * 页面注册表。path 是交换机上的只读页面, model 是归一化函数。
 * detail 表示需要额外查询参数的子页面 (参数由调用方给出, 不接受前端任意路径)。
 */
export const PAGES = {
  overview: { path: '/MainRpm.htm', model: overview },
  ports: { path: '/PortSettingRpm.htm', model: portsConfig },
  stats: { path: '/PortStatisticsRpm.htm', model: portStats },
  system: { path: '/SystemInfoRpm.htm', model: systemInfo },
  ip: { path: '/IpSettingRpm.htm', model: ipSetting },
  fixIp: { path: '/FixIpSettingRpm.htm', model: fixIp },
  user: { path: '/UserAccountRpm.htm', model: userAccount },
  cloud: { path: '/cloud.htm', model: cloud },
  lag: { path: '/PortTrunkRpm.htm', model: lag },
  isolation: { path: '/PortIsolationRpm.htm', model: isolation },
  mirror: { path: '/PortMirrorRpm.htm', model: mirror },
  loop: { path: '/LoopPreventionRpm.htm', model: loop },
  cable: { path: '/CableDiagRpm.htm', model: cable },
  vlanMtu: { path: '/VlanMtuRpm.htm', model: vlanMtu },
  vlanPort: { path: '/VlanPortBasicRpm.htm', model: vlanPort },
  vlan8021q: { path: '/Vlan8021QRpm.htm', model: vlan8021q },
  vlanPvid: { path: '/Vlan8021QPvidRpm.htm', model: vlanPvid },
  qosBasic: { path: '/QosBasicRpm.htm', model: qosBasic },
  qosBandwidth: { path: '/QosBandWidthControlRpm.htm', model: qosBandwidth },
  qosStorm: { path: '/QosStormControlRpm.htm', model: qosStorm },
  firmware: { path: '/fwupgradephase0.htm', model: firmware },
  macSearch: { path: '/MacSearchRpm.htm', model: macSearch },
};

/** 单端口报文统计明细页 (原厂 "查看" 链接)。 */
export const STATS_DETAIL = {
  path: '/PortStatisticsAllRpm.htm',
  buildQuery: (port) => new URLSearchParams({ port: String(port - 1) }), // 原厂用的是 0 起始下标
  model: portStatsDetail,
};
