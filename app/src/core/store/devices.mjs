// 设备表: 面板里绑定了哪些设备。保存在 data/devices.json; 密码字段 (secret) 是保险箱里的密文。
//
// 对外只暴露"公开记录" (不含密文, 只告诉你有没有存密码); 明文密码只能通过 credentials(id) 取得,
// 而且解密后只在内存里使用, 不写日志、不返回给浏览器。

import { randomBytes } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { trackJson } from './json-file.mjs';

const ID_RE = /^d_[0-9a-f]{10}$/;
const NAME_MAX = 64;
const TAG_MAX = 32;
const TAGS_MAX = 8;
const ADAPTER_RE = /^[a-z0-9][a-z0-9-]*$/;
const VERSION = 1;

/**
 * 规范化设备地址: 只接受 http(s)://主机[:端口], 不带路径 / 查询串 / 用户名密码。
 * 返回不带末尾斜杠的字符串。
 */
export function normalizeUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? '').trim());
  } catch {
    throw new AppError('设备地址格式不正确，应形如 http://192.168.1.1', 'BAD_PARAM');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AppError('设备地址只支持 http:// 或 https://', 'BAD_PARAM');
  if (!url.hostname) throw new AppError('设备地址缺少主机名或 IP', 'BAD_PARAM');
  if (url.username || url.password) throw new AppError('设备地址里不能带账号密码，请填在下面的账号密码栏', 'BAD_PARAM');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new AppError('设备地址只填到主机和端口，不要带路径', 'BAD_PARAM');
  return url.origin;
}

function cleanTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw new AppError('标签必须是字符串数组', 'BAD_PARAM');
  const out = [];
  for (const tag of tags) {
    const t = String(tag).trim();
    if (!t) continue;
    if (t.length > TAG_MAX) throw new AppError(`标签最长 ${TAG_MAX} 个字符：${t}`, 'BAD_PARAM');
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > TAGS_MAX) throw new AppError(`每台设备最多 ${TAGS_MAX} 个标签`, 'BAD_PARAM');
  return out;
}

const cleanInterval = (value, fallback, min, max, label) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (!Number.isInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new AppError(`${label} 取值范围为 ${min}-${max} 秒`, 'BAD_PARAM');
  }
  return Number(value);
};

