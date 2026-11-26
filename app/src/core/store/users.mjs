// 面板自己的管理员账号。保存在 data/auth.json, 密码只存 scrypt 哈希, 不存明文。
//
// 面板有了自己的账号, 才能替用户保存各台设备的密码 (见 vault.mjs); 登录面板不再借用交换机的账号。
// 只有一个管理员账号; 多用户、权限分级不在当前范围内。

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { trackJson } from './json-file.mjs';

// scrypt 参数: N=2^14, r=8, p=1 是 OWASP 推荐的交互式口令下限, 单次校验约 50-80ms。
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const USERNAME_RE = /^[\x21-\x7e]{1,64}$/;

function derive(password, salt) {
  return scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
}

/** 明文 → `scrypt$N$r$p$salt$hash`。 */
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = derive(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** 校验明文是否与存储的哈希匹配。格式不对直接判否。 */
function verifyHash(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  let expected;
  let salt;
  try {
    expected = Buffer.from(hashB64, 'base64url');
    salt = Buffer.from(saltB64, 'base64url');
  } catch {
    return false;
  }
  const actual = scryptSync(password, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024 });
  return expected.length > 0 && actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function assertPasswordPolicy(password) {
  if (typeof password !== 'string' || password.length < 8) throw new AppError('面板密码至少 8 个字符', 'BAD_PARAM');
  if (password.length > 128) throw new AppError('面板密码最长 128 个字符', 'BAD_PARAM');
}

export function openUserStore(file) {
  // 面板运行期间也可能有人用命令行 (switchctl setup / user passwd) 改这个文件, 所以每次都先核对文件有没有变
  const store = trackJson(file, null);

  // 账号不存在时也做一次哈希运算, 让"账号不存在"和"密码错误"的耗时一致
  const DUMMY_SALT = Buffer.from('netpanel-dummy-salt!!');

  return {
    file,
    get exists() {
      return !!store.read();
    },
    get username() {
      return store.read()?.username ?? null;
    },

    /** 首次初始化: 创建管理员账号。已经初始化过则拒绝。 */
    create(username, password) {
      const name = String(username ?? '').trim();
      if (!USERNAME_RE.test(name)) throw new AppError('面板账号为 1-64 个英文字母、数字或英文符号', 'BAD_PARAM');
      assertPasswordPolicy(password);
      if (store.read()) throw new AppError('面板已经初始化过了', 'CONFLICT');
      store.write({ username: name, hash: hashPassword(password), createdAt: new Date().toISOString() });
    },

    /** 校验账号密码。成功返回 true。 */
    verify(username, password) {
      const data = store.read();
      if (!data || typeof password !== 'string') {
        derive('timing-equalizer', DUMMY_SALT);
        return false;
      }
      const userOk = typeof username === 'string' && username.trim() === data.username && username.trim().length > 0;
      const passOk = verifyHash(password, data.hash);
      if (!userOk) derive('timing-equalizer', DUMMY_SALT);
      return userOk && passOk;
    },

    /** 修改密码: 需要提供旧密码。 */
    changePassword(username, oldPassword, newPassword) {
      if (!this.verify(username, oldPassword)) throw new AppError('当前密码不正确', 'BAD_CREDENTIALS');
      assertPasswordPolicy(newPassword);
      store.write({ ...store.read(), hash: hashPassword(newPassword), updatedAt: new Date().toISOString() });
    },
  };
}
