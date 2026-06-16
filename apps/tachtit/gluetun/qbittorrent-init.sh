#!/bin/bash
# Init script to configure qBittorrent to use tun0 interface

CONFIG_FILE="/config/qBittorrent/qBittorrent.conf"

# Wait for config file to exist
timeout=30
while [ ! -f "$CONFIG_FILE" ] && [ $timeout -gt 0 ]; do
    echo "Waiting for qBittorrent config file..."
    sleep 1
    ((timeout--))
done

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Config file not found, skipping interface configuration"
    exit 0
fi

# Check if Advanced section exists, if not create it
if ! grep -q "^\[Advanced\]" "$CONFIG_FILE"; then
    echo "" >> "$CONFIG_FILE"
    echo "[Advanced]" >> "$CONFIG_FILE"
fi

# Add interface settings if not present
if ! grep -q "Session\\\\Interface=" "$CONFIG_FILE"; then
    sed -i '/^\[Advanced\]/a Session\\Interface=tun0' "$CONFIG_FILE"
    sed -i '/^\[Advanced\]/a Session\\InterfaceName=tun0' "$CONFIG_FILE"
    echo "Added tun0 interface binding to qBittorrent config"
else
    echo "Interface already configured in qBittorrent config"
fi
