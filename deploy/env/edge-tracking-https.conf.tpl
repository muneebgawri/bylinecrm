
# The short-link host (P3-4): tracked links (/r/<token>) and the open pixel (/o/<token>), and nothing else —
# the app is never served on it. Its DNS record is a DNS-only CNAME to the public host (the API checks the
# CNAME, which Cloudflare's proxy would hide), so clients reach the edge directly: no `cloudflare-only` here,
# and the visitor is $remote_addr itself. The API rate-limits these routes per client.
server {
    listen 80;
    server_name __TRACKING_HOST__;

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
    server_name __TRACKING_HOST__;

    ssl_certificate /etc/letsencrypt/live/__TRACKING_HOST__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__TRACKING_HOST__/privkey.pem;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;

    resolver 127.0.0.11 valid=10s ipv6=off;
    set $bylinecrm_web http://__WEB_UPSTREAM__:80;

    location ~ ^/[ro]/[A-Za-z0-9_-]+$ {
        limit_except GET HEAD { deny all; }
        proxy_pass $bylinecrm_web;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 30s;
    }

    location / {
        return 404;
    }
}
