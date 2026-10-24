# 二本のロボットアームの所作設計

自然に見える動き、美しい動き、感情が伝わる動きは、それぞれ別に評価する。まず肘の曲がる側、手のひら、手の長軸、途中の回旋を整え、その姿勢を保ちながら速さや間合いを変える。左右差や揺らぎを足すこと自体を、自然さの根拠にしない。

## 自然さと左右のまとまり

人の平面到達運動では、手先の加速度の変化を抑えるモデルが、釣鐘形の速度をよく説明する。ただし、これはすべての動きを時間平均で丸める理由にはならない。始めと終わりを滑らかにしつつ、途中の強調や停止を残す設計が出発点になる。[FlashとHoganの実験](https://newmanlab.mit.edu/wp-content/uploads/2017/09/1985-the-coordination-of-arm-movements-an-experimentally-confirmed-mathematical-model.pdf)

左右の手を同時に異なる目標へ動かす課題では、最大速度や到達の時刻が密に同期した。両腕に共通するリズムを保ち、小さな先行遅延や高さの違いを比較する。毎フレーム独立した乱数を加える方法は、この協調を崩しやすい。[Kelsoらの実験](https://doi.org/10.1126/science.424729)

## 間と抑揚を作る

「間」は停止や無音を含めて進行を捉える考え方。「序破急」は導入・展開・終結の構成にも関わる。ロボットでは、構える、動く、形を見せる、収めるという句に応用できる。速度を一方向に増やすだけの処理にはしない。[間](https://www2.ntj.jac.go.jp/dglib/contents/learn/edc29/shiru/shikumi/rhythm/ma/index.html)、[序破急](https://www2.ntj.jac.go.jp/dglib/contents/learn/edc22/naritachi/bugaku/column.html)

歌舞伎の見得は、形を止めて感情の高まりに注意を集める。能の実践で語られる「溜め」も、静止と次の動きの関係を考える手掛かりになる。ここから借りるのは時間配分の発想であり、二腕だけで能や日本舞踊を再現したとは扱わない。[見得](https://www2.ntj.jac.go.jp/unesco/kabuki/jp/production/performance5.html)、[能楽師への取材](https://openers.jp/lounge/lounge_features/CyqeGdqC)

## 感情は形と時間の組合せで試す

LabanのEffortは、空間への直接性、急ぐか持続するか、強さや軽さ、動きを拘束するか流すかを記述する語彙。開く・包む・上がる・退くといった形の変化も使える。ただし「速い＝喜び」のような普遍的対応にはしない。人の全身運動の研究と、腕だけのロボットで伝わる印象は区別する。[人の動きの評価](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2019.01389/full)、[ロボットアームの映像評価](https://arxiv.org/html/2505.11716v2)

## Motion Previewで比較する案

次の数値は、効果が保証された値ではなく、比較を始めるための提案。元の姿勢と総時間をそろえ、一度に一要素を変える。

| 要素 | 比較する初期値 | 主に見る点 |
|---|---|---|
| 抑揚 | 始終0.5倍、中盤1.2倍と一定速度 | 滑らかさと強調の両立 |
| 左右の先行 | 0、2、4フレーム | まとまりと硬さ |
| 形を見せる間 | 0.25、0.5、0.8秒保持 | 決まって見えるか、詰まって見えるか |
| 左右の振幅差 | 0、2、5% | 自然さと姿勢の整合 |

名前を隠して順番を変え、自然さ・美しさ・伝わる意図を別々に評価する。既存の速度曲線は抑揚を調整できるが、左右独立の遅延や空間的な姿勢変更には別の処理が必要になる。

推定トルクは機械負荷の比較値であり、表現上の「力強さ」ではない。静止して重力を支える姿勢も負荷は高くなり得る。PLAの仮重量に基づく値から、感情や実機の余裕を断定しない。

## 研究条件と適用範囲

| 資料 | 条件と今回への適用 |
|---|---|
| [FlashとHogan 1985](https://newmanlab.mit.edu/wp-content/uploads/2017/09/1985-the-coordination-of-arm-movements-an-experimentally-confirmed-mathematical-model.pdf) | 9人。主に水平面の肩と肘による到達運動。手先軌道の滑らかさの根拠。頭上の演技全般を検証した研究ではない。 |
| [Kelsoら 1979](https://doi.org/10.1126/science.424729) | 左右で距離や精度要求が異なる二手到達課題。同期の知見であり、演技では常に左右同時が最良という結論ではない。 |
| [Shafirら 2016](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2015.02030/full) | Laban経験者80人が動きを実行し、感じた感情を自己評価。観客によるロボットの評価とは異なる。 |
| [Shafirら 2019](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2019.01389/full) | 62人が専門家5人の全身運動映像を評価。運動要素と感情帰属の関連。二腕への転用は比較が必要。 |
| [Raghuら 2025](https://arxiv.org/html/2505.11716v2) | 単腕の6軌道をオンライン映像で評価。50人募集、1人除外。形や後退が印象に寄与し、同じEffort設定でも印象が変わる。 |
| [日本芸術文化振興会の間](https://www2.ntj.jac.go.jp/dglib/contents/learn/edc29/shiru/shikumi/rhythm/ma/index.html) | 伝統音楽の実践的説明。保持時間への応用は設計上の解釈。 |
| [同 序破急](https://www2.ntj.jac.go.jp/dglib/contents/learn/edc22/naritachi/bugaku/column.html) | 雅楽の構成概念の説明。特定の速度曲線を実験で推奨する資料ではない。 |
| [同 見得](https://www2.ntj.jac.go.jp/unesco/kabuki/jp/production/performance5.html) | 歌舞伎の演技術の説明。静止と強調の対比の参考。 |
| [能楽師 友枝昭世への取材](https://openers.jp/lounge/lounge_features/CyqeGdqC) | 抑制された静けさについての実践語りと筆者の解釈。定量的な運動実験とは区別する。 |
