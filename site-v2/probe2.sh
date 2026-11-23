#!/bin/sh
D=/var/lib/remote-assist-site/products/ai-ssh-pro
mkdir -p "$D"
printf '<!DOCTYPE html><html><head><title>PROBE-XYZ</title></head><body><h1>PROBE-XYZ-999</h1></body></html>' > "$D/index.html"
chown -R rasite:rasite /var/lib/remote-assist-site/products
echo '=== without restart ==='
curl -s http://127.0.0.1/ai-ssh-pro/ | grep -o 'PROBE-XYZ-999' | head -1
curl -s http://127.0.0.1/ai-ssh-pro/ | grep -o '<title>[^<]*</title>' | head -1
echo '=== status ==='
systemctl is-active remote-assist-site
rm -rf "$D"
echo '=== cleaned ==='
