#!/bin/sh
# スリープを止めるかどうかを1分おきに決める（root の LaunchDaemon com.nankan.acsleep が呼ぶ）。
#
# pmset の disablesleep は電源別に持てず**システム全体**に効くので、状態を見てこちらで切り替える。
#
# 判断：
#   電源につながっている            → 寝かせない
#   バッテリーで残量が BATT_MIN%（既定70）超 → 寝かせない（フタを閉じて持ち歩いても取得が続く）
#   バッテリーで残量が BATT_MIN% 以下 → 元に戻す（2026-10-27 に 40→70。電池の減りが大きかったため）
#
# 以前は「電源につながっているときだけ」にしていたが、**つなぎ忘れた週末に62時間止まった**
# （2026-09-25 19:37〜09-28 10:06）。締切前オッズと予想の記録はその時刻を過ぎたら取り返せないので、
# 電池がある間は動かすほうが得になる。残量の下限は BATT_MIN で変えられる。
#
# 2026-11-24：残量が BATT_MIN 以下になっても**寝ないまま 1% まで使い切っていた**（11/20・11/23。2回とも公開が30時間前後止まった）。
# Safari のページがスピーカーを掴んだまま（coreaudiod の PreventUserIdleSystemSleep が24時間近く続く）で、
# フタを開けて置いてあると「操作なしで寝る」が働かない。そこで、電池・BATT_MIN 以下・IDLE_MIN 分（既定15）操作なし・
# 画面を点けておく要求（動画の再生など）も無い、がそろったらこちらから寝かせる。
BATT_MIN=${BATT_MIN:-70}
IDLE_MIN=${IDLE_MIN:-15}

ps_line=$(pmset -g ps | head -2 | tr '\n' ' ')
case "$ps_line" in
  *"AC Power"*) want=1; batt=0 ;;
  *)
    batt=1
    pct=$(printf '%s' "$ps_line" | sed -n 's/.*[^0-9]\([0-9][0-9]*\)%.*/\1/p')
    [ -n "$pct" ] || pct=0
    if [ "$pct" -gt "$BATT_MIN" ]; then want=1; else want=0; fi
    ;;
esac

now=$(pmset -g | awk '/SleepDisabled/{print $2}')
[ "$now" = "$want" ] || pmset -a disablesleep "$want"

if [ "$batt" = 1 ] && [ "$want" = 0 ]; then
  idle=$(ioreg -c IOHIDSystem | awk '/HIDIdleTime/{print int($NF/1000000000); exit}')
  disp=$(pmset -g assertions | awk '$1=="PreventUserIdleDisplaySleep"{print $2; exit}')
  if [ "${idle:-0}" -ge $((IDLE_MIN * 60)) ] && [ "${disp:-1}" = 0 ]; then pmset sleepnow >/dev/null 2>&1; fi
fi
