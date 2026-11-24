/*
 * 数据层回归测试（无依赖）：node tests/roundtrip.test.js
 *
 * 覆盖：rules.json 往返一致、取值智能转类型的边界、条件树归一化、四项校验。
 */
"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

global.window = global;
global.crypto = global.crypto || crypto.webcrypto;
require(path.join(__dirname, "..", "assets", "rule-editor.js"));
var RE = global.RuleEditor;

var failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ok   " + name);
  else {
    failures++;
    console.log("  FAIL " + name + (extra ? "\n         " + extra : ""));
  }
}
function eq(a, b) { return JSON.stringify(sortish(a)) === JSON.stringify(sortish(b)); }
function sortish(v) {
  if (Array.isArray(v)) return v.map(sortish);
  if (v && typeof v === "object") {
    var out = {};
    Object.keys(v).sort().forEach(function (k) { out[k] = sortish(v[k]); });
    return out;
  }
  return v;
}

/* 1. 示例文件：导入 → 导出，检查归一化结果与字段契约 */
var samplePath = path.join(__dirname, "..", "examples", "rules.example.json");
var original = JSON.parse(fs.readFileSync(samplePath, "utf-8"));
var roundTrip = RE.serializeTree(RE.loadTree(original));
check("export keeps " + original.length + " rules", roundTrip.length === original.length);
check("exported key order matches project schema",
  Object.keys(roundTrip[0]).join(",") === "rule_id,rule_type,rule_conditions,rule_prompt,grading,uncertainty,source_reference",
  Object.keys(roundTrip[0]).join(","));
check("redundant nested $and is merged on export",
  eq(roundTrip[2].rule_conditions, {
    $and: [
      { field: "first_screen_result", operator: "=", value: "abnormal" },
      { field: "interval_weeks", operator: "<=", value: 12 },
      { field: "interval_weeks", operator: ">", value: 0 }
    ]
  }), JSON.stringify(roundTrip[2].rule_conditions));
check("bare atom condition stays an atom",
  eq(roundTrip[1].rule_conditions, { field: "prior_diagnosis", operator: "!=", value: "none" }));
check("uncertainty is null when level is none", roundTrip[1].uncertainty === null);
check("validate passes on the shipped sample", RE.validateTree(RE.loadTree(original)).length === 0);
check("load → export → load → export is idempotent", eq(RE.serializeTree(RE.loadTree(roundTrip)), roundTrip));

/* 2. 取值转类型边界：数字串转数字，但 inf/nan/十六进制/超长整数保持字符串（否则写出非法 JSON 或丢精度） */
var valueCases = [
  ["18", 18], ["-3", -3], ["0.7", 0.7], ["1e3", 1000], [" 42 ", 42],
  ["1型", "1型"], ["yes", "yes"], ["", ""], ["inf", "inf"], ["Infinity", "Infinity"],
  ["nan", "nan"], ["0x10", "0x10"], ["9007199254740993", "9007199254740993"], ["12abc", "12abc"]
];
valueCases.forEach(function (c) {
  var got = RE.parseValue(c[0]);
  check('parseValue("' + c[0] + '") = ' + JSON.stringify(got), got === c[1], "got " + JSON.stringify(got) + " typeof " + typeof got);
});

/* 3. 归一化：删空框 / 单子取消嵌套 / 同逻辑合并 / 异逻辑保留嵌套 */
function norm(children) { return RE.normalizeConditions({ kind: "logic", logic: "and", children: children }); }
var bar = { kind: "bar", field: "a", operator: "=", value: "1" };
var barOut = { field: "a", operator: "=", value: 1 };
var barB = { kind: "bar", field: "b", operator: "=", value: "2" };
var barBOut = { field: "b", operator: "=", value: 2 };
check("empty logic box alone yields nothing", norm([{ kind: "logic", logic: "or", children: [] }]) === null);
check("empty logic box is dropped among siblings", eq(norm([{ kind: "logic", logic: "or", children: [] }, bar]), barOut));
check("single-child box unwraps", eq(norm([{ kind: "logic", logic: "or", children: [bar] }]), barOut));
check("same-logic children merge", eq(norm([{ kind: "logic", logic: "and", children: [bar] }, barB]), { $and: [barOut, barBOut] }));
check("different-logic child stays nested",
  eq(norm([{ kind: "logic", logic: "or", children: [bar, barB] }, { kind: "bar", field: "c", operator: "=", value: "3" }]),
    { $and: [{ $or: [barOut, barBOut] }, { field: "c", operator: "=", value: 3 }] }));

