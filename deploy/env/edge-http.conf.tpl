# BylineCRM __ENV__ on the NewswireOS edge — STEP 1 of 2: plain HTTP only (P5-4a, P5-4c).
#
# Rendered from deploy/env/edge-http.conf.tpl by install-edge.sh as
# /opt/newswireos-runtime/nginx-dynamic/bylinecrm-__ENV__.conf, which the edge's nginx.conf includes
# at http level. Safe before a certificate exists: it serves Let's Encrypt's HTTP-01 challenge from the
# certbot webroot the edge already mounts, and redirects everything else to https. The https template
# replaces it once certbot has issued the certificate.
#
# Contract with NewswireOS (whose releases gate on `nginx -t`): nothing here may make `nginx -t`
# fail or make nginx depend on BylineCRM being up. This file references no upstream at all.

server {
    listen 80;
    server_name __HOST__;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type text/plain;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
