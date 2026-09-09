#!/bin/sh
set -eu
if [ "$#" -ne 2 ]; then
  echo 'Usage: sh scripts/atlas-grafana.sh <Grafana 13.2.0 home> <Atlas output root>' >&2
  exit 1
fi
atlas_grafana_home=$(cd "$1" && pwd -P)
atlas_output=$(cd "$2/grafana" && pwd -P)
export GF_PATHS_DATA="$atlas_output/data"
export GF_PATHS_LOGS="$atlas_output/logs"
export GF_PATHS_PLUGINS="$atlas_output/plugins"
export GF_PATHS_PROVISIONING="$atlas_output/provisioning"
export EBO_ATLAS_DASHBOARDS="$atlas_output/dashboards"
mkdir -p "$GF_PATHS_DATA" "$GF_PATHS_LOGS" "$GF_PATHS_PLUGINS"
if [ ! -d "$GF_PATHS_PLUGINS/yesoreyeram-infinity-datasource" ]; then
  "$atlas_grafana_home/bin/grafana" cli --homepath "$atlas_grafana_home" --pluginsDir "$GF_PATHS_PLUGINS" plugins install yesoreyeram-infinity-datasource 4.0.0
fi
exec "$atlas_grafana_home/bin/grafana" server --homepath "$atlas_grafana_home" --config "$atlas_output/grafana.ini"
