# 実測電流の取り込み

ShosaEdit はモーターのシリアルポートを開きません。既存の TD 監視処理が読み取った Present Current を、共有フォルダの JSON に書き出して取り込みます。監視処理と並行する別のモーター読み出しは追加しません。

## 接続時の設定

1. 既存監視処理のキャッシュから `export_current_snapshot.py` の `cached_channel` を作り、`publish_snapshot` で共有ファイルへ保存します。**このヘルパーを TD の実際のキャッシュへ接続する部分は、接続環境のキャッシュ構造に合わせて組み込みが必要です。** 未接続状態では実測検証を行えません。
2. `captured_at_ms` は計測が成功した時刻（Unix epoch ミリ秒）です。古いキャッシュを再保存するだけでこの時刻を更新してはいけません。キャッシュが monotonic 秒の場合は、取得側で epoch に変換します。
3. `current_a`（実測 A）または `current_raw`（符号付き int16 / unsigned register word）と型番で確認した `current_unit_ma` を渡します。Goal Current・Present Load・PWM は渡しません。
4. ShosaEdit で、その共有 JSON の絶対パスを指定します。例：`/Volumes/B2J_rehersal/telemetry/current.json`。
5. 元計測時刻から 2 秒を超えたチャンネルは stale とされます。時刻が未来の場合も時計ずれとして fresh になりません。PC 間の時計を同期してください。

## JSON 契約

```json
{
  "version": 1,
  "timestampMs": 1794540000000,
  "channels": [
    {"side":"R", "id":1, "currentA":0.35,
     "timestampMs":1794540000000, "temperatureC":32, "voltageV":12.0,
     "torqueEnabled":true}
  ]
}
```

`id` は実機 ID（右 1–9、左 11–18）。各チャンネルの `timestampMs` は省略時だけトップレベルの時刻を使用します。温度・電圧・torqueEnabled は任意です。値が読めなかったモーターを 0 として補完しないでください。

GET `/api/telemetry/status` はスナップショットと各チャンネルの `fresh` / `ageMs` を返します。POST `/api/telemetry/configure` に `{"path":"絶対パス"}` を送ると保存されます。空文字で切断します。API は同一オリジンのローカル UI 専用です。

ファイル読込は別スレッド・タイムアウト付きプロセスで行うため、切断した共有フォルダが UI リクエストを止めません。
