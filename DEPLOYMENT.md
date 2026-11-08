# 可选容器部署

本轮已验证本地入口；当前机器没有运行 Docker daemon，因此未执行镜像构建或 Linux 容器运行验收。

```sh
cp .env.example .env
bash deploy.sh deploy
bash deploy.sh status
```

主机端口与容器端口独立配置。`BASE_IMAGE` 可指向已批准的镜像仓库；不自动改宿主配置。支持 deploy/start/restart/stop/status/logs，不自动删除既有容器。这里只提供单容器部署模板，没有账号认证或公网访问控制；对外开放前由部署方配置访问控制。

运行数据不要打进镜像。已有容器不会被 deploy 自动覆盖；需要保留运行输出时另行配置持久卷。健康路由为 `/healthz`。
