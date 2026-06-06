# 电费结算单 提取与比对工具

把「电费结算单」（PDF / PNG / JPG）里的 **编号、购电月份、电价** 提取出来，
和一张 Excel 基准表做精确比对。封装为通用工具类
[`BillSettlementTool`](./bill_settlement_tool.py)。

## 两个核心方法（+ 工具类封装）

### 方法 1：`filter_bill_files(root_dir)`
- 递归扫描目录，过滤出所有**电费结算单**文件；
- **结算单不能是电量结算单**：判定规则为「文件名含『结算单』且不含『电量』」，
  因此 `电量结算单`、`核算单 / 分布式光伏发电补贴核算单` 等都会被排除；
- 去掉**内容完全相同**（SHA-256 字节级）的重复文件。

### 方法 2：`extract_records(files)` / `extract_file(path)`
- `extract_file(path)`：**单文件提取**的可复用最小单元，返回该文件的记录列表
  （多页 PDF 则多条）；
- `extract_records(files)`：批量提取，内部对每个文件复用 `extract_file`。

从文件中逐页 OCR 提取三项：

| 数据项 | 来源 | 规则 |
|--------|------|------|
| 编号 | 表头「电厂（交易对象）编号」 | 定位表头，取其正下方最近的 14~18 位数字 |
| 购电月份 | 「购电月份」字段 | 解析 `20xx年xx月` → `(年, 月)` |
| 电价 | 「电价」列 | 该列常有多行，**取最后一行（结算小计）的原始值**；一行都没有 → `0` |

> 一个文件可能含多条记录：例如华尔特的一份 PDF 有 13 页 = 13 个编号，
> 每页各产出一条记录。

### 比对：`match_with_excel(records, xlsx)`
- Excel 中**备注为「新丰」的行不参与**（去掉新丰，剩余 **76 条**）；
- **编号、购电月份、电价 三项完全相等**才算命中（是相等，不是约等于）；
- 提取数据**可以多，但不能少**：76 条全部命中才算 `成功`。

`run(root_dir, xlsx)` 一步完成「方法1 → 方法2 → 比对」。

## 安装

```bash
pip install -r requirements.txt
```

> OCR 采用 **RapidOCR**（PP-OCR 模型随 pip 包分发，**无需联网下载模型**）。
> 若环境可联网下载模型，也可注入 PaddleOCR：`BillSettlementTool(ocr_engine=...)`。

## 使用

命令行：

```bash
python bill_settlement_tool.py <文件根目录> <对比用Excel.xlsx> [sheet名]
```

代码：

```python
from bill_settlement_tool import BillSettlementTool

tool = BillSettlementTool(dpi=300)

# 方法 1
files = tool.filter_bill_files("/path/to/电费结算单")

# 方法 2
records = tool.extract_records(files)

# 比对
result = tool.match_with_excel(records, "/path/to/对比.xlsx")
print(result.summary())          # 匹配结果：76/76 -> 成功 ✅
assert result.success
```

## 在本数据集上的实测结果

```
[方法1] 过滤+去重后电费结算单文件: 38 个
[方法2] 共提取记录: 98 条        # 76 条在范围内 + 22 条 2025年11/12月（多余，允许）
匹配结果：76/76 -> 成功 ✅
```

- 19 个不同编号 × 4 个月（2026-01 ~ 2026-04）= 76；
- 华尔特 13 编号、沙井智荟 1、特旺 1、首熙 1、完美印刷 1、鑫海盈 2。

## Excel 列约定

`序号 | 电厂（交易对象）编号 | 购电月份 | 电价 | 备注`

- 「购电月份」支持 Excel 日期序列号（如 `46023` = 2026-01）或日期 / 文本；
- 「备注」用于标记公司，含「新丰」的行会被剔除。
