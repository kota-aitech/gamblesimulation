#!/bin/sh
# 取得・反映のジョブを「ログインしていなくても動く」LaunchDaemon に入れ直す。**sudo で1回だけ**実行する。
#   有効化: sudo sh tools/launchd/install_daemons.sh on
#   解除  : sudo sh tools/launchd/install_daemons.sh off   （元の LaunchAgent に戻す）
#
# なぜ要るか：install.sh で入れているのは LaunchAgent（~/Library/LaunchAgents）で、**ログインしている間しか動かない**。
# ログアウトや、ユーザーの切り替え・再起動後にログインしていない間は、オッズの見張りも結果の取り込みも止まる。
# LaunchDaemon（/Library/LaunchDaemons）はログインに関係なく動く。root ではなく本人のユーザー（UserName）で動かすので、
# 作るファイルの持ち主は今までどおり。
#
# **公開（com.nankan.publish）は LaunchAgent のまま**にする。GitHub の認証がログイン中の鍵束（キーチェーン）にあり、
# ログインしていないと push できないため。ログアウト中にたまった commit は、次にログインしたときにまとめて push される。
# 締切前オッズはこれとは別に GitHub Actions（クラウド）でも取っているので、Mac が完全に止まっても二度と取れないものは残る。
#
# スリープ中はどちらも動かない（macOS の仕様）。フタを閉じても動かすための nosleep.sh on も一緒に入れる。
set -e
REPO=$(cd "$(dirname "$0")/../.." && pwd)
[ "$(id -u)" = 0 ] || { echo "sudo で実行してください: sudo sh tools/launchd/install_daemons.sh ${1:-on}"; exit 1; }
USER_NAME=${SUDO_USER:?sudo から実行してください}
USER_ID=$(id -u "$USER_NAME")
HOMEDIR=$(eval echo "~$USER_NAME")
NODE=$(sudo -u "$USER_NAME" sh -lc 'command -v node')
LABELS="com.nankan.oddswatch com.nankan.refresh com.nankan.results com.boat.live com.boat.refresh com.jra.refresh com.banei.refresh com.keirin.refresh com.keirin.backfill"

case "${1:-on}" in
  on)
    for LABEL in $LABELS; do
      SRC="$REPO/tools/launchd/$LABEL.plist"
      [ -f "$SRC" ] || { echo "（$LABEL の plist が無いので飛ばす）"; continue; }
      DST="/Library/LaunchDaemons/$LABEL.plist"
      sed -e "s|__REPO__|$REPO|g" -e "s|__NODE__|$NODE|g" "$SRC" > "$DST"
      plutil -insert UserName -string "$USER_NAME" "$DST"
      plutil -insert GroupName -string staff "$DST"
      plutil -extract EnvironmentVariables xml1 -o /dev/null "$DST" 2>/dev/null || plutil -insert EnvironmentVariables -dictionary "$DST"
      plutil -replace EnvironmentVariables.HOME -string "$HOMEDIR" "$DST"
      plutil -replace EnvironmentVariables.USER -string "$USER_NAME" "$DST"
      chown root:wheel "$DST"; chmod 644 "$DST"
      # 同じジョブが2本動かないよう、LaunchAgent 版を外してから入れる
      launchctl bootout "gui/$USER_ID/$LABEL" 2>/dev/null || true
      rm -f "$HOMEDIR/Library/LaunchAgents/$LABEL.plist"
      launchctl bootout "system/$LABEL" 2>/dev/null || true
      launchctl bootstrap system "$DST"
      echo "常駐（ログイン不要）: $LABEL"
    done
    sh "$REPO/tools/launchd/nosleep.sh" on
    echo ""
    echo "取得・反映はログインしていなくても動きます（公開 com.nankan.publish はログイン中に動きます）。"
    echo "点検: node tools/health.mjs   解除: sudo sh tools/launchd/install_daemons.sh off"
    ;;
  off)
    for LABEL in $LABELS; do
      launchctl bootout "system/$LABEL" 2>/dev/null || true
      rm -f "/Library/LaunchDaemons/$LABEL.plist"
    done
    # 元の LaunchAgent に戻す（本人のユーザーで install.sh を回す）
    sudo -u "$USER_NAME" sh "$REPO/tools/launchd/install.sh" $LABELS
    echo "LaunchAgent（ログイン中だけ動く）に戻しました。スリープの設定は sudo sh tools/launchd/nosleep.sh off で戻せます。"
    ;;
  *) echo "使い方: sudo sh tools/launchd/install_daemons.sh [on|off]"; exit 1 ;;
esac
