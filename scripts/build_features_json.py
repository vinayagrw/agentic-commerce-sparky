#!/usr/bin/env python3
"""Build docs/features.json from docs/FEATURE_CATALOGUE.md and docs/USER_STORIES.md.

Usage:
    python3 scripts/build_features_json.py            # (re)generate docs/features.json
    python3 scripts/build_features_json.py --check     # validate, exit non-zero on drift

The generator is intentionally conservative: it parses the catalogue's own
"### n.n Title" sections plus the OPS1-10 / MLO1-10 tables, and cross-checks
every story id it emits against docs/USER_STORIES.md. It does not invent
numbers; MLOps/Ops figures are copied verbatim from the catalogue text.
"""
from __future__ import annotations

import json
import re
import sys
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
CATALOGUE = DOCS / "FEATURE_CATALOGUE.md"
STORIES = DOCS / "USER_STORIES.md"
OUT = DOCS / "features.json"

# ---------------------------------------------------------------------------
# Shared "alternative tech stack" building blocks (verified via Context7:
# LangGraph /langchain-ai/langgraph, Vercel AI SDK /vercel/ai, checked
# 2026-09-17). No benchmarks or numbers here — composability/trade-off notes
# only.
# ---------------------------------------------------------------------------
NOTE = "not built or measured here; checked 2026-09-17"

ALT1_AGENT = {
    "components": ["Next.js + Vercel AI SDK (tool calling, streaming UI)", "LangGraph (stateful multi-agent graph, human-in-the-loop interrupt)"],
    "tradeoff": f"Composable, self-hosted, no vendor lock-in, but you own orchestration, retries and observability wiring yourself. {NOTE}.",
    "betterWhen": "You need to run the same agent graph across clouds or on-prem, or want fine-grained control over the interrupt/resume state machine.",
}
ALT2_AGENT = {
    "components": ["Vertex AI Agent Builder / Agent Engine", "Azure AI Foundry Agent Service (variant note)"],
    "tradeoff": f"Managed runtime, built-in evaluation and tracing, but couples the demo to one cloud's agent lifecycle and pricing. {NOTE}.",
    "betterWhen": "The team already standardises on GCP (or Azure) and wants managed session state, grounding and deployment without running its own agent host.",
}
ALT1_SEARCH = {
    "components": ["OpenSearch hybrid (BM25 + k-NN)", "BGE or Cohere rerank cross-encoder"],
    "tradeoff": f"Same hybrid-retrieval shape as search-svc today, fully self-hosted and tunable, but you operate the cluster and reranker yourself. {NOTE}.",
    "betterWhen": "Query volume or index size outgrows a single-process FAISS/BM25 setup, or the team needs cluster-level access control.",
}
ALT2_SEARCH = {
    "components": ["Vertex AI Search (retail/commerce)", "BigQuery for catalogue + event storage"],
    "tradeoff": f"Managed relevance tuning and commerce-specific ranking signals, but retrieval logic and re-ranking become opaque to the demo's own eval harness. {NOTE}.",
    "betterWhen": "The catalogue and clickstream already live in BigQuery and the team wants managed relevance without maintaining ranking code.",
}
ALT1_MLOPS = {
    "components": ["Feast (feature store)", "MLflow or Kubeflow Pipelines (training, registry)", "Langfuse or Arize Phoenix (LLM tracing/eval)"],
    "tradeoff": f"Open, portable, matches the current MLflow-based registry almost 1:1, but each piece (features, pipelines, tracing) is a separate system to run and reconcile. {NOTE}.",
    "betterWhen": "The team wants to keep MLOps infra open-source and portable across clouds, or already runs Kubernetes for other workloads.",
}
ALT2_MLOPS = {
    "components": ["Vertex AI Pipelines + Model Registry", "Cloud Trace (spans/latency)"],
    "tradeoff": f"One managed pipeline/registry/tracing surface with IAM-level governance, but MLOps tooling and gates are then GCP-specific. {NOTE}.",
    "betterWhen": "Governance and audit (who promoted what, when) matters more than infra portability, and the org is already on GCP.",
}


def alt_for(area: str) -> dict:
    a = area.lower()
    if "mlops" in a or "ops copilot" in a or a.startswith("ops"):
        return {"alt1": ALT1_MLOPS, "alt2": ALT2_MLOPS}
    if "storefront" in a or "catalogue" in a or "triage" in a:
        return {"alt1": ALT1_SEARCH, "alt2": ALT2_SEARCH}
    return {"alt1": ALT1_AGENT, "alt2": ALT2_AGENT}


# ---------------------------------------------------------------------------
# Parse docs/USER_STORIES.md into {story_id: {persona, given, when, then, spec}}
# ---------------------------------------------------------------------------
GWT_RE = re.compile(
    r"\*\*Given\*\*\s*(?P<given>.*?),?\s*\*\*[Ww]hen\*\*\s*(?P<when>.*?),?\s*\*\*[Tt]hen\*\*\s*(?P<then>.*)",
    re.DOTALL,
)


UNPROVEN_RE = re.compile(r"^\|\s*([A-Za-z0-9, ]+?)\s*\|", re.MULTILINE)


def parse_unproven_ids(text: str) -> set[str]:
    """IDs listed in the '## Stories without proof' table (first column, comma-separated)."""
    m = re.search(r"## Stories without proof\n(.*)", text, re.DOTALL)
    if not m:
        return set()
    ids: set[str] = set()
    for line in m.group(1).splitlines():
        row = UNPROVEN_RE.match(line)
        if not row or row.group(1).strip() in ("ID", "---") or set(row.group(1).strip()) == {"-"}:
            continue
        for part in row.group(1).split(","):
            part = part.strip()
            if part:
                ids.add(part)
    return ids


