#!/bin/sh
# 締切前のオッズ取得と、その反映を launchd に登録する。リポジトリ直下から実行すること。
#   com.nankan.oddswatch … 1分おきに南関のオッズの取り時を見る
#   com.nankan.refresh   … 2分おきに、オッズが変わっていれば各ページへ反映する
#   com.boat.live        … 1分おきにボートの直前情報と締切前オッズを拾う
#   com.boat.refresh     … 3分おきに、変化があればボートの予測を作り直して boat.html に反映・push
#   com.nankan.results   … 21:20 / 23:00 / 06:30 に南関のその日の結果・払戻・最終オッズを取り込み、日別の成績を更新・push
#   com.jra.refresh      … 20分おきに JRA の出馬表を取り直して予想を jra.html / TOP に反映・push。夜に結果と指数、月曜にモデル
#   com.banei.refresh    … 15分おきにばんえいの出馬表を取り直して予想を banei.html / TOP に反映・push。夜に結果と指数、月曜にモデル
#   com.nankan.publish   … 15分おきに、溜まったコミットをまとめて push（Render のデプロイ回数を抑える。各 refresh は commit だけ）
# 引数に Label を並べると、そのぶんだけ登録し直す（例: sh tools/launchd/install.sh com.boat.live）
set -e
REPO=$(cd "$(dirname "$0")/../.." && pwd)
NODE=$(command -v node)
mkdir -p "$HOME/Library/LaunchAgents"
LABELS=${*:-"com.nankan.oddswatch com.nankan.refresh com.boat.live com.boat.refresh com.nankan.results com.jra.refresh com.banei.refresh com.nankan.publish"}
for LABEL in $LABELS; do
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  sed -e "s|__REPO__|$REPO|g" -e "s|__NODE__|$NODE|g" "$REPO/tools/launchd/$LABEL.plist" > "$PLIST"
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "登録: $PLIST"
done
echo "  リポジトリ : $REPO"
echo "  node       : $NODE"
echo "  ログ       : $REPO/data/nankan/oddswatch.log ／ refresh.log ／ $REPO/data/boat/live.log"
echo "止めるとき : launchctl unload ~/Library/LaunchAgents/<Label>.plist"
