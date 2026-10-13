"""Model signing (technique 34). Uses the OpenSSF `model_signing` package in elliptic-key (private key) mode with a
generated DEMO key. If that path fails, falls back to an HMAC-SHA256 manifest, clearly labelled as NOT OpenSSF."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path

from .db import DATA

DEMO_HMAC_KEY = os.environ.get("OPS_DEMO_HMAC_KEY", "sparky-next-ops-demo-key-not-secret").encode()


def art_root() -> Path:
    return Path(os.environ.get("OPS_ARTIFACT_DIR") or DATA / "model_artifacts")


def key_paths() -> tuple[Path, Path]:
    d = Path(os.environ.get("OPS_KEY_DIR") or DATA / "ops_keys")
    return d / "demo_signing_key.pem", d / "demo_signing_key.pub.pem"


def ensure_key() -> tuple[Path, Path]:
    priv, pub = key_paths()
    if not priv.exists():
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec

        priv.parent.mkdir(parents=True, exist_ok=True)
        k = ec.generate_private_key(ec.SECP256R1())
        priv.write_bytes(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        pub.write_bytes(k.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
    return priv, pub


def materialize(version: str, record: dict) -> Path:
    """Write the model artifact directory for a version: ranker config + model card (deterministic JSON)."""
    d = art_root() / version
    d.mkdir(parents=True, exist_ok=True)
    (d / "config.json").write_text(json.dumps(record["config"], indent=2, sort_keys=True))
    card = {"name": "sparky-search-ranker", "version": version, "config_hash": record.get("config_hash"),
            "parent": record.get("parent"), "note": record.get("note"), "metrics": record.get("metrics", {}),
            "mlflow": record.get("mlflow", {}), "training_data": "Amazon ESCI Shopping Queries (Apache-2.0), US subset"}
    (d / "model_card.json").write_text(json.dumps(card, indent=2, sort_keys=True))
    return d


def _manifest(d: Path) -> dict:
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(d.iterdir()) if p.is_file()}


def sign(version: str, record: dict) -> dict:
    d = materialize(version, record)
    sig = art_root() / f"{version}.sig"
    hsig = art_root() / f"{version}.hmac.json"
    for f in (sig, hsig):
        f.unlink(missing_ok=True)
    try:
        import model_signing

        priv, pub = ensure_key()
        model_signing.signing.Config().use_elliptic_key_signer(private_key=priv).sign(d, sig)
        method = {"method": "model_signing", "package_version": getattr(model_signing, "__version__", "?"),
                  "mode": "elliptic-key (ECDSA P-256), DEMO key generated locally; production would use Sigstore keyless/KMS",
                  "public_key": str(pub)}
    except Exception as e:  # fallback, clearly labelled
        body = {"version": version, "files": _manifest(d)}
        body["hmac_sha256"] = hmac.new(DEMO_HMAC_KEY, json.dumps(body["files"], sort_keys=True).encode(), hashlib.sha256).hexdigest()
        hsig.write_text(json.dumps(body, indent=2))
        sig = hsig
        method = {"method": "HMAC-SHA256 FALLBACK (NOT OpenSSF model_signing)", "reason": repr(e)[:200]}
    return {"version": version, "artifact_dir": str(d), "signature_path": str(sig),
            "signature_sha256": hashlib.sha256(sig.read_bytes()).hexdigest(), "files": _manifest(d), **method,
            "verification": verify(version)}


def verify(version: str) -> dict:
    d = art_root() / version
    sig, hsig = art_root() / f"{version}.sig", art_root() / f"{version}.hmac.json"
    if sig.exists():
        import model_signing

        _, pub = key_paths()
        try:
            model_signing.verifying.Config().use_elliptic_key_verifier(public_key=pub).verify(d, sig)
            return {"verified": True, "method": "model_signing elliptic-key"}
        except Exception as e:
            return {"verified": False, "method": "model_signing elliptic-key", "error": str(e)[:300]}
    if hsig.exists():
        body = json.loads(hsig.read_text())
        files = _manifest(d)
        mac = hmac.new(DEMO_HMAC_KEY, json.dumps(files, sort_keys=True).encode(), hashlib.sha256).hexdigest()
        ok = hmac.compare_digest(mac, body["hmac_sha256"]) and files == body["files"]
        return {"verified": ok, "method": "HMAC-SHA256 FALLBACK"}
    return {"verified": False, "error": "no signature found; call sign_model first"}
