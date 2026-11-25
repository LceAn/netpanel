# 交换机管理面板。零依赖，只需要 Node.js。
#   docker build -t switch-panel .
#   docker run -d --name switch-panel -p 8208:8208 -e SWITCH_URL=http://10.0.0.239 switch-panel
# 注意: 容器要能访问到交换机所在的网段 (默认 bridge 网络一般可以出网; 不行就用 --network host)。

FROM node:24-alpine

WORKDIR /app
COPY package.json server.mjs ./
COPY lib ./lib
COPY public ./public

ENV PANEL_HOST=0.0.0.0 \
    PANEL_PORT=8208 \
    SWITCH_URL=http://10.0.0.239

USER node
EXPOSE 8208

CMD ["node", "server.mjs"]
