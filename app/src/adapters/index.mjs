// 全部适配器。新增一种设备支持时, 在这里注册即可 (见 docs/adapters.md)。

import { jsonAdapter } from './tplink-json/index.mjs';
import { rpmAdapter } from './tplink-rpm/index.mjs';

export const adapters = [rpmAdapter, jsonAdapter];

export function registerAdapters(registry) {
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}
