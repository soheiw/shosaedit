ShosaEdit — ロボットアームの動作編集・比較ツール

詳しい使い方と画面例は README.md を参照してください。
English documentation: README.en.md
GitHub: https://github.com/soheiw/shosaedit#readme

起動方法
・macOS: 起動.command をダブルクリック
・ターミナル: python3 launch.py
・通常のURL: http://127.0.0.1:8765/
  別のポートで起動した場合はターミナルの表示を確認してください。

名前を付けて保存した動きはブラウザ内に保持し、Motion JSONも保存します。
サイトデータの消去や別ブラウザへの移動に備え、JSONも保管してください。
実機への接続は行いません。実機の可動域・校正・衝突は未検証です。

CADなしで簡易表示できます。モデル選択から簡易／詳細CADを切り替えます。
詳細CADは別途入手し private-model/ に model.json と model.bin を置いてください。
配置後は「モデルを再読み込み」。これらのデータはGit管理しません。
