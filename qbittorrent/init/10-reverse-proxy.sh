#!/usr/bin/with-contenv bash
set -euo pipefail

CONF="/config/qBittorrent/qBittorrent.conf"
mkdir -p /config/qBittorrent

if [[ ! -f "${CONF}" ]]; then
  cat > "${CONF}" <<'INI'
[Preferences]
INI
fi

if ! grep -q '^\[Preferences\]$' "${CONF}"; then
  printf '\n[Preferences]\n' >> "${CONF}"
fi

set_pref() {
  local key="$1"
  local value="$2"
  local key_pattern
  key_pattern="$(printf '%s' "${key}" | sed -e 's/[][\\/.*^$]/\\&/g')"
  if grep -Fq "${key}=" "${CONF}"; then
    sed -i "s|^${key_pattern}=.*|${key}=${value}|" "${CONF}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${CONF}"
  fi
}

set_pref 'WebUI\Address' '0.0.0.0'
set_pref 'WebUI\Port' '8080'
set_pref 'WebUI\HostHeaderValidation' 'false'
set_pref 'WebUI\CSRFProtection' 'false'
set_pref 'WebUI\ReverseProxySupportEnabled' 'true'
set_pref 'WebUI\ServerDomains' "${BASE_DOMAIN};${BASE_DOMAIN}:${QBIT_HTTPS_PORT};localhost;127.0.0.1"
set_pref 'WebUI\TrustedReverseProxies' '127.0.0.1/8;10.0.0.0/8;172.16.0.0/12;192.168.0.0/16;fc00::/7'
set_pref 'WebUI\AlternativeUIEnabled' 'false'