# Lenient smoke-test for "is there an actual verb here", not a grammar checker: a
# base-verb whitelist (covers imperative/first-person phrasing like "I open ...")
# OR any word of 3+ letters inflected as a verb (renders, opened, detecting, ...).
WHEN_VERBS = re.compile(
    r"\b(ask|open|click|type|press|pick|say|attach|drag|use|choose|remove|add|change|save|reload|look|break|"
    r"approve|reject|request|call|run|start|tick|sort|go|search|reach|read|edit|resend|wait|fire|exceed|"
    r"exhaust|breach|spend|toggle|upload|switch|scroll|select|submit|load|resize|is|are|come|arrive|finish|"
    r"need|fail|check|state|inject|browse|end|answer|render|detect|process|split|see|do)\b"
    r"|\b\w{3,}(s|ed|ing)\b",
    re.IGNORECASE,
)

THEN_ASSERTIONS = re.compile(
    r"\b(shows?|is|are|has|have|contains?|appears?|displays?|returns?|records?|lists?|renders?|matches?|says?|"
    r"states?|names?|marks?|blocks?|refuses?|updates?|persists?|passes?|fails?|turns?|drops?|carr(y|ies)|cites?|"
    r"links?|opens?|closes?|files?|writes?|includes?|shown|correlates?|ranks?|labels?|announces?|"
    r"follows?|gets?|sees?|resize|stack|change|applies?|apply|proposes?|runs?|reads?|split|drop|comes?|"
    r"reaches?|sends?|gives?|lets?)\b"
    r"|\b\w{3,}(s|ed|ing)\b",
    re.IGNORECASE,
)


def parse_stories(text: str) -> dict:
    stories: dict[str, dict] = {}
    current_h2 = ""
    for line in text.splitlines():
        if line.startswith("## "):
            current_h2 = line[3:].strip()
            continue
        m = re.match(r"^\|\s*([A-Za-z0-9]+)\s*\|(.*)\|(.*)\|(.*)\|\s*$", line)
        if not m:
            continue
        story_id, story_col, acc_col, spec_col = m.groups()
        if story_id in ("ID", "---") or set(story_id) == {"-"}:
            continue
        acc = acc_col.strip()
        gwt = GWT_RE.search(acc)
        given = when = then = ""
        if gwt:
            given = re.sub(r"\*\*", "", gwt.group("given")).strip(" .")
            when = re.sub(r"\*\*", "", gwt.group("when")).strip(" .")
            then = re.sub(r"\*\*", "", gwt.group("then")).strip(" .")
        else:
            then = re.sub(r"\*\*", "", acc).strip()
        spec_m = re.search(r"`([a-zA-Z0-9_\-]+\.spec\.ts)`", spec_col)
        spec = spec_m.group(1) if spec_m else ""
        stories[story_id] = {
            "id": story_id,
            "persona": current_h2,
            "given": given,
            "when": when,
            "then": then,
            "spec": spec,
        }
    return stories


# ---------------------------------------------------------------------------
# Parse docs/FEATURE_CATALOGUE.md
# ---------------------------------------------------------------------------
STORY_REF_RE = re.compile(r"\[([A-Za-z0-9]+(?:\s*/\s*[A-Za-z0-9]+)*)\]\(USER_STORIES\.md")
SPEC_RE = re.compile(r"`([a-zA-Z0-9_\-]+\.spec\.ts)`")
MERMAID_RE = re.compile(r"```mermaid\n(.*?)```", re.DOTALL)

# ---------------------------------------------------------------------------
# coverage_ids: the machine-checked feature -> data/coverage.json join.
# The catalogue is the source of truth: a section may carry a line
#   **Coverage.** #7, #8
# (plain sections) or, for the OPS/MLO tables, one entry per story id
#   **Coverage.** OPS1 -> #30; OPS2 -> #20; OPS9 -> (none)
# `#n` is a data/coverage.json `techniques[].id` row; a bare `MLOn` is a
# `mlops_top10.rows[].id` row. `--check` fails on an id that does not exist
# there, so a feature with no genuine row keeps an empty list rather than
# being linked to a near-miss.
# ---------------------------------------------------------------------------
COVERAGE_LINE_RE = re.compile(r"^\*\*Coverage\.\*\*\s*(.+)$", re.MULTILINE)
COVERAGE_ID_RE = re.compile(r"#(\d+)|\b(MLO\d+)\b")

CoverageId = int | str


def _coverage_ids(text: str) -> list[CoverageId]:
    ids: list[CoverageId] = []
    for num, row in COVERAGE_ID_RE.findall(text):
        cid: CoverageId = int(num) if num else row
        if cid not in ids:
            ids.append(cid)
    return ids


def parse_coverage_ids(body: str) -> list[CoverageId]:
    """Coverage ids from a plain `### n.n` section's **Coverage.** line ([] when absent)."""
    m = COVERAGE_LINE_RE.search(body)
    return _coverage_ids(m.group(1)) if m else []


def parse_coverage_map(body: str) -> dict[str, list[CoverageId]]:
    """`**Coverage.** OPS1 -> #30; OPS2 -> #20` -> {"OPS1": [30], "OPS2": [20]}."""
    m = COVERAGE_LINE_RE.search(body)
    if not m:
        return {}
    out: dict[str, list[CoverageId]] = {}
    for entry in m.group(1).split(";"):
        parts = entry.split("->")
        if len(parts) != 2:
            continue
        sid = parts[0].strip()
        if not re.fullmatch(r"(OPS|MLO)\d+", sid):
            continue
        out[sid] = _coverage_ids(parts[1])
    return out


def load_coverage_ids() -> set[CoverageId]:
    """Every id that exists in data/coverage.json: technique ids + mlops_top10 row ids."""
    cov = json.loads((ROOT / "data" / "coverage.json").read_text())
    known: set[CoverageId] = {t["id"] for t in cov.get("techniques", []) if isinstance(t.get("id"), int)}
    known |= {r["id"] for r in (cov.get("mlops_top10") or {}).get("rows", []) if isinstance(r.get("id"), str)}
    return known


