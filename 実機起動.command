#!/bin/zsh
# ShosaEdit with direct arm control (no TouchDesigner). DISCONNECT the arms in TD first.
cd -- "${0:A:h}"
if [[ ! -x .venv/bin/python ]]; then
  echo '.venv がありません。次を実行してください： python3 -m venv .venv && .venv/bin/pip install dynamixel-sdk pyserial'
  read -k1
  exit 1
fi
.venv/bin/python launch.py --hardware
