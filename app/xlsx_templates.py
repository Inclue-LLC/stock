"""ダウンロード用の Excel テンプレート（商品マスタ / 在庫取込）。"""

from openpyxl import Workbook
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.datavalidation import DataValidation

FONT = "Meiryo UI"
HEADER_FILL = PatternFill("solid", fgColor="1F4E9E")
REQUIRED_FILL = PatternFill("solid", fgColor="C0392B")
AUTO_FILL = PatternFill("solid", fgColor="7F8C8D")
ERROR_FILL = PatternFill("solid", fgColor="F8D7DA")
THIN = Side(style="thin", color="D0D5DD")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
UNITS = ["個", "本", "枚", "箱", "袋", "セット", "ケース", "kg", "g", "L", "ml"]


def _header(ws, columns, fills):
    for col, ((title, width), fill) in enumerate(zip(columns, fills), start=1):
        c = ws.cell(row=1, column=col, value=title)
        c.font = Font(name=FONT, bold=True, color="FFFFFF", size=11)
        c.fill = fill
        c.alignment = Alignment(horizontal="center", vertical="center")
        c.border = BORDER
        ws.column_dimensions[c.column_letter].width = width
    ws.row_dimensions[1].height = 26
    ws.freeze_panes = "A2"


def _jan_check_formula(cell: str, rng: str) -> str:
    """JAN（8/13桁）の桁数・チェックデジット・重複を判定する数式。"""
    c = cell
    cd13 = (f"MOD(10-MOD(SUMPRODUCT(MID({c},{{1,3,5,7,9,11}},1)*1)"
            f"+3*SUMPRODUCT(MID({c},{{2,4,6,8,10,12}},1)*1),10),10)")
    cd8 = (f"MOD(10-MOD(3*SUMPRODUCT(MID({c},{{1,3,5,7}},1)*1)"
           f"+SUMPRODUCT(MID({c},{{2,4,6}},1)*1),10),10)")
    # COUNTIF は "4901..." を数値扱いして文字列セルと一致しないため、SUMPRODUCT で文字列比較する
    return (
        f'=IF({c}="","",IF(SUMPRODUCT(--({rng}={c}))>1,"JAN重複",'
        f'IFERROR(IF(LEN({c})=13,IF({cd13}=RIGHT({c},1)*1,"OK","チェックデジット誤り"),'
        f'IF(LEN({c})=8,IF({cd8}=RIGHT({c},1)*1,"OK","チェックデジット誤り"),"桁数エラー")),"数字以外を含む")))'
    )


def product_master_workbook(rows: int = 3000) -> Workbook:
    wb = Workbook()
    ws = wb.active
    ws.title = "商品マスタ"
    columns = [("JANコード", 18), ("商品名", 40), ("品番", 16), ("単位", 9), ("備考", 36), ("JANチェック（自動）", 20)]
    _header(ws, columns, [REQUIRED_FILL, REQUIRED_FILL, HEADER_FILL, HEADER_FILL, HEADER_FILL, AUTO_FILL])
    last = rows + 1

    body = Font(name=FONT, size=11)
    for r in range(2, last + 1):
        for col in range(1, 7):
            c = ws.cell(row=r, column=col)
            c.font = body
            c.border = BORDER
        ws.cell(row=r, column=1).number_format = "@"  # JAN を文字列で保持（指数表記・先頭0落ち防止）
        ws.cell(row=r, column=3).number_format = "@"
        chk = ws.cell(row=r, column=6, value=_jan_check_formula(f"A{r}", f"$A$2:$A${last}"))
        chk.font = Font(name=FONT, size=10, color="595959")
        chk.alignment = Alignment(horizontal="center")

    ws.auto_filter.ref = f"A1:F{last}"

    jan_dv = DataValidation(type="custom", formula1="OR(LEN(A2)=8,LEN(A2)=13)", allow_blank=True,
                            errorStyle="warning", showErrorMessage=True,
                            errorTitle="JANコード", error="JANコードは8桁または13桁の数字で入力してください。",
                            promptTitle="JANコード", prompt="8桁または13桁。先頭の0もそのまま入力できます。",
                            showInputMessage=True)
    jan_dv.add(f"A2:A{last}")
    unit_dv = DataValidation(type="list", formula1='"' + ",".join(UNITS) + '"', allow_blank=True,
                             errorStyle="information", showErrorMessage=False)
    unit_dv.add(f"D2:D{last}")
    ws.add_data_validation(jan_dv)
    ws.add_data_validation(unit_dv)

    # JAN の重複・誤りを赤く表示
    ws.conditional_formatting.add(
        f"A2:A{last}", FormulaRule(formula=[f'AND(A2<>"",F2<>"OK")'], fill=ERROR_FILL))
    ws.conditional_formatting.add(
        f"F2:F{last}", FormulaRule(formula=['AND(F2<>"",F2<>"OK")'], fill=ERROR_FILL,
                                   font=Font(name=FONT, color="C0392B", bold=True)))

    _product_guide(wb.create_sheet("記入方法"))
    return wb


