#!/usr/bin/env bash
# Investigate why DEEPSEEK_API_KEY is missing on the server.
# Usage: ./scripts/investigate-deepseek.sh
set -euo pipefail

HOST="miguel@memorax.us"
PORT="19096"
DEST="/opt/pauken"

echo "================================================"
echo " Pauken — DeepSeek env investigation"
echo "================================================"

ssh -t -p "$PORT" "$HOST" "
set -e

echo ''
echo '==> 1. Is Docker running?'
docker info --format '{{.ServerVersion}}' 2>/dev/null || echo 'Docker not running'

echo ''
echo '==> 2. Is the api container up?'
CONTAINER=\$(docker compose -f $DEST/deploy/docker-compose.yml ps -q api 2>/dev/null || true)
if [ -z \"\$CONTAINER\" ]; then
  echo '   No api container found (docker compose may not be running).'
else
  echo '   Container: '\$CONTAINER

  echo ''
  echo '==> 3. What is DEEPSEEK_API_KEY inside the container?'
  INNER=\$(docker exec \$CONTAINER sh -c 'echo \${DEEPSEEK_API_KEY:-EMPTY}' 2>/dev/null || echo 'exec failed')
  echo '   DEEPSEEK_API_KEY = '\$INNER

  echo ''
  echo '==> 4. All env vars set inside the container:'
  docker exec \$CONTAINER env | sort

  echo ''
  echo '==> 5. Is --env-file being used in the container CMD?'
  docker inspect \$CONTAINER --format '{{.Config.Cmd}}'
fi

echo ''
echo '==> 6. docker-compose api service environment block:'
grep -A 15 '^  api:' $DEST/deploy/docker-compose.yml | grep -A 10 'environment:'

echo ''
echo '==> 7. Does deploy/.env exist?'
if [ -f $DEST/deploy/.env ]; then
  echo '   YES'
  echo '   ---'
  grep -v '^\s*#' $DEST/deploy/.env | grep -v '^\s*$' | sed 's/=.*/=***/' | sed 's/^/   /'
else
  echo '   NO — docker-compose will NOT auto-load any .env file'
  echo '   (compose looks for .env next to the compose file, i.e. deploy/.env)'
fi

echo ''
echo '==> 8. Does project-root .env exist?'
if [ -f $DEST/.env ]; then
  echo '   YES'
else
  echo '   NO'
fi

echo ''
echo '==> 9. Container logs (last 20 lines):'
docker compose -f $DEST/deploy/docker-compose.yml logs --tail=20 api 2>/dev/null || true

echo ''
echo '================================================'
echo ' Investigation complete.'
echo '================================================'
echo ''
echo 'Most likely fix: add DEEPSEEK_API_KEY to the'
echo 'environment block in deploy/docker-compose.yml.'
echo 'Then create deploy/.env with the key value,'
echo 'and run: docker compose -f deploy/docker-compose.yml up -d --force-recreate api'
echo '================================================'
"
