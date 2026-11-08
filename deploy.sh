#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
log() { printf '\033[36m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
if [[ -f .env ]]; then
  while IFS='=' read -r key value || [[ -n "${key:-}" ]]; do
    case "$key" in HOST_PORT|CONTAINER_PORT|IMAGE_NAME|CONTAINER_NAME|PUBLIC_ORIGIN|ALLOWED_HOSTS|BASE_IMAGE|BIND_ADDRESS) export "$key=$value";; esac
  done < .env
fi
HOST_PORT=${HOST_PORT:-8080}
CONTAINER_PORT=${CONTAINER_PORT:-8080}
BIND_ADDRESS=${BIND_ADDRESS:-127.0.0.1}
IMAGE_NAME=${IMAGE_NAME:-external-local-catalog:local}
CONTAINER_NAME=${CONTAINER_NAME:-external-local-catalog}
PUBLIC_ORIGIN=${PUBLIC_ORIGIN:-http://127.0.0.1:$HOST_PORT}
ALLOWED_HOSTS=${ALLOWED_HOSTS:-127.0.0.1:$HOST_PORT,localhost:$HOST_PORT}
[[ "$HOST_PORT" =~ ^[0-9]+$ && "$CONTAINER_PORT" =~ ^[0-9]+$ ]] || fail '端口须为数字'
((HOST_PORT > 0 && HOST_PORT < 65536 && CONTAINER_PORT > 0 && CONTAINER_PORT < 65536)) || fail '端口范围须为1—65535'
command -v docker >/dev/null || fail '未安装 Docker'
docker info >/dev/null 2>&1 || fail 'Docker 服务不可用，请先启动已安装的 Docker 服务'
exists() { docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; }
start() {
  if exists; then
    [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME")" == true ]] && { log '容器已运行'; return; }
    docker start "$CONTAINER_NAME" || fail '容器启动失败'; return
  fi
  if command -v ss >/dev/null; then
    ss -ltnH | awk '{print $4}' | awk -F: '{print $NF}' | awk -v p="$HOST_PORT" '$0==p {found=1} END {exit !found}' && fail '主机端口已占用'
  elif command -v lsof >/dev/null; then
    lsof -nP -iTCP:"$HOST_PORT" -sTCP:LISTEN >/dev/null 2>&1 && fail '主机端口已占用'
  fi
  docker run -d --name "$CONTAINER_NAME" -p "$BIND_ADDRESS:$HOST_PORT:$CONTAINER_PORT" \
    -e HOST=0.0.0.0 -e PORT="$CONTAINER_PORT" -e PUBLIC_ORIGIN="$PUBLIC_ORIGIN" \
    -e ALLOWED_HOSTS="$ALLOWED_HOSTS" "$IMAGE_NAME" || { docker logs "$CONTAINER_NAME" 2>/dev/null || true; fail '容器创建失败'; }
  sleep 2
  [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME")" == true ]] || { docker logs "$CONTAINER_NAME"; fail '服务已退出'; }
  log "服务已启动：http://127.0.0.1:$HOST_PORT；健康状态可用 status 查看"
}
case "${1:-status}" in
  deploy) exists && fail '容器已存在；先检查旧容器，避免覆盖数据'
    args=(); [[ -n "${BASE_IMAGE:-}" ]] && args+=(--build-arg "BASE_IMAGE=$BASE_IMAGE")
    docker build "${args[@]}" -t "$IMAGE_NAME" . || fail '构建失败；可设置 BASE_IMAGE 为已批准的镜像源'
    start;;
  start) start;;
  restart) exists || fail '容器不存在'; docker restart "$CONTAINER_NAME";;
  stop) exists || fail '容器不存在'; docker stop "$CONTAINER_NAME";;
  status) exists || fail '容器不存在'; docker inspect -f '{{json .State}}' "$CONTAINER_NAME";;
  logs) exists || fail '容器不存在'; docker logs --tail 100 "$CONTAINER_NAME";;
  *) fail '用法：bash deploy.sh deploy|start|restart|stop|status|logs';;
esac
