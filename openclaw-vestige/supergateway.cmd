pkill -f supergateway
pkill -f vestige-mcp

nohup npx supergateway \
  --stdio "vestige-mcp --data-dir /data/vestige/vestige.db" \
  --port 3100 \
  --outputTransport streamableHttp \
  --streamableHttpPath /mcp \
  --healthEndpoint /health \
  --stateful \
  --sessionTimeout 300000 \
  > ~/supergateway.stdout 2> ~/supergateway.stderr &