def _product_guide(ws):
    ws.sheet_view.showGridLines = False
    ws.column_dimensions["A"].width = 3
    ws.column_dimensions["B"].width = 20
    ws.column_dimensions["C"].width = 10
    ws.column_dimensions["D"].width = 22
    ws.column_dimensions["E"].width = 64
    ws["B2"] = "商品マスタの記入方法"
    ws["B2"].font = Font(name=FONT, size=16, bold=True)
    notes = [
        "「商品マスタ」シートの2行目から、1行に1商品ずつ入力してください。",
        "赤い見出しの列（JANコード・商品名）は必須です。青い見出しの列は任意です。",
        "灰色の「JANチェック（自動）」列は自動で判定します。「OK」以外が出た行は JAN を見直してください。",
        "JAN の重複・桁数・チェックデジットに問題がある行は、JAN のセルが赤くなります。",
        "入力後、在庫管理システムの「商品マスタ」→「Excel / CSV で一括登録」からこのファイルを取り込みます。",
        "すでに登録済みの JAN は、入力した項目で上書きされます（空欄の項目は変更されません）。",
    ]
    for i, text in enumerate(notes, start=4):
        ws.cell(row=i, column=2, value=f"・{text}").font = Font(name=FONT, size=11)

    top = 4 + len(notes) + 1
    headers = ["項目", "必須", "記入例", "説明"]
    for col, h in enumerate(headers, start=2):
        c = ws.cell(row=top, column=col, value=h)
        c.font = Font(name=FONT, bold=True, color="FFFFFF")
        c.fill = HEADER_FILL
        c.border = BORDER
    items = [
        ("JANコード", "必須", "4901234567894", "8桁または13桁の数字。セルは文字列形式なので、先頭の0や13桁もそのまま入力できます。"),
        ("商品名", "必須", "保湿クリーム 50g", "画面や帳票に表示される名前。"),
        ("品番", "", "SK-001", "社内の品番・型番など。JAN の代わりに品番で取込・入力することもできます。"),
        ("単位", "", "個", "リストから選択（個・本・箱・セット など）。リストにない単位も入力できます。空欄なら「個」。"),
        ("備考", "", "春限定パッケージ", "自由記入。"),
    ]
    for r, row in enumerate(items, start=top + 1):
        for col, v in enumerate(row, start=2):
            c = ws.cell(row=r, column=col, value=v)
            c.font = Font(name=FONT, size=11, color="C0392B" if v == "必須" else "000000")
            c.border = BORDER
            c.alignment = Alignment(vertical="center", wrap_text=True)
            if col == 4:
                c.number_format = "@"
        ws.row_dimensions[r].height = 34


def stock_import_workbook(rows: int = 1000) -> Workbook:
    wb = Workbook()
    ws = wb.active
    ws.title = "在庫取込"
    columns = [("JANコード", 18), ("商品名", 36), ("数量", 10), ("拠点", 20), ("備考", 40)]
    _header(ws, columns, [REQUIRED_FILL, HEADER_FILL, REQUIRED_FILL, HEADER_FILL, HEADER_FILL])
    body = Font(name=FONT, size=11)
    for r in range(2, rows + 2):
        for col in range(1, 6):
            c = ws.cell(row=r, column=col)
            c.font = body
            c.border = BORDER
        ws.cell(row=r, column=1).number_format = "@"
        ws.cell(row=r, column=3).number_format = "#,##0"
    return wb
