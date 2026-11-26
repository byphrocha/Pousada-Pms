#!/usr/bin/env bash
# Gera os ícones do app (build/icons) a partir de assets/icone*.svg. Requer rsvg-convert.
set -euo pipefail
cd "$(dirname "$0")/.."
rsvg-convert -w 180 -h 180 assets/icone.svg -o build/icons/apple-touch-icon.png
rsvg-convert -w 192 -h 192 assets/icone.svg -o build/icons/icon-192.png
rsvg-convert -w 512 -h 512 assets/icone.svg -o build/icons/icon-512.png
rsvg-convert -w 512 -h 512 assets/icone-maskable.svg -o build/icons/icon-maskable-512.png
echo "ícones gerados em build/icons"
