// 极简路由表: 按 "方法 + 路径模式" 找处理函数。路径模式里的 :name 匹配一段路径。
//   router.get('/api/devices/:id', handler)  →  handler({ params: { id } })
// 只支持本项目需要的这点功能, 不引入依赖。

export class Router {
  #routes = [];

  #add(method, pattern, handler) {
    const keys = [];
    const source = pattern.replace(/\/:([A-Za-z_]+)/g, (_, key) => {
      keys.push(key);
      return '/([^/]+)';
    });
    this.#routes.push({ method, re: new RegExp(`^${source}/?$`), keys, handler, pattern });
  }

  get(pattern, handler) { this.#add('GET', pattern, handler); }
  post(pattern, handler) { this.#add('POST', pattern, handler); }
  patch(pattern, handler) { this.#add('PATCH', pattern, handler); }
  delete(pattern, handler) { this.#add('DELETE', pattern, handler); }

  /** 找匹配的路由。params 里的值已做 URL 解码。 */
  find(method, path) {
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      const m = route.re.exec(path);
      if (!m) continue;
      try {
        return { handler: route.handler, params: Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(m[i + 1])])) };
      } catch {
        return null; // 路径里有非法的百分号编码
      }
    }
    return null;
  }

  /** 这个路径是否存在 (任意方法)。用来区分 404 和 405。 */
  exists(path) {
    return this.#routes.some((route) => route.re.test(path));
  }

  /** 列出全部路由 (文档和测试用)。 */
  list() {
    return this.#routes.map((route) => ({ method: route.method, pattern: route.pattern }));
  }
}
