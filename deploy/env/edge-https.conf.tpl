# BylineCRM __ENV__ on the NewswireOS edge — STEP 2 of 2: HTTPS (P5-4a, P5-4c).
#
# Rendered from deploy/env/edge-https.conf.tpl by install-edge.sh in place of the http file, after
# certbot has issued /etc/letsencrypt/live/__HOST__/. The edge's http block already handles
# Cloudflare and TLS defaults; this file adds only the two server blocks for this host.
#
# The upstream names the LIVE web colour (__WEB_UPSTREAM__); a release renders this file again with
# the other colour and reloads the edge, which is how the web cutover is atomic (P5-4c). The name is
# resolved when a request arrives (Docker's resolver, variable upstream — the same pattern as Slotline
# in the edge's nginx.conf), so `nginx -t`, nginx start and NewswireOS reloads never depend on
# BylineCRM running. With BylineCRM down, this host answers 502 and nothing else changes.
#
# Behind Cloudflare's proxy (an option for production — crm.pinionnewswire.com is one subdomain level,
# which Universal SSL covers): the edge's http block already rewrites $remote_addr from
# CF-Connecting-IP for requests that come from Cloudflare's published ranges and leaves every other
# request's address as it is, so this file needs nothing for either mode and restricts nothing by IP.

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

server {
    listen 443 ssl;
    server_name __HOST__;

    ssl_certificate /etc/letsencrypt/live/__HOST__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__HOST__/privkey.pem;

    # Attachments are capped at 25 MiB by the API (ATTACHMENT_MAX_BYTES); leave room for the envelope.
    client_max_body_size 26m;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    # Not embedded anywhere yet. When the NewswireOS shell embeds the CRM (P5-3) this becomes a
    # Content-Security-Policy frame-ancestors list naming that host.
    add_header X-Frame-Options "DENY" always;

    resolver 127.0.0.11 valid=10s ipv6=off;
    set $bylinecrm_web http://__WEB_UPSTREAM__:80;

    location / {
        proxy_pass $bylinecrm_web;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        # The visitor, once: the BylineCRM web container passes these through unchanged and the API
        # trusts exactly one proxy hop, so the right-most X-Forwarded-For entry must be the visitor.
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }
}
