// 统一的错误类型。核心层只抛这些错误, 由最外层 (HTTP / 命令行) 决定怎么呈现。

/**
 * @typedef {'OFFLINE'|'TIMEOUT'|'BAD_CREDENTIALS'|'LOGIN_FAILED'|'SESSION'|'BAD_PARAM'|'BAD_RESPONSE'
 *          |'UNCERTAIN'|'BUSY'|'NOT_FOUND'|'CONFLICT'|'UNSUPPORTED'} Code
 */

/** 各错误码默认对应的 HTTP 状态码。 */
const STATUS = {
  BAD_CREDENTIALS: 401,
  SESSION: 401,
  BAD_PARAM: 400,
  BAD_RESPONSE: 502,
  OFFLINE: 502,
  TIMEOUT: 504,
  LOGIN_FAILED: 503,
  UNCERTAIN: 502,
  BUSY: 409,
  CONFLICT: 409,
  NOT_FOUND: 404,
  UNSUPPORTED: 400,
};

export class AppError extends Error {
  /**
   * @param {string} message
   * @param {Code} code
   * @param {{ details?: string[], cause?: unknown, status?: number, [k: string]: unknown }} extra
   */
  constructor(message, code = 'ERROR', { details, cause, status, ...rest } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    this.status = status ?? STATUS[code] ?? 500;
    Object.assign(this, rest);
  }
}

/** 设备侧的问题: 连不上、登录失败、设备拒绝、设备返回了看不懂的内容。 */
export class SwitchError extends AppError {
  constructor(message, code = 'ERROR', extra = {}) {
    super(message, code, extra);
    this.name = 'SwitchError';
  }
}

/** 面板自身的请求处理错误, 状态码由抛出方明确指定。 */
export class HttpError extends AppError {
  constructor(status, message, code = 'HTTP', details) {
    super(message, code, { details, status });
    this.name = 'HttpError';
  }
}

/** 把任意异常归一成 AppError (未知异常包成 INTERNAL, 不向外暴露细节)。 */
export function normalizeError(err) {
  if (err instanceof AppError) return err;
  const wrapped = new AppError('面板内部错误', 'INTERNAL', { cause: err, status: 500 });
  wrapped.internal = true;
  return wrapped;
}
