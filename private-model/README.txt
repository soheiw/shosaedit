Optional detailed CAD assets / 任意の詳細CADデータ

The public app works without these files, using the simplified model.
To enable detailed CAD display, obtain the authorized files separately and place:
  private-model/model.json
  private-model/model.bin
For the actual left arm (otherwise a mirrored-right fallback is shown):
  private-model/left-model.json
  private-model/left-model.bin
Optional material recalculation data:
  private-model/mass-shapes.json

Use the GUI Model selector to switch between Simplified and Detailed CAD.
After adding or replacing files, press Reload model.
All files in this directory except this README are ignored by Git.
Never force-add private assets to Git.

このフォルダに詳細CADの model.json と model.bin を別途配置してください。
実際の左腕形状には left-model.json と left-model.bin も配置します。
左腕ファイルがない場合は、右腕の鏡像による代用を明示します。
必要なら材料再計算用の mass-shapes.json も配置できます。
配置・交換後はGUIの「モデルを再読み込み」を押してください。
このREADME以外はGit管理対象外です。詳細CADの配布は別経路で行ってください。
