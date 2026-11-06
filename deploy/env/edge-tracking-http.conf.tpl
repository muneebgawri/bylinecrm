
# The short-link host (P3-4) before its certificate exists: the ACME challenge, and nothing else.
# install-edge.sh appends this while /etc/letsencrypt/live/__TRACKING_HOST__/ is missing; issue it with
#   certbot certonly --webroot -w <the edge's certbot webroot> -d __TRACKING_HOST__
# then run install-edge.sh again, which switches to edge-tracking-https.conf.tpl.
server {
    listen 80;
    server_name __TRACKING_HOST__;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type text/plain;
    }

    location / {
        return 404;
    }
}