# ---------------------------------------------------------------------------
# atlas_nodes: the machine-checked feature -> mermaid-node join the Guide atlas
# uses. The catalogue is the source of truth: a section may carry a line
#   **Atlas nodes.** 0.1#shop, 1.1#home
# (plain sections) or, for the OPS/MLO tables, one entry per story id
#   **Atlas nodes.** OPS1 -> ops1-incident-triage#chat; OPS10 -> ops1-...#bell
# Each entry is `<diagram>#<nodeId>`, where <diagram> is the catalogue section
# number (or the feature id) of the feature that owns the mermaid diagram, and
# <nodeId> is a node id inside it. `--check` fails when the diagram does not
# exist, when the node id is not in that diagram, or when two features claim the
# same node — so a node either points at a declared feature or stays inert in
# the atlas. Nothing is guessed from labels.
# ---------------------------------------------------------------------------
ATLAS_LINE_RE = re.compile(r"^\*\*Atlas nodes\.\*\*\s*(.+)$", re.MULTILINE)
ATLAS_ENTRY_RE = re.compile(r"([A-Za-z0-9][\w.\-]*)#([A-Za-z][\w-]*)")
# mermaid node declarations: `id[label]`, `id(label)`, `id{label}` (same shape the
# web reads in web/src/guide/guideModel.ts).
MERMAID_NODE_RE = re.compile(r"(\b[A-Za-z][\w-]*)\s*[\[({]+\s*\"?([^\"\]})]{2,120})\"?\s*[\])}]+")


def _atlas_entries(text: str) -> list[str]:
    out: list[str] = []
    for diagram, node in ATLAS_ENTRY_RE.findall(text):
        entry = f"{diagram}#{node}"
        if entry not in out:
            out.append(entry)
    return out


def parse_atlas_nodes(body: str) -> list[str]:
    """Raw atlas entries from a plain `### n.n` section's **Atlas nodes.** line."""
    m = ATLAS_LINE_RE.search(body)
    return _atlas_entries(m.group(1)) if m else []


def parse_atlas_map(body: str) -> dict[str, list[str]]:
    """`**Atlas nodes.** OPS1 -> ops1-...#chat; OPS10 -> ops1-...#bell` -> per story id."""
    m = ATLAS_LINE_RE.search(body)
    if not m:
        return {}
    out: dict[str, list[str]] = {}
    for entry in m.group(1).split(";"):
        parts = entry.split("->")
        if len(parts) != 2:
            continue
        sid = parts[0].strip()
        if not re.fullmatch(r"(OPS|MLO)\d+", sid):
            continue
        out[sid] = _atlas_entries(parts[1])
    return out


def mermaid_node_ids(diagram: str | None) -> set[str]:
    return {m.group(1) for m in MERMAID_NODE_RE.finditer(diagram or "")}


def resolve_atlas_nodes(features: list[dict]) -> None:
    """Rewrite each `<section-or-id>#node` entry to `<feature id>#node`, in place."""
    by_id = {f["id"] for f in features}
    for f in features:
        resolved: list[str] = []
        for entry in f.get("atlas_nodes", []):
            prefix, node = entry.split("#", 1)
            if prefix in by_id:
                fid = prefix
            else:
                hits = [i for i in by_id if i.startswith(f"{prefix}-")]
                fid = hits[0] if len(hits) == 1 else prefix
            resolved.append(f"{fid}#{node}")
        f["atlas_nodes"] = resolved


def slugify(s: str) -> str:
    s = re.sub(r"[`*\[\]()]", "", s)
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s


