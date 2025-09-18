#!/bin/bash

# Lancer LocalTunnel sur le port 5173 (Vite)
npx localtunnel --port 5173 --subdomain mon-vite-test > tunnel1.log &

# Lancer LocalTunnel sur le port 8080 (API)
npx localtunnel --port 8080 --subdomain mon-api-test > tunnel2.log &

# Attendre un peu et afficher les logs
sleep 3
echo "🔗 Tunnel 1 (port 5173) log :"
cat tunnel1.log

echo ""
echo "🔗 Tunnel 2 (port 8080) log :"
cat tunnel2.log
