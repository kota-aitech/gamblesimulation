# odds-cloud ブランチ

締切前オッズの記録だけを置く枝。**GitHub Actions（.github/workflows/odds.yml）が書き、Mac は読むだけ。**

- main に置かないのは、push のたびに GitHub Pages がビルドされて「1時間に10回」の制限に当たるため
- 1レース1行の追記のみ。`data/odds_cloud/<競技>/<日付>.jsonl`
- Mac 側の `tools/merge_cloud_odds.mjs` がここから取り込んで、既存の `odds_live.jsonl` に混ぜる