def route_example(area_num: str, name: str) -> list[dict]:
    """Real app routes per catalogue area, with a realistic ESCI prompt where relevant."""
    prompt_shop = "coffee and #4 cone filters under $25"
    prompt_ops = "triage the latest incident"
    n = area_num
    if n.startswith("1."):
        q = urllib.parse.quote("peanut butter")
        return [{
            "title": f"Search the storefront: {name}",
            "steps": ["Open /shop", "Use the search box or navigate to the results route", "Inspect the rendered page for the behaviour described above"],
            "link": f"/shop/search?q={q}",
            "expected": "ESCI-backed result cards render with price, rating and pickup status (synthetic commerce data).",
        }, {
            "title": f"Follow it from the home page: {name}",
            "steps": ["Open /shop", "Pick a category tile or mission card, or open /shop/cart directly", "Check the header cart count and the page's own data label"],
            "link": "/shop/cart",
            "expected": "The header cart count matches the session's cart and the page states its data is synthetic.",
        }]
    if n.startswith("2.") or n.startswith("4.") or n in ("8.2",):
        chat = urllib.parse.quote(prompt_shop)
        return [{
            "title": f"Drive it from Sparky chat: {name}",
            "steps": [f"Open /shopper/1?layout=split&chat={chat}", "Watch the chat pane and the synced site pane", "Open \"How Sparky worked\" for the run detail"],
            "link": f"/shopper/1?layout=split&chat={chat}",
            "expected": "The agent turn streams into chat, and the linked site pane reflects the same session state.",
        }, {
            "title": f"Watch it sync from the site side: {name}",
            "steps": ["Open /shop?view=split", "Add or remove an item on the site pane", "Watch the chat pane's activity feed update without a reload"],
            "link": "/shop?view=split",
            "expected": "The change appears on the other pane over the session SSE stream, no page reload.",
        }]
    if n.startswith("3."):
        return [{
            "title": f"Operator view: {name}",
            "steps": ["Search something with no matches on /shop/search", "Open /triage", "Acknowledge or resolve the filed record"],
            "link": "/triage",
            "expected": "The triage queue shows the query, filters, store and relaxation for the zero-result search.",
        }, {
            "title": f"File the record from the storefront: {name}",
            "steps": ["Open /shop/search?q=zzznobrandnothingmatchesthisquery", "See the zero-result page with a relaxation suggestion", "Open /triage in a second tab and find the same query"],
            "link": "/shop/search?q=zzznobrandnothingmatchesthisquery",
            "expected": "The zero-result page shows a relaxation with its count, and the same record appears in the triage queue.",
        }]
    if n.startswith("6.") or n.startswith("8.1") or n.startswith("9.") or n.startswith("5.2"):
        beat = "8a" if "data" in name.lower() else ("8b" if "closed" in name.lower() else "8c")
        copilot = urllib.parse.quote(prompt_ops)
        return [{
            "title": f"Ask the Ops Copilot: {name}",
            "steps": [f"Open /ops/{beat}?copilot={copilot}", "Read the ops_insight card and its cited records", "Follow any approval link if one appears"],
            "link": f"/ops/{beat}?copilot={copilot}",
            "expected": "A cited A2UI card answers the question with real ops.db / registry / ledger data, never a guess.",
        }, {
            "title": f"Open the dashboard directly: {name}",
            "steps": [f"Open /ops/{beat}", "Read the dashboard cards without asking the Copilot anything", "Cross-check a figure against data/coverage.json or docs/evidence/*"],
            "link": f"/ops/{beat}",
            "expected": "The dashboard's own numbers match the cited evidence file, with n.",
        }]
    if n.startswith("7."):
        return [{
            "title": f"Open the ops surface: {name}",
            "steps": ["Open /coverage to see the technique board", "Open /ops/replay for a specific run"],
            "link": "/coverage",
            "expected": "Coverage board and replay both cite real evidence files with n.",
        }, {
            "title": f"Open a specific replay: {name}",
            "steps": ["Run any shopper turn", "Open /ops/replay and pick the newest run", "Step the scrub slider through recorded frames"],
            "link": "/ops/replay",
            "expected": "The replay list shows the run and the slider steps through its recorded events.",
        }]
    if n.startswith("5.1"):
        chat = urllib.parse.quote(prompt_shop)
        return [{
            "title": "Beat 1: goal to cart",
            "steps": [f"Open /shopper/1?chat={chat}", "Watch Planner -> Shopper -> Critic run"],
            "link": f"/shopper/1?chat={chat}",
            "expected": "Cart is filled under the stated budget with a Critic verdict shown.",
        }, {
            "title": "Beat 1 in split view",
            "steps": [f"Open /shopper/1?layout=split&chat={chat}", "Approve each proposal as it appears", "Check the cart total against the $25 budget"],
            "link": f"/shopper/1?layout=split&chat={chat}",
            "expected": "The audit log shows proposed then approved for each line, with no pending action left.",
        }]
    return [{
        "title": name,
        "steps": ["Open the storefront at /shop", "Follow the flow described in the catalogue section"],
        "link": "/shop",
        "expected": "Behaviour matches the acceptance criteria in the linked user stories.",
    }, {
        "title": f"{name} from the Guide",
        "steps": ["Open /guide", "Search or browse to this feature", "Open its Try it tab for a prefilled link"],
        "link": "/guide",
        "expected": "The Guide's Try it tab holds a prompt in the composer without sending it.",
    }]


def build_story_entries(ref_ids: list[str], spec_fallback: str, stories: dict) -> list[dict]:
    out = []
    for sid in ref_ids:
        s = stories.get(sid)
        if not s:
            continue
        entry = dict(s)
        if not entry["spec"]:
            entry["spec"] = spec_fallback
        out.append(entry)
    return out


