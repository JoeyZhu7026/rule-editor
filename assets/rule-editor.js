/*
 * 规则库编辑器数据层（纯函数，无依赖）
 *
 * 逐条平移 EBM-Clinic/app/a_layer/rule_editor.py 的语义：
 *   loadTree / serializeTree / normalizeConditions / validateTree / parseValue
 *
 * 编辑器树结构：
 *   [ { type, open, rules: [ { uid, id, prompt, source, uncertainty, grading, conditions, open } ] } ]
 *
 * 条件节点两类：
 *   逻辑框 { uid, kind: "logic", logic: "and"|"or", children: [节点], open }
 *   条件条 { uid, kind: "bar", field, operator, value }   // value 恒为字符串，下载时智能转类型
 *
 * 与 Python 版的两处刻意思辨（见 parseValue 注释）：
 *   1. 不把 "inf" / "nan" / "0x10" 转成数字，避免写出非法 JSON；
 *   2. 超出双精度安全整数范围的数字串保持字符串，避免精度丢失。
 */
(function (global) {
  "use strict";

  var OPERATORS = ["=", "!=", "<", "<=", ">", ">="];
  var UNCERTAINTY_LEVELS = ["none", "low", "moderate", "high"];

  function uid() {
    var buf = new Uint8Array(4);
    if (global.crypto && global.crypto.getRandomValues) {
      global.crypto.getRandomValues(buf);
    } else {
      for (var i = 0; i < 4; i++) buf[i] = Math.floor(Math.random() * 256);
    }
    var out = "";
    for (var j = 0; j < buf.length; j++) out += ("0" + buf[j].toString(16)).slice(-2);
    return out;
  }

  function newLogicNode(logic) {
    return { uid: uid(), kind: "logic", logic: logic || "and", children: [], open: true };
  }

  function newConditionNode() {
    return { uid: uid(), kind: "bar", field: "", operator: "=", value: "" };
  }

  function nextRuleId(tree) {
    var max = 0, re = /^rule-(\d+)$/i;
    tree.forEach(function (typeInfo) {
      typeInfo.rules.forEach(function (rule) {
        var m = re.exec(String(rule.id || "").trim());
        if (m) max = Math.max(max, parseInt(m[1], 10));
      });
    });
    return "rule-" + String(max + 1);
  }

  function createNewRule(tree) {
    return {
      uid: uid(),
      id: nextRuleId(tree),
      prompt: "",
      source: "",
      uncertainty: { level: "none", reason: "" },
      grading: { evidence_level: "", recommendation_level: "" },
      conditions: newLogicNode("and"),
      open: true
    };
  }

  /* rules.json 条件树 → 编辑器节点树 */
  function conditionsToEditor(cond) {
    if (!cond || typeof cond !== "object") return null;
    if (Array.isArray(cond["$and"])) {
      return {
        uid: uid(), kind: "logic", logic: "and", open: true,
        children: cond["$and"].map(conditionsToEditor).filter(Boolean)
      };
    }
    if (Array.isArray(cond["$or"])) {
      return {
        uid: uid(), kind: "logic", logic: "or", open: true,
        children: cond["$or"].map(conditionsToEditor).filter(Boolean)
      };
    }
    if (Object.prototype.hasOwnProperty.call(cond, "field")) {
      var v = cond.value;
      return {
        uid: uid(), kind: "bar",
        field: cond.field == null ? "" : String(cond.field),
        operator: cond.operator == null ? "=" : String(cond.operator),
        value: v == null ? "" : String(v)
      };
    }
    return null;
  }

  /* rules.json（规则数组）→ 编辑器树，按 rule_type 首现顺序分组 */
  function loadTree(rules) {
    var order = [];
    var byType = Object.create(null);

    rules.forEach(function (rule) {
      var rt = rule.rule_type == null ? "unknown" : String(rule.rule_type);
      if (!byType[rt]) { byType[rt] = { uid: uid(), type: rt, rules: [], open: true }; order.push(rt); }
    });

    rules.forEach(function (rule) {
      var rt = rule.rule_type == null ? "unknown" : String(rule.rule_type);
      var node = conditionsToEditor(rule.rule_conditions || {});
      if (!node) node = newLogicNode("and");
      else if (node.kind === "bar") node = { uid: uid(), kind: "logic", logic: "and", open: true, children: [node] };

      var unc = rule.uncertainty || {};
      var grading = rule.grading || {};
      byType[rt].rules.push({
        uid: uid(),
        id: rule.rule_id == null ? "" : String(rule.rule_id),
        prompt: rule.rule_prompt == null ? "" : String(rule.rule_prompt),
        source: rule.source_reference == null ? "" : String(rule.source_reference),
        uncertainty: {
          level: unc.level || grading.uncertainty_level || "none",
          reason: unc.reason != null ? unc.reason : (grading.uncertainty_reason || "")
        },
        grading: {
          evidence_level: grading.evidence_level || "",
          recommendation_level: grading.recommendation_level || ""
        },
        conditions: node,
        open: false
      });
    });

    return order.map(function (t) { return byType[t]; });
  }

  var INT_RE = /^[+-]?\d+$/;
  var NUM_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

  /*
   * 字符串取值 → 智能转类型（对齐 Python int()/float() 的常用分支）
   * 刻意不转：空串、inf/nan/Infinity、十六进制等 JS Number() 会吃下的写法、
   * 以及超出安全整数范围的整数串——前两者会写出非法 JSON，后者会丢精度。
   */
  function parseValue(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return s;
    if (INT_RE.test(s)) {
      var asInt = Number(s);
      return Number.isSafeInteger(asInt) ? asInt : s;
    }
    if (NUM_RE.test(s)) {
      var asNum = Number(s);
      return Number.isFinite(asNum) ? asNum : s;
    }
    return s;
  }

  /* 归一化条件树（自底向上）：删空逻辑框 / 单子取消嵌套 / 同逻辑合并 */
  function normalizeConditions(node) {
    if (!node) return null;
    if (node.kind === "bar" || Object.prototype.hasOwnProperty.call(node, "field")) {
      return { field: node.field, operator: node.operator, value: parseValue(node.value) };
    }

    var children = [];
    (node.children || []).forEach(function (child) {
      var n = normalizeConditions(child);
      if (n) children.push(n);
    });
    if (!children.length) return null;
    if (children.length === 1) return children[0];

    var logic = node.logic === "or" ? "$or" : "$and";
    var merged = [];
    children.forEach(function (child) {
      if (Array.isArray(child[logic])) merged = merged.concat(child[logic]);
      else merged.push(child);
    });
    if (merged.length === 1) return merged[0];
    var out = {};
    out[logic] = merged;
    return out;
  }

  function collectConditionBars(node, out) {
    if (!node) return out;
    if (node.kind === "bar" || Object.prototype.hasOwnProperty.call(node, "field")) {
      out.push(node);
      return out;
    }
    (node.children || []).forEach(function (c) { collectConditionBars(c, out); });
    return out;
  }

  function serializeUncertainty(unc) {
    var level = (unc && unc.level) || "none";
    if (level === "none") return null;
    return { level: level, reason: (unc && unc.reason) || "" };
  }

  /* 编辑器树 → rules.json 的规则数组 */
  function serializeTree(tree) {
    var rules = [];
    tree.forEach(function (typeInfo) {
      typeInfo.rules.forEach(function (rule) {
        var unc = rule.uncertainty || {};
        var grading = rule.grading || {};
        rules.push({
          rule_id: String(rule.id || "").trim(),
          rule_type: typeInfo.type,
          rule_conditions: normalizeConditions(rule.conditions) || {},
          rule_prompt: rule.prompt || "",
          grading: {
            evidence_level: grading.evidence_level || "",
            recommendation_level: grading.recommendation_level || "",
            uncertainty_level: unc.level || "none",
            uncertainty_reason: unc.reason || ""
          },
          uncertainty: serializeUncertainty(unc),
          source_reference: rule.source || ""
        });
      });
    });
    return rules;
  }

  /* 四项校验：空 id / 重复 id / 条件条三要素不全 / 规则无条件条 */
  function validateTree(tree) {
    var errors = [];
    var located = [];
    tree.forEach(function (typeInfo) {
      typeInfo.rules.forEach(function (rule) { located.push([typeInfo.type, rule]); });
    });

    located.forEach(function (pair) {
      if (!String(pair[1].id || "").trim()) {
        errors.push({ kind: "empty_id", rule_type: pair[0], rule_ids: ["(空)"], detail: "规则 id 为空" });
      }
    });

    var seen = Object.create(null);
    located.forEach(function (pair) {
      var rid = String(pair[1].id || "").trim();
      if (!rid) return;
      if (seen[rid]) {
        errors.push({
          kind: "duplicate_id", rule_type: pair[0], rule_ids: [rid],
          detail: "id「" + rid + "」重复（已存在于「" + seen[rid] + "」类型中）"
        });
      } else {
        seen[rid] = pair[0];
      }
    });

    located.forEach(function (pair) {
      var type = pair[0], rule = pair[1];
      var rid = String(rule.id || "").trim() || "(空)";
      var bars = collectConditionBars(rule.conditions, []);
      if (!bars.length) {
        errors.push({ kind: "no_conditions", rule_type: type, rule_ids: [rid], detail: "没有任何条件条" });
        return;
      }
      var incomplete = bars.filter(function (b) {
        return !String(b.field || "").trim() || !String(b.operator || "").trim() || !String(b.value || "").trim();
      });
      if (incomplete.length) {
        errors.push({
          kind: "incomplete_condition", rule_type: type, rule_ids: [rid],
          detail: "存在 " + incomplete.length + " 个未填写齐全的条件条（变量名、运算符、取值缺一不可）"
        });
      }
    });

    return errors;
  }

  function countRules(tree) {
    return tree.reduce(function (acc, t) { return acc + t.rules.length; }, 0);
  }

  global.RuleEditor = {
    OPERATORS: OPERATORS,
    UNCERTAINTY_LEVELS: UNCERTAINTY_LEVELS,
    uid: uid,
    newLogicNode: newLogicNode,
    newConditionNode: newConditionNode,
    nextRuleId: nextRuleId,
    createNewRule: createNewRule,
    loadTree: loadTree,
    serializeTree: serializeTree,
    normalizeConditions: normalizeConditions,
    collectConditionBars: collectConditionBars,
    validateTree: validateTree,
    parseValue: parseValue,
    countRules: countRules
  };
})(window);
