// 数据目录里 JSON 文件的读写。文件都很小 (几 KB), 所以用同步接口。
//
// 抗崩溃的写法 ("先临时文件、后正式文件", 不用重命名):
//   1. 把完整内容写进固定的临时文件 <文件名>.tmp 并落盘;
//   2. 再直接覆盖正式文件并落盘。
// 第 2 步写到一半崩溃时, 正式文件会残缺, 但临时文件里是同一份完整内容 —— readJson 会自动用它恢复。
// 之所以不用"写临时文件再 rename"的原子写法: 在某些 Windows 环境下 (例如被安全软件实时监控的目录)
// 重命名一次要一两秒, 而这里的两种操作都是毫秒级。
//
// 多进程同时写同一个文件时不做协调 (后写的覆盖先写的)。但"面板在运行、同时有人用命令行改数据"是正常的用法,
// 所以每个存储在读写之前都会先核对文件有没有被别的进程改过 (trackJson), 改了就重新读取 ——
// 这样面板既能马上看到命令行做的修改, 也不会在下次写入时拿自己内存里的旧数据把对方的修改覆盖掉。

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from '../errors.mjs';

const tmpOf = (file) => `${file}.tmp`;

function parse(file) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, err };
  }
}

/** 把 text 写进 file 并落盘; 新建的文件权限设为仅本用户可读写 (Windows 上不生效, 靠目录权限)。 */
function writeDurable(file, text) {
  const fd = openSync(file, 'w', 0o600);
  try {
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 读 JSON; 文件不存在返回 fallback。正式文件损坏但临时文件完整时用临时文件恢复。 */
export function readJson(file, fallback) {
  const main = existsSync(file) ? parse(file) : null;
  if (main?.ok) return main.value;

  const tmp = tmpOf(file);
  if (existsSync(tmp)) {
    const backup = parse(tmp);
    if (backup.ok) return backup.value; // 上次写到一半崩溃了: 临时文件里有完整内容
  }
  if (!main) return fallback;
  throw new AppError(`数据文件已损坏，不是合法的 JSON：${file}`, 'DATA_CORRUPT', { cause: main.err, status: 500 });
}

export function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const text = `${JSON.stringify(data, null, 2)}\n`;
  try {
    writeDurable(tmpOf(file), text);
    writeDurable(file, text);
  } catch (err) {
    throw new AppError(`无法写入数据文件：${file}`, 'IO', { cause: err, status: 500 });
  }
}

/** 删除数据文件及其临时文件 (测试和重置用)。 */
export function removeJson(file) {
  for (const f of [file, tmpOf(file)]) {
    try {
      unlinkSync(f);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

/** 文件的"版本": 修改时间 + 元数据变更时间 + 大小。与上次看到的不一样, 就说明有进程写过它。 */
function fileStamp(file) {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
  } catch {
    return null; // 文件还不存在
  }
}

/**
 * 一个"启动时读入、之后放在内存里"的数据文件, 带上变化检测。
 * @param {Function} [validate] 读入后校验数据 (不合法就抛错, 例如 DATA_CORRUPT)
 * @returns {{ read: () => object, write: (data: object) => void, reload: () => object }}
 */
export function trackJson(file, fallback, { validate = () => {} } = {}) {
  let stamp = fileStamp(file);
  const load = () => {
    const data = readJson(file, fallback);
    validate(data);
    return data;
  };
  let data = load();
  return {
    /** 当前数据。文件被别的进程改过时先重新读取。 */
    read() {
      const now = fileStamp(file);
      if (now !== stamp) {
        data = load();
        stamp = now;
      }
      return data;
    },
    /** 无条件重新读取 (不信任内存里的数据时用)。 */
    reload() {
      stamp = fileStamp(file);
      data = load();
      return data;
    },
    /** 写入并记住写完之后的文件版本。 */
    write(value) {
      writeJson(file, value);
      stamp = fileStamp(file);
      data = value;
    },
  };
}
