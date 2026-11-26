// 凭据保险箱: 用一个随机密钥 (保存在数据目录的密钥文件里) 对设备密码做认证加密。
//
// 这能防止"配置文件被随手拷走 / 提交进仓库 / 贴给别人"时密码直接暴露,
// 但挡不住能读到整个数据目录的人——他们同时拿得到密钥。这和大多数自托管工具的做法一致,
// 所以请把 data/ 目录当作密码本身来保护 (见 README 的"安全模型")。
//
// 密文格式: v1:<iv>:<authTag>:<ciphertext>  (均为 base64url)
// aad (附加认证数据) 绑定密文属于哪个设备: 把 A 设备的密文贴到 B 设备上会被拒绝。

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from '../errors.mjs';

const KEY_BYTES = 32;

/** 读密钥文件; 不存在就创建。 */
function loadOrCreateKey(keyFile) {
  mkdirSync(dirname(keyFile), { recursive: true });
  if (existsSync(keyFile)) return readKey(keyFile, 0);

  const key = randomBytes(KEY_BYTES);
  try {
    // 'wx' = 独占创建: 面板服务和命令行同时首次运行时, 后到的一方不会覆盖先到一方的密钥
    const fd = openSync(keyFile, 'wx', 0o600);
    try {
      writeFileSync(fd, key);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return key;
  } catch (err) {
    if (err.code !== 'EEXIST') throw new AppError(`无法创建密钥文件：${keyFile}`, 'IO', { cause: err, status: 500 });
    return readKey(keyFile, 1); // 另一个进程抢先创建了, 用它的
  }
}

function readKey(keyFile, attempt) {
  const key = readFileSync(keyFile);
  // 另一个进程刚建好文件、还没写完时可能读到空文件: 稍等重试几次
  if (key.length === 0 && attempt < 20) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    return readKey(keyFile, attempt + 1);
  }
  if (key.length !== KEY_BYTES) throw new AppError(`密钥文件已损坏（应为 ${KEY_BYTES} 字节）：${keyFile}`, 'DATA_CORRUPT', { status: 500 });
  return key;
}

export function openVault(keyFile) {
  const key = loadOrCreateKey(keyFile);
  const b64 = (buf) => buf.toString('base64url');
  const aadOf = (aad) => Buffer.from(String(aad), 'utf8');

  return {
    keyFile,

    /** 明文 → 密文。 */
    encrypt(plain, aad = '') {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aadOf(aad));
      const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return `v1:${b64(iv)}:${b64(cipher.getAuthTag())}:${b64(ct)}`;
    },

    /** 密文 → 明文。密钥不对、密文被改动、或 aad 不匹配都会报错 (不会返回错误的明文)。 */
    decrypt(payload, aad = '') {
      const parts = typeof payload === 'string' ? payload.split(':') : [];
      if (parts.length !== 4 || parts[0] !== 'v1') throw new AppError('已保存的凭据格式无法识别', 'VAULT', { status: 500 });
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
        decipher.setAAD(aadOf(aad));
        decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
      } catch (err) {
        throw new AppError('无法解密已保存的凭据：密钥文件与数据文件不匹配，或数据被改动过', 'VAULT', { cause: err, status: 500 });
      }
    },
  };
}
