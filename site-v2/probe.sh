#!/bin/sh
echo '=== strings: products path refs ==='
strings /usr/local/bin/remote-assist-site | grep -i -E 'products|/ai-ssh-pro|SITE_DATA|StaticFile|FileServer' | head -40
echo '=== put probe file ==='
echo 'PROBE-OK-12345' > /var/lib/remote-assist-site/products/probe.txt
chown rasite:rasite /var/lib/remote-assist-site/products/probe.txt
echo '=== curl probes ==='
for u in /products/probe.txt /product/probe.txt /p/probe.txt /ai-ssh-pro/probe.txt /probe.txt; do
  printf '%s -> ' "$u"
  curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1$u"
done
echo '=== curl body ==='
curl -s http://127.0.0.1/products/probe.txt | head -3
rm -f /var/lib/remote-assist-site/products/probe.txt