def parse_section(num: str, title: str, body: str, stories: dict) -> dict:
    area_map = {
        "0": "Architecture",
        "1": "Storefront",
        "2": "Session & sync",
        "3": "Catalogue & triage",
        "4": "Sparky chat AI",
        "5": "Demo beats",
        "6": "Ops Copilot beats",
        "7": "Gates & coverage",
        "8": "Ops Copilot / streaming",
        "9": "MLOps",
    }
    area = area_map.get(num.split(".")[0], "Other")

    # story ids referenced, in order, de-duplicated
    raw_refs = STORY_REF_RE.findall(body)
    ref_ids: list[str] = []
    for r in raw_refs:
        for part in re.split(r"\s*/\s*", r):
            if part not in ref_ids:
                ref_ids.append(part)
    specs_in_body = SPEC_RE.findall(body)
    spec_fallback = specs_in_body[0] if specs_in_body else ""
    story_entries = build_story_entries(ref_ids, spec_fallback, stories)

    stack_m = re.search(r"\*\*Tech stack\.\*\*\s*(.*)", body)
    stack: list[str] = []
    if stack_m:
        raw = stack_m.group(1).split("\n\n")[0].strip()
        raw = raw.rstrip(".")
        # split on top-level commas (ignore commas inside parens/backticks)
        depth = 0
        buf = ""
        parts = []
        for ch in raw:
            if ch in "([":
                depth += 1
            elif ch in ")]":
                depth -= 1
            if ch == "," and depth == 0:
                parts.append(buf.strip())
                buf = ""
            else:
                buf += ch
        if buf.strip():
            parts.append(buf.strip())
        stack = [p for p in parts if p]

    diagram_m = MERMAID_RE.search(body)
    diagram = diagram_m.group(1).strip() if diagram_m else None

    summary = ""
    if story_entries:
        s0 = story_entries[0]
        if s0["given"] and s0["then"]:
            summary = f"Given {s0['given']}, when {s0['when']}, then {s0['then']}.".replace("..", ".")
        elif s0["then"]:
            summary = s0["then"].rstrip(".") + "."
    if not summary:
        detail_m = re.search(r"\*\*Technical details\.\*\*\s*(.*)", body, re.DOTALL)
        if detail_m:
            detail_text = detail_m.group(1).strip().lstrip("- ")
            first = re.split(r"(?<=[.;])\s", detail_text, maxsplit=1)[0]
            summary = re.sub(r"[`*]", "", first).strip()
    if not summary:
        summary = f"{title} ({area})."

    fid = f"{num}-{slugify(title)}"

    # A handful of sections lack a "Tech stack."/"Technical details." heading
    # or a rich enough intro paragraph for auto-extraction; hand-fill those.
    OVERRIDES = {
        "0.1": {
            "summary": "Container map of the whole demo: web talks to bff over AG-UI/session SSE, the claude CLI (spawned per role) is given only policy-mcp, which proxies shop-mcp and ops-mcp onto search-svc and the shared data stores.",
            "stack": ["React 18 + Vite (web)", "Fastify 5 (bff)", "claude CLI per role", "policy-mcp (stdio proxy)", "shop-mcp / ops-mcp", "search-svc (BM25 + bge-small + RRF + rerank)"],
        },
        "5.1": {
            "summary": "The scripted opening demo beat: a split-view goal ('coffee and filters under $25') runs through Planner, Shopper and Critic, needs human approval on each proposal, and lands in a cart that meets the goal and budget.",
            "stack": ["React split view", "AG-UI POST /api/agui", "Planner/Shopper/Critic roles", "policy-mcp guard"],
        },
        "5.2": {
            "summary": "Untrusted seller-listing text is quarantined by CaMeL before the privileged planner ever sees it, so a prompt-injected 'add 10 boxes' instruction is blocked by policy-mcp's guarded_add_to_cart rather than silently executed.",
            "stack": ["shop-mcp guard.py / injection.py", "policy-mcp policy.py", "bff CaMeL quarantine (agents/camel.ts, guard.ts)", "policy_events.jsonl feed"],
        },
        "1.1": {
            "summary": "The /shop home page: category tiles and four curated mission cards (nut-free lunches, coffee and #4 filters, puppy kit, desk setup) that each link straight into a search, plus a saved-lists preview read from the session.",
        },
        "2.2": {
            "summary": "A single SiteSession per session id (store, query, filters, cart, activity, constraints, verifier verdict) is pushed to the browser as an SSE STATE_SNAPSHOT then STATE_DELTA stream, so the site and chat panes always see the same state.",
        },
        "6.1": {
            "summary": "Given the ops plane, when I ask it to validate the catalogue and label recent queries, then a DQ report appears (missingness, dietary coverage, outliers, dedup) and low-confidence labels (below 0.7) go to a human review queue.",
        },
        "6.2": {
            "summary": "Given drift on the seasonal query stream, when I approve a remediation, then a candidate ranker is built, gated (paired NDCG CI, p95, red-team), canaried with a guardrail watcher, and either promoted or auto-rolled-back on breach.",
        },
        "6.3": {
            "summary": "Given shopper traffic, when I open the FinOps view, then I see how the router splits queries across lexical/hybrid/premium/claude arms by a 0.15 confidence margin, with cost per 1k queries and per fulfilled task for each arm.",
        },
        "7.1": {
            "summary": "Release gates (NDCG delta CI lower >= -0.005, p95 <= 150ms, red-team blocked = 1.0) and a preregistered-candidate check can turn red and block a release; named-person overrides and open bypass classes are logged, never silent.",
        },
        "7.2": {
            "summary": "The /coverage board reads data/coverage.json and renders a tally (real-measured vs real-no-metric vs script-ready vs absent) per technique, refusing with a 503 rather than a placeholder when the file is missing.",
        },
        "7.3": {
            "summary": "Every AG-UI/session run is recorded verbatim to data/agui_runs/*.jsonl and can be replayed frame-by-frame at /ops/replay/:runId, the same records OPS9's replay_summary and AI1's 'How Sparky worked' link cite.",
        },
        "7.4": {
            "summary": "A presenter density mode (larger type, simplified chrome) toggled from the top bar, backed by localStorage, plus Playwright-recorded .webm fallbacks of the shopper split-view flow for when a live demo is not possible.",
        },
    }
    if num in OVERRIDES:
        summary = OVERRIDES[num].get("summary", summary)
        stack = OVERRIDES[num].get("stack", stack)

    return {
        "id": fid,
        "area": area,
        "name": title,
        "summary": summary,
        "stories": story_entries,
        "stack": stack,
        "alternatives": alt_for(area),
        "examples": route_example(num, title),
        "diagram": diagram,
        "coverage_ids": parse_coverage_ids(body),
        "atlas_nodes": parse_atlas_nodes(body),
    }


TABLE_ROW_RE = re.compile(
    r"\|\s*\[(?P<id>[A-Za-z0-9]+)\]\(USER_STORIES\.md#(?P<anchor>[^)]+)\)\s*\|\s*(?P<gwt>.*?)\s*\|\s*(?P<tool>.*?)\s*\|\s*$"
)


