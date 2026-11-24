/*
 * 规则图形化编辑器 UI 层（无依赖，经典脚本，可直接 file:// 打开或部署到 GitHub Pages）
 *
 * 数据模型与校验全部来自 assets/rule-editor.js（window.RuleEditor）。
 * 本文件只做三件事：渲染编辑器树、把点击/输入映射为树操作、下载前跑校验。
 *
 * 安全约定：所有来自 JSON 的内容一律走 textContent / input.value，
 * 不用 innerHTML 拼接，避免导入的恶意规则库执行脚本。
 */
(function (global) {
  "use strict";

  var RE = global.RuleEditor;
  var doc = global.document;

  /* 示例：覆盖多类型、嵌套逻辑框、字符串/数字取值，用来演示归一化 */
  var SAMPLE_RULES = [
    {
      rule_id: "rule-001",
      rule_type: "screening",
      rule_conditions: {
        $and: [
          { field: "age", operator: ">=", value: 18 },
          { field: "risk_score", operator: ">=", value: 0.7 },
          { $or: [{ field: "symptom", operator: "=", value: "cough" }, { field: "fever", operator: "=", value: "yes" }] }
        ]
      },
      rule_prompt: "建议完成初筛问卷并进入门诊评估",
      grading: { evidence_level: "moderate", recommendation_level: "conditional for", uncertainty_level: "low", uncertainty_reason: "问卷完成依赖患者配合" },
      uncertainty: { level: "low", reason: "问卷完成依赖患者配合" },
      source_reference: "示例指南 §2.1"
    },
    {
      rule_id: "rule-002",
      rule_type: "screening",
      rule_conditions: { $and: [{ field: "prior_diagnosis", operator: "!=", value: "none" }] },
      rule_prompt: "既有诊断者需复核分诊记录",
      grading: { evidence_level: "", recommendation_level: "", uncertainty_level: "none", uncertainty_reason: "" },
      uncertainty: null,
      source_reference: ""
    },
    {
      rule_id: "rule-101",
      rule_type: "followup",
      rule_conditions: {
        $and: [
          { field: "first_screen_result", operator: "=", value: "abnormal" },
          { $and: [{ field: "interval_weeks", operator: "<=", value: 12 }, { field: "interval_weeks", operator: ">", value: 0 }] }
        ]
      },
      rule_prompt: "12 周内安排复查",
      grading: { evidence_level: "low", recommendation_level: "conditional for", uncertainty_level: "moderate", uncertainty_reason: "缺少本地队列数据" },
      uncertainty: { level: "moderate", reason: "缺少本地队列数据" },
      source_reference: "示例指南 §4.3"
    }
  ];

  var TYPE_ACTS = { "toggle-type": 1, "move-type-up": 1, "move-type-down": 1, "add-rule": 1, "del-type": 1 };
  var RULE_ACTS = { "toggle-rule": 1, "move-rule-up": 1, "move-rule-down": 1, "del-rule": 1, "expand-rule": 1, "collapse-rule": 1 };
  var NODE_ACTS = {
    "toggle-logic": 1, "add-bar": 1, "add-box": 1, "toggle-node": 1,
    "wrap-node": 1, "unwrap-node": 1, "move-node-up": 1, "move-node-down": 1, "del-node": 1
  };

  var els = {};
  var state = { tree: [], source: "", dirty: false, messages: [], previewOpen: false };

  /* ------------------------------------------------------------------ DOM 工具 */

  function h(tag, props, children) {
    var el = doc.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "value") el.value = v;
      else if (k === "dataset") Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; });
      else if (typeof v === "boolean") el.setAttribute(k, "");
      else el.setAttribute(k, v);
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c);
    });
    return el;
  }

  function button(label, act, opts) {
    var o = opts || {};
    return h("button", {
      class: "btn btn-" + (o.kind || "ghost") + (o.big ? " btn-lg" : " btn-sm"),
      type: "button",
      text: label,
      title: o.title || label,
      dataset: { act: act },
      disabled: o.disabled === true
    });
  }

  function spacer() { return h("span", { class: "spacer" }); }

  function field(labelText, el) {
    return h("label", { class: "field" }, [h("span", { class: "field-wrap" }, [h("span", { class: "k", text: labelText }), el])]);
  }

  /* ------------------------------------------------------- 定位树中的对象（按 uid） */

  function findType(typeUid) {
    for (var i = 0; i < state.tree.length; i++) if (state.tree[i].uid === typeUid) return state.tree[i];
    return null;
  }

  function findTypeByName(name) {
    for (var i = 0; i < state.tree.length; i++) if (state.tree[i].type === name) return state.tree[i];
    return null;
  }

  function findRule(ruleUid) {
    for (var i = 0; i < state.tree.length; i++) {
      var t = state.tree[i];
      for (var j = 0; j < t.rules.length; j++) if (t.rules[j].uid === ruleUid) return { typeInfo: t, rule: t.rules[j] };
    }
    return null;
  }

  function searchNode(node, parent, target) {
    if (node.uid === target) return { node: node, parent: parent, siblings: null, index: -1 };
    if (!node.children) return null;
    for (var i = 0; i < node.children.length; i++) {
      var hit = searchNode(node.children[i], node, target);
      if (hit) { hit.siblings = node.children; hit.index = i; return hit; }
    }
    return null;
  }

  function findNode(nodeUid) {
    for (var i = 0; i < state.tree.length; i++) {
      var typeInfo = state.tree[i];
      for (var j = 0; j < typeInfo.rules.length; j++) {
        var rule = typeInfo.rules[j];
        if (!rule.conditions) continue;
        var hit = searchNode(rule.conditions, null, nodeUid);
        if (hit) { hit.typeInfo = typeInfo; hit.rule = rule; return hit; }
      }
    }
    return null;
  }

  function nearestUid(el) {
    var node = el;
    while (node && node !== els.editor) {
      if (node.dataset && node.dataset.uid) return node.dataset.uid;
      node = node.parentNode;
    }
    return null;
  }

  function swap(arr, a, b) { var t = arr[a]; arr[a] = arr[b]; arr[b] = t; }

  /* ---------------------------------------------------------------------- 渲染 */

  function valueHint(raw) {
    var v = RE.parseValue(raw);
    if (String(raw || "").trim() === "") return "未填写";
    if (typeof v === "number") return "→ " + v + " (number)";
    return '→ "' + v + '" (string)';
  }

  function renderNode(node, depth, isRoot) {
    if (!node) return h("p", { class: "muted", text: "（无条件树）" });
    if (node.kind === "bar") return renderBar(node);
    return renderLogicBox(node, isRoot, depth);
  }

  function renderBar(bar) {
    var ops = RE.OPERATORS.slice();
    if (ops.indexOf(bar.operator) === -1) ops.unshift(bar.operator);

    return h("div", { class: "bar", "data-uid": bar.uid }, [
      h("input", { class: "inp mono grow", type: "text", placeholder: "变量名 field", value: bar.field || "", dataset: { act: "edit-bar", role: "field", uid: bar.uid } }),
      h("select", { class: "inp op", dataset: { act: "edit-bar", role: "operator", uid: bar.uid } }, ops.map(function (op) {
        return h("option", { value: op, text: op, selected: op === bar.operator });
      })),
      h("input", { class: "inp grow", type: "text", placeholder: "取值 value", value: bar.value || "", dataset: { act: "edit-bar", role: "value", uid: bar.uid } }),
      h("span", { class: "hint type-hint", text: valueHint(bar.value) }),
      spacer(),
      button("↑", "move-node-up", { title: "上移" }),
      button("↓", "move-node-down", { title: "下移" }),
      button("✕", "del-node", { kind: "danger", title: "删除条件条" })
    ]);
  }

  function renderLogicBox(node, isRoot, depth) {
    var children = node.children || [];
    var collapsed = node.open === false;

    var head = h("div", { class: "box-head", "data-uid": node.uid }, [
      h("button", {
        class: "logic logic-" + (node.logic === "or" ? "or" : "and"),
        type: "button",
        text: node.logic === "or" ? "任一满足 OR" : "全部满足 AND",
        title: "点击切换 AND / OR",
        dataset: { act: "toggle-logic", uid: node.uid }
      }),
      h("span", { class: "badge", text: children.length + " 项" }),
      spacer(),
      button("＋ 条件条", "add-bar", { title: "在本框末尾加一条 field/operator/value" }),
      button("＋ 逻辑框", "add-box", { title: "在本框末尾加一个嵌套逻辑框" }),
      button("⤵ 包一层", "wrap-node", { disabled: isRoot, title: isRoot ? "根逻辑框已是最外层" : "把本框装进一个新的外层逻辑框" }),
      button("⤴ 拆本层", "unwrap-node", { disabled: isRoot || !children.length, title: isRoot ? "根逻辑框不能拆除" : "把本框的内容物提升到上一层" }),
      button("↑", "move-node-up", { disabled: isRoot, title: "上移" }),
      button("↓", "move-node-down", { disabled: isRoot, title: "下移" }),
      button(collapsed ? "▸" : "▾", "toggle-node", { title: collapsed ? "展开" : "折叠" }),
      button("✕", "del-node", { kind: "danger", title: "删除本逻辑框及其全部内容" })
    ]);

    var body = h("div", { class: "box-body" });
    children.forEach(function (c) { body.appendChild(renderNode(c, depth + 1, false)); });
    if (!children.length) body.appendChild(h("p", { class: "muted", text: "空逻辑框——下载时会被自动删掉，校验也算作「没有任何条件条」。" }));

    return h("div", { class: "box level-" + Math.min(depth, 4) + (collapsed ? " collapsed" : ""), "data-uid": node.uid }, [head, body]);
  }

  function renderRule(rule) {
    var bars = RE.collectConditionBars(rule.conditions, []);
    var folded = rule.open === false;

    var head = h("div", { class: "rule-head" }, [
      h("button", {
        class: "twisty", type: "button", text: folded ? "▸" : "▾",
        title: folded ? "展开本规则" : "折叠本规则",
        dataset: { act: "toggle-rule", uid: rule.uid }
      }),
      h("input", { class: "inp mono rule-id", type: "text", placeholder: "rule-001", value: rule.id || "", dataset: { act: "edit-rule", role: "id", uid: rule.uid } }),
      h("span", { class: "badge", text: bars.length + " 条件条" }),
      h("span", { class: "ellipsis summary", text: rule.prompt || "（未填写指南建议）" }),
      spacer(),
      button("↑", "move-rule-up", { title: "在本类型内上移" }),
      button("↓", "move-rule-down", { title: "在本类型内下移" }),
      button("🗑", "del-rule", { kind: "danger", title: "删除本规则" })
    ]);

    var body = h("div", { class: "rule-body" }, [
      h("div", { class: "grid" }, [
        field("指南建议", h("textarea", { class: "inp", rows: 2, placeholder: "这条规则对应指南原文的建议", value: rule.prompt || "", dataset: { act: "edit-rule", role: "prompt", uid: rule.uid } })),
        field("溯源", h("input", { class: "inp", type: "text", placeholder: "指南章节 / 页码", value: rule.source || "", dataset: { act: "edit-rule", role: "source", uid: rule.uid } })),
        field("不确定性等级", h("select", { class: "inp", dataset: { act: "edit-rule", role: "unc-level", uid: rule.uid } }, RE.UNCERTAINTY_LEVELS.map(function (lv) {
          return h("option", { value: lv, text: lv, selected: (rule.uncertainty.level || "none") === lv });
        }))),
        field("不确定性说明", h("input", { class: "inp", type: "text", placeholder: "为什么不确定", value: rule.uncertainty.reason || "", dataset: { act: "edit-rule", role: "unc-reason", uid: rule.uid } })),
        field("证据质量", h("input", { class: "inp", type: "text", list: "dl-evidence", placeholder: "如 moderate", value: rule.grading.evidence_level || "", dataset: { act: "edit-rule", role: "evidence", uid: rule.uid } })),
        field("推荐强度", h("input", { class: "inp", type: "text", list: "dl-reco", placeholder: "如 conditional for", value: rule.grading.recommendation_level || "", dataset: { act: "edit-rule", role: "reco", uid: rule.uid } }))
      ]),
      h("div", { class: "tree-label" }, [
        h("span", { class: "k", text: "条件树" }),
        spacer(),
        button("全部展开", "expand-rule", { title: "展开本规则的所有逻辑框" }),
        button("全部折叠", "collapse-rule", { title: "折叠本规则的所有逻辑框" })
      ]),
      h("div", { class: "tree" }, [renderNode(rule.conditions, 0, true)])
    ]);

    return h("article", { class: "rule-card" + (folded ? " folded" : ""), "data-uid": rule.uid }, [head, folded ? null : body]);
  }

  function renderTypeInfo(typeInfo) {
    var head = h("div", { class: "type-head" }, [
      h("button", {
        class: "twisty", type: "button", text: typeInfo.open === false ? "▸" : "▾",
        title: "折叠 / 展开本类型",
        dataset: { act: "toggle-type", uid: typeInfo.uid }
      }),
      h("span", { class: "k", text: "规则类型 rule_type" }),
      h("input", { class: "inp mono type-name", type: "text", list: "dl-types", spellcheck: "false", value: typeInfo.type, dataset: { act: "edit-type-input", uid: typeInfo.uid } }),
      h("span", { class: "badge", text: typeInfo.rules.length + " 条规则" }),
      spacer(),
      button("↑", "move-type-up", { title: "上移本类型" }),
      button("↓", "move-type-down", { title: "下移本类型" }),
      button("＋ 新建规则", "add-rule", { kind: "primary", title: "在本类型末尾追加一条规则" }),
      button("🗑 删除类型", "del-type", { kind: "danger" })
    ]);

    var body = h("div", { class: "type-body" });
    typeInfo.rules.forEach(function (r) { body.appendChild(renderRule(r)); });
    if (!typeInfo.rules.length) body.appendChild(h("p", { class: "muted", text: "本类型还没有规则，点「＋ 新建规则」加一条。" }));

    return h("section", { class: "type-card", "data-uid": typeInfo.uid }, [head, typeInfo.open === false ? null : body]);
  }

  function renderEmpty() {
    return h("div", { class: "empty-card" }, [
      h("h2", { text: "开始编辑规则库" }),
      h("p", { class: "muted", text: "三种起手方式，选一个：" }),
      h("div", { class: "row" }, [
        button("📥 导入本地 rules.json", "empty-import", { big: true }),
        button("🧪 载入示例规则库", "empty-sample", { big: true }),
        button("✨ 从空白开始", "empty-new", { kind: "primary", big: true })
      ]),
      h("p", { class: "muted", text: "全部操作都在浏览器里完成：导入的文件不会被上传，下载也只是本地存文件。" })
    ]);
  }

  function renderPreview() {
    var box = h("details", { class: "preview-card" }, [
      h("summary", { text: "🔍 下载前预览（已按项目规则归一化：删空框、单子取消嵌套、同逻辑合并、取值智能转类型）" }),
      h("pre", { class: "mono", text: JSON.stringify(RE.serializeTree(state.tree), null, 2) })
    ]);
    if (state.previewOpen) box.open = true;
    box.addEventListener("toggle", function () { state.previewOpen = box.open; });
    return box;
  }

  function renderEditor() {
    els.editor.textContent = "";
    if (!state.tree.length) { els.editor.appendChild(renderEmpty()); return; }
    state.tree.forEach(function (t) { els.editor.appendChild(renderTypeInfo(t)); });
    els.editor.appendChild(renderPreview());
  }

  function renderStatus() {
    var n = RE.countRules(state.tree);
    els.status.textContent = "规则库：" + (state.source || "未命名") +
      "｜" + state.tree.length + " 个类型｜" + n + " 条规则｜" +
      (state.dirty ? "有未下载的修改" : "与上次导入/下载一致");
    els.status.className = "status" + (state.dirty ? " dirty" : "");
  }

  function renderMessages() {
    els.messages.textContent = "";
    state.messages.forEach(function (m) {
      els.messages.appendChild(h("p", { class: "msg msg-" + m.level, text: m.text }));
    });
  }

  /* 结构性变更后整块重渲染；文本输入只改模型 + 局部刷新，避免输入焦点丢失 */
  function renderAll() {
    var focus = captureFocus();
    renderEditor();
    renderStatus();
    renderMessages();
    restoreFocus(focus);
  }

  function captureFocus() {
    var el = doc.activeElement;
    if (!el || !els.editor.contains(el) || !el.dataset || !el.dataset.uid) return null;
    var start = null;
    try { start = el.selectionStart; } catch (e) { start = null; }
    return { uid: el.dataset.uid, act: el.dataset.act || "", role: el.dataset.role || "", start: start };
  }

  function restoreFocus(key) {
    if (!key) return;
    var sel = '[data-uid="' + key.uid + '"]';
    if (key.role) sel += "[data-role='" + key.role + "']";
    if (key.act) sel += "[data-act='" + key.act + "']";
    var el = els.editor.querySelector(sel);
    if (!el) return;
    el.focus();
    if (key.start != null && el.setSelectionRange) {
      try { el.setSelectionRange(key.start, key.start); } catch (e) { /* select 等元素不支持 */ }
    }
  }

  /* ---------------------------------------------------------------------- 树操作 */

  function markDirty() { state.dirty = true; }

  function addType(typeName) {
    var name = (typeName || "screening").trim() || "screening";
    var same = findTypeByName(name);
    if (same) { same.open = true; return same; }
    var t = { uid: RE.uid(), type: name, rules: [], open: true };
    state.tree.push(t);
    return t;
  }

  function addRule(typeInfo) {
    var r = RE.createNewRule(state.tree);
    typeInfo.rules.push(r);
    typeInfo.open = true;
    return r;
  }

  function dropEmptyTypes() {
    state.tree = state.tree.filter(function (t) { return t.rules.length > 0; });
  }

  function setOpenAll(open) {
    state.tree.forEach(function (t) {
      t.rules.forEach(function (r) {
        r.open = open;
        setOpen(r.conditions, open);
      });
    });
  }

  function setOpen(node, open) {
    if (!node || node.kind === "bar") return;
    node.open = open;
    (node.children || []).forEach(function (c) { setOpen(c, open); });
  }

  /* ---------------------------------------------------------------- 事件：点击 */

  function onClick(ev) {
    var target = ev.target;
    if (!target || !target.closest) return;
    var el = target.closest("[data-act]");
    if (!el || !els.editor.contains(el) || el.disabled) return;
    var act = el.dataset.act;

    if (act.indexOf("empty-") === 0) return emptyAction(act);
    if (act === "expand-all") { setOpenAll(true); renderAll(); return; }
    if (act === "collapse-all") { setOpenAll(false); renderAll(); return; }
    if (act === "add-type") { addType(global.prompt("新规则类型名（如 treatment）：", "treatment")); markDirty(); renderAll(); return; }

    var uid = nearestUid(el);
    if (!uid) return;
    if (TYPE_ACTS[act]) return typeAction(act, uid);
    if (RULE_ACTS[act]) return ruleAction(act, uid);
    if (NODE_ACTS[act]) return nodeAction(act, uid);
  }

  function emptyAction(act) {
    if (act === "empty-import") { els["import-file"].click(); return; }
    if (act === "empty-sample") { onSample(); return; }
    if (act === "empty-new") {
      state.tree = [{ uid: RE.uid(), type: "screening", rules: [], open: true }];
      state.source = "新建规则库";
      markDirty();
      state.messages = [{ level: "info", text: "已新建 screening 类型，点「＋ 新建规则」加第一条规则。" }];
      renderAll();
    }
  }

  function typeAction(act, typeUid) {
    var t = findType(typeUid);
    if (!t) return;
    var idx = state.tree.indexOf(t);

    if (act === "toggle-type") t.open = t.open === false;
    else if (act === "move-type-up") { if (idx > 0) { swap(state.tree, idx, idx - 1); markDirty(); } }
    else if (act === "move-type-down") { if (idx < state.tree.length - 1) { swap(state.tree, idx, idx + 1); markDirty(); } }
    else if (act === "add-rule") { addRule(t); markDirty(); }
    else if (act === "del-type") {
      if (!confirm("删除类型「" + t.type + "」及其 " + t.rules.length + " 条规则？")) return;
      state.tree.splice(idx, 1);
      markDirty();
      state.messages = [{ level: "info", text: "已删除类型「" + t.type + "」。" }];
    }
    renderAll();
  }

  function ruleAction(act, ruleUid) {
    var found = findRule(ruleUid);
    if (!found) return;
    var rules = found.typeInfo.rules;
    var idx = rules.indexOf(found.rule);

    if (act === "toggle-rule") found.rule.open = found.rule.open === false;
    else if (act === "move-rule-up") { if (idx > 0) { swap(rules, idx, idx - 1); markDirty(); } }
    else if (act === "move-rule-down") { if (idx < rules.length - 1) { swap(rules, idx, idx + 1); markDirty(); } }
    else if (act === "del-rule") {
      if (!confirm("删除规则「" + (found.rule.id || "(空 id)") + "」？")) return;
      rules.splice(idx, 1);
      markDirty();
      dropEmptyTypes();
    } else if (act === "expand-rule" || act === "collapse-rule") {
      found.rule.open = true;
      setOpen(found.rule.conditions, act === "expand-rule");
    }
    renderAll();
  }

  function nodeAction(act, nodeUid) {
    var ctx = findNode(nodeUid);
    if (!ctx) return;
    var node = ctx.node;
    var isRoot = ctx.siblings === null;

    if (act === "toggle-logic") { node.logic = node.logic === "or" ? "and" : "or"; markDirty(); }
    else if (act === "add-bar") { node.children.push(RE.newConditionNode()); node.open = true; markDirty(); }
    else if (act === "add-box") { node.children.push(RE.newLogicNode("and")); node.open = true; markDirty(); }
    else if (act === "toggle-node") node.open = node.open === false;
    else if (act === "move-node-up" && !isRoot) { swap(ctx.siblings, ctx.index, ctx.index - 1); markDirty(); }
    else if (act === "move-node-down" && !isRoot) { swap(ctx.siblings, ctx.index, ctx.index + 1); markDirty(); }
    else if (act === "del-node") {
      var label = node.kind === "bar" ? "条件条" : "逻辑框及其 " + (node.children || []).length + " 项内容";
      if (!confirm("删除这个" + label + "？")) return;
      if (isRoot) ctx.rule.conditions = RE.newLogicNode("and");
      else ctx.siblings.splice(ctx.index, 1);
      markDirty();
    } else if (act === "wrap-node" && !isRoot) {
      var box = RE.newLogicNode("and");
      box.children.push(node);
      ctx.siblings.splice(ctx.index, 1, box);
      if (ctx.parent) ctx.parent.open = true;
      markDirty();
    } else if (act === "unwrap-node" && !isRoot && (node.children || []).length) {
      ctx.siblings.splice.apply(ctx.siblings, [ctx.index, 1].concat(node.children));
      markDirty();
    }
    renderAll();
  }

  /* -------------------------------------------------------------- 事件：文本输入 */

  /* 把输入框/下拉框的值写回树模型；返回是否命中可编辑元素 */
  function applyEdit(el) {
    var act = el.dataset ? el.dataset.act : null;
    if (act === "edit-bar") {
      var ctx = findNode(el.dataset.uid);
      if (!ctx || ctx.node.kind !== "bar") return false;
      ctx.node[el.dataset.role] = el.value;
      return true;
    }
    if (act !== "edit-rule") return false;
    var found = findRule(el.dataset.uid);
    if (!found) return false;
    var rule = found.rule;
    var role = el.dataset.role;
    if (role === "id") rule.id = el.value;
    else if (role === "prompt") rule.prompt = el.value;
    else if (role === "source") rule.source = el.value;
    else if (role === "evidence") rule.grading.evidence_level = el.value;
    else if (role === "reco") rule.grading.recommendation_level = el.value;
    else if (role === "unc-level") rule.uncertainty.level = el.value;
    else if (role === "unc-reason") rule.uncertainty.reason = el.value;
    else return false;
    return true;
  }

  function onInput(ev) {
    var el = ev.target;
    var act = el.dataset ? el.dataset.act : null;
    if (!act || !els.editor.contains(el)) return;

    if (act === "edit-bar") {
      if (!applyEdit(el)) return;
      if (el.dataset.role === "value") {
        var hint = el.parentNode.querySelector(".type-hint");
        if (hint) hint.textContent = valueHint(el.value);
      }
      markDirty();
      softRefresh();
    } else if (act === "edit-rule") {
      if (!applyEdit(el)) return;
      var rule = findRule(el.dataset.uid).rule;
      var role = el.dataset.role;
      var card = el.closest(".rule-card");
      if (card) {
        var badge = card.querySelector(".rule-head .badge");
        if (badge) badge.textContent = RE.collectConditionBars(rule.conditions, []).length + " 条件条";
        var summary = card.querySelector(".summary");
        if (summary && role === "prompt") summary.textContent = el.value || "（未填写指南建议）";
      }
      markDirty();
      softRefresh();
    }
  }

  /* 下拉选择与类型改名走 change：需要重建受影响的 UI，交给整块重渲染 */
  function onChange(ev) {
    var el = ev.target;
    var act = el.dataset ? el.dataset.act : null;
    if (act === "edit-type-input") renameType(el);
    else if (act === "edit-rule" || act === "edit-bar") {
      if (!applyEdit(el)) return;
      markDirty();
      renderAll();
    }
  }

  function renameType(input) {
    var t = findType(input.dataset.uid);
    if (!t) return;
    var next = input.value.trim();
    if (!next) {
      input.value = t.type;
      state.messages = [{ level: "error", text: "规则类型名不能为空。" }];
      renderAll();
      return;
    }
    if (next === t.type) return;
    var clash = findTypeByName(next);
    if (clash) {
      input.value = t.type;
      state.messages = [{ level: "error", text: "已存在同名类型「" + next + "」，把规则挪过去或换个名字，否则导出的 rule_type 会重复。" }];
      renderAll();
      return;
    }
    t.type = next;
    markDirty();
    state.messages = [{ level: "ok", text: "类型已改名为「" + next + "」，下载时本组规则都会带上新的 rule_type。" }];
    renderAll();
  }

  var softTimer = null;
  function softRefresh() {
    if (softTimer) return;
    softTimer = global.setTimeout(function () {
      softTimer = null;
      var box = els.editor.querySelector(".preview-card");
      if (box && box.open) {
        var pre = box.querySelector("pre");
        if (pre) pre.textContent = JSON.stringify(RE.serializeTree(state.tree), null, 2);
      }
      renderStatus();
    }, 400);
  }

  /* ------------------------------------------------------------------ 文件操作 */

  function loadRules(rules, label) {
    state.tree = RE.loadTree(rules);
    /* 每个类型展开第一条规则，避免刚导入时只看到一排折叠的 id */
    state.tree.forEach(function (t) { if (t.rules.length) t.rules[0].open = true; });
    state.source = label;
    state.dirty = false;
    state.messages = [{
      level: "ok",
      text: "已载入「" + label + "」：" + RE.countRules(state.tree) + " 条规则，分属 " + state.tree.length + " 个类型。改完点「下载规则库」。"
    }];
    renderAll();
  }

  function fail(text) {
    state.messages = [{ level: "error", text: text }];
    renderAll();
  }

  function onImport(ev) {
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    if (state.dirty && !confirm("当前有未下载的修改，导入「" + file.name + "」会覆盖编辑器内容，继续？")) return;

    var reader = new global.FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = global.JSON.parse(String(reader.result || ""));
      } catch (e) {
        fail("「" + file.name + "」不是合法 JSON：" + e.message);
        return;
      }
      var rules = global.Array.isArray(parsed) ? parsed : (parsed && global.Array.isArray(parsed.rules) ? parsed.rules : null);
      if (!rules) {
        fail("「" + file.name + "」不是规则库文件：顶层应为规则对象数组（或含 rules 数组的对象）。");
        return;
      }
      var good = rules.filter(function (r) { return r && typeof r === "object" && !global.Array.isArray(r); });
      if (!good.length) {
        fail("「" + file.name + "」里没有可用的规则对象（每项应为含 rule_id / rule_conditions 的对象）。");
        return;
      }
      loadRules(good, file.name);
    };
    reader.onerror = function () { fail("读取「" + (file.name || "文件") + "」失败。"); };
    reader.readAsText(file, "utf-8");
  }

  function hasContent() {
    return state.tree.length > 0;
  }

  function onNew() {
    if (hasContent() && !confirm("新建会丢弃当前编辑器中的内容（含未下载的修改），继续？")) return;
    state.tree = [];
    state.source = "新建规则库";
    markDirty();
    state.messages = [{ level: "info", text: "已新建空规则库，先加一个规则类型。" }];
    renderAll();
  }

  function onSample() {
    if (hasContent() && !confirm("载入示例会替换当前编辑器内容，继续？")) return;
    loadRules(SAMPLE_RULES, "示例规则库");
  }

  function downloadName() {
    var name = String(els["download-name"].value || "rules.json").trim().replace(/[\\/:*?"<>|]/g, "_");
    if (!name) name = "rules.json";
    if (!/\.json$/i.test(name)) name += ".json";
    return name;
  }

  function onDownload() {
    var rules = RE.serializeTree(state.tree);
    if (!rules.length) {
      state.messages = [{ level: "error", text: "规则库为空，至少写一条规则再下载。" }];
      renderAll();
      return;
    }
    var errors = RE.validateTree(state.tree);
    if (errors.length) {
      state.messages = [{ level: "error", text: "校验未通过（" + errors.length + " 项），已阻止下载。下列规则已展开：" }].concat(
        errors.map(function (e) {
          return { level: "error", text: "· [" + e.rule_type + "] " + e.rule_ids.join(", ") + " — " + e.detail };
        })
      );
      setOpenAll(true);
      renderAll();
      return;
    }

    var name = downloadName();
    var blob = new global.Blob([global.JSON.stringify(rules, null, 2) + "\n"], { type: "application/json" });
    var url = global.URL.createObjectURL(blob);
    var a = h("a", { href: url, download: name });
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 1500);

    state.source = name;
    state.dirty = false;
    state.messages = [{ level: "ok", text: "校验通过，已下载 " + name + "（" + rules.length + " 条规则）。" }];
    renderAll();
  }

  /* ---------------------------------------------------------------------- 启动 */

  function boot() {
    ["import-file", "btn-sample", "btn-new", "btn-add-type", "btn-expand-all", "btn-collapse-all",
      "download-name", "btn-download", "status", "messages", "editor"].forEach(function (id) {
      els[id] = doc.getElementById(id);
    });

    els["import-file"].addEventListener("change", onImport);
    els["btn-sample"].addEventListener("click", onSample);
    els["btn-new"].addEventListener("click", onNew);
    els["btn-download"].addEventListener("click", onDownload);
    els["btn-add-type"].addEventListener("click", function () {
      addType(global.prompt("新规则类型名（如 treatment / followup / prevention）：", "treatment"));
      markDirty();
      renderAll();
    });
    els["btn-expand-all"].addEventListener("click", function () { setOpenAll(true); renderAll(); });
    els["btn-collapse-all"].addEventListener("click", function () { setOpenAll(false); renderAll(); });

    els.editor.addEventListener("click", onClick);
    els.editor.addEventListener("input", onInput);
    els.editor.addEventListener("change", onChange);

    doc.addEventListener("keydown", function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && String(ev.key).toLowerCase() === "s") {
        ev.preventDefault();
        onDownload();
      }
    });

    global.addEventListener("beforeunload", function (ev) {
      if (!state.dirty) return;
      ev.preventDefault();
      ev.returnValue = "规则库有未下载的修改";
    });

    renderAll();
  }

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", boot);
  else boot();
})(window);
