# 展项能源负荷编排服务

面向科技展览馆设备负荷、启停依赖和削峰计划的 TypeScript 后端服务。

当前工程提供严格类型检查、HTTP 运行入口、健康检查和领域参考资料。业务数据目录预留为 `reference/`，运行时生成的数据应写入 `.runtime/`。

## 运行

需要 Node.js 22 或更高版本。执行 `npm ci` 安装依赖，`npm test` 完成编译与测试，`npm start` 启动已编译服务。服务默认监听 8000 端口，访问 `GET /health` 可确认进程状态。也可以使用 `docker compose up --build` 启动容器。
