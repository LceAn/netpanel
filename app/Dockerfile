# NetPanel —— 交换机管理面板。零依赖, 只需要 Node.js。
#
#   docker build -t netpanel .
#   docker run -d --name netpanel -p 8208:8208 -v netpanel-data:/data netpanel
#
# 首次打开 http://<主机>:8208 创建管理员账号, 然后在界面里添加交换机 (设备地址填容器能访问到的地址)。
# 容器要能连到交换机所在的网段: 默认的 bridge 网络一般可以; 不行就用 --network host。
# 数据目录 /data 里保存设备表 (设备密码已加密)、密钥、面板账号和设置 —— 用命名卷或自己建的目录把它持久化。
# 用自己建的目录 (-v /path:/data) 时, 要保证容器里的 node 用户 (uid 1000) 对它有写权限。

FROM node:24-alpine

WORKDIR /app
COPY package.json server.mjs ./
COPY bin ./bin
COPY src ./src
COPY web ./web
# 模拟交换机 (开发 / 演示用, 面板本身不需要)。不需要就删掉这两行
COPY scripts ./scripts
COPY test/fixtures ./test/fixtures

# 命名卷第一次挂载时会沿用这个目录的属主, 所以 non-root 的 node 用户也能写
RUN mkdir -p /data && chown node:node /data

ENV PANEL_HOST=0.0.0.0 \
    PANEL_PORT=8208 \
    PANEL_DATA_DIR=/data

USER node
VOLUME ["/data"]
EXPOSE 8208
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8208/api/status || exit 1

CMD ["node", "server.mjs"]
