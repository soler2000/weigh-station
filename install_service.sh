#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="weigh-station.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_WORKING_DIR="${SCRIPT_DIR}"
DEFAULT_VENV_DIR="${DEFAULT_WORKING_DIR}/.venv"
DEFAULT_PORT="6000"
DEFAULT_USER="${SUDO_USER:-$(id -un)}"
if [[ -n "${SUDO_USER:-}" ]]; then
  DEFAULT_GROUP="$(id -gn "${SUDO_USER}")"
else
  DEFAULT_GROUP="$(id -gn)"
fi

usage() {
  cat <<USAGE
Usage: sudo ./install_service.sh [options]

Options:
  --user USER           System user for the service (default: ${DEFAULT_USER})
  --group GROUP         System group for the service (default: ${DEFAULT_GROUP})
  --working-dir PATH    Absolute path to the project directory (default: ${DEFAULT_WORKING_DIR})
  --venv PATH           Absolute path to the Python virtualenv (default: <working-dir>/.venv)
  --port PORT           HTTP port exposed by uvicorn (default: ${DEFAULT_PORT})
  -h, --help            Show this help message
USAGE
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "[ERROR] This script must be run as root (use sudo)." >&2
    exit 1;
  fi
}

main() {
  require_root

  local service_user="${DEFAULT_USER}"
  local service_group="${DEFAULT_GROUP}"
  local working_dir="${DEFAULT_WORKING_DIR}"
  local venv_dir="${DEFAULT_VENV_DIR}"
  local port="${DEFAULT_PORT}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --user)
        service_user="$2"
        shift 2
        ;;
      --group)
        service_group="$2"
        shift 2
        ;;
      --working-dir)
        working_dir="$2"
        shift 2
        ;;
      --venv)
        venv_dir="$2"
        shift 2
        ;;
      --port)
        port="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "[ERROR] Unknown option: $1" >&2
        usage >&2
        exit 1
        ;;
    esac
  done

  if [[ ! -d "${working_dir}" ]]; then
    echo "[ERROR] Working directory '${working_dir}' does not exist." >&2
    exit 1
  fi

  working_dir="$(cd "${working_dir}" && pwd)"

  venv_dir="$(python3 - "${venv_dir}" <<'PY'
import os
import sys
print(os.path.abspath(sys.argv[1]))
PY
)"

  if [[ -z "${service_group}" ]]; then
    service_group="${service_user}"
  fi

  if ! id "${service_user}" &>/dev/null; then
    echo "[ERROR] User '${service_user}' does not exist." >&2
    exit 1
  fi

  if ! getent group "${service_group}" >/dev/null; then
    echo "[ERROR] Group '${service_group}' does not exist." >&2
    exit 1
  fi

  if [[ ! -x "${venv_dir}/bin/uvicorn" ]]; then
    echo "[WARN] Uvicorn not found in '${venv_dir}'." >&2
    echo "       Create the virtual environment and install dependencies first:" >&2
    echo "         python3 -m venv '${venv_dir}'" >&2
    echo "         source '${venv_dir}/bin/activate' && pip install -r requirements.txt" >&2
  fi

  local unit_template="${SCRIPT_DIR}/${SERVICE_NAME}"
  if [[ ! -f "${unit_template}" ]]; then
    echo "[ERROR] Service template '${unit_template}' not found." >&2
    exit 1
  fi

  local tmp_unit
  tmp_unit="$(mktemp)"
  trap 'rm -f "${tmp_unit}"' EXIT

  sed \
    -e "s|^User=.*|User=${service_user}|" \
    -e "s|^Group=.*|Group=${service_group}|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=${working_dir}|" \
    -e "s|^ExecStart=.*|ExecStart=${venv_dir}/bin/uvicorn app.main:app --host 0.0.0.0 --port ${port}|" \
    "${unit_template}" > "${tmp_unit}"

  install -m 0644 "${tmp_unit}" "/etc/systemd/system/${SERVICE_NAME}"
  rm -f "${tmp_unit}"
  trap - EXIT

  mkdir -p /etc/default
  if [[ ! -f /etc/default/weigh-station ]]; then
    touch /etc/default/weigh-station
    echo "[INFO] Created /etc/default/weigh-station (empty)." >&2
    echo "       Populate this file with KEY=value overrides as needed." >&2
  fi

  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}"

  systemctl status "${SERVICE_NAME}" --no-pager || true

  echo "[INFO] Service '${SERVICE_NAME}' installed and enabled." >&2
  echo "       Logs: journalctl -u ${SERVICE_NAME} -f" >&2
}

main "$@"
