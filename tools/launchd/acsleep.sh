#!/bin/sh
# 電源につながっている間だけスリープを止める（root の LaunchDaemon com.nankan.acsleep が1分おきに呼ぶ）。
# pmset の disablesleep は電源別に持てず**システム全体**に効くので、電源の状態を見てこちらで切り替える。
# つないでいないのに寝かせないと、電池を使い切って落ちる＝取りこぼしが増えるため。
if pmset -g ps | head -1 | grep -q "AC Power"; then
  pmset -a disablesleep 1
else
  pmset -a disablesleep 0
fi