export function openDeviceStore(file, vault, { adapterExists = () => true } = {}) {
  const store = trackJson(file, { version: VERSION, devices: [] }, {
    validate: (d) => {
      if (!d || !Array.isArray(d.devices)) throw new AppError(`设备表文件已损坏：${file}`, 'DATA_CORRUPT', { status: 500 });
    },
  });
  // 每个操作都是"读取 → 修改 → 写回"一气呵成的同步代码: 中间没有 await, 不会被别的操作插进来
  const save = (data) => store.write(data);
  const findIn = (data, id) => data.devices.find((d) => d.id === id);
  const needIn = (data, id) => {
    const rec = typeof id === 'string' ? findIn(data, id) : undefined;
    if (!rec) throw new AppError(`设备不存在：${String(id).slice(0, 40)}`, 'NOT_FOUND');
    return rec;
  };
  /** 公开记录: 去掉密文, 只保留"有没有存密码"。 */
  const pub = (rec) => {
    const { secret, ...rest } = rec;
    return { ...rest, hasSecret: typeof secret === 'string' && secret.length > 0 };
  };

  const validateName = (data, name, exceptId) => {
    const value = String(name ?? '').trim();
    if (!value) throw new AppError('请给设备起一个名字', 'BAD_PARAM');
    if (value.length > NAME_MAX) throw new AppError(`设备名字最长 ${NAME_MAX} 个字符`, 'BAD_PARAM');
    const dup = data.devices.find((d) => d.id !== exceptId && d.name.toLowerCase() === value.toLowerCase());
    if (dup) throw new AppError(`已经有一台设备叫「${value}」了，请换个名字`, 'CONFLICT');
    return value;
  };

  return {
    file,

    list: () => store.read().devices.map(pub),
    get: (id) => pub(needIn(store.read(), id)),

    /** 解密某台设备的密码。只在需要连接设备时调用。 */
    credentials(id) {
      const rec = needIn(store.read(), id);
      return { username: rec.username, password: vault.decrypt(rec.secret, rec.id) };
    },

    add(input) {
      const data = store.read();
      const url = normalizeUrl(input.url);
      const adapter = String(input.adapter ?? '');
      if (!ADAPTER_RE.test(adapter) || !adapterExists(adapter)) throw new AppError(`不支持的适配器：${adapter || '(空)'}`, 'BAD_PARAM');
      const username = String(input.username ?? '').trim();
      const password = String(input.password ?? '');
      if (!username || username.length > 64 || !/^[\x21-\x7e]+$/.test(username)) throw new AppError('设备账号为 1-64 个可见字符', 'BAD_PARAM');
      if (!password || password.length > 128 || /[^\x21-\x7e]/.test(password)) throw new AppError('设备密码为 1-128 个可见字符', 'BAD_PARAM');

      // 设备 id: 5 字节随机数的十六进制。撞上的概率可以忽略, 但真的撞上就重新生成
      let id;
      do id = `d_${randomBytes(5).toString('hex')}`; while (findIn(data, id));
      const now = new Date().toISOString();
      const rec = {
        id,
        name: validateName(data, input.name),
        adapter,
        url,
        username,
        secret: vault.encrypt(password, id),
        enabled: input.enabled !== false,
        pollIntervalSec: cleanInterval(input.pollIntervalSec, null, 5, 3600, '轮询间隔'),
        tags: cleanTags(input.tags),
        notes: String(input.notes ?? '').slice(0, 500),
        identified: input.identified ?? null,
        createdAt: now,
        updatedAt: now,
      };
      data.devices.push(rec);
      save(data);
      return pub(rec);
    },

    /** 修改设备。password 留空表示不改密码。 */
    update(id, patch) {
      const data = store.read();
      const rec = needIn(data, id);
      if (patch.name !== undefined) rec.name = validateName(data, patch.name, id);
      if (patch.url !== undefined) rec.url = normalizeUrl(patch.url);
      if (patch.adapter !== undefined) {
        if (!ADAPTER_RE.test(patch.adapter) || !adapterExists(patch.adapter)) throw new AppError(`不支持的适配器：${patch.adapter}`, 'BAD_PARAM');
        rec.adapter = patch.adapter;
      }
      if (patch.username !== undefined) {
        const username = String(patch.username).trim();
        if (!username || username.length > 64 || !/^[\x21-\x7e]+$/.test(username)) throw new AppError('设备账号为 1-64 个可见字符', 'BAD_PARAM');
        rec.username = username;
      }
      if (patch.password !== undefined && patch.password !== '') {
        if (patch.password.length > 128 || /[^\x21-\x7e]/.test(patch.password)) throw new AppError('设备密码为 1-128 个可见字符', 'BAD_PARAM');
        rec.secret = vault.encrypt(patch.password, rec.id);
      }
      if (patch.enabled !== undefined) rec.enabled = !!patch.enabled;
      if (patch.pollIntervalSec !== undefined) rec.pollIntervalSec = cleanInterval(patch.pollIntervalSec, null, 5, 3600, '轮询间隔'); // null = 用全局默认
      if (patch.tags !== undefined) rec.tags = cleanTags(patch.tags);
      if (patch.notes !== undefined) rec.notes = String(patch.notes).slice(0, 500);
      if (patch.identified !== undefined) rec.identified = patch.identified;
      rec.updatedAt = new Date().toISOString();
      save(data);
      return pub(rec);
    },

    /** 记录一次成功的识别结果 (型号 / 固件 / 端口数)。 */
    setIdentified(id, identified) {
      const data = store.read();
      const rec = needIn(data, id);
      rec.identified = identified;
      rec.updatedAt = new Date().toISOString();
      save(data);
    },

    remove(id) {
      const data = store.read();
      const rec = needIn(data, id);
      data.devices = data.devices.filter((d) => d !== rec);
      save(data);
    },

    /** 无条件重新从磁盘读取。 */
    reload: () => store.reload(),
  };
}

export { ID_RE };