/* 4. 四项校验 */
function ruleTree(rule, type) {
  return [{ uid: "t", type: type || "screening", open: true, rules: [rule] }];
}
function barNode(field, op, value) { return { uid: "b1", kind: "bar", field: field, operator: op, value: value }; }
function boxNode(children) { return { uid: "b0", kind: "logic", logic: "and", children: children, open: true }; }

function kinds(tree) { return RE.validateTree(tree).map(function (e) { return e.kind; }); }
check("detects empty id", kinds(ruleTree({ uid: "r", id: "  ", conditions: boxNode([barNode("a", "=", "1")]), uncertainty: {}, grading: {} })).indexOf("empty_id") >= 0);
check("detects no conditions", kinds(ruleTree({ uid: "r", id: "rule-1", conditions: boxNode([]), uncertainty: {}, grading: {} })).indexOf("no_conditions") >= 0);
check("detects incomplete bar", kinds(ruleTree({ uid: "r", id: "rule-1", conditions: boxNode([barNode("a", "=", "")]), uncertainty: {}, grading: {} })).indexOf("incomplete_condition") >= 0);
var dupTree = [
  { uid: "t1", type: "screening", open: true, rules: [{ uid: "r1", id: "rule-1", conditions: boxNode([barNode("a", "=", "1")]), uncertainty: {}, grading: {} }] },
  { uid: "t2", type: "treatment", open: true, rules: [{ uid: "r2", id: "rule-1", conditions: boxNode([barNode("a", "=", "1")]), uncertainty: {}, grading: {} }] }
];
check("detects duplicate id across types", kinds(dupTree).indexOf("duplicate_id") >= 0);
check("clean tree has no errors", RE.validateTree(ruleTree({ uid: "r", id: "rule-1", conditions: boxNode([barNode("a", "=", "1")]), uncertainty: {}, grading: {} })).length === 0);

/* 5. 载入容错：裸条件根、缺 uncertainty、只有 grading 的不确定性 */
var tolerant = RE.loadTree([
  { rule_id: "r-atom", rule_type: "screening", rule_conditions: { field: "a", operator: "=", value: 1 } },
  { rule_id: "r-grading", rule_type: "treatment", rule_conditions: {}, grading: { uncertainty_level: "high", uncertainty_reason: "缺证据", evidence_level: "low" } }
]);
check("bare atom root becomes a logic box", tolerant[0].rules[0].conditions.kind === "logic");
check("grading.uncertainty_level is honoured when uncertainty is absent", tolerant[1].rules[0].uncertainty.level === "high");
check("missing fields default to empty strings", tolerant[0].rules[0].prompt === "" && tolerant[0].rules[0].source === "");
var back = RE.serializeTree(tolerant);
check("bare atom round trips to an atom", eq(back[0].rule_conditions, { field: "a", operator: "=", value: 1 }));
check("grading-only uncertainty is re-emitted", eq(back[1].uncertainty, { level: "high", reason: "缺证据" }));

/* 6. 新规则 id 递增 */
var fresh = RE.createNewRule(tolerant);
check("new rule gets a unique-ish id", typeof fresh.id === "string" && fresh.id.length > 0);
var numbered = RE.loadTree([{ rule_id: "rule-7", rule_type: "screening", rule_conditions: {} }]);
check("next id follows rule-N pattern", RE.createNewRule(numbered).id === "rule-8", RE.createNewRule(numbered).id);

/* 7. 可选：node tests/roundtrip.test.js ../your/rules.json —— 校验自己的规则库
 *    期望「导入 → 导出」与原文件结构一致（说明原文件已是归一化后的形态），且校验全过。 */
var userPath = process.argv[2];
if (userPath) {
  var userRules = JSON.parse(fs.readFileSync(path.resolve(userPath), "utf-8"));
  var list = Array.isArray(userRules) ? userRules : userRules.rules;
  var back2 = RE.serializeTree(RE.loadTree(list));
  console.log("\n  检查 " + userPath + "（" + list.length + " 条规则）");
  check("user file round trips unchanged", eq(back2, list),
    JSON.stringify(back2.filter(function (r, i) { return !eq(r, list[i]); })).slice(0, 400));
  var userErrors = RE.validateTree(RE.loadTree(list));
  check("user file passes the four checks", userErrors.length === 0,
    userErrors.map(function (e) { return e.kind + ":" + e.rule_ids.join("/"); }).join(", "));
}

console.log(failures ? "\n" + failures + " 项失败" : "\n全部通过");
process.exit(failures ? 1 : 0);
