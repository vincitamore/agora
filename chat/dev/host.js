// The dev page's host side: the cards and the block a host registers, drawn with the kit's card
// classes. A real host loads each card from its own source of truth; this one reads the fixtures.

import { registerCard, registerBlock } from "../client/index.js";
import { RECORDS } from "./fixtures.js";

const el = (tag, attrs = {}, kids = []) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? "" : String(v));
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.appendChild(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
};
const load = (type) => async (id) => {
  await new Promise((r) => setTimeout(r, 30));
  const r = RECORDS[`${type} ${id}`];
  if (!r) throw new Error("no such record");
  return r;
};
const head = (id, kind, status, statusClass = "") =>
  el("div", { class: "chat-card-head" }, [
    el("span", {}, [el("span", { class: "chat-card-id" }, [id]), el("span", { class: "chat-card-kind" }, [`  ${kind}`])]),
    el("span", { class: `chat-card-status ${statusClass}` }, [status]),
  ]);

registerCard("plan", {
  load: load("plan"),
  render: (p) => el("section", { class: `chat-card${p.risk === 2 ? " chat-risk-2" : p.risk === 3 ? " chat-risk-3" : ""}`, "aria-label": `Plan ${p.id}` }, [
    head(p.id, p.riskWords, p.status, p.awaiting ? "is-you" : ""),
    el("div", { class: "chat-card-body" }, [
      el("span", { class: "chat-card-title" }, [p.title]),
      el("div", { class: "chat-card-lines" }, p.lines.map(([op, t]) => el("div", { class: op === "+" ? "chat-line-add" : op === "-" ? "chat-line-del" : "" }, [`${op} ${t}`]))),
      p.note ? el("span", { class: "chat-card-lines chat-faint" }, [p.note]) : null,
    ]),
    p.awaiting ? el("div", { class: "chat-card-actions" }, [
      el("button", { type: "button", class: "chat-btn chat-btn-go", "data-chat-action": "go" }, ["GO"]),
      el("button", { type: "button", class: "chat-btn", "data-chat-action": "edit" }, ["edit"]),
      el("button", { type: "button", class: "chat-btn", "data-chat-action": "decline" }, ["decline"]),
    ]) : null,
    p.foot ? el("div", { class: "chat-card-foot" }, p.foot.map((t, i) => el("span", { class: i ? "chat-faint" : "" }, [t]))) : null,
  ]),
  actions: { go: async () => {}, edit: async () => {}, decline: async () => {} },
});

registerCard("receipt", {
  load: load("receipt"),
  render: (r) => el("section", { class: "chat-card chat-card--receipt", "aria-label": `Receipt ${r.id}` }, [
    el("div", { class: "chat-card-head" }, [
      el("span", { style: "display:flex;flex-direction:column;gap:2px" }, [el("span", {}, [r.line]), el("span", { class: "chat-faint" }, [r.note])]),
      el("span", { class: "chat-faint" }, [`receipt ${r.id}`]),
    ]),
  ]),
});

registerCard("watch", {
  load: load("watch"),
  render: (w) => el("section", { class: "chat-card chat-card--edge", "aria-label": `Watch ${w.id}` }, [
    head(w.id, w.what, w.status),
    el("div", { class: "chat-card-body chat-card-lines" }, [el("span", {}, [w.now]), el("span", { class: "chat-faint" }, [w.note])]),
    el("div", { class: "chat-card-actions" }, [
      el("button", { type: "button", class: "chat-btn", "data-chat-action": "extend" }, ["extend"]),
      el("button", { type: "button", class: "chat-btn", "data-chat-action": "end" }, ["end now"]),
    ]),
  ]),
  actions: { extend: async () => {}, end: async () => {} },
});

registerCard("view", {
  load: load("view"),
  render: (v) => {
    const max = Math.max(...v.counts, 1);
    const bars = el("div", { style: "display:grid;grid-template-columns:repeat(14,minmax(0,1fr));gap:6px;align-items:end;height:56px;border-bottom:1px solid var(--chat-rule)" },
      v.counts.map((n) => el("div", { style: `height:${Math.max(2, Math.round((n / max) * 52))}px;background:${n ? "var(--chat-ink3)" : "var(--chat-rule)"}` })));
    return el("section", { class: "chat-card", "aria-label": `View ${v.id}` }, [
      head(v.id, v.what, v.status),
      el("div", { class: "chat-card-body" }, [
        bars,
        el("div", { class: "chat-card-lines chat-faint", style: "display:flex;justify-content:space-between;font-size:10.5px" }, v.axis.map((t) => el("span", {}, [t]))),
      ]),
      el("div", { class: "chat-card-actions" }, v.controls.map((t) => el("button", { type: "button", class: "chat-btn" }, [t]))),
    ]);
  },
});

// ```evidence: `$ command @ age` lines and their output, inert text in mono with ages to the right
registerBlock("evidence", (source) => el("div", { class: "chat-evidence" }, source.split("\n").map((line) => {
  const m = line.match(/^(.*?)\s+@\s+(.+)$/);
  const text = m ? m[1] : line;
  return el("div", { class: "chat-ev-line" }, [
    el("span", { class: text.startsWith("$") ? "chat-ev-cmd" : "" }, [text]),
    m ? el("span", { class: "chat-ev-age" }, [m[2]]) : null,
  ]);
})));