def parse_top10_table(section_body: str, area: str, id_prefix: str, spec: str, stories: dict) -> list[dict]:
    features = []
    coverage_map = parse_coverage_map(section_body)
    atlas_map = parse_atlas_map(section_body)
    diagram_m = MERMAID_RE.search(section_body)
    diagram = diagram_m.group(1).strip() if diagram_m else None
    stack_m = re.search(r"\*\*Tech stack\.\*\*\s*(.*)", section_body)
    stack_line = stack_m.group(1).split("\n")[0].strip().rstrip(".") if stack_m else ""
    stack = [p.strip() for p in re.split(r",\s*(?![^(]*\))", stack_line) if p.strip()]

    for line in section_body.splitlines():
        m = TABLE_ROW_RE.match(line.strip())
        if not m:
            continue
        sid = m.group("id")
        if not sid.startswith(id_prefix):
            continue
        gwt_text = re.sub(r"`", "", m.group("gwt"))
        tool = m.group("tool").strip()
        s = stories.get(sid)
        story_entry = dict(s) if s else {"id": sid, "persona": area, "given": "", "when": "", "then": gwt_text, "spec": spec}
        if not story_entry.get("spec"):
            story_entry["spec"] = spec
        # a second, real, hand-authored story for this same capability lives in
        # USER_STORIES.md under id "<sid>B" (e.g. OPS1B, MLO3B) rather than being
        # synthesised here; pick it up like any other story.
        extra_entries = []
        extra = stories.get(f"{sid}B")
        if extra:
            extra_entry = dict(extra)
            if not extra_entry.get("spec"):
                extra_entry["spec"] = spec
            extra_entries.append(extra_entry)
        gwt = GWT_RE.search(m.group("gwt"))
        summary = re.sub(r"\*\*", "", m.group("gwt"))
        summary = re.sub(r"`", "", summary)
        if gwt:
            summary = f"Given {gwt.group('given')}, when {gwt.group('when')}, then {gwt.group('then')}"
            summary = re.sub(r"\*\*", "", summary).strip(" .") + "."
        beat = "8a" if id_prefix == "OPS" else "8b"
        copilot_prompt = {
            "OPS1": "triage the latest incident",
            "OPS2": "what is NDCG@10 per registry version",
            "OPS3": "run the re-run eval gate runbook",
            "OPS4": "give me release notes for the candidate",
            "OPS5": "compare champion and candidate",
            "OPS6": "which query slices are drifting",
            "OPS7": "cluster the eval failures",
            "OPS8": "show cost and tokens by role",
            "OPS9": "what went wrong in the latest run",
            "OPS10": "show me the open alerts",
            "MLO1": "interleave rrf_rerank vs rrf",
            "MLO2": "run a CUPED sequential A/B on the online sessions",
            "MLO3": "check training-serving skew on the candidate version",
            "MLO4": "where did the champion model come from",
            "MLO5": "should we retrain given current drift",
            "MLO6": "audit sponsored vs organic exposure",
            "MLO7": "what changed in the agent config",
            "MLO8": "show SLO and error-budget status",
            "MLO9": "run a golden-set regression check",
            "MLO10": "shadow the candidate against the champion",
        }.get(sid, "help me understand this ops metric")
        copilot = urllib.parse.quote(copilot_prompt)
        features.append({
            "id": f"{sid.lower()}-{slugify(tool.split('(')[0])}",
            "area": area,
            "name": f"{sid}: {tool.split('(')[0].strip().strip('`')}",
            "summary": summary,
            "stories": [story_entry, *extra_entries],
            "stack": stack,
            "alternatives": alt_for(area),
            "examples": [{
                "title": f"Ask the Ops Copilot ({sid})",
                "steps": [f"Open /ops/{beat}?copilot={copilot}", "Read the cited ops_insight card"],
                "link": f"/ops/{beat}?copilot={copilot}",
                "expected": summary,
            }, (
                {
                    "title": f"Run the tool directly ({sid}, no LLM)",
                    "steps": ["cd services/ops-mcp", f"uv run python -m ops_mcp.mlops_top10 {tool.split('(')[0].strip().strip('`')} '{{}}'", "Check the JSON result's tier, citations and n"],
                    "link": f"/ops/{beat}",
                    "expected": f"A {tool.split('(')[0].strip().strip('`')} result with `ui: ops_insight`, a citation and n > 0, matching the card shown in chat.",
                } if id_prefix == "MLO" else {
                    "title": f"Open the dashboard directly ({sid})",
                    "steps": [f"Open /ops/{beat} without a prompt", "Find the section that covers this capability", "Cross-check a figure against docs/evidence/*"],
                    "link": f"/ops/{beat}",
                    "expected": "The same underlying data the chat card cites, visible without asking the Copilot anything.",
                }
            )],
            "diagram": diagram if sid in (id_prefix + "1",) else None,
            "coverage_ids": coverage_map.get(sid, []),
            "atlas_nodes": atlas_map.get(sid, []),
        })
    return features


