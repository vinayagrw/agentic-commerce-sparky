"""ML-BOM (technique 35): CycloneDX 1.6 JSON with a machine-learning-model component, model card, datasets and
dependencies; validated with cyclonedx-python-lib's JSON schema validator."""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

from .signing import art_root

SPEC = "1.6"


def build(version: str, record: dict, signature: dict | None = None) -> dict:
    cfg, metrics = record["config"], record.get("metrics", {})
    model_ref, ds_ref = f"sparky-search-ranker@{version}", "dataset:amazon-esci"
    emb_ref, rr_ref = f"model:{cfg['embedding_model']}", f"model:{cfg['reranker_model']}"
    perf = []
    for key, val in sorted(metrics.items()):
        if isinstance(val, (int, float)):
            perf.append({"type": key, "value": str(val), "slice": "ESCI test split" if key.startswith("test") else "ESCI dev split"})
    props = [{"name": f"sparky:config:{k}", "value": json.dumps(v) if isinstance(v, (dict, list)) else str(v)} for k, v in sorted(cfg.items())]
    props += [{"name": "sparky:config_hash", "value": str(record.get("config_hash"))},
              {"name": "sparky:mlflow_run_id", "value": str(record.get("mlflow", {}).get("run_id"))},
              {"name": "sparky:registry_status", "value": str(record.get("status"))}]
    if signature:
        props += [{"name": "sparky:signature:method", "value": signature.get("method", "")},
                  {"name": "sparky:signature:sha256", "value": signature.get("signature_sha256", "")},
                  {"name": "sparky:signature:verified", "value": str(signature.get("verification", {}).get("verified"))}]
    model = {
        "type": "machine-learning-model", "bom-ref": model_ref, "name": "sparky-search-ranker", "version": version,
        "description": "Hybrid product-search ranker: BM25 + dense retrieval fused with weighted RRF, optional cross-encoder rerank",
        "supplier": {"name": "Agentic Commerce demo"},
        "hashes": [{"alg": "SHA-256", "content": h} for h in (signature or {}).get("files", {}).values()],
        "properties": props,
        "modelCard": {
            "modelParameters": {
                "approach": {"type": "supervised"}, "task": "information-retrieval / product search ranking",
                "architectureFamily": "hybrid sparse+dense retrieval with cross-encoder reranking",
                "modelArchitecture": f"BM25 + {cfg['embedding_model']} (RRF k={cfg['rrf_k']}, w_bm25={cfg['w_bm25']}, "
                                     f"w_vector={cfg['w_vector']}) + {cfg['reranker_model'] if cfg['reranker'] else 'no reranker'}",
                "datasets": [{"ref": ds_ref}],
                "inputs": [{"format": "text/plain (shopper query)"}], "outputs": [{"format": "application/json (ranked product ids)"}],
            },
            "quantitativeAnalysis": {"performanceMetrics": perf},
            "considerations": {
                "users": ["e-commerce shoppers", "shopping agents via MCP"],
                "useCases": ["hybrid product search", "agentic shopping retrieval"],
                "technicalLimitations": ["English (US) queries only", "catalog subset of ~25k ESCI products",
                                         "prices/stock/dietary tags are synthetic"],
                "ethicalConsiderations": [{"name": "sponsored results bias",
                                           "mitigationStrategy": "sponsored items labelled and capped at 1 per 8 results"}],
            },
        },
    }
    dataset = {
        "type": "data", "bom-ref": ds_ref, "name": "Amazon Shopping Queries Dataset (ESCI)", "version": "2022",
        "licenses": [{"license": {"id": "Apache-2.0"}}],
        "externalReferences": [{"type": "distribution", "url": "https://github.com/amazon-science/esci-data"}],
        "data": [{"type": "dataset", "name": "esci-us-subset",
                  "contents": {"url": "https://github.com/amazon-science/esci-data"},
                  "classification": "public",
                  "description": "US-locale query-product pairs with E/S/C/I labels; ~25k products, 1644 queries (dev/test)"}],
    }
    deps = [
        {"type": "machine-learning-model", "bom-ref": emb_ref, "name": cfg["embedding_model"], "licenses": [{"license": {"id": "MIT"}}],
         "externalReferences": [{"type": "distribution", "url": f"https://huggingface.co/{cfg['embedding_model']}"}]},
        {"type": "library", "bom-ref": "lib:bm25s", "name": "bm25s", "licenses": [{"license": {"id": "MIT"}}]},
        {"type": "library", "bom-ref": "lib:faiss-cpu", "name": "faiss-cpu", "licenses": [{"license": {"id": "MIT"}}]},
    ]
    dep_refs = [emb_ref, "lib:bm25s", "lib:faiss-cpu", ds_ref]
    if cfg.get("reranker"):
        deps.append({"type": "machine-learning-model", "bom-ref": rr_ref, "name": cfg["reranker_model"],
                     "licenses": [{"license": {"id": "Apache-2.0"}}],
                     "externalReferences": [{"type": "distribution", "url": f"https://huggingface.co/{cfg['reranker_model']}"}]})
        dep_refs.append(rr_ref)
    return {
        "$schema": f"http://cyclonedx.org/schema/bom-{SPEC}.schema.json", "bomFormat": "CycloneDX", "specVersion": SPEC,
        "serialNumber": f"urn:uuid:{uuid.uuid4()}", "version": 1,
        "metadata": {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                     "tools": {"components": [{"type": "application", "name": "ops-mcp", "version": "0.1.0"}]},
                     "component": model},
        "components": [dataset, *deps],
        "dependencies": [{"ref": model_ref, "dependsOn": dep_refs}, *[{"ref": r} for r in dep_refs]],
    }


def validate(bom: dict) -> dict:
    try:
        from cyclonedx.schema import SchemaVersion
        from cyclonedx.validation.json import JsonStrictValidator

        errors = JsonStrictValidator(SchemaVersion.from_version(bom["specVersion"])).validate_str(json.dumps(bom))
        if errors:
            return {"valid": False, "validator": "cyclonedx-python-lib JsonStrictValidator",
                    "error": str(getattr(errors, "data", errors))[:500]}
        return {"valid": True, "validator": "cyclonedx-python-lib JsonStrictValidator", "schema": f"CycloneDX {bom['specVersion']}"}
    except ImportError as e:  # pragma: no cover
        return {"valid": None, "validator": "unavailable", "error": repr(e)}


def write(version: str, bom: dict) -> Path:
    p = art_root() / f"{version}.cdx.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(bom, indent=2))
    return p
