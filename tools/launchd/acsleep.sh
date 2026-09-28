#!/bin/sh
# スリープを止めるかどうかを1分おきに決める（root の LaunchDaemon com.nankan.acsleep が呼ぶ）。
#
# pmset の disablesleep は電源別に持てず**システム全体**に効くので、状態を見てこちらで切り替える。
#
# 判断：
#   電源につながっている            → 寝かせない
#   バッテリーで残量が CO_MIN% 超   → 寝かせない（フタを閉じて持ち歩いても取得が続く）
#   バッテリーで残量が CO_MIN% 以下 → 元に戻す（使い切って落ちるほうが被害が大きい）
#
# 以前は「電源につながっているときだけ」にしていたが、**つなぎ忘れた週末に62時間止まった**
# （2026-09-25 19:37〜09-28 10:06）。締切前オッズと予想の記録はその時刻を過ぎたら取り返せないので、
# 電池がある間は動かすほうが得になる。残量の下限は BATT_MIN で変えられる。
BATT_MIN=${BATT_MIN:-40}

ps_line=$(pmset -g ps | head -2 | tr '\n' ' ')
case "$ps_line" in
  *"AC Power"*) want=1 ;;
  *)
    pct=$(printf '%s' "$ps_line" | sed -n 's/.*[^0-9]\([0-9][0-9]*\)%.*/\1/p')
    [ -n "$pct" ] || pct=0
    if [ "$pct" -gt "$BATT_MIN" ]; then want=1; else want=0; fi
    ;;
esac

now=$(pmset -g | awk '/SleepDisabled/{print $2}')
[ "$now" = "$want" ] || pmset -a disablesleep "$want"
