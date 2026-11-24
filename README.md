# 规则图形化编辑器（rule_editor_v7）

一个**纯前端**的 `rules.json` 图形化编辑器：导入规则库 → 用树状界面改条件与分级 → 校验通过后下载。
没有后端、没有登录、不上传任何文件，双击 `index.html` 就能用，也能直接部署到 GitHub Pages。

条件结构、字段命名、保存前校验与归一化规则与 EBM-Clinic 的 `workspace/rules.json` 保持一致，
因此这里导出的文件可以直接拿回项目的工作台继续使用。

## 用法

1. 打开页面（本地双击 `index.html`，或部署后的 Pages 地址）。
2. 起手三选一：
   - **📥 导入规则库**：选择本地的 `rules.json`（顶层是规则对象数组，也兼容 `{ "rules": [...] }`）；
   - **🧪 载入示例**：装一份 3 条规则、含嵌套逻辑框的示例；
   - **✨ 新建规则库** / **＋ 规则类型**：从空白开始。
3. 编辑：
   - 规则类型分组可改名、排序、删除；改名会阻止与已有类型重名。
   - 每条规则有 `rule_id`、指南建议、溯源、不确定性等级与说明、证据质量、推荐强度。
   - 条件树用**逻辑框**（AND / OR，可无限嵌套）和**条件条**（`field / operator / value`）表达；
     支持加条、加框、包一层、拆本层、上下移动、删除、折叠展开。
   - 条件条取值是文本框，旁边会实时显示下载时会转成的类型（`→ 18 (number)` / `→ "yes" (string)`）。
4. **💾 校验并下载规则库**（或 `Ctrl/⌘ + S`）：先跑校验，**不通过就不生成文件**并在页面顶部逐条列出原因。
   下载文件名可自填，非法字符会被替换，自动补 `.json`。
5. 底部「下载前预览」展开即可看到归一化之后的最终 JSON。

## 下载前的四项校验

任一不通过即阻止下载：

| 校验 | 说明 |
| --- | --- |
| `empty_id` | 规则 `rule_id` 为空 |
| `duplicate_id` | `rule_id` 重复（跨规则类型也会查） |
| `incomplete_condition` | 条件条的变量名 / 运算符 / 取值没填齐 |
| `no_conditions` | 规则一条条件都没有 |

## 下载时的归一化（自底向上）

1. 删掉空逻辑框；
2. 只有一个内容的逻辑框取消嵌套；
3. 与外层逻辑相同的逻辑框合并进外层；
4. 取值智能转类型：整数串 → number，小数/科学计数串 → number，其余保持字符串。

转类型刻意**不**吃 `inf` / `nan` / `Infinity` / `0x10` 这类写法，也**不**把超出双精度安全整数的数字串转成数字
——前者会写出非法 JSON，后者会丢精度。

## 输出文件的字段

```json
{
  "rule_id": "rule-001",
  "rule_type": "screening",
  "rule_conditions": { "$and": [ { "field": "age", "operator": ">=", "value": 18 } ] },
  "rule_prompt": "建议完成初筛问卷",
  "grading": {
    "evidence_level": "moderate",
    "recommendation_level": "conditional for",
    "uncertainty_level": "low",
    "uncertainty_reason": "依赖患者配合"
  },
  "uncertainty": { "level": "low", "reason": "依赖患者配合" },
  "source_reference": "指南 §2.1"
}
```

`uncertainty_level` 为 `none` 时 `uncertainty` 输出 `null`；导入时若只有 `grading.uncertainty_level`，也会读进不确定性等级。

## 部署到 GitHub Pages

仓库里放好本目录，然后在 GitHub 上：

**Settings → Pages → Build and deployment → Source: Deploy from a branch → 选分支与 `/ (root)`（或 `/rule_editor_v7`）**

等一分钟左右即可通过 `https://<用户名>.github.io/<仓库名>/` 访问。
本目录根的 `.nojekyll` 请放在**仓库根目录**（若把编辑器放在子目录部署，把它一并复制到仓库根），避免下划线开头的文件被 Jekyll 漏掉。

## 目录结构

```
index.html              页面骨架（工具栏 + 编辑器容器）
assets/rule-editor.js   数据层：载入 / 导出 / 归一化 / 校验（纯函数，无 DOM）
assets/app.js           UI 层：渲染树、按钮与输入映射、下载
assets/styles.css       样式（无框架、无外部字体）
examples/rules.example.json  可直接导入的示例规则库
tests/roundtrip.test.js 数据层回归测试
```

## 本地跑测试

```bash
node tests/roundtrip.test.js                       # 数据层回归（示例文件 + 边界用例）
node tests/roundtrip.test.js path/to/your/rules.json   # 顺带检查自己的规则库能否无损往返
```

覆盖：导入/导出往返与幂等、取值转类型边界（`inf` / 超长整数等）、归一化四条规则、四项校验、导入容错。
`examples/rules.example.json` 是合成的示例数据，不含任何真实患者或院内资料。

## 隐私

页面不发起任何网络请求（无 `fetch`、无外部 CDN、无统计脚本），文件只经由浏览器读取后在本地生成下载。
刷新或关闭页面时如果还有未下载的修改，浏览器会提示。

## 已知限制

- 修改只在当前页面里，关闭即丢失（这是刻意的：不做登录、不做云端历史）。要留存就下载文件。
- 条件树用按钮 + 上下移动编辑，不支持鼠标拖拽。
- 只处理单个 `rules.json`；变量词典、患者数据、检测报告不在本工具范围内。