def main() -> int:
    check = "--check" in sys.argv
    cat_text = CATALOGUE.read_text()
    stories_text = STORIES.read_text()
    stories = parse_stories(stories_text)

    # split catalogue into ### sections, tracking the num/title
    section_re = re.compile(r"^### (\d+\.\d+) (.+)$", re.MULTILINE)
    matches = list(section_re.finditer(cat_text))
    features: list[dict] = []
    handled_top10 = False
    for i, m in enumerate(matches):
        num, title = m.group(1), m.group(2).strip()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(cat_text)
        body = cat_text[start:end]
        # cut at next ## (h2) boundary too, already handled since ### precedes it
        if num == "0.1":
            # merge 0.1-0.3 into one architecture feature
            arch_end = matches[i + 3].start() if i + 3 < len(matches) else len(cat_text)
            merged_body = cat_text[start:arch_end]
            feat = parse_section("0.1", "Architecture and tech stack", merged_body, stories)
            feat["examples"] = [{
                "title": "Read the container diagram",
                "steps": ["Open docs/FEATURE_CATALOGUE.md section 0.1", "Cross-check ports against CLAUDE.md"],
                "link": "/shop",
                "expected": "web (5173), bff (8787), search-svc (8801), shop-http (8802), ops-http (8803) all reachable.",
            }, {
                "title": "Confirm the CLI's only MCP server",
                "steps": ["Run a shopper turn on /shopper/1", "Open its trace or replay record", "Check the tool calls only ever go through policy-mcp-proxied names"],
                "link": "/ops/replay",
                "expected": "Every tool call traces back through policy-mcp to shop-mcp or ops-mcp, never a direct MCP server.",
            }]
            features.append(feat)
            continue
        if num in ("0.2", "0.3"):
            continue  # merged above
        if num == "8.1":
            features.extend(parse_top10_table(body, "Ops Copilot beats", "OPS", "ops-copilot-top10.spec.ts", stories))
            continue
        if num == "9.1":
            features.extend(parse_top10_table(body, "MLOps", "MLO", "mlops-top10.spec.ts", stories))
            continue
        feat = parse_section(num, title, body, stories)
        if num == "7.5":
            chat = urllib.parse.quote("coffee and #4 cone filters under $25")
            copilot = urllib.parse.quote("show me the open alerts")
            feat["examples"] = [
                {"title": "Prefill a shopper prompt", "steps": ["Open the link", "Check the prompt is in the composer and nothing was sent", "Press Enter to run it"], "link": f"/shopper/1?chat={chat}", "expected": "The Sparky composer holds the prompt; no turn starts until you send it."},
                {"title": "Prefill an Ops Copilot prompt", "steps": ["Open the link", "The Ops Copilot dock opens with the prompt in its composer"], "link": f"/ops/8a?copilot={copilot}", "expected": "The Ops Copilot composer holds the prompt; nothing is sent."},
            ]
        features.append(feat)

    # deep tracing (docs/TRACING.md; diagram source docs/tracing_flow.mmd)
    flow = DOCS / "tracing_flow.mmd"
    features.append({
        "id": "tracing-deep-tracing",
        "area": "Ops",
        "name": "Deep tracing",
        "summary": ("Every turn is one trace: a turn root span in the bff, router/llm/tool/state/verifier/budget/error spans at the code "
                    "points that do the work, policy spans in policy-mcp and retrieval spans in search-svc under the same traceId "
                    "(W3C traceparent), plus hitl and feedback spans that land on the turn later. Spans are written to "
                    "data/traces/YYYY-MM-DD.jsonl (on by default, TRACE_FILE=0 disables), OTLP to Jaeger stays optional, prompts and "
                    "shopper text are hashed unless OTEL_CAPTURE_CONTENT=1. See docs/TRACING.md."),
        "stories": [dict(stories[sid]) for sid in ("T1", "T2") if sid in stories],
        "stack": [
            "OpenTelemetry API + sdk-node in bff (bff/src/otel.ts, bff/src/trace/*)",
            "opentelemetry-sdk in policy-mcp / shop-mcp / ops-mcp / search-svc (sparky_trace.py)",
            "Local JSONL span store data/traces (50 MB rotation)",
            "AG-UI CUSTOM `trace` event at RUN_STARTED",
            "GET /api/traces, GET /api/traces/:traceId, POST /api/traces/web",
            "Ops Copilot tool trace_summary (T0, via policy-mcp)",
        ],
        "alternatives": {
            "alt1": {
                "components": ["Langfuse (self-hosted) or Arize Phoenix", "OpenLLMetry / OpenInference auto-instrumentation"],
                "tradeoff": f"Rich LLM trace UI, evals and prompt management out of the box, but another service and database to run, and auto-instrumentation cannot see through the Claude CLI subprocess to policy-mcp without the same env propagation used here. {NOTE}.",
                "betterWhen": "Several teams need a shared trace UI with annotation queues and dataset curation, not one laptop demo.",
            },
            "alt2": {
                "components": ["OTel Collector -> Grafana Tempo or Cloud Trace", "Jaeger all-in-one (already wired: OTEL_ENABLED=1)"],
                "tradeoff": f"Standard backends with search and service graphs and no custom store, but a collector must be up for anything to be recorded, which the local JSONL sink avoids. {NOTE}.",
                "betterWhen": "Traces must be retained centrally, correlated with infra metrics, or queried across many hosts.",
            },
        },
        "examples": [
            {
                "title": "Find the trace of a replayed run",
                "steps": ["Run a shopper turn in /shop chat", "Open /ops/replay and pick the run", "GET /api/traces/run/<runId> (or read trace_id on GET /api/replay/runs/:id)", "GET /api/traces/<traceId>"],
                "link": "/ops/replay",
                "expected": "One span tree whose root is `turn shopper`, kind_counts including router, llm, tool, policy, retrieval, state, verifier, budget, and services sparky-bff, policy-mcp, search-svc.",
            },
            {
                "title": "Ask Ops Copilot about a trace",
                "steps": ["Open /ops", "Ask: summarise the latest trace"],
                "link": "/ops/8a?copilot=summarise%20the%20latest%20trace",
                "expected": "trace_summary (T0) card: span count per kind, slowest spans, policy refusals, zero-result searches, LLM cost and cache-read ratio, each cited to a span id.",
            },
            {
                "title": "Open the trace waterfall",
                "steps": ["Run a shopper turn", "Click View trace under the answer (or open /ops/traces and pick the newest)", "Toggle kind chips and click a span"],
                "link": "/ops/traces",
                "expected": "A waterfall of the turn's spans coloured by kind (turn, router, llm, tool, policy, retrieval, state, ui ...) with per-kind counts and each span's recorded attributes.",
            },
            {
                "title": "HITL wait and feedback on the same trace",
                "steps": ["Ask Sparky to add an item with HITL on", "Approve the proposal after a pause", "Give the answer a thumbs down", "GET /api/traces/<traceId>"],
                "link": "/shop",
                "expected": "A hitl span with sparky.hitl.wait_ms equal to the real pause and a feedback span with a feedback event, both under the turn root.",
            },
        ],
        "diagram": flow.read_text().strip() if flow.exists() else None,
        # Not a catalogue section (this feature is authored from docs/TRACING.md), so its
        # coverage id is named here: technique 29 (LLM online evals) is the only
        # data/coverage.json row whose code list names bff/src/otel.ts.
        "coverage_ids": [29],
        # Authored here rather than in the catalogue (this feature has no `### n.n`
        # section); every id below is a node in the diagram above and is checked by --check.
        "atlas_nodes": [f"tracing-deep-tracing#{n}" for n in ("turn", "router", "llm", "tool", "misc", "store", "api", "web", "bff")],
    })

    resolve_atlas_nodes(features)
    generated = json.dumps(features, indent=2, ensure_ascii=False) + "\n"

    if check:
        problems: list[str] = []
        if not OUT.exists():
            print("FAIL: docs/features.json does not exist", file=sys.stderr)
            return 1
        try:
            existing = json.loads(OUT.read_text())
        except json.JSONDecodeError as e:
            print(f"FAIL: docs/features.json is not valid JSON: {e}", file=sys.stderr)
            return 1
        if not isinstance(existing, list) or not existing:
            problems.append("features.json must be a non-empty JSON array")
        unproven = parse_unproven_ids(stories_text)
        required = {"id", "area", "name", "summary", "stories", "stack", "alternatives", "examples", "diagram", "coverage_ids", "atlas_nodes"}
        known_coverage = load_coverage_ids()
        generated_coverage = {f["id"]: f["coverage_ids"] for f in features}
        generated_atlas = {f["id"]: f["atlas_nodes"] for f in features}
        diagram_nodes = {f["id"]: mermaid_node_ids(f.get("diagram")) for f in existing if isinstance(f, dict)}
        atlas_claims: dict[str, str] = {}
        seen_ids = set()
        seen_story_ids: set[str] = set()
        for feat in existing:
            missing = required - set(feat.keys())
            if missing:
                problems.append(f"feature {feat.get('id', '?')} missing fields: {missing}")
            fid = feat.get("id")
            if fid in seen_ids:
                problems.append(f"duplicate feature id: {fid}")
            seen_ids.add(fid)
            cids = feat.get("coverage_ids")
            if not isinstance(cids, list):
                problems.append(f"feature {fid} coverage_ids must be a list (got {type(cids).__name__})")
            else:
                for cid in cids:
                    if cid not in known_coverage:
                        problems.append(f"feature {fid} coverage_ids references {cid!r}, which is not a techniques[].id or mlops_top10.rows[].id in data/coverage.json")
                if fid in generated_coverage and cids != generated_coverage[fid]:
                    problems.append(f"feature {fid} coverage_ids {cids} drifted from the catalogue's **Coverage.** line {generated_coverage[fid]} (rerun scripts/build_features_json.py)")
            anodes = feat.get("atlas_nodes")
            if not isinstance(anodes, list):
                problems.append(f"feature {fid} atlas_nodes must be a list (got {type(anodes).__name__})")
            else:
                for entry in anodes:
                    if not isinstance(entry, str) or "#" not in entry:
                        problems.append(f"feature {fid} atlas_nodes entry {entry!r} is not '<feature id>#<node id>'")
                        continue
                    src, node = entry.split("#", 1)
                    if src not in diagram_nodes:
                        problems.append(f"feature {fid} atlas_nodes {entry!r} names feature {src!r}, which is not in features.json")
                    elif not diagram_nodes[src]:
                        problems.append(f"feature {fid} atlas_nodes {entry!r} names {src!r}, which has no mermaid diagram")
                    elif node not in diagram_nodes[src]:
                        problems.append(f"feature {fid} atlas_nodes {entry!r} names a node that is not in {src}'s diagram")
                    owner = atlas_claims.get(entry)
                    if owner and owner != fid:
                        problems.append(f"atlas node {entry!r} is claimed by both {owner} and {fid} — a node maps to at most one feature")
                    atlas_claims[entry] = fid
                if fid in generated_atlas and anodes != generated_atlas[fid]:
                    problems.append(f"feature {fid} atlas_nodes {anodes} drifted from the catalogue's **Atlas nodes.** line {generated_atlas[fid]} (rerun scripts/build_features_json.py)")
            alts = feat.get("alternatives", {})
            for key in ("alt1", "alt2"):
                if key not in alts:
                    problems.append(f"feature {fid} alternatives missing {key}")
                    continue
                for f in ("components", "tradeoff", "betterWhen"):
                    if f not in alts[key]:
                        problems.append(f"feature {fid} alternatives.{key} missing {f}")
            feat_stories = feat.get("stories", [])
            if fid != "tracing-deep-tracing" and len(feat_stories) < 2:
                problems.append(f"feature {fid} has fewer than 2 stories ({len(feat_stories)})")
            for story in feat_stories:
                sid = story.get("id")
                seen_story_ids.add(sid)
                if sid not in stories:
                    problems.append(f"feature {fid} references unknown story id {sid} (not in USER_STORIES.md)")
                for field in ("persona", "given", "when", "then"):
                    if not str(story.get(field, "")).strip():
                        problems.append(f"feature {fid} story {sid} has an empty {field}")
                when_text = story.get("when", "")
                if when_text and not WHEN_VERBS.search(when_text):
                    problems.append(f"feature {fid} story {sid} 'when' has no recognisable action verb: {when_text!r}")
                then_text = story.get("then", "")
                if then_text and not (THEN_ASSERTIONS.search(then_text) or "`" in then_text):
                    problems.append(f"feature {fid} story {sid} 'then' is not checkable (no observable object/assertion word): {then_text!r}")
                spec = story.get("spec")
                if spec:
                    spec_path = ROOT / "web" / "e2e" / spec
                    if not spec_path.exists():
                        problems.append(f"feature {fid} story {sid} references missing spec file web/e2e/{spec}")
                elif sid not in unproven:
                    problems.append(f"feature {fid} story {sid} has no spec and is not listed in the 'Stories without proof' table")
        # coverage: every OPS/MLO id present
        expected_ids = {f"OPS{n}" for n in range(1, 11)} | {f"MLO{n}" for n in range(1, 11)}
        found_story_ids = {s["id"] for f in existing for s in f.get("stories", [])}
        missing_top10 = expected_ids - found_story_ids
        if missing_top10:
            problems.append(f"missing OPS/MLO coverage: {sorted(missing_top10)}")
        if not any(f.get("id") == "tracing-deep-tracing" for f in existing):
            problems.append("missing tracing-deep-tracing feature")

        if problems:
            print("features.json check FAILED:", file=sys.stderr)
            for p in problems:
                print(f"  - {p}", file=sys.stderr)
            return 1
        mapped_nodes = len(atlas_claims)
        all_nodes = sum(len(v) for v in diagram_nodes.values())
        print(f"features.json check OK: {len(existing)} features, {len(stories)} stories cross-checked, {mapped_nodes} of {all_nodes} mermaid nodes declared in atlas_nodes.")
        return 0

    OUT.write_text(generated)
    print(f"Wrote {OUT} with {len(features)} features.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
