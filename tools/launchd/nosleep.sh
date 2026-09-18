#!/bin/sh
# フタを閉じても自動取得を止めないための電源設定。**sudo で1回だけ**実行する。
#   有効化: sudo sh tools/launchd/nosleep.sh on
#   解除  : sudo sh tools/launchd/nosleep.sh off
#
# なぜ要るか：launchd の StartInterval はスリープ中は動かない。MacBook はフタを閉じると
# 電源設定に関係なく clamshell sleep に入り、以後は DarkWake（メンテナンス用の短い目覚め）だけになる。
# caffeinate はアイドルスリープしか止められないので、フタ閉じには効かない。
# 唯一の手当てが pmset disablesleep で、これには root が要る。
#
# 安全のため **電源接続中（-c）だけ**に効かせる。バッテリー運用のときは今までどおり寝る
# （つないでいないのに寝かせないと、電池切れで落ちて取りこぼしが増えるため）。
# 閉じたまま動かすので、カバンの中など放熱できない場所には入れないこと。
set -e
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DAEMON=/Library/LaunchDaemons/com.nankan.acsleep.plist
[ "$(id -u)" = 0 ] || { echo "sudo で実行してください: sudo sh tools/launchd/nosleep.sh ${1:-on}"; exit 1; }
case "${1:-on}" in
  on)
    # disablesleep は電源別に持てず**システム全体**に効く（macOS 側の仕様）。
    # そのままだとバッテリー運用でも寝なくなって電池を使い切るので、
    # 電源の状態を1分おきに見て切り替える LaunchDaemon を入れる。
    sed "s#__REPO__#$REPO#g" "$REPO/tools/launchd/com.nankan.acsleep.plist" > "$DAEMON"
    chown root:wheel "$DAEMON"; chmod 644 "$DAEMON"
    launchctl bootout system/com.nankan.acsleep 2>/dev/null || true
    launchctl bootstrap system "$DAEMON"
    sh "$REPO/tools/launchd/acsleep.sh"        # いますぐ1回反映
    pmset -c sleep 0
    pmset -c disksleep 0
    pmset -c displaysleep 5          # 画面だけは消す（本体は起きたまま）
    pmset -c powernap 1
    # 電源につないだまま前の晩から寝てしまっている場合に備えて、毎朝8:45に起こす。
    # 起きたあとは上の disablesleep が効くので、つないだままなら1日中起きている。
    pmset repeat wakeorpoweron MTWRFSU 08:45:00
    echo "電源接続中はスリープしない設定にしました（フタを閉じても取得は続きます）"
    echo "バッテリーに切り替わったら自動で元に戻ります（電池切れ防止）"
    echo "毎朝 8:45 に自動で起きる予約も入れました（バッテリー運用で寝てしまった日の保険）"
    ;;
  off)
    launchctl bootout system/com.nankan.acsleep 2>/dev/null || true
    rm -f "$DAEMON"
    pmset -a disablesleep 0
    pmset -c sleep 10
    pmset -c disksleep 10
    pmset repeat cancel
    echo "元に戻しました（電源接続中も10分でスリープ・朝の自動起動も解除・常駐も削除）"
    ;;
  *) echo "使い方: sudo sh tools/launchd/nosleep.sh [on|off]"; exit 1 ;;
esac
pmset -g custom | sed -n '/AC Power/,$p'
