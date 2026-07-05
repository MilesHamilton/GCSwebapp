#!/bin/sh
# Generate the Basic Auth file from env before nginx starts. Fails CLOSED: if the
# credentials aren't set we write an impossible entry so nginx denies everyone rather
# than serving the app wide open.
set -e

HTPASSWD=/etc/nginx/.htpasswd

if [ -n "$BASIC_AUTH_USER" ] && [ -n "$BASIC_AUTH_PASS" ]; then
    htpasswd -bc "$HTPASSWD" "$BASIC_AUTH_USER" "$BASIC_AUTH_PASS"
    echo "[basic-auth] credentials configured for user '$BASIC_AUTH_USER'"
else
    echo "[basic-auth] WARN: BASIC_AUTH_USER/BASIC_AUTH_PASS not set — denying all requests" >&2
    printf 'disabled:!\n' > "$HTPASSWD"
fi
